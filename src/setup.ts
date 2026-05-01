import fs from 'fs';
import path from 'path';
import { input, select, checkbox, password, confirm } from '@inquirer/prompts';
import { fileURLToPath } from 'url';
import { ENV_VARIABLES } from './config/env-vars.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, '.env.example');
const TEAM_JSON_PATH = path.join(PROJECT_ROOT, 'src/config/team.json');
const TEAM_EXAMPLE_PATH = path.join(PROJECT_ROOT, 'src/config/team.example.json');

// Env keys handled by dedicated checkbox flows (not the generic env loop).
const SKIP_IN_ENV_LOOP = new Set(['ENABLED_HOOKS', 'ENABLED_JOBS', 'ENABLED_ACTIONS', 'INBOUND_SERVICE']);

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf-8');
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...rest] = trimmed.split('=');
      if (key && rest.length >= 0) {
        result[key.trim()] = rest.join('=').trim();
      }
    }
  }
  return result;
}

interface DiscoveredModule {
  name: string;
  value: string;
  description?: string;
}

function discover(dir: string, suffix: string, exclude: string[]): DiscoveredModule[] {
  const fullDir = path.join(PROJECT_ROOT, dir);
  if (!fs.existsSync(fullDir)) return [];
  const files = fs.readdirSync(fullDir);
  return files
    .filter(f => f.endsWith(`${suffix}.ts`) && !exclude.includes(f))
    .map(f => {
      const name = f.replace('.ts', '');
      const filePath = path.join(fullDir, f);
      const content = fs.readFileSync(filePath, 'utf-8');
      const match = content.match(/description\s*=\s*(['"`])(.*?)\1/);
      const description = match ? match[2] : undefined;
      return { name, value: name, description };
    });
}

async function getAvailableServices(): Promise<DiscoveredModule[]> {
  return discover('src/services', 'Service', ['InboundService.ts']);
}

async function getAvailableActions(): Promise<DiscoveredModule[]> {
  return discover('src/actions', 'Action', ['Action.ts', 'ActionDispatcher.ts']);
}

async function getAvailableJobs(): Promise<DiscoveredModule[]> {
  return discover('src/jobs', 'Job', ['Job.ts']);
}

async function getAvailableHooks(): Promise<DiscoveredModule[]> {
  return discover('src/hooks', 'Hook', ['Hook.ts', 'HookDispatcher.ts']);
}

async function ensureTeamJson(): Promise<void> {
  if (fs.existsSync(TEAM_JSON_PATH)) {
    console.log(`\n✓ team.json already exists at src/config/team.json`);
    console.log('  (A richer Baileys-aware setup that lists your groups + members ships next.)');
    return;
  }
  if (!fs.existsSync(TEAM_EXAMPLE_PATH)) {
    console.warn('\n⚠ team.example.json missing; skipping team config bootstrap.');
    return;
  }
  const create = await confirm({
    message: 'No src/config/team.json found. Create one from team.example.json?',
    default: true
  });
  if (create) {
    fs.copyFileSync(TEAM_EXAMPLE_PATH, TEAM_JSON_PATH);
    console.log(`\n✓ Created ${TEAM_JSON_PATH}`);
    console.log('  Edit it manually for now — replace the placeholder JIDs with real ones.');
    console.log('  (Tip: run `npm start` once, send a message in each target chat, copy the logged remoteJid.)');
  }
}

async function run() {
  console.log('--- Configuration Setup ---\n');

  const currentEnv = parseEnvFile(ENV_PATH);
  const exampleEnv = parseEnvFile(ENV_EXAMPLE_PATH);
  const newEnv: Record<string, string> = { ...currentEnv };

  // 1. Generic env vars (skipping ones handled by dedicated checkbox flows)
  for (const envVar of ENV_VARIABLES) {
    if (SKIP_IN_ENV_LOOP.has(envVar.key)) continue;
    const defaultVal = currentEnv[envVar.key] || exampleEnv[envVar.key] || envVar.default || '';
    const description = envVar.description ? `\n   ℹ️  ${envVar.description}` : '';
    const promptOpts = {
      message: `Enter value for ${envVar.key}:${description}\n  >`,
      default: defaultVal,
    };
    const answer = envVar.secret
      ? await password({ message: promptOpts.message, mask: '*' })
      : await input(promptOpts);
    // Preserve existing secret if user just hits enter on empty prompt.
    newEnv[envVar.key] = (envVar.secret && !answer) ? (currentEnv[envVar.key] || '') : answer;
  }

  // 2. Inbound service
  const services = await getAvailableServices();
  if (services.length > 0) {
    const defaultService = currentEnv['INBOUND_SERVICE'] || services[0].value;
    newEnv['INBOUND_SERVICE'] = await select({
      message: 'Select the inbound service:',
      choices: services,
      default: defaultService
    });
  }

  // 3. Actions
  const actions = await getAvailableActions();
  if (actions.length > 0) {
    const currentActions = (currentEnv['ENABLED_ACTIONS'] || '').split(',').map(s => s.trim()).filter(Boolean);
    const selected = await checkbox({
      message: 'Select actions to enable (mention-triggered commands):',
      choices: actions.map(a => ({ ...a, checked: currentActions.includes(a.value) }))
    });
    newEnv['ENABLED_ACTIONS'] = selected.join(',');
  }

  // 4. Hooks
  const hooks = await getAvailableHooks();
  if (hooks.length > 0) {
    const currentHooks = (currentEnv['ENABLED_HOOKS'] || 'PersistMessageHook').split(',').map(s => s.trim()).filter(Boolean);
    const selected = await checkbox({
      message: 'Select hooks to enable (passive per-message side-effects):',
      choices: hooks.map(h => ({ ...h, checked: currentHooks.includes(h.value) }))
    });
    newEnv['ENABLED_HOOKS'] = selected.join(',');
  }

  // 5. Jobs
  const jobs = await getAvailableJobs();
  if (jobs.length > 0) {
    const currentJobs = (currentEnv['ENABLED_JOBS'] || 'PruneMessagesJob').split(',').map(s => s.trim()).filter(Boolean);
    const selected = await checkbox({
      message: 'Select jobs to enable (cron-driven units):',
      choices: jobs.map(j => ({ ...j, checked: currentJobs.includes(j.value) }))
    });
    newEnv['ENABLED_JOBS'] = selected.join(',');
  }

  // 6. team.json bootstrap
  await ensureTeamJson();

  // Write .env (preserves order: ENV_VARIABLES first, then INBOUND_SERVICE / ENABLED_*).
  const orderedKeys = [
    ...ENV_VARIABLES.filter(e => !SKIP_IN_ENV_LOOP.has(e.key)).map(e => e.key),
    'INBOUND_SERVICE',
    'ENABLED_ACTIONS',
    'ENABLED_HOOKS',
    'ENABLED_JOBS',
  ];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const k of orderedKeys) {
    if (!(k in newEnv)) continue;
    lines.push(`${k}=${newEnv[k]}`);
    seen.add(k);
  }
  // Preserve any extra keys we don't know about (e.g., manually set DEBUG).
  for (const [k, v] of Object.entries(newEnv)) {
    if (!seen.has(k)) lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf-8');
  console.log('\n✅ Saved configuration to .env');
}

run().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});

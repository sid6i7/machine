import fs from 'fs';
import path from 'path';
import { input, select, checkbox } from '@inquirer/prompts';
import { fileURLToPath } from 'url';
import { ENV_VARIABLES } from './config/env-vars.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, '.env.example');

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

async function getAvailableServices(): Promise<{ name: string, value: string }[]> {
  const servicesDir = path.join(PROJECT_ROOT, 'src/services');
  if (!fs.existsSync(servicesDir)) return [];
  const files = fs.readdirSync(servicesDir);
  return files
    .filter(f => f.endsWith('Service.ts') && f !== 'InboundService.ts')
    .map(f => {
      const name = f.replace('.ts', '');
      return { name, value: name };
    });
}

async function getAvailableActions(): Promise<{ name: string, value: string, description?: string }[]> {
  const actionsDir = path.join(PROJECT_ROOT, 'src/actions');
  if (!fs.existsSync(actionsDir)) return [];
  const files = fs.readdirSync(actionsDir);
  return files
    .filter(f => f.endsWith('Action.ts') && f !== 'Action.ts')
    .map(f => {
      const name = f.replace('.ts', '');
      const filePath = path.join(actionsDir, f);
      const content = fs.readFileSync(filePath, 'utf-8');
      const match = content.match(/description\s*=\s*(['"`])(.*?)\1/);
      const description = match ? match[2] : undefined;
      return { name, value: name, description };
    });
}

async function run() {
  console.log('--- Configuration Setup ---\n');

  const currentEnv = parseEnvFile(ENV_PATH);
  const exampleEnv = parseEnvFile(ENV_EXAMPLE_PATH);
  const newEnv: Record<string, string> = {};

  // 1. Ask for basic config variables from config constant
  for (const envVar of ENV_VARIABLES) {
    const defaultVal = currentEnv[envVar.key] || exampleEnv[envVar.key] || envVar.default || '';
    const description = envVar.description ? `\n   ℹ️  ${envVar.description}` : '';
    const answer = await input({
      message: `Enter value for ${envVar.key}:${description}\n  >`,
      default: defaultVal,
    });
    newEnv[envVar.key] = answer;
  }

  // 2. Ask for inbound service
  const services = await getAvailableServices();
  if (services.length > 0) {
    const defaultService = currentEnv['INBOUND_SERVICE'] || services[0].value;
    const selectedService = await select({
      message: 'Select the inbound service to use:',
      choices: services,
      default: defaultService
    });
    newEnv['INBOUND_SERVICE'] = selectedService;
  } else {
    console.warn('No inbound services found in src/services/.');
  }

  // 3. Ask for actions to enable
  const actions = await getAvailableActions();
  if (actions.length > 0) {
    const currentActions = (currentEnv['ENABLED_ACTIONS'] || '').split(',').map(s => s.trim()).filter(Boolean);
    const selectedActions = await checkbox({
      message: 'Select which actions should be enabled:',
      choices: actions.map(a => ({
        ...a,
        checked: currentActions.includes(a.value)
      }))
    });
    newEnv['ENABLED_ACTIONS'] = selectedActions.join(',');
  } else {
    console.warn('No actions found in src/actions/.');
  }

  // Write to .env
  const envContent = Object.entries(newEnv)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  
  fs.writeFileSync(ENV_PATH, envContent + '\n', 'utf-8');
  console.log('\n✅ Successfully saved configuration to .env');
}

run().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});

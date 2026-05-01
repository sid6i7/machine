import { logger } from '../utils/logger.js';
import type { Hook, HookContext } from './Hook.js';
import type { JobContext } from '../jobs/Job.js';
import type { InboundMessage } from '../services/InboundService.js';

export class HookDispatcher {
  private hooks: Hook[] = [];

  constructor(private baseCtx: JobContext) {}

  // Discover and instantiate hooks listed in ENABLED_HOOKS env. Same dynamic-
  // import pattern as ActionDispatcher.
  async loadEnabled(): Promise<void> {
    const enabled = (process.env.ENABLED_HOOKS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    for (const name of enabled) {
      try {
        const module = await import(`./${name}.js`);
        const HookClass = module[name];
        if (!HookClass) {
          logger.error({ name }, 'Hook class not found in module');
          continue;
        }
        const instance: Hook = new HookClass();
        this.hooks.push(instance);
        logger.info({ name: instance.name }, 'Loaded hook');
      } catch (err) {
        logger.error({ err, name }, 'Failed to load hook');
      }
    }
  }

  // Run all matching hooks in parallel. Errors are caught + logged per hook;
  // never propagated. The caller (index.ts) does NOT await this.
  async run(message: InboundMessage): Promise<void> {
    if (this.hooks.length === 0) return;
    const ctx: HookContext = { ...this.baseCtx, message };

    const tasks = this.hooks
      .filter(h => {
        try { return h.appliesTo(ctx); }
        catch (err) {
          logger.error({ err, hook: h.name }, 'Hook.appliesTo threw; skipping');
          return false;
        }
      })
      .map(async h => {
        try {
          await h.handle(ctx);
        } catch (err) {
          logger.error({ err, hook: h.name, msgId: message.id }, 'Hook.handle threw');
        }
      });

    await Promise.allSettled(tasks);
  }

  list(): Hook[] {
    return this.hooks.slice();
  }
}

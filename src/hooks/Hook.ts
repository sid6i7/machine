import type { InboundMessage } from '../services/InboundService.js';
import type { JobContext } from '../jobs/Job.js';

// Hooks see the same shared services as jobs, plus the message that fired them.
export interface HookContext extends JobContext {
  message: InboundMessage;
}

export interface Hook {
  name: string;
  description?: string;
  // Cheap, synchronous gate. Run for every inbound message; keep it fast.
  appliesTo(ctx: HookContext): boolean;
  // Fire-and-forget side effects. Errors are caught and logged by HookDispatcher;
  // never re-thrown. Hooks must not block action dispatch.
  handle(ctx: HookContext): Promise<void>;
}

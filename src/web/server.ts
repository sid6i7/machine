import Fastify, { type FastifyInstance } from 'fastify';
import basicAuth from '@fastify/basic-auth';
import formbody from '@fastify/formbody';
import { logger } from '../utils/logger.js';
import { registerRoutes } from './routes.js';
import type { JobContext } from '../jobs/Job.js';

export async function startWebServer(ctx: JobContext): Promise<FastifyInstance> {
  const port = Number(process.env.WEB_PORT || '7777');
  const host = process.env.WEB_HOST || '127.0.0.1';
  const user = process.env.WEB_USER || '';
  const pass = process.env.WEB_PASS || '';

  const app = Fastify({ logger: false });

  // HTMX posts form-encoded bodies; without this Fastify returns 415 on
  // approve / skip / pin / unpin / save endpoints.
  await app.register(formbody);

  if (user && pass) {
    await app.register(basicAuth, {
      validate: async (username, password, _req, _reply) => {
        if (username !== user || password !== pass) {
          throw new Error('Unauthorized');
        }
      },
      authenticate: { realm: 'machine' }
    });
    app.addHook('onRequest', app.basicAuth);
  } else {
    logger.warn({}, 'web: no WEB_USER/WEB_PASS set — running without auth (localhost only)');
  }

  registerRoutes(app, ctx);

  await app.listen({ port, host });
  logger.info({ host, port, auth: !!(user && pass) }, 'web: server listening');
  return app;
}

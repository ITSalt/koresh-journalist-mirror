import type { FastifyInstance } from 'fastify';
import { isConnectPlatform, type ConnectService } from '../connect/service.js';

/**
 * The director's connect routes (WP-PLAT-06). Registered inside the bearer scope of
 * `registerDirectorApi`, so each needs the token and is reachable on 127.0.0.1 only.
 * No answer of these routes ever holds a token, a code, an app secret or the store key; the
 * `url` of `start` holds the one-time state, which is what the owner's link is made of.
 */
export function registerConnectRoutes(api: FastifyInstance, connect: ConnectService): void {
  api.get('/v1/connect', async () => connect.overview());

  // No body and no query is read: the scopes and the redirect address are fixed by the service.
  api.post<{ Params: { platform: string } }>('/v1/connect/:platform/start', async (req, reply) => {
    const { platform } = req.params;
    if (!isConnectPlatform(platform)) return reply.code(404).send({ error: 'unknown platform' });
    const started = connect.start(platform);
    if (!started.ok) {
      return reply
        .code(409)
        .send({ error: `${platform} connect is not configured`, missing: started.missing });
    }
    return { url: started.url, expiresAt: started.expiresAt };
  });

  api.delete<{ Params: { platform: string } }>('/v1/connect/:platform', async (req, reply) => {
    const { platform } = req.params;
    if (!isConnectPlatform(platform)) return reply.code(404).send({ error: 'unknown platform' });
    // Idempotent: 200 with `disconnected: false` when nothing was stored.
    return { platform, ...connect.disconnect(platform) };
  });
}

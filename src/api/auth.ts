import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface AuthOptions {
  /** The expected bearer token; when absent every request is refused (fail closed). */
  token: string | undefined;
  /** Failures allowed per client in one window before it is blocked. */
  maxFailures?: number;
  windowMs?: number;
  now?: () => number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Constant-time comparison: both sides are hashed to equal length first. */
export function tokenMatches(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

/** Extracts the token of an `Authorization: Bearer <token>` header, or undefined. */
export function bearerOf(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer +(\S+)$/i.exec(header.trim());
  return m?.[1];
}

/**
 * Returns a Fastify onRequest hook: 401 without a valid bearer token, 429 for a client without a
 * valid token once it has produced `maxFailures` failures inside `windowMs`. A valid token always
 * passes, so local noise cannot lock the director out. Nothing here logs a token.
 */
export function bearerAuth(opts: AuthOptions) {
  const max = opts.maxFailures ?? 10;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const failures = new Map<string, number[]>();

  const recent = (ip: string): number[] => {
    const cutoff = now() - windowMs;
    const list = (failures.get(ip) ?? []).filter((t) => t > cutoff);
    if (list.length > 0) failures.set(ip, list);
    else failures.delete(ip);
    return list;
  };

  return async function authenticate(req: FastifyRequest, reply: FastifyReply) {
    const given = bearerOf(req.headers.authorization);
    const ok = opts.token !== undefined && given !== undefined && tokenMatches(given, opts.token);
    // A correct token is never locked out (behind the docker port mapping all callers share one IP).
    if (ok) return;
    const list = recent(req.ip);
    const locked = list.length >= max;
    const retry = Math.max(1, Math.ceil(((list[0] ?? 0) + windowMs - now()) / 1000));
    // Failures keep being counted (the newest `max` are kept, so the lock slides with attacks).
    failures.set(req.ip, [...list, now()].slice(-max));
    if (locked) {
      return reply
        .code(429)
        .header('retry-after', String(retry))
        .send({ error: 'too many failed attempts' });
    }
    return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized' });
  };
}

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { Config } from './config.js';
import { detectMimeType } from './magic-number.js';
import type { Storage } from './storage.js';
import { ID_REGEX } from './storage.js';
import { RateLimiter } from './rate-limit.js';

export interface ServerOptions {
  config: Config;
  storage: Storage;
  port: number;
  host?: string;
  maxFileSize?: number;
  publicBaseUrl?: () => string | null;
}

export interface RunningServer {
  port: number;
  host: string;
  close: () => Promise<void>;
}

const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;

export function buildApp(opts: ServerOptions): Hono {
  const app = new Hono();
  const uploadLimiter = new RateLimiter({ limit: 60, windowMs: HOUR_MS });
  const getLimiter = new RateLimiter({ limit: 500, windowMs: HOUR_MS });
  const maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

  app.get('/health', (c) => c.json({ ok: true, entries: opts.storage.stats().entries }));

  app.post('/upload', async (c) => {
    const key = c.req.header('X-Api-Key');
    if (!key || key !== opts.config.apiKey) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const rl = uploadLimiter.check(key);
    if (!rl.allowed) {
      return c.json({ error: 'rate_limited', resetAt: rl.resetAt }, 429);
    }

    let body;
    try {
      body = await c.req.parseBody();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }

    const file = body['file'];
    if (!(file instanceof File)) {
      return c.json({ error: 'missing_file' }, 400);
    }
    if (file.size > maxFileSize) {
      return c.json({ error: 'file_too_large', max: maxFileSize }, 413);
    }

    const buf = new Uint8Array(await file.arrayBuffer());
    const mime = detectMimeType(buf);
    if (!mime) {
      return c.json({ error: 'unsupported_type' }, 415);
    }

    const { entry, deduped } = await opts.storage.store(buf, mime);
    const base = opts.publicBaseUrl?.() ?? null;
    const url = base ? `${base}/f/${entry.id}` : `/f/${entry.id}`;

    return c.json({
      id: entry.id,
      url,
      mimeType: entry.mimeType,
      size: entry.size,
      expiresAt: entry.expiresAt,
      deduped,
    });
  });

  app.get('/f/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID_REGEX.test(id)) {
      return c.json({ error: 'invalid_id' }, 400);
    }

    const ipKey =
      c.req.header('cf-connecting-ip') ??
      c.req.header('x-forwarded-for') ??
      'anon';
    const rl = getLimiter.check(`get:${ipKey}`);
    if (!rl.allowed) {
      return c.json({ error: 'rate_limited', resetAt: rl.resetAt }, 429);
    }

    const result = await opts.storage.get(id);
    if (!result) {
      return c.json({ error: 'not_found' }, 404);
    }

    return new Response(result.buf, {
      headers: {
        'Content-Type': result.entry.mimeType,
        'Content-Length': String(result.entry.size),
        'Cache-Control': 'private, max-age=300',
      },
    });
  });

  return app;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const app = buildApp(opts);
  const host = opts.host ?? '127.0.0.1';

  return new Promise<RunningServer>((resolve) => {
    const server = serve(
      { fetch: app.fetch, hostname: host, port: opts.port },
      (info) => {
        resolve({
          port: info.port,
          host,
          close: () =>
            new Promise<void>((done, reject) => {
              server.close((err) => (err ? reject(err) : done()));
            }),
        });
      },
    );
  });
}

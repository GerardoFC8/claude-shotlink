import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, startServer } from './server.js';
import { Storage } from './storage.js';
import type { Config } from './config.js';

const API_KEY = 'sk_test_key_123';
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0x99, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x5b, 0x8e, 0x9e,
  0x6e, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

async function buildTestApp() {
  const dir = await mkdtemp(join(tmpdir(), 'shotlink-test-'));
  const config: Config = {
    apiKey: API_KEY,
    createdAt: new Date().toISOString(),
  };
  const storage = new Storage({ dir, ttlMs: 60_000 });
  await storage.init();
  const app = buildApp({ config, storage, port: 0 });
  const cleanup = async (): Promise<void> => {
    await storage.shutdown();
    await rm(dir, { recursive: true, force: true });
  };
  return { app, storage, cleanup };
}

describe('server', () => {
  let harness: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    harness = await buildTestApp();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('GET /health returns ok', async () => {
    const res = await harness.app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('POST /upload rejects requests without API key', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'x.png');
    const res = await harness.app.request('/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(401);
  });

  it('POST /upload rejects requests with wrong API key', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'x.png');
    const res = await harness.app.request('/upload', {
      method: 'POST',
      headers: { 'X-Api-Key': 'nope' },
      body: fd,
    });
    expect(res.status).toBe(401);
  });

  it('POST /upload rejects non-image content via magic number', async () => {
    const fd = new FormData();
    const fakePng = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
    fd.append('file', new Blob([fakePng], { type: 'image/png' }), 'x.png');
    const res = await harness.app.request('/upload', {
      method: 'POST',
      headers: { 'X-Api-Key': API_KEY },
      body: fd,
    });
    expect(res.status).toBe(415);
  });

  it('POST /upload stores a valid PNG and returns an id', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'x.png');
    const res = await harness.app.request('/upload', {
      method: 'POST',
      headers: { 'X-Api-Key': API_KEY },
      body: fd,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; url: string; mimeType: string; size: number };
    expect(body.mimeType).toBe('image/png');
    expect(body.size).toBe(PNG_BYTES.byteLength);
    expect(body.id).toMatch(/^[a-zA-Z0-9]{16}$/);
    expect(body.url).toBe(`/f/${body.id}`);
  });

  it('GET /f/:id returns 400 for malformed id', async () => {
    const res = await harness.app.request('/f/invalid');
    expect(res.status).toBe(400);
  });

  it('GET /f/:id returns 404 for unknown id', async () => {
    const res = await harness.app.request('/f/aaaaaaaaaaaaaaaa');
    expect(res.status).toBe(404);
  });

  it('GET /f/:id returns the stored image', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'x.png');
    const upload = await harness.app.request('/upload', {
      method: 'POST',
      headers: { 'X-Api-Key': API_KEY },
      body: fd,
    });
    const { id } = (await upload.json()) as { id: string };

    const res = await harness.app.request(`/f/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.byteLength).toBe(PNG_BYTES.byteLength);
  });

  it('POST /upload deduplicates identical content', async () => {
    const upload = async () => {
      const fd = new FormData();
      fd.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'x.png');
      const res = await harness.app.request('/upload', {
        method: 'POST',
        headers: { 'X-Api-Key': API_KEY },
        body: fd,
      });
      return (await res.json()) as { id: string; deduped: boolean };
    };
    const first = await upload();
    const second = await upload();
    expect(second.id).toBe(first.id);
    expect(second.deduped).toBe(true);
  });
});

// ── publicBaseUrl regression tests (SPEC-UPL-02, SPEC-UPL-03, SPEC-SEC-01) ───

const UPLOAD_PNG_BYTES = PNG_BYTES;

async function buildTestAppWithPublicBaseUrl(publicBaseUrl?: () => string | null) {
  const dir = await mkdtemp(join(tmpdir(), 'shotlink-url-test-'));
  const config: Config = { apiKey: API_KEY, createdAt: new Date().toISOString() };
  const storage = new Storage({ dir, ttlMs: 60_000 });
  await storage.init();
  const app = buildApp({ config, storage, port: 0, publicBaseUrl });
  const cleanup = async (): Promise<void> => {
    await storage.shutdown();
    await rm(dir, { recursive: true, force: true });
  };
  return { app, cleanup };
}

describe('server publicBaseUrl scenarios', () => {
  it('UPL-A: url is fully qualified when publicBaseUrl returns a tunnel URL', async () => {
    const { app, cleanup } = await buildTestAppWithPublicBaseUrl(
      () => 'https://xyz.trycloudflare.com'
    );
    try {
      const fd = new FormData();
      fd.append('file', new Blob([UPLOAD_PNG_BYTES], { type: 'image/png' }), 'x.png');
      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'X-Api-Key': API_KEY },
        body: fd,
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { id: string; url: string };
      expect(body.url).toMatch(/^https:\/\/xyz\.trycloudflare\.com\/f\/[a-zA-Z0-9]+$/);
    } finally {
      await cleanup();
    }
  });

  it('UPL-B: url is relative when publicBaseUrl returns null', async () => {
    const { app, cleanup } = await buildTestAppWithPublicBaseUrl(() => null);
    try {
      const fd = new FormData();
      fd.append('file', new Blob([UPLOAD_PNG_BYTES], { type: 'image/png' }), 'x.png');
      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'X-Api-Key': API_KEY },
        body: fd,
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { url: string };
      expect(body.url).toMatch(/^\/f\/[a-zA-Z0-9]+$/);
    } finally {
      await cleanup();
    }
  });

  it('SEC-B: startServer uses 127.0.0.1 when host option is not provided (loopback default)', async () => {
    // Verify the host default: startServer without explicit host binds to 127.0.0.1
    const dir = await mkdtemp(join(tmpdir(), 'shotlink-sec-test-'));
    const config: Config = { apiKey: API_KEY, createdAt: new Date().toISOString() };
    const storage = new Storage({ dir, ttlMs: 60_000 });
    await storage.init();

    const server = await startServer({ config, storage, port: 0 });
    try {
      expect(server.host).toBe('127.0.0.1');
    } finally {
      await server.close();
      await storage.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── FIX-7: Hard Invariant #4 — rate limit + size cap server-level tests ──────

describe('server — FIX-7: rate limit and size cap wiring', () => {
  let harness: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    harness = await buildTestApp();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('FIX-7a: 61st upload in same window returns 429 with rate_limited error', async () => {
    // Upload 60 valid PNGs — all should be 200
    for (let i = 0; i < 60; i++) {
      const fd = new FormData();
      fd.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'x.png');
      const res = await harness.app.request('/upload', {
        method: 'POST',
        headers: { 'X-Api-Key': API_KEY },
        body: fd,
      });
      expect(res.status).toBe(200);
    }

    // 61st must be rate-limited
    const fd = new FormData();
    fd.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'x.png');
    const res = await harness.app.request('/upload', {
      method: 'POST',
      headers: { 'X-Api-Key': API_KEY },
      body: fd,
    });
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string; resetAt: number };
    expect(body.error).toBe('rate_limited');
    expect(typeof body.resetAt).toBe('number');
  });

  it('FIX-7b: upload of 5MB+1 byte returns 413 with file_too_large error', async () => {
    // Create a blob with a valid PNG header but 5MB+1 bytes total
    const MAX = 5 * 1024 * 1024;
    const oversized = new Uint8Array(MAX + 1);
    // Put PNG magic bytes at the start so it passes the magic-number check (but size check comes first)
    oversized.set(PNG_BYTES.slice(0, 8), 0);

    const fd = new FormData();
    fd.append('file', new Blob([oversized], { type: 'image/png' }), 'big.png');
    const res = await harness.app.request('/upload', {
      method: 'POST',
      headers: { 'X-Api-Key': API_KEY },
      body: fd,
    });
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string; max: number };
    expect(body.error).toBe('file_too_large');
    expect(body.max).toBe(MAX);
  });
});

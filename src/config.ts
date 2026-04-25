import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeAtomic } from './atomic-write.js';

/**
 * On-disk config file at ~/.claude-shotlink/config.json.
 *
 * v0.2 additions are all OPTIONAL — pre-existing v0.1 files (with only
 * apiKey + createdAt) parse correctly. Missing tunnel fields default to
 * "quick mode" at runtime.
 */
export interface Config {
  /** API key used to authenticate /upload requests. v0.1.0+. */
  apiKey: string;
  /** ISO 8601 timestamp of when the config was first created. v0.1.0+. */
  createdAt: string;

  // ── v0.2 additions (all optional, additive) ──────────────────────────────

  /**
   * Tunnel mode. Absent → defaults to 'quick'.
   * - 'quick': cloudflared spawns a try-cloudflare anonymous tunnel.
   * - 'named': cloudflared runs a pre-created named tunnel by name.
   */
  tunnelMode?: 'quick' | 'named';

  /**
   * Cloudflare tunnel name (required when tunnelMode === 'named').
   * Must already exist in the user's Cloudflare account
   * (created via `cloudflared tunnel create <name>`).
   */
  tunnelName?: string;

  /**
   * Public hostname for the named tunnel (required when tunnelMode === 'named').
   * The user is responsible for the DNS CNAME pointing this hostname at the
   * tunnel. Validated as a host-shaped string (no scheme, no path).
   */
  tunnelHostname?: string;

  // ── v0.3 additions (all optional, additive) ──────────────────────────────

  /**
   * Absolute path to cloudflared credentials JSON file (UUID-keyed).
   * Written by `setup-tunnel`; absence preserves v0.2 spawn behavior
   * (cloudflared reads ~/.cloudflared/config.yml).
   * Must be an absolute path starting with '/'.
   */
  tunnelCredentialsFile?: string;

  /**
   * Local port the named tunnel proxies to. Used as the default port when
   * `start` is run without --port. Must be an integer in [1, 65535].
   * Default 7331.
   */
  tunnelLocalPort?: number;
}

export const CONFIG_DIR = join(homedir(), '.claude-shotlink');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/** Allowed top-level keys in the config file. */
const ALLOWED_KEYS = new Set<string>([
  'apiKey',
  'createdAt',
  'tunnelMode',
  'tunnelName',
  'tunnelHostname',
  'tunnelCredentialsFile',
  'tunnelLocalPort',
]);

/**
 * Hostname shape: no scheme, no path — e.g. "shots.example.com".
 * Must be at least two dot-separated labels.
 * Exported for reuse in CLI flag validation (FIX-3, FIX-8).
 */
export const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/**
 * Validates the parsed config object shape. Throws descriptive errors on
 * invalid shape, unknown fields, or invalid field values.
 *
 * @throws {Error} on any validation failure
 */
function validateConfigShape(parsed: unknown): asserts parsed is Config {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Config root must be a JSON object.');
  }
  const v = parsed as Record<string, unknown>;

  // Reject unknown keys (fail-fast policy)
  for (const k of Object.keys(v)) {
    if (!ALLOWED_KEYS.has(k)) {
      throw new Error(`Unknown field in config: ${k}.`);
    }
  }

  // Required fields
  if (typeof v['apiKey'] !== 'string' || v['apiKey'] === '') {
    throw new Error('Config field apiKey is missing or empty.');
  }
  if (typeof v['createdAt'] !== 'string' || v['createdAt'] === '') {
    throw new Error('Config field createdAt is missing or empty.');
  }

  // Optional v0.2 fields
  if ('tunnelMode' in v && v['tunnelMode'] !== 'quick' && v['tunnelMode'] !== 'named') {
    throw new Error(`Invalid tunnelMode in config: expected 'quick' or 'named'.`);
  }
  if ('tunnelName' in v && (typeof v['tunnelName'] !== 'string' || v['tunnelName'] === '')) {
    throw new Error('Config field tunnelName must be a non-empty string.');
  }
  if ('tunnelHostname' in v) {
    if (typeof v['tunnelHostname'] !== 'string' || v['tunnelHostname'] === '') {
      throw new Error('Config field tunnelHostname must be a non-empty string.');
    }
    if (!HOSTNAME_RE.test(v['tunnelHostname'])) {
      throw new Error(
        `Config field tunnelHostname has invalid shape: "${v['tunnelHostname']}" — expected a bare hostname (no scheme, no path).`,
      );
    }
  }

  // v0.3 optional fields
  if ('tunnelCredentialsFile' in v) {
    if (typeof v['tunnelCredentialsFile'] !== 'string' || v['tunnelCredentialsFile'] === '') {
      throw new Error('Config field tunnelCredentialsFile must be a non-empty string.');
    }
    if (!v['tunnelCredentialsFile'].startsWith('/')) {
      throw new Error('Config field tunnelCredentialsFile must be an absolute path.');
    }
  }
  if ('tunnelLocalPort' in v) {
    const p = v['tunnelLocalPort'];
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error('Config field tunnelLocalPort must be an integer between 1 and 65535.');
    }
  }

  // FIX-1: Co-constraint — when tunnelMode is 'named', tunnelCredentialsFile and
  // tunnelLocalPort must BOTH be set or BOTH be absent.  A partial pair means the
  // config was hand-edited incorrectly and the spawn path would silently fall back
  // to a different (legacy) code path, hiding the misconfiguration.
  if (v['tunnelMode'] === 'named') {
    const hasCredsFile = 'tunnelCredentialsFile' in v;
    const hasLocalPort = 'tunnelLocalPort' in v;
    if (hasCredsFile !== hasLocalPort) {
      throw new Error(
        'tunnelCredentialsFile and tunnelLocalPort must be both set together when tunnelMode is \'named\' and credentials-file mode is used. ' +
        'Set both, or remove both to use legacy ~/.cloudflared/config.yml.',
      );
    }
  }
}

export async function ensureConfig(): Promise<Config> {
  if (existsSync(CONFIG_PATH)) {
    return loadConfig();
  }
  const config: Config = {
    apiKey: generateApiKey(),
    createdAt: new Date().toISOString(),
  };
  await saveConfig(config);
  return config;
}

export async function loadConfig(): Promise<Config> {
  return loadConfigFrom(CONFIG_PATH);
}

/**
 * Load config from an explicit path — useful for testing without
 * resetting module state.
 */
export async function loadConfigFrom(path: string): Promise<Config> {
  const raw = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse config file at ${path}: invalid JSON.`);
  }
  validateConfigShape(parsed);
  return parsed;
}

/**
 * Atomically write config to disk at mode 0o600.
 *
 * @param config  The Config object to persist.
 * @param path    Optional explicit path (defaults to CONFIG_PATH). Used in tests.
 */
export async function saveConfig(config: Config, path: string = CONFIG_PATH): Promise<void> {
  await writeAtomic(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function rotateApiKey(): Promise<Config> {
  const existing = await loadConfig();
  const updated: Config = { ...existing, apiKey: generateApiKey() };
  await saveConfig(updated);
  return updated;
}

export function generateApiKey(): string {
  return 'sk_' + randomBytes(32).toString('hex');
}

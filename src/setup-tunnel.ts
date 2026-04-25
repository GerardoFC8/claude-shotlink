/**
 * setup-tunnel.ts
 *
 * Orchestration module for the `setup-tunnel` wizard subcommand (CA-1).
 *
 * This module is pure domain logic: it shells out to cloudflared,
 * parses the results, and writes config. No CLI flag parsing lives here.
 * All side-effectful operations are injected via `SetupTunnelDeps` so
 * unit tests can run without a real cloudflared binary.
 *
 * Sequence (see design §3.1):
 *  1. assertCertExists — preflight check
 *  2. spawnCreate      — cloudflared tunnel create --output json <name>
 *  3. resolveCredentialsFile — prefer JSON field, fall back to <uuid>.json path
 *  4. spawnRouteDns    — cloudflared tunnel route dns <name> <hostname> (unless skipDns)
 *  5. mergeConfig + saveConfig
 *  6. return SetupTunnelResult
 */
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

import type { Config } from './config.js';
import { HOSTNAME_RE } from './config.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface SetupTunnelDeps {
  /** Absolute path to the cloudflared binary. */
  binaryPath: string;
  /** Directory that cloudflared stores certs and credentials in. Default: ~/.cloudflared */
  cloudflaredHome: string;
  /** Absolute path to the claude-shotlink config file. */
  configPath: string;
  /** Load (or create) the current config. */
  ensureConfig: () => Promise<Config>;
  /** Atomically persist config to disk. */
  saveConfig: (c: Config) => Promise<void>;
  /**
   * Spawn implementation (injected for tests).
   * Matches the signature used by node:child_process.spawn.
   */
  spawnImpl: (
    cmd: string,
    args: string[],
    opts: { stdio: ['ignore', 'pipe', 'pipe'] }
  ) => ChildProcess;
  /**
   * Synchronous file-existence check (injected for tests).
   * Default: fs.existsSync.
   */
  fileExists: (p: string) => boolean;
  /**
   * Read a file as UTF-8 string (injected for tests).
   * Default: fs/promises.readFile(p, 'utf8').
   */
  readFileUtf8: (p: string) => Promise<string>;
  /**
   * List directory entries (injected for tests).
   * Default: fs/promises.readdir(dir).
   */
  readdirImpl?: (dir: string) => Promise<string[]>;
}

export interface SetupTunnelInput {
  /** Cloudflare tunnel name (--name flag). */
  name: string;
  /** Public hostname to route to the tunnel (--hostname flag). */
  hostname: string;
  /** Local port the tunnel proxies to (--port flag, default 7331). */
  port: number;
  /** Skip `cloudflared tunnel route dns` spawn when true. */
  skipDns: boolean;
}

export type SetupTunnelResult =
  | {
      ok: true;
      uuid: string;
      credentialsFile: string;
      dnsRouted: boolean;
      dnsManualCommand?: string;
    }
  | {
      ok: false;
      reason:
        | 'invalid-hostname'
        | 'missing-cert'
        | 'create-failed'
        | 'parse-failed'
        | 'creds-not-found'
        | 'route-failed'
        | 'tunnel-exists-no-creds';
      message: string;
      recoveryHint?: string;
    };

// ── Internal helpers ──────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TunnelCreateJson {
  id: string;
  name: string;
  credentials_file?: string;
  [key: string]: unknown;
}

interface CloudflaredCredentialFile {
  TunnelID?: string;
  TunnelName?: string;
  [key: string]: unknown;
}

/**
 * Parse the JSON output from `cloudflared tunnel create --output json`.
 *
 * cloudflared occasionally emits log lines before the JSON — find the first `{`.
 * Throws on parse failure; caller maps the error to 'parse-failed'.
 */
export function parseTunnelCreateOutput(stdout: string): { uuid: string; credentialsFile?: string } {
  const trimmed = stdout.trim();
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart < 0) {
    throw new Error('cloudflared tunnel create: no JSON in output');
  }
  const jsonText = trimmed.slice(jsonStart);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`cloudflared tunnel create: invalid JSON: ${jsonText.slice(0, 200)}`);
  }
  const obj = parsed as Partial<TunnelCreateJson>;
  if (typeof obj.id !== 'string' || !UUID_RE.test(obj.id)) {
    throw new Error('cloudflared tunnel create: missing/invalid id field');
  }
  const credentialsFile =
    typeof obj.credentials_file === 'string' ? obj.credentials_file : undefined;
  return { uuid: obj.id, credentialsFile };
}

/**
 * Find an existing tunnel by name using `cloudflared tunnel list --output json`,
 * then verify the credentials file at `<UUID>.json` exists in cloudflared home.
 *
 * v0.3.1 replaces the v0.3.0 approach of scanning credentials JSON files for a
 * `TunnelName` field — that field doesn't exist in real cloudflared credentials
 * (which only contain TunnelID, TunnelSecret, AccountTag, Endpoint). The old
 * approach broke idempotency for every real user.
 *
 * Returns the credentials path + UUID if found and the file exists; null otherwise.
 */
async function findExistingTunnelByName(
  name: string,
  cloudflaredHome: string,
  binaryPath: string,
  spawnImpl: SetupTunnelDeps['spawnImpl'],
  fileExists: (p: string) => boolean,
): Promise<{ uuid: string; credentialsFilePath: string } | null> {
  const result = await runCommand(spawnImpl, binaryPath, ['tunnel', 'list', '--output', 'json']);
  if (result.code !== 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    if (obj['name'] !== name) continue;
    const id = obj['id'];
    if (typeof id !== 'string' || !UUID_RE.test(id)) continue;

    const credentialsFilePath = join(cloudflaredHome, `${id}.json`);
    if (!fileExists(credentialsFilePath)) return null;
    return { uuid: id, credentialsFilePath };
  }
  return null;
}

/** Run a command and collect { code, stdout, stderr }. */
function runCommand(
  spawnImpl: SetupTunnelDeps['spawnImpl'],
  binaryPath: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnImpl(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    child.on('close', (code: number | null) => {
      resolve({ code, stdout, stderr });
    });

    // Handle spawn errors (e.g. binary not found)
    child.on('error', () => {
      resolve({ code: 1, stdout, stderr });
    });
  });
}

// ── Default deps factory ──────────────────────────────────────────────────────

/**
 * Build the default production deps.
 * Callers (CLI handler) pass these + any overrides into `runSetupTunnel`.
 */
export function defaultSetupTunnelDeps(
  binaryPath: string,
  configPath: string,
  ensureConfigFn: () => Promise<Config>,
  saveConfigFn: (c: Config) => Promise<void>,
): SetupTunnelDeps {
  return {
    binaryPath,
    cloudflaredHome: join(homedir(), '.cloudflared'),
    configPath,
    ensureConfig: ensureConfigFn,
    saveConfig: saveConfigFn,
    spawnImpl: spawn as SetupTunnelDeps['spawnImpl'],
    fileExists: existsSync,
    readFileUtf8: (p) => readFile(p, 'utf8'),
    // readdirImpl: omitted — falls back to dynamic import of node:fs/promises
  };
}

// ── Main orchestration function ────────────────────────────────────────────────

/**
 * Run the setup-tunnel wizard.
 *
 * Sequence (design §3.1):
 *  1. Validate hostname (early, cheap)
 *  2. Assert cert.pem exists
 *  3. Spawn `cloudflared tunnel create --output json <name>`
 *  4. Parse UUID + credentials_file from JSON (or fallback scan on already-exists)
 *  5. Resolve credentials file path
 *  6. Spawn `cloudflared tunnel route dns <name> <hostname>` (unless skipDns)
 *  7. Merge existing config + new tunnel fields
 *  8. Save config
 *  9. Return ok result
 */
export async function runSetupTunnel(
  input: SetupTunnelInput,
  deps: SetupTunnelDeps,
): Promise<SetupTunnelResult> {
  const { name, hostname, port, skipDns } = input;
  const { binaryPath, cloudflaredHome, spawnImpl, fileExists, readFileUtf8, readdirImpl } = deps;

  // ── Step 1: Validate hostname ─────────────────────────────────────────────
  if (!HOSTNAME_RE.test(hostname)) {
    return {
      ok: false,
      reason: 'invalid-hostname',
      message:
        `Invalid --hostname: "${hostname}" — expected a bare hostname (no scheme, no path), e.g. "shots.example.com".`,
    };
  }

  // ── Step 2: Assert cert.pem exists ───────────────────────────────────────
  const certPath = join(cloudflaredHome, 'cert.pem');
  if (!fileExists(certPath)) {
    return {
      ok: false,
      reason: 'missing-cert',
      message:
        `cloudflared not authenticated.\nRun: cloudflared tunnel login\nThen re-run: claude-shotlink setup-tunnel --name ${name} --hostname ${hostname}`,
    };
  }

  // ── Step 3: Spawn tunnel create ──────────────────────────────────────────
  const createResult = await runCommand(spawnImpl, binaryPath, [
    'tunnel',
    'create',
    '--output',
    'json',
    name,
  ]);

  let uuid: string;
  let credentialsFile: string;

  if (createResult.code === 0) {
    // ── Step 4a: Parse JSON output ──────────────────────────────────────────
    let parsed: { uuid: string; credentialsFile?: string };
    try {
      parsed = parseTunnelCreateOutput(createResult.stdout);
    } catch (e) {
      return {
        ok: false,
        reason: 'parse-failed',
        message:
          `Created tunnel but failed to parse cloudflared output. ` +
          `Run \`ls ${cloudflaredHome}/*.json\` to find the credentials file. Tunnel name: ${name}.`,
        recoveryHint: String(e),
      };
    }
    uuid = parsed.uuid;
    // ── Step 5a: Resolve credentials file ──────────────────────────────────
    if (parsed.credentialsFile !== undefined) {
      credentialsFile = parsed.credentialsFile;
    } else {
      // FIX-2: fallback to <cloudflaredHome>/<uuid>.json — but verify it exists
      // before proceeding. If cloudflared wrote the file elsewhere (custom config),
      // a missing file here would return ok:true and let the next `start` fail with
      // a cryptic cloudflared error.
      // JD R2 (C3): use a dedicated `creds-not-found` reason discriminant so callers
      // can distinguish a parse failure from a post-parse file-location failure.
      const fallbackPath = join(cloudflaredHome, `${uuid}.json`);
      if (!fileExists(fallbackPath)) {
        return {
          ok: false,
          reason: 'creds-not-found',
          message:
            `Could not locate credentials file for tunnel '${name}' at '${fallbackPath}'. ` +
            `Re-run \`claude-shotlink setup-tunnel --name ${name} --hostname ${hostname}\` to recreate.`,
        };
      }
      credentialsFile = fallbackPath;
    }
  } else if (/already exists/i.test(createResult.stderr)) {
    // ── Step 4b: Idempotency — tunnel already exists ────────────────────────
    // v0.3.1 fix: use `cloudflared tunnel list --output json` (not JSON file scan
     // by TunnelName field — that field doesn't exist in real credentials JSONs).
    const found = await findExistingTunnelByName(
      name,
      cloudflaredHome,
      binaryPath,
      spawnImpl,
      fileExists,
    );
    if (!found) {
      return {
        ok: false,
        reason: 'tunnel-exists-no-creds',
        message:
          `Tunnel "${name}" exists in your Cloudflare account but its credentials file is not on this machine. ` +
          `To recreate from scratch: cloudflared tunnel delete ${name} && claude-shotlink setup-tunnel --name ${name} --hostname ${hostname}`,
      };
    }
    uuid = found.uuid;
    credentialsFile = found.credentialsFilePath;
  } else {
    // ── Step 4c: Create failed (network/auth) ────────────────────────────────
    const stderrTail = createResult.stderr.split('\n').slice(-10).join('\n');
    return {
      ok: false,
      reason: 'create-failed',
      message:
        `Failed to create tunnel "${name}". cloudflared exited with code ${createResult.code ?? 'null'}. stderr tail:\n${stderrTail}`,
    };
  }

  // ── Step 6: Spawn route dns ───────────────────────────────────────────────
  let dnsRouted = false;
  let dnsManualCommand: string | undefined;
  const manualDnsCmd = `cloudflared tunnel route dns ${name} ${hostname}`;

  if (!skipDns) {
    const routeResult = await runCommand(spawnImpl, binaryPath, [
      'tunnel',
      'route',
      'dns',
      name,
      hostname,
    ]);
    if (routeResult.code === 0) {
      dnsRouted = true;
    } else {
      // DNS route failed — still write config (tunnel is valid), but return the manual command
      dnsRouted = false;
      dnsManualCommand = manualDnsCmd;
    }
  } else {
    // skipDns — provide the manual command as a hint
    dnsManualCommand = manualDnsCmd;
  }

  // ── Step 7 + 8: Merge config + save ──────────────────────────────────────
  const existing = await deps.ensureConfig();
  const merged: Config = {
    ...existing,
    tunnelMode: 'named',
    tunnelName: name,
    tunnelHostname: hostname,
    tunnelCredentialsFile: credentialsFile,
    tunnelLocalPort: port,
  };
  await deps.saveConfig(merged);

  // ── Step 9: Return ok result ──────────────────────────────────────────────
  return {
    ok: true,
    uuid,
    credentialsFile,
    dnsRouted,
    ...(dnsManualCommand !== undefined ? { dnsManualCommand } : {}),
  };
}

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeAtomic } from './atomic-write.js';

export interface Config {
  apiKey: string;
  createdAt: string;
}

export const CONFIG_DIR = join(homedir(), '.claude-shotlink');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

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
  try {
    return JSON.parse(raw) as Config;
  } catch {
    throw new Error(`Failed to parse config file at ${path}: invalid JSON.`);
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await writeAtomic(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
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

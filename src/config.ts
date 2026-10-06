import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import type { Config } from './types.js';

export function loadConfig(dryRun = false, env: NodeJS.ProcessEnv = process.env): Config {
  const model = env.OPENAI_MODEL?.trim();
  const apiKey = env.OPENAI_API_KEY?.trim() ?? '';
  if (!model || /\s/.test(model)) throw new Error('Configure OPENAI_MODEL com um identificador de modelo válido.');
  if (!dryRun && !apiKey) throw new Error('Configure OPENAI_API_KEY no ambiente ou no arquivo .env.');
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Configuração inválida: ${key}.`);
    return value;
  };
  return { apiKey, model,
    minIntervalMs: number('MIN_REQUEST_INTERVAL_MS', 1000, 0, 60000),
    timeoutMs: number('REQUEST_TIMEOUT_MS', 60000, 100, 300000),
    maxOutputTokens: number('MAX_OUTPUT_TOKENS', 1200, 100, 32000),
    databasePath: env.DATABASE_PATH?.trim() || 'data/chatbot.sqlite',
    historyLimit: number('HISTORY_MAX_TURNS', 20, 1, 100),
    memoryLimit: number('MEMORY_MAX_TURNS', 3, 0, 20),
    memoryMaxChars: number('MEMORY_MAX_CHARS', 2000, 0, 20000) };
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim().length > 0);
}

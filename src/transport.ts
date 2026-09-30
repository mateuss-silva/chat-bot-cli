import OpenAI from 'openai';
import { setTimeout as delay } from 'timers/promises';
import type { Attempt, Config, GenerationResult, Message } from './types.js';
import { object } from './config.js';

export const MAX_RETRIES = 3;
export interface Clock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
const realClock: Clock = { now: Date.now, sleep: async (ms, signal) => { await delay(ms, undefined, { signal }); } };

export class RateLimiter {
  private lastStart: number | undefined;
  constructor(private readonly intervalMs: number, private readonly clock: Clock = realClock) { }
  async wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const wait = this.lastStart === undefined ? 0 : Math.max(0, this.lastStart + this.intervalMs - this.clock.now());
    if (wait) await this.clock.sleep(wait, signal);
    signal?.throwIfAborted();
    this.lastStart = this.clock.now();
  }
}

function statusOf(error: unknown): number | undefined {
  return object(error) && typeof error.status === 'number' ? error.status : undefined;
}
export function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  if (object(error) && (error.code === 'insufficient_quota' || error.code === 'billing_hard_limit_reached')) return false;
  if (object(error) && error.streamFailure === true) return error.code === 'server_error' || error.code === 'rate_limit_exceeded';
  if (status !== undefined) return status === 429 || (status >= 500 && status <= 599);
  return error instanceof OpenAI.APIConnectionError || (error instanceof Error &&
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(String((error as { code?: unknown }).code)));
}

export function retryAfterMs(error: unknown, now: number): number | undefined {
  if (!object(error) || !error.headers) return undefined;
  const headers = error.headers;
  let value: unknown;
  if (headers instanceof Headers) value = headers.get('retry-after');
  else if (object(headers)) value = headers['retry-after'];
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
export function retryDelayMs(error: unknown, retryIndex: number, now: number, random = Math.random): number {
  return Math.max(retryAfterMs(error, now) ?? 0, 500 * 2 ** retryIndex + Math.floor(random() * 250));
}

// Never print provider messages: they can contain supplied data or credentials.
export function safeError(error: unknown, cancelled = false): string {
  if (cancelled) return 'Solicitação cancelada.';
  const status = statusOf(error);
  if (status === 401 || status === 403) return 'Autenticação ou autorização recusada. Verifique a configuração.';
  if (status === 429) return 'Limite de uso ou de requisições atingido.';
  if (status !== undefined && status >= 500) return 'Serviço temporariamente indisponível.';
  if (status !== undefined) return `Solicitação recusada (HTTP ${status}). Verifique o modelo e os parâmetros.`;
  if (error instanceof OpenAI.APIConnectionTimeoutError || (error instanceof Error && error.name === 'TimeoutError')) return 'Tempo limite da solicitação excedido.';
  if (error instanceof OpenAI.APIConnectionError) return 'Falha de conexão com o serviço.';
  return 'Não foi possível concluir a solicitação.';
}

export interface Requester {
  generate(messages: Message[], signal?: AbortSignal, onText?: (text: string) => void, schema?: Record<string, unknown>): Promise<GenerationResult>;
}

export class ApiRequester implements Requester {
  private readonly client: OpenAI;
  private readonly limiter: RateLimiter;
  constructor(private readonly config: Config, client?: OpenAI) {
    this.client = client ?? new OpenAI({ apiKey: config.apiKey, maxRetries: 0, timeout: config.timeoutMs });
    this.limiter = new RateLimiter(config.minIntervalMs);
  }
  async generate(messages: Message[], signal?: AbortSignal, onText?: (text: string) => void,
    schema?: Record<string, unknown>): Promise<GenerationResult> {
    const started = Date.now();
    const operationTimeout = AbortSignal.timeout(this.config.timeoutMs * (MAX_RETRIES + 1) + 30000);
    const operationSignal = signal ? AbortSignal.any([signal, operationTimeout]) : operationTimeout;
    const deadline = started + this.config.timeoutMs * (MAX_RETRIES + 1) + 30000;
    const attempts: Attempt[] = [];
    let output = '';
    let model = 'unavailable';
    let usage: unknown = 'unavailable';
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      let attemptStart = Date.now();
      let completed = false;
      let explicitlyIncomplete = false;
      let requestStarted = false;
      try {
        await this.limiter.wait(operationSignal);
        attemptStart = Date.now();
        const attemptSignal = AbortSignal.any([operationSignal, AbortSignal.timeout(this.config.timeoutMs)]);
        requestStarted = true;
        const stream = await this.client.responses.create({
          model: this.config.model,
          input: messages,
          max_output_tokens: this.config.maxOutputTokens,
          store: false,
          stream: true,
          ...(schema ? { text: { format: { type: 'json_schema' as const, name: 'policy_review', strict: true, schema } } } : {})
        }, { signal: attemptSignal, maxRetries: 0 });
        for await (const event of stream) {
          if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
            output += event.delta;
            onText?.(event.delta);
          } else if (event.type === 'response.created' || event.type === 'response.in_progress') {
            model = event.response.model;
          } else if (event.type === 'response.completed') {
            completed = true;
            model = event.response.model;
            usage = event.response.usage ?? 'unavailable';
            if (!output && event.response.output_text) { output = event.response.output_text; onText?.(output); }
          } else if (event.type === 'response.incomplete') {
            explicitlyIncomplete = true;
            model = event.response.model;
            usage = event.response.usage ?? 'unavailable';
            throw new Error('Incomplete response');
          } else if (event.type === 'response.failed') {
            model = event.response.model;
            usage = event.response.usage ?? 'unavailable';
            // Retry server failures only before any generated text.
            throw { code: event.response.error?.code ?? 'response_failed', streamFailure: true };
          } else if (event.type === 'error') {
            throw { code: event.code, streamFailure: true };
          }
        }
        if (!completed || !output.trim()) throw new Error('No complete textual response');
        attempts.push({
          number: retry + 1, startedAt: new Date(attemptStart).toISOString(), latencyMs: Date.now() - attemptStart,
          status: 'complete', error: 'unavailable', httpStatus: 'unavailable', retryDelayMs: 0
        });
        return { status: 'complete', output, error: 'unavailable', attempts, model, usage, latencyMs: Date.now() - started };
      } catch (error) {
        const status = output || explicitlyIncomplete ? 'incomplete' as const : 'error' as const;
        const message = safeError(error, signal?.aborted === true);
        const backoff = retryDelayMs(error, retry, Date.now());
        const canRetry = !output && !explicitlyIncomplete && !operationSignal.aborted && retry < MAX_RETRIES && isRetryable(error) && Date.now() + backoff < deadline;
        if (requestStarted) attempts.push({
          number: retry + 1, startedAt: new Date(attemptStart).toISOString(), latencyMs: Date.now() - attemptStart,
          status, error: message, httpStatus: statusOf(error) ?? 'unavailable', retryDelayMs: canRetry ? backoff : 0
        });
        if (!canRetry) return { status, output, error: message, attempts, model, usage, latencyMs: Date.now() - started };
        try { await realClock.sleep(backoff, operationSignal); }
        catch { return { status, output, error: safeError(undefined, signal?.aborted === true), attempts, model, usage, latencyMs: Date.now() - started }; }
      }
    }
    throw new Error('Unreachable retry state');
  }
}

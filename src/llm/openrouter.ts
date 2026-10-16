// OpenRouter chat completion client (JSON output, cost reporting). Key from env only.

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResult {
  content: string;
  /** `usage.cost` in USD as reported by OpenRouter; undefined when the response has none. */
  costUsd: number | undefined;
  model: string;
}

export interface LlmClient {
  readonly model: string;
  complete(messages: ChatMessage[]): Promise<LlmResult>;
}

/** An LLM call failed. Messages never contain the API key. */
export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface CompletionBody {
  choices?: { message?: { content?: unknown } }[];
  usage?: { cost?: unknown };
  error?: { message?: unknown };
}

const short = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

/** Every form of the key a transport or the API could echo back is replaced (L-3). */
function keyScrubber(key: string): (s: string) => string {
  const needles = [...new Set([key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)])];
  return (s) => needles.reduce((acc, n) => acc.split(n).join('[REDACTED]'), s);
}

export function createOpenRouterClient(opts: OpenRouterOptions): LlmClient {
  if (!opts.apiKey) throw new LlmError('OPENROUTER_API_KEY is not set');
  if (!opts.model) throw new LlmError('model is not set');
  const url = `${(opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const scrub = keyScrubber(opts.apiKey);
  // The message is scrubbed before it is cut, so a key on the cut edge cannot survive in part.
  const fail = (message: string) => new LlmError(short(scrub(message)));

  return {
    model: opts.model,
    async complete(messages) {
      let res: Response;
      let text: string;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            'content-type': 'application/json',
            'x-title': 'koresh-journalist',
          },
          body: JSON.stringify({
            model: opts.model,
            messages,
            response_format: { type: 'json_object' },
            usage: { include: true },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (e) {
        const name = (e as { name?: string } | null)?.name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new LlmError(`openrouter: timed out after ${timeoutMs} ms`);
        }
        // Only the scrubbed message is kept: no `cause`, whose text could hold the key.
        throw fail(`openrouter: request failed: ${String((e as Error)?.message ?? e)}`);
      }
      let body: CompletionBody;
      try {
        body = JSON.parse(text) as CompletionBody;
      } catch {
        throw new LlmError(`openrouter: HTTP ${res.status}, response is not JSON`);
      }
      const apiError = typeof body.error?.message === 'string' ? body.error.message : undefined;
      if (!res.ok || apiError !== undefined) {
        throw fail(`openrouter: HTTP ${res.status}: ${apiError ?? 'error'}`);
      }
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new LlmError('openrouter: response has no content');
      const cost = body.usage?.cost;
      return {
        content,
        costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined,
        model: opts.model,
      };
    },
  };
}

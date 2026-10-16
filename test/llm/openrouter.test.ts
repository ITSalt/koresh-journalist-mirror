import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOpenRouterClient, DEFAULT_TIMEOUT_MS, LlmError } from '../../src/llm/openrouter.js';
import { FakeOpenRouter } from './fake-openrouter.js';

const KEY = 'fake-openrouter-key-for-tests';
let fake: FakeOpenRouter;
beforeEach(async () => {
  fake = await new FakeOpenRouter().start();
});
afterEach(async () => {
  await fake.stop();
});

const client = (over: { timeoutMs?: number } = {}) =>
  createOpenRouterClient({ apiKey: KEY, model: 'vendor/model-a', baseUrl: fake.baseUrl, ...over });

describe('OpenRouter client', () => {
  it('times out after 120 s by default', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(120_000);
  });

  it('posts a JSON chat completion with usage.include and returns content and cost', async () => {
    fake.replies.push({ content: '{"ok":true}', cost: 0.0421 });
    const r = await client().complete([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    expect(r).toEqual({ content: '{"ok":true}', costUsd: 0.0421, model: 'vendor/model-a' });
    const req = fake.requests[0]!;
    expect(req.url).toBe('/api/v1/chat/completions');
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.body.model).toBe('vendor/model-a');
    expect(req.body.messages).toHaveLength(2);
    expect(req.body.response_format).toEqual({ type: 'json_object' });
    expect(req.body.usage).toEqual({ include: true });
  });

  it('reports a missing usage.cost as undefined', async () => {
    fake.replies.push({ content: '{}', cost: null });
    expect((await client().complete([{ role: 'user', content: 'x' }])).costUsd).toBeUndefined();
  });

  it('throws LlmError on an HTTP error without leaking the key', async () => {
    fake.replies.push({ status: 402, body: { error: { message: 'Insufficient credits' } } });
    const err = await client()
      .complete([{ role: 'user', content: 'x' }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(String(err)).toMatch(/402.*Insufficient credits/);
    expect(String(err)).not.toContain(KEY);
  });

  it('throws LlmError on an error body with status 200 and on missing content', async () => {
    fake.replies.push({ status: 200, body: { error: { message: 'upstream failed' } } });
    await expect(client().complete([{ role: 'user', content: 'x' }])).rejects.toThrow(
      /upstream failed/,
    );
    fake.replies.push({ status: 200, body: { choices: [] } });
    await expect(client().complete([{ role: 'user', content: 'x' }])).rejects.toThrow(LlmError);
  });

  it('L-3: never puts the key into the error when fetch rejects', async () => {
    // A transport that echoes the request (URL and headers) into its error message.
    const leaky: typeof fetch = (input, init) => {
      const auth = new Headers(init?.headers).get('authorization');
      const cause = new Error(`connect ECONNREFUSED; header ${auth}; key=${KEY}`);
      return Promise.reject(
        Object.assign(new TypeError(`fetch failed ${String(input)} ${auth}`), { cause }),
      );
    };
    const err = await createOpenRouterClient({
      apiKey: KEY,
      model: 'vendor/model-a',
      baseUrl: fake.baseUrl,
      fetch: leaky,
    })
      .complete([{ role: 'user', content: 'x' }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(String((err as Error).message)).toMatch(/request failed: fetch failed/);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(KEY);
    expect(String((err as Error).stack)).not.toContain(KEY);
    expect((err as Error).cause).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });

  it('L-3: keeps the key out of an API error message that echoes it', async () => {
    fake.replies.push({ status: 401, body: { error: { message: `bad key ${KEY}` } } });
    const err = await client()
      .complete([{ role: 'user', content: 'x' }])
      .catch((e: unknown) => e);
    expect(String(err)).toMatch(/401/);
    expect(String(err)).not.toContain(KEY);
  });

  it('times out', async () => {
    fake.replies.push({ hang: true });
    await expect(
      client({ timeoutMs: 100 }).complete([{ role: 'user', content: 'x' }]),
    ).rejects.toThrow(/timed out/);
  });

  it('refuses to build without a key or a model', () => {
    expect(() =>
      createOpenRouterClient({ apiKey: '', model: 'm', baseUrl: fake.baseUrl }),
    ).toThrow();
    expect(() =>
      createOpenRouterClient({ apiKey: KEY, model: '', baseUrl: fake.baseUrl }),
    ).toThrow();
  });
});

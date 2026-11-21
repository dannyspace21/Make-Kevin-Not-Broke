// Tests for the multi-AI adapters using FAKE HTTP responses (no keys / network needed).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Configure three providers BEFORE config.js is loaded.
process.env.OPENAI_API_KEY = 'sk-test-openai-000000';
process.env.OPENAI_MODEL = 'test-gpt';
process.env.GEMINI_API_KEY = 'test-gemini-key-000000';
process.env.GEMINI_MODEL = 'test-gemini';
process.env.CUSTOM_AI_1_NAME = 'Local Ollama';
process.env.CUSTOM_AI_1_BASE_URL = 'http://localhost:11434/v1';
process.env.CUSTOM_AI_1_MODEL = 'llama-test';
process.env.AI_DEFAULT_PROVIDER = 'gemini';

const { aiStatus, simulate, advise } = await import('../src/ai/copilot.js');

const DECISION = { action: 'buy', confidence: 150, position_size_pct: 10, entry: 100, stop_loss: 95, take_profit: 110, reasoning: 'r', risks: ['x'] };

test('status lists every configured provider, never keys', () => {
  const s = aiStatus();
  assert.deepEqual(s.providers.map((p) => p.id), ['openai', 'gemini', 'custom1']);
  assert.equal(s.defaultProvider, 'gemini');
  assert.ok(!JSON.stringify(s).includes('test-gemini-key'));
});

test('Gemini adapter: key in header, JSON decision parsed + clamped', async () => {
  const m = mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.match(String(url), /models\/test-gemini:generateContent$/);
    assert.equal(opts.headers['x-goog-api-key'], 'test-gemini-key-000000');
    const body = { candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(DECISION) + '\n```' }] } }] };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const { decision, provider } = await simulate({ providerId: 'gemini', scenario: '', context: {} });
  m.mock.restore();
  assert.equal(provider.id, 'gemini');
  assert.equal(decision.action, 'BUY');
  assert.equal(decision.confidence, 100); // clamped
});

test('OpenAI-compatible adapter (ChatGPT) sends bearer key', async () => {
  const m = mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
    assert.equal(opts.headers.Authorization, 'Bearer sk-test-openai-000000');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Looks bullish.' } }] }), { status: 200 });
  });
  const r = await advise({ providerId: 'openai', question: 'hi', context: {} });
  m.mock.restore();
  assert.equal(r.answer, 'Looks bullish.');
});

test('local Ollama provider works without a key; JSON-mode 400 falls back', async () => {
  let calls = 0;
  const m = mock.method(globalThis, 'fetch', async (url, opts) => {
    calls++;
    assert.equal(opts.headers.Authorization, undefined);
    const body = JSON.parse(opts.body);
    if (body.response_format) return new Response('{"error":"unsupported"}', { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: `Sure: ${JSON.stringify(DECISION)}` } }] }), { status: 200 });
  });
  const { decision } = await simulate({ providerId: 'custom1', scenario: '', context: {} });
  m.mock.restore();
  assert.equal(calls, 2);
  assert.equal(decision.action, 'BUY');
});

test('bad key gives a friendly, provider-named error', async () => {
  const m = mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 401 }));
  await assert.rejects(advise({ providerId: 'openai', question: 'x', context: {} }), /ChatGPT \(OpenAI\): API key was rejected/);
  m.mock.restore();
});

test('unknown provider id falls back to the default provider', async () => {
  const m = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 }));
  const r = await advise({ providerId: 'evil', question: 'x', context: {} });
  m.mock.restore();
  assert.equal(r.provider.id, 'gemini');
});

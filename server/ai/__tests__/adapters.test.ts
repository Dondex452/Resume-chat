import test from 'node:test';
import assert from 'node:assert/strict';
import { openaiAdapter } from '../adapters/openai';
import { anthropicAdapter } from '../adapters/anthropic';
import { geminiAdapter } from '../adapters/gemini';
import { AIError } from '../types';

interface Captured {
  url: string;
  init: any;
}

function stubFetch(
  handler: (url: string, init: any) => Response | Promise<Response>,
): { captured: Captured[]; restore: () => void } {
  const captured: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    captured.push({ url: String(url), init });
    return handler(String(url), init);
  }) as any;
  return {
    captured,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const OPENAI_CFG = {
  provider: 'openai-compatible',
  baseURL: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: 'sk-test-key',
};

test('openai: builds URL/headers/body and parses text + tool calls', async () => {
  const { captured, restore } = stubFetch(() =>
    jsonResponse({
      choices: [
        {
          message: {
            content: 'hello',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'update_resume', arguments: '{"patch":{"basics":{"fullName":"Ada"}}}' },
              },
            ],
          },
        },
      ],
    }),
  );
  try {
    const res = await openaiAdapter.chat(
      {
        model: 'gpt-4o-mini',
        system: 'sys',
        temperature: 0.2,
        maxTokens: 123,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'update_resume', description: 'd', parameters: { type: 'object', properties: {} } }],
      },
      OPENAI_CFG,
    );
    const { url, init } = captured[0];
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Authorization'], 'Bearer sk-test-key');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gpt-4o-mini');
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[1].content, 'hi');
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_tokens, 123);
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.tools[0].type, 'function');
    assert.equal(body.tools[0].function.name, 'update_resume');
    assert.equal(res.text, 'hello');
    assert.equal(res.toolCalls[0].id, 'call_1');
    assert.equal(res.toolCalls[0].name, 'update_resume');
    assert.deepEqual(res.toolCalls[0].args, { patch: { basics: { fullName: 'Ada' } } });
  } finally {
    restore();
  }
});

test('openai: omits Authorization header for keyless local endpoints', async () => {
  const { captured, restore } = stubFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
  try {
    await openaiAdapter.chat(
      { model: 'llama3.1', messages: [{ role: 'user', content: 'hi' }] },
      { provider: 'openai-compatible', baseURL: 'http://localhost:11434/v1', model: 'llama3.1' },
    );
    assert.equal(captured[0].init.headers['Authorization'], undefined);
  } finally {
    restore();
  }
});

test('openai: converts assistant tool calls and tool results', async () => {
  const { captured, restore } = stubFetch(() => jsonResponse({ choices: [{ message: { content: 'done' } }] }));
  try {
    await openaiAdapter.chat(
      {
        model: 'm',
        messages: [
          { role: 'user', content: 'u' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'update_resume', args: { patch: {} } }] },
          { role: 'tool', toolCallId: 'c1', name: 'update_resume', content: JSON.stringify({ ok: true }) },
        ],
      },
      OPENAI_CFG,
    );
    const body = JSON.parse(captured[0].init.body);
    assert.equal(body.messages[1].role, 'assistant');
    assert.equal(body.messages[1].content, null);
    assert.deepEqual(body.messages[1].tool_calls[0].function, {
      name: 'update_resume',
      arguments: JSON.stringify({ patch: {} }),
    });
    assert.equal(body.messages[2].role, 'tool');
    assert.equal(body.messages[2].tool_call_id, 'c1');
    assert.equal(body.messages[2].content, JSON.stringify({ ok: true }));
  } finally {
    restore();
  }
});

test('openai: malformed tool arguments do not throw', async () => {
  const { restore } = stubFetch(() =>
    jsonResponse({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [{ id: 'c', type: 'function', function: { name: 'update_resume', arguments: '{not json' } }],
          },
        },
      ],
    }),
  );
  try {
    const res = await openaiAdapter.chat(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      OPENAI_CFG,
    );
    assert.ok(res.toolCalls[0].args.__parse_error);
  } finally {
    restore();
  }
});

test('openai: HTTP errors map to AIError codes', async () => {
  const cases: Array<[number, string]> = [
    [401, 'AI_AUTH'],
    [403, 'AI_AUTH'],
    [429, 'AI_RATE_LIMIT'],
    [500, 'AI_PROVIDER_ERROR'],
  ];
  for (const [status, code] of cases) {
    const { restore } = stubFetch(() => new Response('provider said no', { status }));
    try {
      await assert.rejects(
        () => openaiAdapter.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, OPENAI_CFG),
        (err: unknown) => err instanceof AIError && err.code === code,
      );
    } finally {
      restore();
    }
  }
});

test('openai: network failure -> AI_UNREACHABLE, abort -> AI_TIMEOUT', async () => {
  let stub = stubFetch(() => {
    throw new Error('boom');
  });
  try {
    await assert.rejects(
      () => openaiAdapter.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, OPENAI_CFG),
      (err: unknown) => err instanceof AIError && err.code === 'AI_UNREACHABLE',
    );
  } finally {
    stub.restore();
  }

  stub = stubFetch(() => {
    const err: any = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  });
  try {
    await assert.rejects(
      () => openaiAdapter.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, OPENAI_CFG),
      (err: unknown) => err instanceof AIError && err.code === 'AI_TIMEOUT',
    );
  } finally {
    stub.restore();
  }
});

test('anthropic: builds native Messages request and parses content blocks', async () => {
  const { captured, restore } = stubFetch(() =>
    jsonResponse({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 't1', name: 'update_resume', input: { patch: { basics: { fullName: 'Ada' } } } },
      ],
    }),
  );
  try {
    const res = await anthropicAdapter.chat(
      {
        model: 'claude-sonnet-4-20250514',
        system: 'sys',
        temperature: 0.1,
        maxTokens: 2048,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'update_resume', description: 'd', parameters: { type: 'object', properties: {} } }],
      },
      { provider: 'anthropic', baseURL: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-20250514', apiKey: 'sk-ant' },
    );
    const { url, init } = captured[0];
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.headers['x-api-key'], 'sk-ant');
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(init.body);
    assert.equal(body.system, 'sys');
    assert.equal(body.max_tokens, 2048);
    assert.equal(body.temperature, 0.1);
    assert.equal(body.tools[0].input_schema.type, 'object');
    assert.equal(res.text, 'hello');
    assert.deepEqual(res.toolCalls[0], { id: 't1', name: 'update_resume', args: { patch: { basics: { fullName: 'Ada' } } } });
  } finally {
    restore();
  }
});

test('anthropic: max_tokens defaults to 4096 and tool results merge into one user turn', async () => {
  const { captured, restore } = stubFetch(() => jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
  try {
    await anthropicAdapter.chat(
      {
        model: 'm',
        messages: [
          { role: 'user', content: 'u' },
          {
            role: 'assistant',
            content: 'working',
            toolCalls: [
              { id: 't1', name: 'update_resume', args: { patch: {} } },
              { id: 't2', name: 'update_cover_letter', args: { patch: {} } },
            ],
          },
          { role: 'tool', toolCallId: 't1', name: 'update_resume', content: JSON.stringify({ ok: true }) },
          { role: 'tool', toolCallId: 't2', name: 'update_cover_letter', content: JSON.stringify({ ok: true }) },
        ],
      },
      { provider: 'anthropic', baseURL: 'https://api.anthropic.com/v1', model: 'm', apiKey: 'k' },
    );
    const body = JSON.parse(captured[0].init.body);
    assert.equal(body.max_tokens, 4096);
    const assistant = body.messages[1];
    assert.equal(assistant.role, 'assistant');
    assert.equal(assistant.content[0].type, 'text');
    assert.equal(assistant.content[1].type, 'tool_use');
    assert.equal(assistant.content[2].type, 'tool_use');
    const toolTurn = body.messages[2];
    assert.equal(toolTurn.role, 'user');
    assert.equal(toolTurn.content.length, 2);
    assert.equal(toolTurn.content[0].type, 'tool_result');
    assert.equal(toolTurn.content[0].tool_use_id, 't1');
    assert.equal(toolTurn.content[1].tool_use_id, 't2');
  } finally {
    restore();
  }
});

test('gemini: builds URL with key, converts contents/tools, parses functionCall', async () => {
  const { captured, restore } = stubFetch(() =>
    jsonResponse({
      candidates: [
        {
          content: {
            parts: [
              { text: 'hello' },
              { functionCall: { name: 'update_resume', args: { patch: { basics: { fullName: 'Ada' } } } } },
            ],
          },
        },
      ],
    }),
  );
  try {
    const res = await geminiAdapter.chat(
      {
        model: 'gemini-2.0-flash',
        system: 'sys',
        temperature: 0.3,
        maxTokens: 512,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '', toolCalls: [{ name: 'update_resume', args: { patch: {} } }] },
          { role: 'tool', name: 'update_resume', content: JSON.stringify({ ok: true }) },
        ],
        tools: [{ name: 'update_resume', description: 'd', parameters: { type: 'object', properties: {} } }],
      },
      { provider: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash', apiKey: 'AIza-test' },
    );
    const { url, init } = captured[0];
    assert.ok(url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'));
    assert.ok(url.includes('?key=AIza-test'));
    const body = JSON.parse(init.body);
    assert.equal(body.systemInstruction.parts[0].text, 'sys');
    assert.equal(body.contents[0].role, 'user');
    assert.equal(body.contents[1].role, 'model');
    assert.equal(body.contents[1].parts[0].functionCall.name, 'update_resume');
    assert.equal(body.contents[2].role, 'user');
    assert.equal(body.contents[2].parts[0].functionResponse.name, 'update_resume');
    assert.deepEqual(body.contents[2].parts[0].functionResponse.response, { ok: true });
    assert.equal(body.generationConfig.temperature, 0.3);
    assert.equal(body.generationConfig.maxOutputTokens, 512);
    assert.equal(body.tools[0].functionDeclarations[0].parameters.type, 'OBJECT');
    assert.equal(res.text, 'hello');
    assert.deepEqual(res.toolCalls[0], { name: 'update_resume', args: { patch: { basics: { fullName: 'Ada' } } } });
  } finally {
    restore();
  }
});

test('gemini: blocked / empty candidate surfaces AI_BAD_RESPONSE', async () => {
  const { restore } = stubFetch(() => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }));
  try {
    await assert.rejects(
      () =>
        geminiAdapter.chat(
          { model: 'm', messages: [{ role: 'user', content: 'x' }] },
          { provider: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', model: 'm', apiKey: 'k' },
        ),
      (err: unknown) => err instanceof AIError && err.code === 'AI_BAD_RESPONSE' && /SAFETY/.test((err as Error).message),
    );
  } finally {
    restore();
  }
});

/**
 * M11 Stage B — tests for the `create_template` chat tool (PRD §5.5(a), §9, §10).
 *
 * There is no API key on this machine, so a live generation cannot be proven.
 * What IS proven here:
 *
 *   1. the tool is declared in neutral JSON Schema and converted to each
 *      adapter's wire shape (PRD §16: "request payload construction per adapter
 *      via mocked fetch, runnable with no API key present");
 *   2. every *unconditional* enum the tool advertises is accepted by the ONE
 *      validator (`src/templates/schema.ts`), and the conditional unions are
 *      pinned as a documented divergence;
 *   3. the native chat loop runs exactly ONE repair pass on an invalid document,
 *      executes a repaired one, and executes NOTHING when the repair also fails;
 *   4. the JSON-block fallback path runs `create_template` on the same
 *      parse → validate → repair path;
 *   5. persistence rejects an invalid document and writes nothing, and stores a
 *      valid one exactly once as `origin: 'generated'`.
 *
 * The native/fallback cases stub `globalThis.fetch` with the OpenAI-compatible
 * adapter, exactly like `adapters.test.ts`, so they need no network and no key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CREATE_TEMPLATE_TOOL,
  RESUME_TOOLS,
  UPDATE_RESUME_TOOL,
  createTemplateSchemaErrors,
  formatTemplateSchemaErrors,
  toAnthropicTools,
  toGeminiTools,
  toOpenAITools,
  validateCreateTemplateArgs,
} from '../schema';
import { FALLBACK_ADDENDUM, runChatLoop } from '../index';
import { getBuiltinTemplateSchema } from '../../../src/templates/builtin';
import { validateTemplateSchema } from '../../../src/templates/schema';
import { SqliteDatabase } from '../../store';
import { createGeneratedTemplate } from '../../templateRoutes';

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

/** A fresh, valid `TemplateSchema` — a real built-in, so the fixture cannot drift. */
function validDoc(): any {
  return JSON.parse(JSON.stringify(getBuiltinTemplateSchema('minimal')));
}

const toolSchemaNode = (): any => (CREATE_TEMPLATE_TOOL.parameters as any).properties.schema;
const propsNode = (): any => toolSchemaNode().properties.sections.items.properties.props;

const OPENAI_CFG = {
  provider: 'openai-compatible',
  baseURL: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: 'sk-test-key',
};

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(text: string): any {
  return { choices: [{ message: { content: text } }] };
}

function toolCallResponse(name: string, args: any, text = ''): any {
  return {
    choices: [
      {
        message: {
          content: text,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  };
}

/**
 * Queue of OpenAI-compatible responses, one per `fetch`. Every request body is
 * captured so a test can assert what was actually sent.
 */
function queueFetch(responses: any[]): {
  captured: any[];
  callCount: () => number;
  restore: () => void;
} {
  const captured: any[] = [];
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    captured.push({
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index++;
    return jsonResponse(next);
  }) as any;
  return {
    captured,
    callCount: () => index,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

interface RecordedCall {
  name: string;
  args: any;
}

function recorder(): { calls: RecordedCall[]; handler: (name: string, args: any) => Promise<any> } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    handler: async (name: string, args: any) => {
      calls.push({ name, args });
      return { ok: true, template_id: 'tpl-test' };
    },
  };
}

function withTempDb<T>(fn: (db: SqliteDatabase) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm11-generate-'));
  const db = new SqliteDatabase(path.join(dir, 'database.sqlite'));
  try {
    return fn(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. Declaration + per-adapter conversion
// ---------------------------------------------------------------------------

test('create_template: declared as a neutral tool with the full TemplateSchema shape', () => {
  assert.equal(CREATE_TEMPLATE_TOOL.name, 'create_template');
  assert.deepEqual(CREATE_TEMPLATE_TOOL.parameters.required, ['schema']);

  const node = toolSchemaNode();
  assert.deepEqual(
    node.required,
    ['id', 'name', 'version', 'origin', 'page', 'tokens', 'layout', 'sections'],
    'a model must supply the whole document',
  );
  // The structure is real, not an opaque object.
  for (const key of ['page', 'tokens', 'sections']) {
    assert.ok(node.properties[key], `schema must describe ${key}`);
  }
  assert.deepEqual(node.properties.sections.items.required, [
    'key',
    'label',
    'enabled',
    'order',
    'column',
    'variant',
  ]);
  assert.deepEqual(
    node.properties.sections.items.properties.key.enum,
    ['basics', 'personal', 'summary', 'work', 'education', 'skills', 'projects', 'certifications', 'languages', 'signature'],
  );
  assert.ok(node.properties.tokens.required.includes('rootClass'));
  assert.ok(node.properties.sections.items.properties.props, 'the per-section props bag is advertised');
});

test('create_template: RESUME_TOOLS registers all three tools', () => {
  assert.deepEqual(
    RESUME_TOOLS.map((t) => t.name).sort(),
    ['create_template', 'update_cover_letter', 'update_resume'],
  );
  // The pre-existing tool shape is untouched.
  assert.deepEqual(UPDATE_RESUME_TOOL.parameters.required, ['patch']);
});

test('create_template: converted per adapter (no vendor schema types in app logic)', () => {
  const openai: any = toOpenAITools([CREATE_TEMPLATE_TOOL])[0];
  assert.equal(openai.type, 'function');
  assert.equal(openai.function.name, 'create_template');
  assert.deepEqual(openai.function.parameters.required, ['schema']);
  assert.ok(openai.function.parameters.properties.schema.properties.tokens);
  assert.ok(openai.function.parameters.properties.schema.properties.sections.items.properties.props);

  const anthropic: any = toAnthropicTools([CREATE_TEMPLATE_TOOL])[0];
  assert.equal(anthropic.name, 'create_template');
  assert.equal(anthropic.input_schema.properties.schema.required[0], 'id');
  assert.ok(anthropic.input_schema.properties.schema.properties.sections);

  const gemini: any = toGeminiTools([CREATE_TEMPLATE_TOOL])[0].functionDeclarations[0];
  assert.equal(gemini.name, 'create_template');
  assert.equal(gemini.parameters.type, 'OBJECT');
  assert.equal(gemini.parameters.properties.schema.type, 'OBJECT');
  assert.equal(gemini.parameters.properties.schema.properties.page.properties.size.type, 'STRING');
  assert.equal(
    gemini.parameters.properties.schema.properties.sections.items.properties.key.type,
    'STRING',
  );
  assert.deepEqual(
    gemini.parameters.properties.schema.properties.sections.items.properties.key.enum,
    ['basics', 'personal', 'summary', 'work', 'education', 'skills', 'projects', 'certifications', 'languages', 'signature'],
  );
  // Gemini rejects unknown keys, so the converter must have dropped them.
  assert.deepEqual(findKeyDeep(gemini, 'additionalProperties'), []);
  assert.deepEqual(findLowercaseTypeValues(gemini), []);
  assert.deepEqual(findKeyDeep(gemini, 'oneOf'), []);
  assert.deepEqual(findKeyDeep(gemini, 'anyOf'), []);
});

// ---------------------------------------------------------------------------
// 2. Validator parity (the highest-value check)
// ---------------------------------------------------------------------------

test('create_template tool schema: its unconditional enums are all validator-accepted', () => {
  const node = toolSchemaNode();
  const cases: Array<[string, string[], (doc: any, value: string) => void]> = [
    ['origin', node.properties.origin.enum, (d, v) => { d.origin = v; }],
    ['layout', node.properties.layout.enum, (d, v) => { d.layout = v; }],
    ['page.size', node.properties.page.properties.size.enum, (d, v) => { d.page.size = v; }],
    ['sections[].column', node.properties.sections.items.properties.column.enum, (d, v) => {
      for (const section of d.sections) section.column = v;
    }],
    ['sections[].variant', node.properties.sections.items.properties.variant.enum, (d, v) => {
      for (const section of d.sections) section.variant = v;
    }],
    ['sidebar.position', node.properties.sidebar.properties.position.enum, (d, v) => {
      d.sidebar = { widthPct: 30, background: '#ffffff', position: v };
    }],
  ];

  for (const [label, values, apply] of cases) {
    assert.ok(values.length > 0, `${label} must declare enum values`);
    for (const value of values) {
      const doc = validDoc();
      apply(doc, value);
      assert.equal(
        validateTemplateSchema(doc).ok,
        true,
        `tool schema advertises ${label}="${value}" but validateTemplateSchema rejects it`,
      );
    }
  }
});

test('create_template tool schema: contact / skills enums are validator-accepted', () => {
  const props = propsNode();

  for (const value of props.properties.contacts.properties.layout.enum) {
    const doc = validDoc();
    doc.sections.find((s: any) => s.key === 'basics').props.contacts.layout = value;
    assert.equal(validateTemplateSchema(doc).ok, true, `contacts.layout="${value}"`);
  }
  for (const value of props.properties.contacts.properties.linkMode.enum) {
    const doc = validDoc();
    doc.sections.find((s: any) => s.key === 'basics').props.contacts.linkMode = value;
    assert.equal(validateTemplateSchema(doc).ok, true, `contacts.linkMode="${value}"`);
  }
  for (const value of props.properties.itemsMode.enum) {
    const doc = validDoc();
    doc.sections.find((s: any) => s.key === 'skills').props.itemsMode = value;
    assert.equal(validateTemplateSchema(doc).ok, true, `skills.itemsMode="${value}"`);
  }
  for (const value of props.properties.fields.items.enum) {
    const doc = validDoc();
    const personal = doc.sections.find((s: any) => s.key === 'personal');
    personal.enabled = true;
    personal.props = { fields: [value] };
    assert.equal(validateTemplateSchema(doc).ok, true, `personal.fields=["${value}"]`);
  }
});

test('create_template tool schema: props.layout values are accepted on their own section key', () => {
  const advertised: string[] = propsNode().properties.layout.enum;
  const perKey: Array<[string, string[]]> = [
    ['basics', ['stack', 'split']],
    ['work', ['role-company-block', 'role-date-then-company', 'inline-role-company']],
    ['education', ['degree-field-block', 'inline-degree-field', 'stacked']],
  ];

  for (const [key, values] of perKey) {
    for (const value of values) {
      assert.ok(advertised.includes(value), `props.layout must advertise "${value}" (used by ${key})`);
      const doc = validDoc();
      const section = doc.sections.find((s: any) => s.key === key);
      assert.ok(section && section.enabled !== false, `${key} must be enabled in the fixture`);
      section.props.layout = value;
      assert.equal(validateTemplateSchema(doc).ok, true, `${key}.layout="${value}"`);
    }
  }
});

test('create_template tool schema: props.variant values are accepted by the keys that use them', () => {
  const advertised: string[] = propsNode().properties.variant.enum;
  assert.deepEqual(advertised, ['full', 'compact', 'stacked', 'inline']);

  for (const value of ['full', 'compact']) {
    const doc = validDoc();
    doc.sections.find((s: any) => s.key === 'certifications').props.variant = value;
    assert.equal(validateTemplateSchema(doc).ok, true, `certifications.variant="${value}"`);
  }
  for (const value of advertised) {
    const doc = validDoc();
    doc.sections.find((s: any) => s.key === 'languages').props.variant = value;
    assert.equal(validateTemplateSchema(doc).ok, true, `languages.variant="${value}"`);
  }
});

test('KNOWN CONDITIONAL: the props.layout / props.variant unions are broader than one key allows', () => {
  // Standard JSON Schema cannot express `enum`/`required` that varies by the
  // value of a *sibling* property, and the Gemini converter whitelists only
  // description/type/properties/items/required/enum/nullable/format. The tool
  // schema therefore advertises the union and the repair pass covers the rest.
  // Pinned here so any future widening is a deliberate decision.
  const basicsWithStacked = validDoc();
  basicsWithStacked.sections.find((s: any) => s.key === 'basics').props.layout = 'stacked';
  assert.equal(validateTemplateSchema(basicsWithStacked).ok, false, 'basics.layout allows only stack|split');

  const certsWithInline = validDoc();
  certsWithInline.sections.find((s: any) => s.key === 'certifications').props.variant = 'inline';
  assert.equal(validateTemplateSchema(certsWithInline).ok, false, 'certifications.variant allows only full|compact');
});

// ---------------------------------------------------------------------------
// 3. Argument validation + error reporting
// ---------------------------------------------------------------------------

test('create_template args: a valid document passes and an invalid one returns a readable error', () => {
  assert.equal(validateCreateTemplateArgs({ schema: validDoc() }), null);
  assert.equal(createTemplateSchemaErrors(validDoc()).length, 0);
  assert.ok(createTemplateSchemaErrors({}).length > 0);

  assert.match(validateCreateTemplateArgs(undefined)!, /required/);
  assert.match(validateCreateTemplateArgs({})!, /required/);
  assert.match(validateCreateTemplateArgs({ schema: undefined })!, /invalid/);
  assert.match(validateCreateTemplateArgs({ schema: { id: 'x' } })!, /invalid \(\d+ error/);
});

test('create_template args: the reported error list is capped so one bad document cannot flood the turn', () => {
  const message = validateCreateTemplateArgs({ schema: { page: {}, tokens: {}, sections: [{}] } })!;
  assert.match(message, /invalid \(\d+ errors\)/);
  assert.match(message, /\(\+\d+ more\)/, 'a long error list must be abbreviated');
});

test('create_template args: formatTemplateSchemaErrors handles the singular and the uncapped case', () => {
  assert.equal(formatTemplateSchemaErrors(['id: must be a non-empty string']), 'The "schema" argument is invalid (1 error): id: must be a non-empty string');
});

// ---------------------------------------------------------------------------
// 4. The chat loop
// ---------------------------------------------------------------------------

test('create_template (full): a valid native call executes once and the tool result carries template_id', async () => {
  const good = validDoc();
  const fetch = queueFetch([
    toolCallResponse('create_template', { schema: good }),
    textResponse('Saved your new template.'),
  ]);
  const { calls, handler } = recorder();
  try {
    const result = await runChatLoop({
      system: 'sys',
      messages: [{ role: 'user', content: 'make me a new template' }],
      tools: RESUME_TOOLS,
      config: OPENAI_CFG as any,
      capability: 'full',
      onToolCall: handler,
    });

    assert.equal(calls.length, 1, 'the tool executes exactly once');
    assert.equal(calls[0].name, 'create_template');
    assert.equal(calls[0].args.schema.id, good.id);
    assert.equal(result.toolCallsExecuted, 1);
    assert.equal(result.text, 'Saved your new template.');

    // PRD §9: the result the model sees is `{ ok, template_id }`.
    const followUp = fetch.captured[1].body.messages as any[];
    const toolMessage = followUp.find((m) => m.role === 'tool');
    assert.deepEqual(JSON.parse(toolMessage.content), { ok: true, template_id: 'tpl-test' });
  } finally {
    fetch.restore();
  }
});

test('create_template (full): an invalid document gets exactly ONE repair pass, then executes', async () => {
  const good = validDoc();
  const fetch = queueFetch([
    toolCallResponse('create_template', { schema: { id: 'broken' } }),
    toolCallResponse('create_template', { schema: good }, 'corrected'),
    textResponse('All fixed.'),
  ]);
  const { calls, handler } = recorder();
  try {
    const result = await runChatLoop({
      system: 'sys',
      messages: [{ role: 'user', content: 'make me a new template' }],
      tools: RESUME_TOOLS,
      config: OPENAI_CFG as any,
      capability: 'full',
      onToolCall: handler,
    });

    assert.equal(fetch.callCount(), 3, 'initial + one repair + the closing turn');
    assert.equal(calls.length, 1, 'the repaired call executes once');
    assert.equal(calls[0].args.schema.id, good.id);
    assert.equal(result.toolCallsExecuted, 1);

    // The repair request told the model exactly what the validator objected to.
    const repairMessages = fetch.captured[1].body.messages as any[];
    assert.match(repairMessages[repairMessages.length - 1].content, /rejected/);
    assert.match(repairMessages[repairMessages.length - 1].content, /create_template/);
  } finally {
    fetch.restore();
  }
});

test('create_template (full): a still-invalid document is rejected and NOTHING is executed', async () => {
  const fetch = queueFetch([
    toolCallResponse('create_template', { schema: { id: 'broken' } }),
    toolCallResponse('create_template', { schema: { id: 'still-broken' } }), // repair also invalid
    textResponse('Sorry, I could not build that template.'),
  ]);
  const { calls, handler } = recorder();
  try {
    const result = await runChatLoop({
      system: 'sys',
      messages: [{ role: 'user', content: 'make me a new template' }],
      tools: RESUME_TOOLS,
      config: OPENAI_CFG as any,
      capability: 'full',
      onToolCall: handler,
    });

    assert.equal(calls.length, 0, 'an invalid document must never reach persistence');
    assert.equal(result.toolCallsExecuted, 0);
    assert.equal(result.text, 'Sorry, I could not build that template.');
  } finally {
    fetch.restore();
  }
});

test('create_template (fallback): a fenced JSON block runs the same validate path', async () => {
  const good = validDoc();
  const block = '```json\n' + JSON.stringify({ tool: 'create_template', schema: good }) + '\n```';
  const fetch = queueFetch([textResponse('Here is your design.\n' + block)]);
  const { calls, handler } = recorder();
  try {
    const result = await runChatLoop({
      system: 'sys',
      messages: [{ role: 'user', content: 'make me a new template' }],
      tools: RESUME_TOOLS,
      config: OPENAI_CFG as any,
      capability: 'fallback',
      onToolCall: handler,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'create_template');
    assert.equal(calls[0].args.schema.id, good.id);
    assert.equal(result.toolCallsExecuted, 1);
    assert.equal(result.capability, 'fallback');
    assert.ok(!result.text.includes('```'), 'the block is stripped from the prose');
  } finally {
    fetch.restore();
  }
});

test('create_template (fallback): a malformed block is repaired once via a second block', async () => {
  const good = validDoc();
  const badBlock = '```json\n{"tool":"create_template","schema":{"id":"broken"}}\n```';
  const goodBlock = '```json\n' + JSON.stringify({ tool: 'create_template', schema: good }) + '\n```';
  const fetch = queueFetch([textResponse(badBlock), textResponse(goodBlock), textResponse('Created.')]);
  const { calls, handler } = recorder();
  try {
    const result = await runChatLoop({
      system: 'sys',
      messages: [{ role: 'user', content: 'make me a new template' }],
      tools: RESUME_TOOLS,
      config: OPENAI_CFG as any,
      capability: 'fallback',
      onToolCall: handler,
    });

    assert.equal(fetch.callCount(), 3, 'initial + one repair + the prose follow-up');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.schema.id, good.id);
    assert.equal(result.toolCallsExecuted, 1);
    // The repair prompt must ask for the `schema` shape, not `patch`.
    const repairMessages = fetch.captured[1].body.messages as any[];
    assert.match(repairMessages[repairMessages.length - 1].content, /"tool":"create_template","schema"/);
  } finally {
    fetch.restore();
  }
});

test('create_template (fallback): a block that stays malformed is discarded, not executed', async () => {
  const badBlock = '```json\n{"tool":"create_template","schema":{"id":"broken"}}\n```';
  const stillBad = '```json\n{"tool":"create_template","schema":{"id":"nope"}}\n```';
  const fetch = queueFetch([textResponse(badBlock), textResponse(stillBad), textResponse('I could not do that.')]);
  const { calls, handler } = recorder();
  try {
    const result = await runChatLoop({
      system: 'sys',
      messages: [{ role: 'user', content: 'make me a new template' }],
      tools: RESUME_TOOLS,
      config: OPENAI_CFG as any,
      capability: 'fallback',
      onToolCall: handler,
    });

    assert.equal(calls.length, 0);
    assert.equal(result.toolCallsExecuted, 0);
    assert.match(result.text, /Discarded a malformed "create_template" update/);
  } finally {
    fetch.restore();
  }
});

test('fallback addendum documents the create_template block shape', () => {
  assert.match(FALLBACK_ADDENDUM, /create_template/);
  assert.match(FALLBACK_ADDENDUM, /"schema"/);
});

// ---------------------------------------------------------------------------
// 5. Persistence
// ---------------------------------------------------------------------------

test('create_template persistence: a valid document is stored once with origin "generated"', () => {
  withTempDb((db) => {
    const doc = validDoc();
    const result = createGeneratedTemplate(db, doc);

    assert.equal(result.ok, true);
    assert.match(result.template_id!, /^[0-9a-f-]{36}$/i);

    const rows: any[] = db.all('SELECT * FROM templates');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, result.template_id);
    assert.equal(rows[0].origin, 'generated');
    const stored = JSON.parse(rows[0].schema_json);
    assert.equal(stored.origin, 'generated');
    assert.equal(stored.name, doc.name);
    assert.deepEqual(stored.sections.map((s: any) => s.key), doc.sections.map((s: any) => s.key));
  });
});

test('create_template persistence: an invalid document is rejected and writes nothing', () => {
  withTempDb((db) => {
    const result = createGeneratedTemplate(db, { id: 'broken' });

    assert.equal(result.ok, false);
    assert.ok(result.template_id === undefined);
    assert.match(result.error!, /invalid/i);
    assert.deepEqual(db.all('SELECT * FROM templates'), [], 'a rejected document must never be persisted');
  });
});

test('create_template persistence: a model-supplied "builtin" origin cannot make the row claim to be built-in', () => {
  withTempDb((db) => {
    const result = createGeneratedTemplate(db, { ...validDoc(), origin: 'builtin' });
    assert.equal(result.ok, true);

    const row = db.get('SELECT * FROM templates WHERE id = ?', [result.template_id]);
    assert.equal(row.origin, 'generated');
    assert.equal(JSON.parse(row.schema_json).origin, 'generated');
  });
});

// ---------------------------------------------------------------------------
// Deep-search helpers (assertions about the converted schema)
// ---------------------------------------------------------------------------

function findLowercaseTypeValues(node: any, at = 'root', found: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((child, i) => findLowercaseTypeValues(child, `${at}[${i}]`, found));
    return found;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' && typeof value === 'string' && value !== value.toUpperCase()) {
        found.push(`${at}.type=${value}`);
      } else {
        findLowercaseTypeValues(value, `${at}.${key}`, found);
      }
    }
  }
  return found;
}

function findKeyDeep(node: any, wanted: string, at = 'root', found: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((child, i) => findKeyDeep(child, wanted, `${at}[${i}]`, found));
    return found;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === wanted) found.push(`${at}.${key}`);
      findKeyDeep(value, wanted, `${at}.${key}`, found);
    }
  }
  return found;
}

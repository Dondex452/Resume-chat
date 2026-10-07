import type {
  CapabilityTier,
  ChatRequest,
  ChatResponse,
  NeutralMessage,
  NeutralTool,
  ProviderConfig,
} from './types';
import { AIError } from './types';
import { getAdapter, findAdapter, listProviders } from './adapters/index';
import { resolveConfig, isLocalEndpoint } from './settings';
import {
  RESUME_TOOLS,
  validateResumePatch,
  validateCoverLetterPatch,
  validateCreateTemplateArgs,
} from './schema';

export { getAdapter, findAdapter, listProviders };
export type { ProviderInfo } from './adapters/index';

export const FALLBACK_ADDENDUM = [
  'You do not have native tool calling. To update structured data, emit one or more fenced code blocks of the form:',
  '```json',
  '{"tool": "update_resume", "patch": { ... }}',
  '```',
  '— valid tool names are `update_resume`, `update_cover_letter` and `create_template`. Emit the block(s) first, then continue with your normal prose reply.',
  'To create a new resume template, emit a fenced block shaped as:',
  '```json',
  '{"tool": "create_template", "schema": { ... a complete TemplateSchema ... }}',
  '```',
].join('\n');

export const CHAT_ONLY_ADDENDUM = [
  'Important: the currently selected model has no reliable structured-update capability.',
  'You can still converse with the user, but you cannot apply resume or cover-letter changes automatically.',
  'If the user asks you to change their document, explain this limitation plainly and keep helping conversationally.',
].join('\n');

const CAPABILITY_PROBE_TOOL: NeutralTool = {
  name: '__capability_probe',
  description: 'Internal capability probe. Call this with ok=true.',
  parameters: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: 'Set to true.' },
    },
    required: ['ok'],
  },
};

// ---------------------------------------------------------------------------
// Fallback JSON-block protocol
// ---------------------------------------------------------------------------

export interface FallbackToolBlock {
  tool: string;
  patch: any;
  /** Set by a `create_template` block (PRD §9: `create_template(schema)`). */
  schema?: any;
  raw: string;
}

function tryParseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const FENCED_BLOCK_RE = /```(?:json|JSON)?\s*([\s\S]*?)```/g;

/** Collect every parsable JSON object from fenced blocks or a bare response. */
export function extractFencedJsonValues(text: string): any[] {
  const values: any[] = [];
  const trimmed = (text || '').trim();
  if (!trimmed) return values;

  const whole = tryParseJson(trimmed);
  if (whole && typeof whole === 'object') return [whole];

  const re = new RegExp(FENCED_BLOCK_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const parsed = tryParseJson(match[1].trim());
    if (parsed && typeof parsed === 'object') values.push(parsed);
  }
  return values;
}

/**
 * Parse tool-update blocks. Accepts fenced ```json blocks (the language tag is
 * optional) and a whole-response bare JSON object. Blocks without a string
 * `tool` field are ignored.
 */
export function parseFallbackToolBlocks(text: string): FallbackToolBlock[] {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];

  const whole = tryParseJson(trimmed);
  if (whole && typeof whole === 'object' && !Array.isArray(whole) && typeof whole.tool === 'string') {
    return [{ tool: whole.tool, patch: whole.patch, schema: whole.schema, raw: trimmed }];
  }

  const out: FallbackToolBlock[] = [];
  const re = new RegExp(FENCED_BLOCK_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const body = match[1].trim();
    const parsed = tryParseJson(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.tool === 'string') {
      out.push({ tool: parsed.tool, patch: parsed.patch, schema: parsed.schema, raw: body });
    }
  }
  return out;
}

/** Remove fenced JSON blocks (and a bare tool-object response) from prose. */
export function stripFallbackBlocks(text: string): string {
  const trimmed = (text || '').trim();
  const whole = tryParseJson(trimmed);
  if (whole && typeof whole === 'object' && !Array.isArray(whole) && typeof whole.tool === 'string') return '';
  return (text || '').replace(/```(?:json|JSON)?\s*[\s\S]*?```/g, '').trim();
}

// ---------------------------------------------------------------------------
// Simple dispatch helpers
// ---------------------------------------------------------------------------

export async function chat(req: ChatRequest, cfg?: ProviderConfig): Promise<ChatResponse> {
  const config = cfg ?? resolveConfig();
  const adapter = getAdapter(config.provider);
  return adapter.chat({ ...req, model: req.model || config.model }, config);
}

/** No-tools call that asks for JSON and returns the raw text. Used by the session pre-parse. */
export async function completeJson(prompt: string, cfg?: ProviderConfig): Promise<string> {
  const config = cfg ?? resolveConfig();
  const adapter = getAdapter(config.provider);
  const res = await adapter.chat(
    {
      model: config.model,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    },
    config,
  );
  return res.text || '';
}

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

export interface CapabilityProbeResult {
  capability: CapabilityTier;
  detail: string;
  latencyMs: number;
}

function needsApiKey(cfg: ProviderConfig): boolean {
  const adapter = findAdapter(cfg.provider);
  if (!adapter) return false;
  const hostedEndpoint = /^https?:\/\//i.test(cfg.baseURL) && !isLocalEndpoint(cfg.baseURL);
  return adapter.requiresApiKey || hostedEndpoint;
}

export async function probeCapability(cfg: ProviderConfig): Promise<CapabilityProbeResult> {
  const adapter = getAdapter(cfg.provider);
  if (needsApiKey(cfg) && !cfg.apiKey) {
    throw new AIError('AI_NOT_CONFIGURED', `No API key configured for provider "${cfg.provider}".`, {
      provider: cfg.provider,
    });
  }

  const started = Date.now();

  // Tier 1: native tool calling.
  try {
    const res = await adapter.chat(
      {
        model: cfg.model,
        temperature: 0,
        messages: [{ role: 'user', content: 'Call the __capability_probe tool with ok=true. Then stop.' }],
        tools: [CAPABILITY_PROBE_TOOL],
      },
      cfg,
    );
    if (res.toolCalls.some((call) => call.name === CAPABILITY_PROBE_TOOL.name)) {
      return {
        capability: 'full',
        detail: 'Native tool calling is supported.',
        latencyMs: Date.now() - started,
      };
    }
  } catch (err) {
    if (err instanceof AIError) {
      // Auth / transport / config problems are fatal; a model merely rejecting
      // the `tools` parameter should still be probed for the fallback tier.
      const fatal: string[] = ['AI_AUTH', 'AI_RATE_LIMIT', 'AI_NOT_CONFIGURED', 'AI_UNREACHABLE', 'AI_TIMEOUT'];
      if (fatal.includes(err.code)) throw err;
    } else {
      throw err;
    }
  }

  // Tier 2: JSON-block fallback.
  const probeInstruction = [
    FALLBACK_ADDENDUM,
    'Now reply with exactly one fenced json code block containing {"ok":true} and nothing else.',
  ].join('\n\n');
  const fallbackRes = await adapter.chat(
    {
      model: cfg.model,
      temperature: 0,
      messages: [{ role: 'user', content: probeInstruction }],
    },
    cfg,
  );
  if (extractFencedJsonValues(fallbackRes.text).length > 0) {
    return {
      capability: 'fallback',
      detail: 'No native tool calling; JSON-block fallback is available.',
      latencyMs: Date.now() - started,
    };
  }

  // Tier 3: conversational only.
  if ((fallbackRes.text || '').trim().length > 0) {
    return {
      capability: 'chat-only',
      detail: 'Model responds but cannot update structured data reliably.',
      latencyMs: Date.now() - started,
    };
  }

  return {
    capability: 'chat-only',
    detail: 'Model returned no usable output.',
    latencyMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Chat loop (native tools + fallback + chat-only)
// ---------------------------------------------------------------------------

/**
 * The result a tool handler returns to the model.
 *
 * `template_id` is the `create_template` success payload (PRD §9:
 * `create_template(schema) -> { ok, template_id }`). It is optional so the two
 * pre-existing tools are untouched.
 */
export interface ToolCallResult {
  ok: boolean;
  error?: string;
  template_id?: string;
}

export type ToolCallHandler = (name: string, args: any) => Promise<ToolCallResult>;

export interface RunChatLoopOptions {
  system?: string;
  messages: NeutralMessage[];
  tools: NeutralTool[];
  config: ProviderConfig;
  capability: CapabilityTier;
  onToolCall: ToolCallHandler;
}

export interface RunChatLoopResult {
  text: string;
  toolCallsExecuted: number;
  capability: CapabilityTier;
}

const KNOWN_TOOL_NAMES = ['update_resume', 'update_cover_letter', 'create_template'];
const MAX_TOOL_ROUNDS = 3;

function validateToolArgs(name: string, args: any): string | null {
  if (name === 'create_template') return validateCreateTemplateArgs(args);
  const patch = args && typeof args === 'object' ? args.patch : undefined;
  if (name === 'update_resume') return validateResumePatch(patch);
  if (name === 'update_cover_letter') return validateCoverLetterPatch(patch);
  return null;
}

/**
 * The argument object a fallback block carries: `create_template` uses `schema`
 * (PRD §9), the other two use `patch`.
 */
function fallbackBlockArgs(block: FallbackToolBlock): any {
  return block.tool === 'create_template' ? { schema: block.schema } : { patch: block.patch };
}

async function attemptNativeRepair(
  config: ProviderConfig,
  system: string | undefined,
  messages: NeutralMessage[],
  tools: NeutralTool[],
  name: string,
  args: any,
  error: string,
): Promise<any | null> {
  const adapter = getAdapter(config.provider);
  try {
    const res = await adapter.chat(
      {
        system,
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        tools,
        messages: [
          ...messages,
          {
            role: 'user',
            content: `The tool call to "${name}" was rejected: ${error}\nOriginal arguments: ${JSON.stringify(
              args,
            )}\nPlease re-issue a corrected "${name}" tool call now.`,
          },
        ],
      },
      config,
    );
    const fixed = res.toolCalls.find((call) => call.name === name);
    if (!fixed) return null;
    if (validateToolArgs(name, fixed.args ?? {})) return null;
    return fixed.args;
  } catch {
    return null;
  }
}

async function runNativeLoop(
  opts: RunChatLoopOptions,
): Promise<RunChatLoopResult> {
  const adapter = getAdapter(opts.config.provider);
  const messages: NeutralMessage[] = [...opts.messages];
  let text = '';
  let executed = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await adapter.chat(
      {
        system: opts.system,
        model: opts.config.model,
        temperature: opts.config.temperature,
        maxTokens: opts.config.maxTokens,
        tools: opts.tools,
        messages,
      },
      opts.config,
    );
    text = res.text || text;

    if (!res.toolCalls.length) {
      return { text, toolCallsExecuted: executed, capability: 'full' };
    }

    messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });

    for (const call of res.toolCalls) {
      let args = call.args ?? {};
      let validationError = validateToolArgs(call.name, args);

      if (validationError) {
        const repaired = await attemptNativeRepair(
          opts.config,
          opts.system,
          opts.messages,
          opts.tools,
          call.name,
          args,
          validationError,
        );
        if (repaired) {
          args = repaired;
          validationError = null;
        } else {
          messages.push({
            role: 'tool',
            content: JSON.stringify({ ok: false, error: validationError }),
            toolCallId: call.id,
            name: call.name,
          });
          continue;
        }
      }

      let result: ToolCallResult;
      try {
        result = await opts.onToolCall(call.name, args);
      } catch (err: any) {
        result = { ok: false, error: err?.message || 'Tool execution failed' };
      }
      if (result.ok) executed++;
      messages.push({
        role: 'tool',
        content: JSON.stringify(result),
        toolCallId: call.id,
        name: call.name,
      });
    }
  }

  return { text, toolCallsExecuted: executed, capability: 'full' };
}

async function repairFallbackBlock(
  opts: RunChatLoopOptions,
  system: string,
  block: FallbackToolBlock,
  error: string,
): Promise<any | null> {
  const adapter = getAdapter(opts.config.provider);
  const shape =
    block.tool === 'create_template'
      ? '{"tool":"create_template","schema":{...}}'
      : `{"tool":"${block.tool}","patch":{...}}`;
  try {
    const res = await adapter.chat(
      {
        system,
        model: opts.config.model,
        temperature: opts.config.temperature,
        maxTokens: opts.config.maxTokens,
        messages: [
          ...opts.messages,
          {
            role: 'user',
            content: `Your previous ${block.tool} JSON block was invalid: ${error}\nRe-emit exactly one corrected fenced json block shaped as ${shape} and nothing else.`,
          },
        ],
      },
      opts.config,
    );
    const fixed = parseFallbackToolBlocks(res.text || '').find((b) => b.tool === block.tool);
    if (!fixed) return null;
    const fixedArgs = fallbackBlockArgs(fixed);
    if (validateToolArgs(block.tool, fixedArgs)) return null;
    return fixedArgs;
  } catch {
    return null;
  }
}

async function runFallbackLoop(
  opts: RunChatLoopOptions,
): Promise<RunChatLoopResult> {
  const adapter = getAdapter(opts.config.provider);
  const system = [opts.system, FALLBACK_ADDENDUM].filter(Boolean).join('\n\n');

  const first = await adapter.chat(
    {
      system,
      model: opts.config.model,
      temperature: opts.config.temperature,
      maxTokens: opts.config.maxTokens,
      messages: opts.messages,
    },
    opts.config,
  );
  const raw = first.text || '';
  const blocks = parseFallbackToolBlocks(raw);

  let executed = 0;
  const notes: string[] = [];

  for (const block of blocks) {
    if (!KNOWN_TOOL_NAMES.includes(block.tool)) {
      notes.push(`Ignored an unknown tool "${block.tool}".`);
      continue;
    }
    const args = fallbackBlockArgs(block);
    const error = validateToolArgs(block.tool, args);
    let effectiveArgs = args;
    if (error) {
      const repaired = await repairFallbackBlock(opts, system, block, error);
      if (!repaired) {
        notes.push(`Discarded a malformed "${block.tool}" update: ${error}`);
        continue;
      }
      effectiveArgs = repaired;
    }
    let result: ToolCallResult;
    try {
      result = await opts.onToolCall(block.tool, effectiveArgs);
    } catch (err: any) {
      result = { ok: false, error: err?.message || 'Tool execution failed' };
    }
    if (result.ok) executed++;
    else notes.push(result.error || `Tool "${block.tool}" failed.`);
  }

  let prose = stripFallbackBlocks(raw);
  if (!prose.trim()) {
    try {
      const follow = await adapter.chat(
        {
          system,
          model: opts.config.model,
          temperature: opts.config.temperature,
          maxTokens: opts.config.maxTokens,
          messages: [
            ...opts.messages,
            {
              role: 'user',
              content: 'Briefly confirm the updates in natural language for the user. Do not emit any JSON blocks.',
            },
          ],
        },
        opts.config,
      );
      prose = follow.text || '';
    } catch {
      /* keep whatever prose we have */
    }
  }

  if (notes.length) prose = [prose, notes.join(' ')].filter(Boolean).join('\n\n');
  if (!prose.trim() && executed > 0) prose = 'I have updated your document with the details you provided.';

  return { text: prose, toolCallsExecuted: executed, capability: 'fallback' };
}

async function runChatOnlyLoop(opts: RunChatLoopOptions): Promise<RunChatLoopResult> {
  const adapter = getAdapter(opts.config.provider);
  const system = [opts.system, CHAT_ONLY_ADDENDUM].filter(Boolean).join('\n\n');
  const res = await adapter.chat(
    {
      system,
      model: opts.config.model,
      temperature: opts.config.temperature,
      maxTokens: opts.config.maxTokens,
      messages: opts.messages,
    },
    opts.config,
  );
  return { text: res.text || '', toolCallsExecuted: 0, capability: 'chat-only' };
}

export async function runChatLoop(opts: RunChatLoopOptions): Promise<RunChatLoopResult> {
  if (opts.capability === 'full') return runNativeLoop(opts);
  if (opts.capability === 'fallback') return runFallbackLoop(opts);
  return runChatOnlyLoop(opts);
}

export { RESUME_TOOLS };

import type {
  ChatRequest,
  ChatResponse,
  NeutralMessage,
  ProviderAdapter,
  ProviderConfig,
  ToolCall,
} from '../types';
import { AIError } from '../types';
import { toAnthropicTools } from '../schema';
import { assertOk, postJson } from './shared';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const PROVIDER = 'anthropic';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

let idCounter = 0;
function generatedToolUseId(): string {
  return `toolu_${Date.now()}_${idCounter++}`;
}

export function toAnthropicMessages(messages: NeutralMessage[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && last.__toolResults) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block], __toolResults: true });
      }
    } else if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length) {
        const content: any[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls) {
          content.push({
            type: 'tool_use',
            id: c.id || generatedToolUseId(),
            name: c.name,
            input: c.args ?? {},
          });
        }
        out.push({ role: 'assistant', content });
      } else {
        out.push({ role: 'assistant', content: m.content });
      }
    } else {
      out.push({ role: 'user', content: m.content });
    }
  }
  // Strip internal bookkeeping marker.
  return out.map(({ __toolResults, ...rest }: any) => rest);
}

export const anthropicAdapter: ProviderAdapter = {
  id: PROVIDER,
  label: 'Anthropic (native Messages API)',
  defaultBaseURL: DEFAULT_BASE_URL,
  defaultModel: DEFAULT_MODEL,
  requiresApiKey: true,
  suggestedModels: ['claude-sonnet-4-20250514', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'],

  async chat(req: ChatRequest, cfg: ProviderConfig): Promise<ChatResponse> {
    const baseURL = (cfg.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = `${baseURL}/messages`;

    const headers: Record<string, string> = {
      'x-api-key': cfg.apiKey || '',
      'anthropic-version': ANTHROPIC_VERSION,
    };

    const body: Record<string, unknown> = {
      model: req.model || cfg.model,
      max_tokens: req.maxTokens ?? cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: toAnthropicMessages(req.messages),
    };
    if (req.system) body.system = req.system;
    const temperature = req.temperature ?? cfg.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    if (req.tools && req.tools.length) body.tools = toAnthropicTools(req.tools);

    const { response, text, json } = await postJson({ url, headers, body, provider: PROVIDER });
    assertOk(PROVIDER, response, text);

    const blocks = json?.content;
    if (!Array.isArray(blocks)) {
      throw new AIError('AI_BAD_RESPONSE', `${PROVIDER}: response did not include a content block array.`, {
        provider: PROVIDER,
      });
    }

    let outText = '';
    const toolCalls: ToolCall[] = [];
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        outText += (outText ? '\n' : '') + block.text;
      } else if (block?.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
      }
    }
    return { text: outText, toolCalls };
  },
};

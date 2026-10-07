import type {
  ChatRequest,
  ChatResponse,
  NeutralMessage,
  ProviderAdapter,
  ProviderConfig,
  ToolCall,
} from '../types';
import { AIError } from '../types';
import { toOpenAITools } from '../schema';
import { assertOk, parseToolArgs, postJson } from './shared';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const PROVIDER = 'openai-compatible';

export function toOpenAIMessages(system: string | undefined, messages: NeutralMessage[]): any[] {
  const out: any[] = [];
  if (system) out.push({ role: 'system', content: system });

  let seq = 0;
  for (const m of messages) {
    if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length) {
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id || `call_${Date.now()}_${seq++}`,
            type: 'function',
            function: {
              name: c.name,
              arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}),
            },
          })),
        });
      } else {
        out.push({ role: 'assistant', content: m.content });
      }
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
    } else {
      out.push({ role: 'user', content: m.content });
    }
  }
  return out;
}

export const openaiAdapter: ProviderAdapter = {
  id: PROVIDER,
  label: 'OpenAI-compatible (OpenAI, OpenRouter, Groq, DeepSeek, Mistral, xAI, Ollama, LM Studio, vLLM, …)',
  defaultBaseURL: DEFAULT_BASE_URL,
  defaultModel: DEFAULT_MODEL,
  requiresApiKey: false,
  suggestedModels: [
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4.1-mini',
    'o4-mini',
    'llama3.1',
    'qwen2.5',
    'mistral-large-latest',
    'deepseek-chat',
  ],

  async chat(req: ChatRequest, cfg: ProviderConfig): Promise<ChatResponse> {
    const baseURL = (cfg.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = `${baseURL}/chat/completions`;

    const headers: Record<string, string> = {};
    // Local endpoints (Ollama/LM Studio) need no auth header.
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

    const body: Record<string, unknown> = {
      model: req.model || cfg.model,
      messages: toOpenAIMessages(req.system, req.messages),
    };
    const temperature = req.temperature ?? cfg.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    const maxTokens = req.maxTokens ?? cfg.maxTokens;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    if (req.tools && req.tools.length) {
      body.tools = toOpenAITools(req.tools);
      body.tool_choice = 'auto';
    }

    const { response, text, json } = await postJson({ url, headers, body, provider: PROVIDER });
    assertOk(PROVIDER, response, text);

    const message = json?.choices?.[0]?.message;
    if (!message) {
      throw new AIError('AI_BAD_RESPONSE', `${PROVIDER}: response did not include choices[0].message.`, {
        provider: PROVIDER,
      });
    }

    let outText = '';
    if (typeof message.content === 'string') outText = message.content;
    else if (Array.isArray(message.content)) {
      outText = message.content.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('');
    }

    const toolCalls: ToolCall[] = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((tc: any) => ({
          id: tc?.id,
          name: tc?.function?.name,
          args: parseToolArgs(tc?.function?.arguments),
        }))
      : [];

    return { text: outText || '', toolCalls };
  },
};

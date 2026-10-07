import type {
  ChatRequest,
  ChatResponse,
  NeutralMessage,
  ProviderAdapter,
  ProviderConfig,
  ToolCall,
} from '../types';
import { AIError } from '../types';
import { toGeminiTools } from '../schema';
import { assertOk, postJson } from './shared';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.0-flash';
const PROVIDER = 'gemini';

function parseToolResultObject(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through */
  }
  return { result: content };
}

export function toGeminiContents(messages: NeutralMessage[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      const parts: any[] = [];
      if (m.content) parts.push({ text: m.content });
      if (m.toolCalls && m.toolCalls.length) {
        for (const c of m.toolCalls) {
          parts.push({ functionCall: { name: c.name, args: c.args ?? {} } });
        }
      }
      if (!parts.length) parts.push({ text: '' });
      out.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      const part = {
        functionResponse: {
          name: m.name || 'tool',
          response: parseToolResultObject(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)),
        },
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && last.__toolResponses) {
        last.parts.push(part);
      } else {
        out.push({ role: 'user', parts: [part], __toolResponses: true });
      }
    }
  }
  return out.map(({ __toolResponses, ...rest }: any) => rest);
}

export const geminiAdapter: ProviderAdapter = {
  id: PROVIDER,
  label: 'Google Gemini (native)',
  defaultBaseURL: DEFAULT_BASE_URL,
  defaultModel: DEFAULT_MODEL,
  requiresApiKey: true,
  suggestedModels: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-1.5-flash'],

  async chat(req: ChatRequest, cfg: ProviderConfig): Promise<ChatResponse> {
    const baseURL = (cfg.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = req.model || cfg.model;
    // API key is passed as a query parameter (consistent across all calls).
    const keyQuery = cfg.apiKey ? `?key=${encodeURIComponent(cfg.apiKey)}` : '';
    const url = `${baseURL}/models/${encodeURIComponent(model)}:generateContent${keyQuery}`;

    const body: Record<string, unknown> = {
      contents: toGeminiContents(req.messages),
    };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.tools && req.tools.length) body.tools = toGeminiTools(req.tools);

    const generationConfig: Record<string, unknown> = {};
    const temperature = req.temperature ?? cfg.temperature;
    if (temperature !== undefined) generationConfig.temperature = temperature;
    const maxTokens = req.maxTokens ?? cfg.maxTokens;
    if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens;
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

    const { response, text, json } = await postJson({ url, headers: {}, body, provider: PROVIDER });
    assertOk(PROVIDER, response, text);

    const candidate = json?.candidates?.[0];
    if (!candidate) {
      const blockReason = json?.promptFeedback?.blockReason;
      const detail = blockReason
        ? `Gemini blocked the request (blockReason: ${blockReason}).`
        : 'Gemini returned no candidates.';
      throw new AIError('AI_BAD_RESPONSE', detail, { provider: PROVIDER });
    }

    let outText = '';
    const toolCalls: ToolCall[] = [];
    const parts = candidate?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part?.text === 'string') outText += part.text;
        if (part?.functionCall?.name) {
          toolCalls.push({ name: part.functionCall.name, args: part.functionCall.args ?? {} });
        }
      }
    }
    return { text: outText, toolCalls };
  },
};

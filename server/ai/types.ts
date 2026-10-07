/**
 * Neutral AI provider contract.
 *
 * No vendor SDK types may appear here or anywhere in application logic. Every
 * adapter converts these neutral shapes to/from its own wire format.
 */

export type CapabilityTier = 'full' | 'fallback' | 'chat-only' | 'unknown';

export interface NeutralTool {
  name: string;
  description: string;
  /** Standard JSON Schema (lowercase `type` values). */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id?: string;
  name: string;
  args: any;
}

export interface NeutralMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** Set on an assistant turn that requested tools. */
  toolCalls?: ToolCall[];
  /** Set on a tool-result turn. */
  toolCallId?: string;
  /** Tool name for a tool-result turn. */
  name?: string;
}

export interface ChatRequest {
  system?: string;
  messages: NeutralMessage[];
  tools?: NeutralTool[];
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
}

export interface ProviderConfig {
  provider: string;
  baseURL: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ProviderAdapter {
  id: string;
  label: string;
  defaultBaseURL: string;
  defaultModel: string;
  /** false for providers/endpoints that can operate without a key (local models). */
  requiresApiKey: boolean;
  suggestedModels: string[];
  chat(req: ChatRequest, cfg: ProviderConfig): Promise<ChatResponse>;
}

export type AIErrorCode =
  | 'AI_NOT_CONFIGURED'
  | 'AI_AUTH'
  | 'AI_RATE_LIMIT'
  | 'AI_PROVIDER_ERROR'
  | 'AI_UNREACHABLE'
  | 'AI_TIMEOUT'
  | 'AI_BAD_RESPONSE';

/** HTTP status used when an AIError reaches an Express route. */
export const AI_ERROR_STATUS: Record<AIErrorCode, number> = {
  AI_NOT_CONFIGURED: 400,
  AI_AUTH: 401,
  AI_RATE_LIMIT: 429,
  AI_PROVIDER_ERROR: 502,
  AI_UNREACHABLE: 502,
  AI_TIMEOUT: 502,
  AI_BAD_RESPONSE: 502,
};

export class AIError extends Error {
  code: AIErrorCode;
  status: number;
  provider?: string;

  constructor(
    code: AIErrorCode,
    message: string,
    opts?: { status?: number; provider?: string; cause?: unknown },
  ) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.status = opts?.status ?? AI_ERROR_STATUS[code] ?? 502;
    this.provider = opts?.provider;
    if (opts?.cause !== undefined) {
      (this as any).cause = opts.cause;
    }
  }
}

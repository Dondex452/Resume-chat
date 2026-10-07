import { AIError } from '../types';

export const DEFAULT_TIMEOUT_MS = 120_000;

export function truncate(input: string, max = 500): string {
  const s = (input || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max) + '…';
}

export interface RawResponse {
  response: Response;
  text: string;
  json: any;
}

/** POST JSON with an AbortController timeout; maps transport errors to AIError. */
export async function postJson(opts: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  provider: string;
  timeoutMs?: number;
}): Promise<RawResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(opts.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError' || controller.signal.aborted) {
      throw new AIError('AI_TIMEOUT', `Request to ${opts.provider} timed out after ${timeoutMs}ms.`, {
        provider: opts.provider,
        cause: err,
      });
    }
    throw new AIError('AI_UNREACHABLE', `Could not reach ${opts.provider}: ${err?.message || String(err)}`, {
      provider: opts.provider,
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  let json: any;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { response, text, json };
}

export function assertOk(provider: string, res: Response, text: string): void {
  if (res.ok) return;
  const snippet = truncate(text, 400);
  const suffix = snippet ? ` Response: ${snippet}` : '';
  if (res.status === 401 || res.status === 403) {
    throw new AIError('AI_AUTH', `${provider} rejected the API key (HTTP ${res.status}).${suffix}`, {
      status: 401,
      provider,
    });
  }
  if (res.status === 429) {
    throw new AIError('AI_RATE_LIMIT', `${provider} rate limit reached (HTTP 429).${suffix}`, {
      status: 429,
      provider,
    });
  }
  throw new AIError('AI_PROVIDER_ERROR', `${provider} returned HTTP ${res.status}.${suffix}`, { provider });
}

/**
 * Parse tool-call arguments. Malformed JSON never throws — it returns an
 * object carrying a note so the validator can trigger a repair pass.
 */
export function parseToolArgs(rawArgs: unknown): any {
  if (rawArgs === undefined || rawArgs === null || rawArgs === '') return {};
  if (typeof rawArgs === 'object') return rawArgs;
  try {
    const parsed = JSON.parse(String(rawArgs));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err: any) {
    return { __parse_error: truncate(`Malformed tool arguments JSON: ${err?.message || String(err)}`, 200) };
  }
}

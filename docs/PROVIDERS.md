# Providers

The app is provider-agnostic by design. All model access goes through one neutral
interface, `ProviderAdapter`, and no vendor SDK is imported anywhere in the
application. Adding support for a new provider means writing **one adapter file**
and registering it — no changes to routes, chat logic, or the database.

- Contract: `server/ai/types.ts`
- Registry: `server/ai/adapters/index.ts`
- Settings and precedence: `server/ai/settings.ts`
- Chat loop and capability probe: `server/ai/index.ts`
- Neutral tool schemas: `server/ai/schema.ts`

---

## 1. The three shipped adapters

| Adapter id | Label | Default base URL | Default model | Requires a key |
|---|---|---|---|---|
| `openai-compatible` | OpenAI-compatible (OpenAI, OpenRouter, Groq, DeepSeek, Mistral, xAI, Ollama, LM Studio, vLLM, …) | `https://api.openai.com/v1` | `gpt-4o-mini` | No — decided by the resolved endpoint (see §4) |
| `anthropic` | Anthropic (native Messages API) | `https://api.anthropic.com/v1` | `claude-sonnet-4-20250514` | Yes |
| `gemini` | Google Gemini (native) | `https://generativelanguage.googleapis.com/v1beta` | `gemini-2.0-flash` | Yes |

When to use which:

- Reach for **`openai-compatible`** first. It covers every hosted service and
  local runtime that exposes the OpenAI chat-completions shape, plus any custom
  base URL.
- Use **`anthropic`** when you want Anthropic's native Messages API (including
  its native tool-use blocks) rather than its compatibility endpoint.
- Use **`gemini`** when you want Google's native `generateContent` API.

### How each adapter builds its request

The base URL is normalised (trailing slashes removed) and a fixed path is
appended. No other path is assumed.

- `openai-compatible`: `POST {baseURL}/chat/completions`
  (`server/ai/adapters/openai.ts`). The key, if present, is sent as
  `Authorization: Bearer {key}`; a missing key sends no auth header, which is what
  local runtimes need.
- `anthropic`: `POST {baseURL}/messages`, with `x-api-key` and
  `anthropic-version` headers (`server/ai/adapters/anthropic.ts`).
- `gemini`: `POST {baseURL}/models/{model}:generateContent?key={key}`
  (`server/ai/adapters/gemini.ts`).

### Base URL examples

The adapter appends the fixed path shown above. The base URLs below are the
provider conventions; confirm against your provider's documentation before
relying on one.

| Provider | Adapter | Typical base URL | Example model id |
|---|---|---|---|
| OpenAI | `openai-compatible` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| OpenRouter | `openai-compatible` | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` |
| Groq | `openai-compatible` | `https://api.groq.com/openai/v1` | `llama-3.1-70b-versatile` |
| DeepSeek | `openai-compatible` | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Mistral | `openai-compatible` | `https://api.mistral.ai/v1` | `mistral-large-latest` |
| xAI | `openai-compatible` | `https://api.x.ai/v1` | `grok-2-latest` |
| Together | `openai-compatible` | `https://api.together.xyz/v1` | `meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo` |
| Fireworks | `openai-compatible` | `https://api.fireworks.ai/inference/v1` | `accounts/fireworks/models/llama-v3p1-70b-instruct` |
| Ollama (local) | `openai-compatible` | `http://localhost:11434/v1` | `llama3.1` |
| LM Studio (local) | `openai-compatible` | `http://localhost:1234/v1` | (the model you loaded) |
| vLLM (local) | `openai-compatible` | `http://localhost:8000/v1` | (the model you served) |
| llama.cpp (local) | `openai-compatible` | `http://localhost:8080/v1` | (the model you served) |
| LocalAI (local) | `openai-compatible` | `http://localhost:8080/v1` | (the model you installed) |
| Anthropic (native) | `anthropic` | `https://api.anthropic.com/v1` | `claude-sonnet-4-20250514` |
| Google Gemini (native) | `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `gemini-2.0-flash` |

The default base URLs and models in the table above are read from the adapters.
Local runtimes need **no API key**: leave the key blank and the request is sent
without an auth header.

---

## 2. The neutral tool schemas

Tools are declared once, in standard JSON Schema, in `server/ai/schema.ts`. Three
tools exist:

| Tool | Purpose |
|---|---|
| `update_resume(patch)` | Apply a patch to the structured resume. |
| `update_cover_letter(patch)` | Apply a patch to the structured cover letter. |
| `create_template(schema)` | Save a complete `TemplateSchema` document as a new template. |

Each adapter converts the neutral schema into its own wire shape:

| Converter | Output shape |
|---|---|
| `toOpenAITools` | `{ type: 'function', function: { name, description, parameters } }` |
| `toAnthropicTools` | `{ name, description, input_schema }` |
| `toGeminiTools` | `{ functionDeclarations: [{ name, description, parameters }] }`, with the schema recursively rewritten to Gemini's proto shape (uppercase `type` values, and only the keys Gemini accepts — `additionalProperties` is stripped, because Gemini rejects it). |

Application logic never sees a vendor-specific schema type. If a tool's
arguments fail validation, the loop first asks the model for a single corrected
call (see §5) before giving up.

---

## 3. Capability tiers and probing

`probeCapability` (`server/ai/index.ts`) runs when a configuration is first used
or when you press **Test** in AI settings. It tries, in order:

1. **Native tool calling (`full`).** The model is asked to call an internal
   `__capability_probe` tool. If the tool call comes back, the tier is `full`.
   Auth, rate-limit, configuration, timeout and unreachable errors are treated as
   fatal and surface immediately — only a model that merely rejects the `tools`
   parameter falls through to the next tier.
2. **JSON-block fallback (`fallback`).** The model is asked to emit a fenced
   `json` code block. If it does, the tier is `fallback`.
3. **Conversational only (`chat-only`).** If the model replies with text but no
   parsable JSON, it is `chat-only`. If it returns nothing usable, it is also
   reported as `chat-only`.

What each tier does at chat time:

| Tier | Behaviour |
|---|---|
| `full` | `runNativeLoop` sends the neutral tools; tool calls are validated, executed, and fed back to the model, up to 3 rounds. |
| `fallback` | No tools are sent. The model is instructed to emit fenced JSON blocks shaped `{"tool": "...", "patch": {...}}` (or `"schema"` for `create_template`). The blocks are parsed, validated and executed, then stripped from the prose shown to the user. If no prose remains, one follow-up call asks for a plain confirmation. |
| `chat-only` | A plain conversational call. A notice is shown in the studio that this model cannot make structured updates. |

The probed tier is persisted, but it is tied to a fingerprint of
`provider|baseURL|model`. If any of those change, the stored tier is treated as
`unknown` and re-probed, so a stale `full` tier can never be run against a
different model.

---

## 4. Which endpoints require a key

`requiresApiKey` on an adapter is not the whole answer — the same
`openai-compatible` adapter serves both hosted and local endpoints. The decision
is made against the **resolved config**:

- `resolveConfig` requires a key when the adapter says it needs one **or** the
  base URL is an `http(s)` address that is not local.
- `isLocalEndpoint` treats `localhost`, `127.0.0.1`, `0.0.0.0`, `::1`,
  `*.local`, `*.internal`, `10.x`, `192.168.x` and `172.16–31.x` as local and
  therefore keyless.

A hosted base URL with no key produces a clear `400 AI_NOT_CONFIGURED` rather
than an obscure auth failure.

---

## 5. Validation, repair, and JSON-block fallback

- **Native tool calls** are validated before execution (`validateResumePatch`,
  `validateCoverLetterPatch`, `validateCreateTemplateArgs`). On failure the loop
  makes **one** repair attempt: it sends the validation error back and asks the
  model to re-issue the call. If the repair fails, the error is returned to the
  model as a tool result and the turn continues; it never crashes.
- **Fallback JSON blocks** go through the same validators. A malformed block gets
  the same single repair pass; if that fails it is discarded and noted.
- `create_template` re-runs `validateTemplateSchema` on the server before writing
  anything, so an invalid generated document is rejected and never rendered.
- Malformed tool-argument JSON never throws — it becomes a parse-error marker
  that triggers the repair path.

---

## 6. Configuration precedence and variable names

Environment variables **override** `settings.json`. The server loads `.env.local`
first, then `.env`.

| Variable | Scope |
|---|---|
| `AI_PROVIDER` | Any provider. Also inferred if a provider-specific key is set. |
| `AI_BASE_URL` | Any provider. |
| `AI_MODEL` | Any provider. |
| `AI_API_KEY` | Any provider. |
| `AI_TEMPERATURE` | Any provider (number). |
| `AI_MAX_TOKENS` | Any provider (number). |
| `OPENAI_BASE_URL` | `openai-compatible` only. |
| `OPENAI_MODEL` | `openai-compatible` only. |
| `OPENAI_API_KEY` | `openai-compatible` only. |
| `ANTHROPIC_API_KEY` | `anthropic` only. |
| `ANTHROPIC_MODEL` | `anthropic` only. |
| `GEMINI_API_KEY` | `gemini` only. |
| `GEMINI_MODEL` | `gemini` only. |

Provider resolution order: an explicit `AI_PROVIDER` wins; otherwise a set
provider key implies a provider (`AI_API_KEY`/`OPENAI_API_KEY` →
`openai-compatible`, then `ANTHROPIC_API_KEY` → `anthropic`, then
`GEMINI_API_KEY` → `gemini`); otherwise the saved provider; otherwise the
default, `openai-compatible`. The UI reports which fields came from the
environment so they are shown as read-only.

---

## 7. Key handling

- The key is stored in `settings.json`, which is **git-ignored**, or supplied via
  the environment.
- It is **never returned to the client in plaintext**. `GET /api/settings`
  returns a masked form (`maskKey`: the first four and last four characters, e.g.
  `sk-...4f2a`) and a `hasApiKey` boolean.
- Echoing the masked value back in a settings update does not overwrite the real
  key.
- Obvious placeholders (`YOUR_API_KEY_HERE`, `<key>`, `changeme`, …) are treated
  as "not configured", so a template value produces the actionable
  `AI_NOT_CONFIGURED` rather than a confusing `401`.

---

## 8. Adding a new provider

Write one adapter file under `server/ai/adapters/`, implementing the
`ProviderAdapter` interface from `server/ai/types.ts`:

```ts
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
```

Then register it in `server/ai/adapters/index.ts`:

```ts
const ADAPTERS: ProviderAdapter[] = [openaiAdapter, anthropicAdapter, geminiAdapter];
```

That is the whole change. The adapter's job is to:

1. Build the provider's request from the neutral `ChatRequest` (use the
   `postJson` helper in `server/ai/adapters/shared.ts` for the fetch, timeout
   and error mapping).
2. Map the neutral `ProviderAdapter` tool schemas with a converter of its own
   (add one to `server/ai/schema.ts` alongside the existing three).
3. Return `{ text, toolCalls }` in the neutral `ChatResponse` shape, parsing tool
   calls via `parseToolArgs` where applicable.

Adapters must translate transport and HTTP failures into `AIError` codes
(`AI_AUTH`, `AI_RATE_LIMIT`, `AI_UNREACHABLE`, `AI_TIMEOUT`, `AI_BAD_RESPONSE`,
…), which the routes map to HTTP statuses (`server/ai/types.ts`,
`AI_ERROR_STATUS`). No adapter may throw a raw error at the route.

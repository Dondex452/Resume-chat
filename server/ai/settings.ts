import fs from 'fs';
import path from 'path';
import type { CapabilityTier, ProviderConfig } from './types';
import { AIError } from './types';
import { findAdapter } from './adapters/index';

export interface PublicSettings {
  provider: string;
  baseURL: string;
  model: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  apiKeySource: 'env' | 'file' | 'none';
  capability: CapabilityTier;
  capabilityCheckedAt: string | null;
  envOverridden: string[];
  updatedAt: string | null;
}

export interface SettingsPatch {
  provider?: string;
  baseURL?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  capability?: CapabilityTier;
  capabilityCheckedAt?: string | null;
}

export interface SettingsOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
}

interface StoredSettings {
  provider?: string;
  baseURL?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  capability?: CapabilityTier;
  capabilityCheckedAt?: string | null;
  /**
   * Fingerprint of the provider|baseURL|model the stored capability was probed
   * against. Internal only — never part of PublicSettings, never contains the
   * API key. A capability whose key no longer matches the resolved config is
   * treated as unknown (see loadSettings).
   */
  capabilityKey?: string;
  updatedAt?: string | null;
}

interface ResolvedSettings {
  provider: string;
  baseURL: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  apiKeySource: 'env' | 'file' | 'none';
  envOverridden: string[];
  stored: StoredSettings;
}

const DEFAULT_PROVIDER = 'openai-compatible';
const CAPABILITY_TIERS: CapabilityTier[] = ['full', 'fallback', 'chat-only', 'unknown'];

function defaultSettingsPath(): string {
  return path.join(process.cwd(), 'settings.json');
}

// --- tiny file cache ---------------------------------------------------------

let cachedPath: string | null = null;
let cachedStored: StoredSettings = {};

export function clearCache(): void {
  cachedPath = null;
  cachedStored = {};
}

function readStored(filePath: string): StoredSettings {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as StoredSettings;
    return {};
  } catch {
    // Missing or corrupt file must never throw.
    return {};
  }
}

function getStored(filePath: string): StoredSettings {
  if (cachedPath === filePath) return cachedStored;
  cachedStored = readStored(filePath);
  cachedPath = filePath;
  return cachedStored;
}

// --- helpers -----------------------------------------------------------------

function firstEnv(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/**
 * Obvious placeholder credentials (`YOUR_GEMINI_API_KEY_HERE`, `<insert-key>`,
 * `changeme`, …) are not usable keys. Treating them as unset produces the
 * actionable AI_NOT_CONFIGURED state instead of a confusing 401, and prevents
 * accidentally shipping a template value as if it were a real credential.
 */
export function isPlaceholderKey(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (/^[<{\[]/.test(v)) return true; // <YOUR_KEY>, {{key}}, [key]
  if (/^(your|my|insert|replace|change|placeholder|example|dummy|todo|sample)[-_ ]/i.test(v)) return true;
  if (/your[-_ ]?(api[-_ ]?key|key|gemini|openai|anthropic|token|secret)/i.test(v)) return true;
  if (/^(changeme|change_me|placeholder|xxx+|\.\.\.)$/i.test(v)) return true;
  return false;
}

/** Like firstEnv, but ignores placeholder-looking values. */
function firstEnvKey(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  const value = firstEnv(env, ...names);
  if (value === undefined) return undefined;
  return isPlaceholderKey(value) ? undefined : value;
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function maskKey(key?: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••••';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/** True for loopback / private / *.local endpoints that need no API key. */
export function isLocalEndpoint(baseURL: string): boolean {
  if (!baseURL) return false;
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(host)) return true;
    if (host.endsWith('.local') || host.endsWith('.internal')) return true;
    if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

function providerSpecificModelEnv(provider: string): string | undefined {
  if (provider === 'openai-compatible') return 'OPENAI_MODEL';
  if (provider === 'anthropic') return 'ANTHROPIC_MODEL';
  if (provider === 'gemini') return 'GEMINI_MODEL';
  return undefined;
}

function providerSpecificKeyEnv(provider: string): string | undefined {
  if (provider === 'openai-compatible') return 'OPENAI_API_KEY';
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (provider === 'gemini') return 'GEMINI_API_KEY';
  return undefined;
}

function resolve(opts?: SettingsOptions): ResolvedSettings {
  const env = opts?.env ?? process.env;
  const filePath = opts?.path ?? defaultSettingsPath();
  const stored = getStored(filePath);

  // --- provider (env beats file; keys can imply a provider) ---
  const explicitProvider = firstEnv(env, 'AI_PROVIDER');
  const hasAIKey = !!firstEnvKey(env, 'AI_API_KEY');
  const hasOpenAIKey = !!firstEnvKey(env, 'OPENAI_API_KEY');
  const hasAnthropicKey = !!firstEnvKey(env, 'ANTHROPIC_API_KEY');
  const hasGeminiKey = !!firstEnvKey(env, 'GEMINI_API_KEY');

  let provider: string;
  let providerFromEnv = false;
  if (explicitProvider) {
    provider = explicitProvider;
    providerFromEnv = true;
  } else if (hasAIKey || hasOpenAIKey) {
    provider = 'openai-compatible';
    providerFromEnv = true;
  } else if (hasAnthropicKey) {
    provider = 'anthropic';
    providerFromEnv = true;
  } else if (hasGeminiKey) {
    provider = 'gemini';
    providerFromEnv = true;
  } else if (stored.provider) {
    provider = stored.provider;
  } else {
    provider = DEFAULT_PROVIDER;
  }

  const adapter = findAdapter(provider);

  // --- baseURL ---
  const aiBaseURL = firstEnv(env, 'AI_BASE_URL');
  const openAIBaseURL = provider === 'openai-compatible' ? firstEnv(env, 'OPENAI_BASE_URL') : undefined;
  const baseURL = aiBaseURL ?? openAIBaseURL ?? stored.baseURL ?? adapter?.defaultBaseURL ?? '';

  // --- model ---
  const aiModel = firstEnv(env, 'AI_MODEL');
  const modelEnvName = providerSpecificModelEnv(provider);
  const providerModel = modelEnvName ? firstEnv(env, modelEnvName) : undefined;
  const model = aiModel ?? providerModel ?? stored.model ?? adapter?.defaultModel ?? '';

  // --- api key ---
  const aiKey = firstEnvKey(env, 'AI_API_KEY');
  const keyEnvName = providerSpecificKeyEnv(provider);
  const providerKey = keyEnvName ? firstEnvKey(env, keyEnvName) : undefined;
  let apiKey: string | undefined;
  let apiKeySource: 'env' | 'file' | 'none';
  if (aiKey) {
    apiKey = aiKey;
    apiKeySource = 'env';
  } else if (providerKey) {
    apiKey = providerKey;
    apiKeySource = 'env';
  } else if (stored.apiKey) {
    apiKey = stored.apiKey;
    apiKeySource = 'file';
  } else {
    apiKey = undefined;
    apiKeySource = 'none';
  }

  // --- numeric overrides ---
  const temperature = toNumber(firstEnv(env, 'AI_TEMPERATURE')) ?? stored.temperature;
  const maxTokens = toNumber(firstEnv(env, 'AI_MAX_TOKENS')) ?? stored.maxTokens;

  // --- what came from env (so the UI can disable those fields) ---
  const envOverridden: string[] = [];
  if (explicitProvider || (providerFromEnv && !stored.provider)) envOverridden.push('provider');
  if (aiBaseURL || openAIBaseURL) envOverridden.push('baseURL');
  if (aiModel || providerModel) envOverridden.push('model');
  if (aiKey || providerKey) envOverridden.push('apiKey');

  return {
    provider,
    baseURL,
    model,
    apiKey,
    temperature,
    maxTokens,
    apiKeySource,
    envOverridden,
    stored,
  };
}

function normalizeCapability(value: unknown): CapabilityTier {
  return typeof value === 'string' && (CAPABILITY_TIERS as string[]).includes(value)
    ? (value as CapabilityTier)
    : 'unknown';
}

/**
 * Stable, readable fingerprint of the configuration a capability probe ran
 * against. Deliberately concatenated rather than hashed so a mismatched record
 * is diagnosable when inspecting the settings file. It never contains the key.
 */
export function capabilityKeyFor(provider: string, baseURL: string, model: string): string {
  return `${provider}|${baseURL}|${model}`;
}

export function loadSettings(opts?: SettingsOptions): PublicSettings {
  const r = resolve(opts);

  // A stored capability is only trustworthy while its fingerprint still
  // describes the *currently resolved* config. A settings change — by file
  // edit, by PUT /api/settings, or by an env override silently changing the
  // effective provider/baseURL/model — must not resurrect a stale tier.
  const currentKey = capabilityKeyFor(r.provider, r.baseURL, r.model);
  const storedKey = typeof r.stored.capabilityKey === 'string' ? r.stored.capabilityKey : '';
  const capabilityFresh = storedKey !== '' && storedKey === currentKey;

  return {
    provider: r.provider,
    baseURL: r.baseURL,
    model: r.model,
    apiKeyMasked: maskKey(r.apiKey),
    hasApiKey: !!r.apiKey,
    apiKeySource: r.apiKeySource,
    capability: capabilityFresh ? normalizeCapability(r.stored.capability) : 'unknown',
    capabilityCheckedAt: capabilityFresh ? (r.stored.capabilityCheckedAt ?? null) : null,
    envOverridden: r.envOverridden,
    updatedAt: r.stored.updatedAt ?? null,
  };
}

export function resolveConfig(opts?: SettingsOptions): ProviderConfig {
  const r = resolve(opts);
  const adapter = findAdapter(r.provider);
  if (!adapter) {
    throw new AIError('AI_NOT_CONFIGURED', `Unknown AI provider "${r.provider}". Configure a supported provider.`, {
      provider: r.provider,
    });
  }

  // Hosted endpoints always need a key; local endpoints may omit it.
  const hostedEndpoint = /^https?:\/\//i.test(r.baseURL) && !isLocalEndpoint(r.baseURL);
  const needsKey = adapter.requiresApiKey || hostedEndpoint;
  if (needsKey && !r.apiKey) {
    throw new AIError(
      'AI_NOT_CONFIGURED',
      `No API key is configured for provider "${r.provider}". Add one in Settings, or set ${providerSpecificKeyEnv(r.provider) || 'AI_API_KEY'} in the environment.`,
      { provider: r.provider },
    );
  }

  return {
    provider: r.provider,
    baseURL: r.baseURL,
    model: r.model,
    apiKey: r.apiKey,
    temperature: r.temperature,
    maxTokens: r.maxTokens,
  };
}

export function saveSettings(patch: SettingsPatch, opts?: SettingsOptions): PublicSettings {
  const filePath = opts?.path ?? defaultSettingsPath();
  // Snapshot the effective config *before* the patch so "did it actually
  // change?" is judged against what is in force (env overrides included), not
  // against a possibly-absent stored value.
  const before = resolve(opts);
  const stored: StoredSettings = { ...getStored(filePath) };

  const providerChanged = patch.provider !== undefined && patch.provider !== before.provider;
  const baseURLChanged = patch.baseURL !== undefined && patch.baseURL !== before.baseURL;
  const modelChanged = patch.model !== undefined && patch.model !== before.model;
  const configChanged = providerChanged || baseURLChanged || modelChanged;
  const suppliesCapability = patch.capability !== undefined;

  if (patch.provider !== undefined) stored.provider = patch.provider;
  if (patch.baseURL !== undefined) stored.baseURL = patch.baseURL;
  if (patch.model !== undefined) stored.model = patch.model;
  if (patch.temperature !== undefined) stored.temperature = patch.temperature;
  if (patch.maxTokens !== undefined) stored.maxTokens = patch.maxTokens;

  if (suppliesCapability) {
    // Probe-then-persist: the caller ran the probe against the new config, so
    // the supplied capability is authoritative and must survive the change.
    stored.capability = patch.capability;
    if (patch.capabilityCheckedAt !== undefined) stored.capabilityCheckedAt = patch.capabilityCheckedAt;
  } else if (configChanged) {
    // The probe result describes a config that is no longer in force.
    stored.capability = 'unknown';
    stored.capabilityCheckedAt = null;
    delete stored.capabilityKey;
  }

  if (patch.apiKey !== undefined) {
    const currentMasked = maskKey(before.apiKey);
    if (patch.apiKey === '') {
      delete stored.apiKey;
    } else if (currentMasked && patch.apiKey === currentMasked) {
      // Echoing the masked form back must never overwrite the real key.
    } else {
      stored.apiKey = patch.apiKey;
    }
  }

  // Publish the patched record to the cache so `resolve` fingerprints the
  // effective config *after* the patch, then write once.
  cachedPath = filePath;
  cachedStored = stored;
  if (suppliesCapability) {
    const after = resolve(opts);
    stored.capabilityKey = capabilityKeyFor(after.provider, after.baseURL, after.model);
  }

  stored.updatedAt = new Date().toISOString();

  fs.writeFileSync(filePath, JSON.stringify(stored, null, 2), 'utf-8');
  cachedPath = filePath;
  cachedStored = stored;

  return loadSettings(opts);
}

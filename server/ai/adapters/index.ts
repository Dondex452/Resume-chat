import type { ProviderAdapter } from '../types';
import { AIError } from '../types';
import { openaiAdapter } from './openai';
import { anthropicAdapter } from './anthropic';
import { geminiAdapter } from './gemini';

const ADAPTERS: ProviderAdapter[] = [openaiAdapter, anthropicAdapter, geminiAdapter];

const ADAPTER_MAP: Record<string, ProviderAdapter> = Object.fromEntries(
  ADAPTERS.map((adapter) => [adapter.id, adapter]),
);

export function findAdapter(id: string): ProviderAdapter | undefined {
  return ADAPTER_MAP[id];
}

export function getAdapter(id: string): ProviderAdapter {
  const adapter = ADAPTER_MAP[id];
  if (!adapter) {
    throw new AIError('AI_PROVIDER_ERROR', `Unknown AI provider: ${id}`, { provider: id });
  }
  return adapter;
}

export interface ProviderInfo {
  id: string;
  label: string;
  defaultBaseURL: string;
  defaultModel: string;
  requiresApiKey: boolean;
  suggestedModels: string[];
}

export function listProviders(): ProviderInfo[] {
  return ADAPTERS.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    defaultBaseURL: adapter.defaultBaseURL,
    defaultModel: adapter.defaultModel,
    requiresApiKey: adapter.requiresApiKey,
    suggestedModels: adapter.suggestedModels,
  }));
}

export function listAdapters(): ProviderAdapter[] {
  return ADAPTERS;
}

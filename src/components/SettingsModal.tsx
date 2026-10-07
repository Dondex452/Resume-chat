/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  KeyRound,
  RefreshCw,
  Zap
} from 'lucide-react';
import { ProviderInfo, PublicSettings, CapabilityTier } from '../types';
import {
  Banner,
  Button,
  CapabilityPill,
  Input,
  Modal,
  Select,
  cn
} from './ui';
import { CAPABILITY_LABELS } from './ui/CapabilityPill';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: (s: PublicSettings) => void;
}

interface TestResult {
  ok: boolean;
  capability?: CapabilityTier;
  latencyMs?: number;
  code?: string;
  error?: string;
  message?: string;
  provider?: string;
  model?: string;
}

const inputClass = 'text-sm px-3 py-2';
const labelClass = 'mb-1 block text-meta font-medium text-text-muted';

export default function SettingsModal({ open, onClose, onSaved }: SettingsModalProps) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Form state
  const [provider, setProvider] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [baseURLEdited, setBaseURLEdited] = useState(false);
  const [modelEdited, setModelEdited] = useState(false);

  // Request state
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const providerRef = useRef<HTMLSelectElement>(null);

  const selectedProvider = providers.find((p) => p.id === provider) || null;
  const defaultBaseURL = selectedProvider?.defaultBaseURL || '';
  const defaultModel = selectedProvider?.defaultModel || '';
  const suggestedModels = selectedProvider?.suggestedModels || [];

  const envOverridden = Array.isArray(settings?.envOverridden) ? settings!.envOverridden : [];
  const apiKeyEnv = settings?.apiKeySource === 'env' || envOverridden.includes('apiKey');
  const hasApiKey = !!settings?.hasApiKey;

  const applySettings = (s: PublicSettings, providerList: ProviderInfo[]) => {
    setSettings(s);
    setProvider(s.provider || '');
    const info = providerList.find((p) => p.id === s.provider) || null;
    setBaseURL(s.baseURL || info?.defaultBaseURL || '');
    setModel(s.model || info?.defaultModel || '');
    setBaseURLEdited(false);
    setModelEdited(false);
  };

  const loadAll = async () => {
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    setTestResult(null);
    setSaved(false);
    setApiKey('');
    setClearKey(false);
    try {
      const [pRes, sRes] = await Promise.all([fetch('/api/providers'), fetch('/api/settings')]);
      let pJson: unknown = null;
      let sJson: unknown = null;
      try {
        pJson = await pRes.json();
      } catch {
        pJson = null;
      }
      try {
        sJson = await sRes.json();
      } catch {
        sJson = null;
      }

      const list = Array.isArray(pJson) ? (pJson as ProviderInfo[]) : [];
      if (!pRes.ok || list.length === 0) {
        const detail = (pJson as { error?: string } | null)?.error;
        setProviders([]);
        setLoading(false);
        setLoadError(
          detail ||
            `Could not load providers (HTTP ${pRes.status}). The AI provider backend may not be running yet.`
        );
        return;
      }
      setProviders(list);

      if (!sRes.ok || !sJson || typeof (sJson as PublicSettings).provider !== 'string') {
        const detail = (sJson as { error?: string } | null)?.error;
        // Providers loaded — still show the form using provider defaults.
        const fallbackProvider = list[0];
        setSettings(null);
        setProvider(fallbackProvider.id);
        setBaseURL(fallbackProvider.defaultBaseURL);
        setModel(fallbackProvider.defaultModel);
        setBaseURLEdited(false);
        setModelEdited(false);
        setLoadError(
          detail ||
            `Could not load current settings (HTTP ${sRes.status}). You can still fill the form and save.`
        );
        setLoading(false);
        return;
      }

      applySettings(sJson as PublicSettings, list);
      setLoading(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setProviders([]);
      setLoading(false);
      setLoadError(`Could not reach the settings API: ${message}`);
    }
  };

  useEffect(() => {
    if (open) {
      void loadAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Autofocus first field once loaded (the Modal primitive owns Escape + focus restore)
  useEffect(() => {
    if (open && !loading && providers.length > 0) {
      providerRef.current?.focus();
    }
  }, [open, loading, providers.length]);

  if (!open) return null;

  const handleProviderChange = (id: string) => {
    setProvider(id);
    const info = providers.find((p) => p.id === id);
    if (info) {
      if (!baseURLEdited) setBaseURL(info.defaultBaseURL);
      if (!modelEdited) setModel(info.defaultModel);
    }
    setSaved(false);
    setTestResult(null);
    setActionError(null);
  };

  const handleResetDefaults = () => {
    setBaseURL(defaultBaseURL);
    setModel(defaultModel);
    setBaseURLEdited(false);
    setModelEdited(false);
    setSaved(false);
    setTestResult(null);
  };

  const effectiveBaseURL = baseURL.trim() || defaultBaseURL;
  const effectiveModel = model.trim() || defaultModel;

  const buildApiKeyField = (): { include: boolean; value?: string } => {
    if (apiKeyEnv) return { include: false };
    if (clearKey) return { include: true, value: '' };
    if (apiKey.trim()) return { include: true, value: apiKey.trim() };
    return { include: false };
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setActionError(null);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = {};
      if (!envOverridden.includes('provider') && provider) body.provider = provider;
      if (!envOverridden.includes('baseURL')) body.baseURL = effectiveBaseURL;
      if (!envOverridden.includes('model')) body.model = effectiveModel;
      const keyField = buildApiKeyField();
      if (keyField.include) body.apiKey = keyField.value;

      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok || !data || typeof (data as PublicSettings).provider !== 'string') {
        const detail =
          (data as { error?: string } | null)?.error || `Save failed (HTTP ${res.status}).`;
        setActionError(detail);
        return;
      }
      const updated = data as PublicSettings;
      applySettings(updated, providers);
      setApiKey('');
      setClearKey(false);
      setSaved(true);
      onSaved?.(updated);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    setActionError(null);
    try {
      const body: Record<string, unknown> = {
        provider,
        baseURL: effectiveBaseURL,
        model: effectiveModel
      };
      const keyField = buildApiKeyField();
      if (keyField.include) body.apiKey = keyField.value;

      const res = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!data || typeof (data as TestResult).ok !== 'boolean') {
        setTestResult({
          ok: false,
          code: 'AI_BAD_RESPONSE',
          error: `Connection test returned an unexpected response (HTTP ${res.status}).`
        });
        return;
      }
      const result = data as TestResult;
      setTestResult(result);

      if (result.ok) {
        // Refresh saved state so the capability badge reflects the probe result.
        try {
          const sRes = await fetch('/api/settings');
          let sJson: unknown = null;
          try {
            sJson = await sRes.json();
          } catch {
            sJson = null;
          }
          if (sRes.ok && sJson && typeof (sJson as PublicSettings).provider === 'string') {
            const fresh = sJson as PublicSettings;
            applySettings(fresh, providers);
            onSaved?.(fresh);
          }
        } catch {
          // Non-fatal: the inline test result is still shown.
        }
      }
    } catch (err) {
      setTestResult({
        ok: false,
        code: 'AI_UNREACHABLE',
        error: err instanceof Error ? err.message : 'Could not reach the settings API.'
      });
    } finally {
      setTesting(false);
    }
  };

  const capability = settings?.capability || 'unknown';
  const busy = saving || testing;

  const renderEnvNote = (field: string) =>
    envOverridden.includes(field) ? (
      <p className="mt-1 flex items-center gap-1.5 text-meta">
        <span className="h-1.5 w-1.5 shrink-0 rounded-button bg-warning" aria-hidden="true" />
        Set by the AI_* environment variable
      </p>
    ) : null;

  const providerEnv = envOverridden.includes('provider');
  const baseURLEnv = envOverridden.includes('baseURL');
  const modelEnv = envOverridden.includes('model');

  const footer = (
    <>
      <div className="flex items-center gap-1.5 text-sm text-text-body">
        {saved && (
          <>
            <CheckCircle2 size={14} className="text-success" />
            <span>Saved</span>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button size="xs" variant="outline" onClick={onClose} disabled={busy}>
          Close
        </Button>
        <Button
          size="xs"
          variant="white"
          loading={testing}
          startIcon={<Zap size={12} />}
          onClick={() => void handleTest()}
          disabled={busy || providers.length === 0}
        >
          Test connection
        </Button>
        <Button
          size="xs"
          loading={saving}
          onClick={() => void handleSave()}
          disabled={busy || providers.length === 0}
        >
          Save
        </Button>
      </div>
    </>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="AI provider settings"
      icon={<KeyRound size={16} />}
      ariaLabel="AI provider settings"
      widthClassName="max-w-lg"
      footer={footer}
    >
      <div className="space-y-4">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-text-muted">
            <Loader2 size={16} className="animate-spin text-primary" />
            <span>Loading provider configuration…</span>
          </div>
        )}

        {!loading && loadError && (
          <Banner
            tone="warn"
            action={
              <Button
                size="xs"
                variant="ghost"
                startIcon={<RefreshCw size={11} />}
                onClick={() => void loadAll()}
              >
                Retry
              </Button>
            }
          >
            {loadError}
          </Banner>
        )}

        {!loading && providers.length === 0 && !loadError && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-text-muted">
            <AlertCircle size={14} />
            <span>No providers available.</span>
          </div>
        )}

        {!loading && providers.length > 0 && (
          <>
            {/* Capability badge */}
            <CapabilityPill
              tier={capability}
              label={CAPABILITY_LABELS[capability]}
              checkedAt={settings?.capabilityCheckedAt}
              icon
            />

            {/* Provider */}
            <div>
              <label htmlFor="ai-provider" className={labelClass}>
                Provider
              </label>
              <Select
                id="ai-provider"
                ref={providerRef}
                value={provider}
                onChange={(e) => handleProviderChange(e.target.value)}
                disabled={providerEnv}
                className={inputClass}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
              {renderEnvNote('provider')}
            </div>

            {/* Base URL */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label htmlFor="ai-base-url" className={cn(labelClass, 'mb-0')}>
                  Base URL
                </label>
                {!baseURLEnv && !modelEnv && (
                  <button
                    type="button"
                    onClick={handleResetDefaults}
                    className="text-meta font-medium text-primary transition-colors duration-200 hover:text-primary-active cursor-pointer"
                  >
                    Reset to defaults
                  </button>
                )}
              </div>
              <Input
                id="ai-base-url"
                type="text"
                value={baseURL}
                placeholder={defaultBaseURL || 'https://api.example.com/v1'}
                disabled={baseURLEnv}
                onChange={(e) => {
                  setBaseURL(e.target.value);
                  setBaseURLEdited(true);
                  setSaved(false);
                }}
                className={inputClass}
              />
              {renderEnvNote('baseURL')}
            </div>

            {/* Model */}
            <div>
              <label htmlFor="ai-model" className={labelClass}>
                Model
              </label>
              <Input
                id="ai-model"
                type="text"
                value={model}
                list="ai-model-suggestions"
                placeholder={defaultModel || 'model-id'}
                disabled={modelEnv}
                onChange={(e) => {
                  setModel(e.target.value);
                  setModelEdited(true);
                  setSaved(false);
                }}
                className={inputClass}
              />
              <datalist id="ai-model-suggestions">
                {suggestedModels.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {suggestedModels.length > 0 && !modelEnv && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {suggestedModels.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        setModel(m);
                        setModelEdited(true);
                        setSaved(false);
                      }}
                      className={cn(
                        'rounded-button border px-2.5 py-0.5 text-meta transition-colors duration-200 cursor-pointer',
                        model === m
                          ? 'border-primary-border bg-primary-soft font-medium text-primary'
                          : 'border-border bg-surface text-text-muted hover:border-primary-border hover:text-primary'
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
              {renderEnvNote('model')}
            </div>

            {/* API key */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label htmlFor="ai-api-key" className={cn(labelClass, 'mb-0')}>
                  API key
                </label>
                {apiKeyEnv ? (
                  <span className="rounded-button border border-border bg-page-alt px-2 py-0.5 text-meta text-text-muted">
                    Set by environment
                  </span>
                ) : (
                  hasApiKey && (
                    <button
                      type="button"
                      onClick={() => {
                        if (clearKey) {
                          setClearKey(false);
                        } else {
                          setClearKey(true);
                          setApiKey('');
                        }
                        setSaved(false);
                      }}
                      className={cn(
                        'text-meta font-medium transition-colors duration-200 cursor-pointer',
                        clearKey ? 'text-text-muted hover:text-text-heading' : 'text-danger hover:text-danger/80'
                      )}
                    >
                      {clearKey ? 'Keep stored key' : 'Clear stored key'}
                    </button>
                  )
                )}
              </div>
              <Input
                id="ai-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                disabled={apiKeyEnv || clearKey}
                placeholder={
                  apiKeyEnv
                    ? 'Managed by environment'
                    : clearKey
                    ? 'Stored key will be cleared'
                    : hasApiKey
                    ? settings?.apiKeyMasked || '••••••••'
                    : 'Paste your API key'
                }
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setSaved(false);
                }}
                className={inputClass}
              />
              {clearKey && (
                <p className="mt-1 flex items-center gap-1.5 text-meta">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-button bg-danger" aria-hidden="true" />
                  The stored key will be removed when you save.
                </p>
              )}
              {!apiKeyEnv && !clearKey && hasApiKey && (
                <p className="mt-1 text-meta">Leave blank to keep the existing key.</p>
              )}
            </div>
          </>
        )}

        {/* Action error */}
        {actionError && <Banner tone="danger" role="alert">{actionError}</Banner>}

        {/* Test result */}
        {testResult && (
          <Banner tone={testResult.ok ? 'success' : 'danger'} role={testResult.ok ? 'status' : 'alert'}>
            {testResult.ok ? (
              <>
                <p className="font-semibold">
                  Connection OK: {CAPABILITY_LABELS[testResult.capability || 'unknown']}
                </p>
                <p className="mt-0.5 text-meta">
                  {testResult.provider}
                  {testResult.model ? ` · ${testResult.model}` : ''}
                  {typeof testResult.latencyMs === 'number' ? ` · ${testResult.latencyMs}ms` : ''}
                </p>
                {testResult.message && <p className="mt-0.5 text-meta">{testResult.message}</p>}
              </>
            ) : (
              <>
                <p className="font-semibold">Connection failed: {testResult.code || 'AI_PROVIDER_ERROR'}</p>
                <p className="mt-0.5 text-meta">{testResult.error || 'The provider could not be reached.'}</p>
              </>
            )}
          </Banner>
        )}
      </div>
    </Modal>
  );
}

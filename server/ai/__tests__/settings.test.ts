import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadSettings, saveSettings, resolveConfig, maskKey, clearCache } from '../settings';
import { AIError } from '../types';

function tmpSettingsPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-ai-settings-'));
  return path.join(dir, 'settings.json');
}

test('maskKey: empty, short, and long keys', () => {
  assert.equal(maskKey(undefined), '');
  assert.equal(maskKey(''), '');
  assert.equal(maskKey('short'), '••••••');
  assert.equal(maskKey('12345678'), '••••••');
  assert.equal(maskKey('sk-abcdefgh1234'), 'sk-a...1234');
});

test('env overrides file values (AI_* wins)', () => {
  clearCache();
  const p = tmpSettingsPath();
  fs.writeFileSync(
    p,
    JSON.stringify({
      provider: 'openai-compatible',
      baseURL: 'https://file.example/v1',
      model: 'file-model',
      apiKey: 'file-key-123456',
    }),
  );
  const pub = loadSettings({ path: p, env: { AI_MODEL: 'env-model', AI_API_KEY: 'env-key-123456' } });
  assert.equal(pub.model, 'env-model');
  assert.equal(pub.hasApiKey, true);
  assert.equal(pub.apiKeySource, 'env');
  assert.equal(pub.apiKeyMasked, maskKey('env-key-123456'));
  assert.ok(pub.envOverridden.includes('model'));
  assert.ok(pub.envOverridden.includes('apiKey'));
  // The plaintext key must never be exposed by the public shape.
  assert.ok(!JSON.stringify(pub).includes('env-key-123456'));
});

test('a bare GEMINI_API_KEY selects the gemini provider (GOTCHAS #1 fix)', () => {
  clearCache();
  const p = tmpSettingsPath();
  const env = { GEMINI_API_KEY: 'gemini-key-abcdef' };
  const pub = loadSettings({ path: p, env });
  assert.equal(pub.provider, 'gemini');
  assert.equal(pub.hasApiKey, true);
  assert.equal(pub.apiKeySource, 'env');

  const cfg = resolveConfig({ path: p, env });
  assert.equal(cfg.provider, 'gemini');
  assert.equal(cfg.apiKey, 'gemini-key-abcdef');
  assert.ok(cfg.baseURL.includes('generativelanguage.googleapis.com'));
});

test('provider-specific model/key env vars are used for the inferred provider', () => {
  clearCache();
  const p = tmpSettingsPath();
  const pub = loadSettings({
    path: p,
    env: { OPENAI_API_KEY: 'sk-openai-abcdef', OPENAI_MODEL: 'gpt-4o' },
  });
  assert.equal(pub.provider, 'openai-compatible');
  assert.equal(pub.model, 'gpt-4o');
  assert.equal(pub.apiKeySource, 'env');
});

test('apiKey patch semantics: undefined / "" / value / masked echo', () => {
  clearCache();
  const p = tmpSettingsPath();
  const opts = { path: p, env: {} as NodeJS.ProcessEnv };

  saveSettings(
    { provider: 'openai-compatible', baseURL: 'https://api.openai.com/v1', model: 'm', apiKey: 'sk-realkey-1234' },
    opts,
  );

  // undefined -> unchanged
  saveSettings({ model: 'm2' }, opts);
  assert.equal(resolveConfig(opts).apiKey, 'sk-realkey-1234');

  // masked echo -> unchanged
  saveSettings({ apiKey: maskKey('sk-realkey-1234') }, opts);
  assert.equal(resolveConfig(opts).apiKey, 'sk-realkey-1234');

  // '' -> cleared
  saveSettings({ apiKey: '' }, opts);
  assert.equal(loadSettings(opts).hasApiKey, false);

  // value -> set
  saveSettings({ apiKey: 'sk-newkey-9999' }, opts);
  assert.equal(resolveConfig(opts).apiKey, 'sk-newkey-9999');
});

test('saveSettings never writes the masked value as the real key', () => {
  clearCache();
  const p = tmpSettingsPath();
  const opts = { path: p, env: {} as NodeJS.ProcessEnv };
  const pub = saveSettings({ apiKey: 'sk-realkey-1234' }, opts);
  assert.equal(pub.apiKeyMasked, 'sk-r...1234');
  const onDisk = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assert.equal(onDisk.apiKey, 'sk-realkey-1234');
  assert.notEqual(onDisk.apiKey, pub.apiKeyMasked);
});

test('placeholder env keys are treated as not configured', () => {
  clearCache();
  const p = tmpSettingsPath();
  const env = { GEMINI_API_KEY: 'YOUR_GEMINI_API_KEY_HERE' };
  const pub = loadSettings({ path: p, env });
  assert.equal(pub.hasApiKey, false);
  assert.equal(pub.apiKeySource, 'none');
  assert.equal(pub.provider, 'openai-compatible');
  assert.throws(
    () => resolveConfig({ path: p, env }),
    (err: unknown) => err instanceof AIError && err.code === 'AI_NOT_CONFIGURED',
  );
});

test('missing and corrupt settings files are tolerated', () => {
  clearCache();
  const missing = path.join(os.tmpdir(), `resume-ai-missing-${Date.now()}`, 'settings.json');
  assert.doesNotThrow(() => loadSettings({ path: missing, env: {} }));
  const missingPub = loadSettings({ path: missing, env: {} });
  assert.equal(missingPub.provider, 'openai-compatible');

  clearCache();
  const p = tmpSettingsPath();
  fs.writeFileSync(p, '{ this is not json');
  const corrupt = loadSettings({ path: p, env: {} });
  assert.equal(corrupt.provider, 'openai-compatible');
  assert.equal(corrupt.hasApiKey, false);
});

test('resolveConfig throws AI_NOT_CONFIGURED when no key is available', () => {
  clearCache();
  const p = tmpSettingsPath();
  assert.throws(
    () => resolveConfig({ path: p, env: {} }),
    (err: unknown) => err instanceof AIError && err.code === 'AI_NOT_CONFIGURED',
  );
});

test('local openai-compatible endpoints need no key', () => {
  clearCache();
  const p = tmpSettingsPath();
  fs.writeFileSync(
    p,
    JSON.stringify({ provider: 'openai-compatible', baseURL: 'http://localhost:11434/v1', model: 'llama3.1' }),
  );
  const cfg = resolveConfig({ path: p, env: {} });
  assert.equal(cfg.apiKey, undefined);
  assert.equal(cfg.baseURL, 'http://localhost:11434/v1');
});

test('loadSettings reports capability and updatedAt from disk', () => {
  clearCache();
  const p = tmpSettingsPath();
  const opts = { path: p, env: {} as NodeJS.ProcessEnv };
  saveSettings({ provider: 'openai-compatible', model: 'm', capability: 'fallback', capabilityCheckedAt: '2026-01-01T00:00:00.000Z' }, opts);
  const pub = loadSettings(opts);
  assert.equal(pub.capability, 'fallback');
  assert.equal(pub.capabilityCheckedAt, '2026-01-01T00:00:00.000Z');
  assert.ok(pub.updatedAt);
});

// ---------------------------------------------------------------------------
// Stale-capability defence (M8 follow-up): a stored probe result must not
// outlive the configuration it was measured against.
// ---------------------------------------------------------------------------

const CAP_CHECKED_AT = '2026-01-01T00:00:00.000Z';

function probeConfig(opts: { path: string; env: NodeJS.ProcessEnv }) {
  saveSettings(
    {
      provider: 'openai-compatible',
      baseURL: 'https://a.example/v1',
      model: 'm',
      capability: 'full',
      capabilityCheckedAt: CAP_CHECKED_AT,
    },
    opts,
  );
  assert.equal(loadSettings(opts).capability, 'full');
}

test('changing baseURL invalidates a stored capability', () => {
  clearCache();
  const p = tmpSettingsPath();
  const opts = { path: p, env: {} as NodeJS.ProcessEnv };
  probeConfig(opts);

  const pub = saveSettings({ baseURL: 'https://b.example/v1' }, opts);
  assert.equal(pub.capability, 'unknown');
  assert.equal(pub.capabilityCheckedAt, null);

  // Invalidation is persisted, not merely returned.
  clearCache();
  assert.equal(loadSettings(opts).capability, 'unknown');
});

test('changing model invalidates a stored capability', () => {
  clearCache();
  const p = tmpSettingsPath();
  const opts = { path: p, env: {} as NodeJS.ProcessEnv };
  probeConfig(opts);

  const pub = saveSettings({ model: 'm2' }, opts);
  assert.equal(pub.capability, 'unknown');
  assert.equal(pub.capabilityCheckedAt, null);
});

test('changing provider invalidates a stored capability', () => {
  clearCache();
  const p = tmpSettingsPath();
  const opts = { path: p, env: {} as NodeJS.ProcessEnv };
  probeConfig(opts);

  const pub = saveSettings({ provider: 'anthropic' }, opts);
  assert.equal(pub.provider, 'anthropic');
  assert.equal(pub.capability, 'unknown');
  assert.equal(pub.capabilityCheckedAt, null);
});

test('re-saving an identical config does not invalidate a stored capability', () => {
  clearCache();
  const p = tmpSettingsPath();
  const opts = { path: p, env: {} as NodeJS.ProcessEnv };
  probeConfig(opts);

  const pub = saveSettings(
    { provider: 'openai-compatible', baseURL: 'https://a.example/v1', model: 'm' },
    opts,
  );
  assert.equal(pub.capability, 'full');
  assert.equal(pub.capabilityCheckedAt, CAP_CHECKED_AT);

  // An unrelated field (apiKey) is likewise not a config change.
  const afterKey = saveSettings({ apiKey: 'sk-realkey-1234' }, opts);
  assert.equal(afterKey.capability, 'full');
});

test('persisting a capability in the same call as a config change keeps the new capability', () => {
  clearCache();
  const p = tmpSettingsPath();
  const opts = { path: p, env: {} as NodeJS.ProcessEnv };
  probeConfig(opts);

  const checkedAt = '2026-02-02T00:00:00.000Z';
  const pub = saveSettings(
    { baseURL: 'https://b.example/v1', model: 'm2', capability: 'fallback', capabilityCheckedAt: checkedAt },
    opts,
  );
  assert.equal(pub.capability, 'fallback');
  assert.equal(pub.capabilityCheckedAt, checkedAt);

  // The new key is written against the *new* config, so a restart preserves it.
  clearCache();
  const reread = loadSettings(opts);
  assert.equal(reread.capability, 'fallback');
  assert.equal(reread.capabilityCheckedAt, checkedAt);
});

test('a capability whose stored key does not match the resolved config reads back as unknown', () => {
  clearCache();
  const p = tmpSettingsPath();
  fs.writeFileSync(
    p,
    JSON.stringify({
      provider: 'openai-compatible',
      baseURL: 'https://a.example/v1',
      model: 'm',
      apiKey: undefined,
      capability: 'full',
      capabilityCheckedAt: CAP_CHECKED_AT,
      capabilityKey: 'openai-compatible|https://something-else/v1|m',
    }),
  );

  const pub = loadSettings({ path: p, env: {} });
  assert.equal(pub.capability, 'unknown');
  assert.equal(pub.capabilityCheckedAt, null);
  // The internal fingerprint must never leak into the public shape.
  assert.ok(!Object.prototype.hasOwnProperty.call(pub, 'capabilityKey'));
  assert.ok(!JSON.stringify(pub).includes('capabilityKey'));
});

test('an env-var provider override makes a mismatched stored capability read back as unknown', () => {
  clearCache();
  const p = tmpSettingsPath();
  const fileOpts = { path: p, env: {} as NodeJS.ProcessEnv };
  probeConfig(fileOpts);

  // The file still says openai-compatible, but env now forces gemini.
  const env = { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'gemini-key-abcdef' } as NodeJS.ProcessEnv;
  const pub = loadSettings({ path: p, env });
  assert.equal(pub.provider, 'gemini');
  assert.equal(pub.capability, 'unknown');
  assert.equal(pub.capabilityCheckedAt, null);
});

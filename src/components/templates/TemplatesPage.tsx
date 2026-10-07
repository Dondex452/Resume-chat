/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * TemplatesPage — the `#/templates` page (PRD §5.5, Decision #23).
 *
 * Template *work* is deliberately its own surface, separate from the studio.
 * This page owns the gallery: the ten built-in designs (read-only — the
 * affordance is Clone, never Edit) and the user's own stored templates, with
 * clone / rename / delete / export / import (PRD §5.5).
 *
 * M11 Stage B adds the **describe-and-generate** entry point (PRD §5.5(a)):
 * one text line in, one `TemplateSchema` out. It is written against the frozen
 * `/api/templates` contract below plus one clearly-marked seam.
 *
 * Honesty rules that shape this file:
 *   - Nothing here mounts `PreviewPaper` or a `[data-resume-paper]` element, so
 *     the studio's export path can never pick up a template thumbnail
 *     (GOTCHA #24).
 *   - The server is the only authority on schema validity. An imported document
 *     — or a generated one the server rejected — is reported with the server's
 *     own `errors[]`; this page never decides for itself, and never renders a
 *     broken design (PRD §5.5 "never rendered broken").
 *   - No provider configured is stated plainly, with the studio's own copy and
 *     an "Open AI settings" action — never a dead control (PRD §5.2).
 *   - M12 Stage A adds the **structural** editor (`TemplateEditor`) behind the
 *     Edit action on a custom row: reorder, move column, toggle visibility, all
 *     against the schema's own vocabulary, with a live preview. Only a custom
 *     row has that affordance — a built-in is read-only, so it offers Clone and
 *     nothing else (PRD §5.5). What the editor deliberately does *not* do is tune
 *     design tokens, and it says so in one plain line rather than offering a
 *     control that would write nothing (see `TemplateEditor`).
 *
 * API contract (frozen — do not invent endpoints):
 *   GET    /api/templates                  -> row[] newest first
 *   POST   /api/templates { name, origin?, schema }
 *   GET    /api/templates/:id
 *   PUT    /api/templates/:id { name?, schema? }
 *   DELETE /api/templates/:id              -> { ok: true }
 *   POST   /api/templates/import { json }  -> 201 row | 400 { errors[] }
 *
 * Generation, today — the marked seam
 *   There is no dedicated one-shot generation endpoint yet (the backend's
 *   `create_template` tool is a chat tool, PRD §9). This page therefore runs the
 *   turn in a **throwaway session** (approach (b)): `POST /api/sessions`, then
 *   `POST /api/sessions/:id/messages`, then the session is deleted in `finally`.
 *   It never reuses an unrelated session id, and it reports a save by diffing
 *   `GET /api/templates` before and after the turn. When the backend exposes a
 *   dedicated route, `handleGenerate` is the single place to swap it in —
 *   nothing else on this page knows how generation is wired.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  FileUp,
  FolderOpen,
  Loader2,
  Pencil,
  RefreshCw,
  Send,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X
} from 'lucide-react';
import { Banner, Button, EmptyState, Input, Textarea } from '../ui';
import SettingsModal from '../SettingsModal';
import { describeAiError } from '../aiErrorCopy';
import TemplateThumb from '../TemplateThumb';
import TemplateEditor from './TemplateEditor';
import { A4_HEIGHT, A4_WIDTH } from '../PreviewPaper';
import { TEMPLATES } from '../../templates';
import { getBuiltinTemplateSchema } from '../../templates/builtin';
import { validateTemplateSchema, type TemplateSchema } from '../../templates/schema';
import type { CapabilityTier } from '../../types';

/** Rendered thumbnail widths. Fixed px because a thumbnail has nothing to observe. */
const BUILTIN_THUMB_WIDTH = 160;
const ROW_THUMB_WIDTH = 112;
const ROW_THUMB_HEIGHT = Math.round((ROW_THUMB_WIDTH * A4_HEIGHT) / A4_WIDTH);

type TemplateOrigin = 'generated' | 'cloned';

/** A row as returned by `GET /api/templates`. */
interface StoredTemplate {
  id: string;
  name: string;
  origin: TemplateOrigin;
  /** Serialised `TemplateSchema`. */
  schema_json: string;
  created_at?: string;
  updated_at?: string;
}

interface Notice {
  tone: 'success' | 'warn' | 'danger';
  message: string;
  /** The server's `errors[]`, verbatim, when it rejected a document. */
  details?: string[];
  /** Show the studio's "Open AI settings" action (provider / auth failures). */
  settingsAction?: boolean;
}

/** The provider facts this page needs from `GET /api/settings`. */
interface ProviderStatus {
  hasApiKey: boolean;
  capability: CapabilityTier;
}

/** A capped snippet of the user's description, for the throwaway session title. */
function sessionTitleFor(description: string): string {
  const oneLine = description.replace(/\s+/g, ' ').trim().slice(0, 60);
  return `[template] ${oneLine}`;
}

/**
 * The turn this page sends. It is deliberately a plain request, not a tool
 * name: whichever model is configured decides how to satisfy it (native
 * `create_template` call, or the JSON-block fallback — PRD §5.2/§9).
 */
function buildTemplatePrompt(description: string): string {
  return `Create a new resume template from this description and save it as a template: "${description}"`;
}

/** `res.json()` never throws into the caller — a non-JSON body is `null`. */
async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function asErrorList(data: any): string[] | undefined {
  if (!data || !Array.isArray(data.errors)) return undefined;
  const list = data.errors.map((e: unknown) => String(e));
  return list.length > 0 ? list : undefined;
}

/** Filename-safe slug for the exported `.json`. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'template';
}

function originLabel(origin: TemplateOrigin): string {
  return origin === 'generated' ? 'Origin: generated' : 'Origin: cloned';
}

/**
 * The page's 72px chrome, shared by the gallery and the structural editor so
 * the two views cannot drift apart. It is pure — it owns no state and takes the
 * one navigation callback (PRD §19.10 rule 1: a product surface stays flat and
 * light; no gradient ramp, no account chrome).
 */
function TemplatePageHeader({ onOpenStudio }: { onOpenStudio: () => void }) {
  return (
    <header className="sticky top-0 z-30 h-header border-b border-border-soft bg-surface shadow-app-header">
      <div className="mx-auto flex h-full max-w-content-xl items-center gap-3 px-4">
        <a
          href="#/"
          title="Back to home"
          className="flex min-h-11 min-w-0 items-center gap-2.5 rounded-nav px-1 py-1 transition-colors duration-200 ease-in-out hover:bg-tint"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-button bg-primary text-white">
            <Sparkles size={16} aria-hidden="true" />
          </span>
          {/* Below `sm` the wordmark is dropped so the nav actions keep their
              space — the brand glyph still links home. */}
          <span className="hidden min-w-0 sm:block">
            <span className="block truncate font-heading text-sm font-medium leading-tight text-text-heading">
              AI Conversational CV Suite
            </span>
            <span className="type-meta hidden leading-tight lg:block">Template suite</span>
          </span>
        </a>

        <nav className="ml-auto flex shrink-0 items-center gap-1" aria-label="Template page navigation">
          {/* The brand doubles as the home link below `sm`; the explicit link
              appears only when there is room for it. */}
          <a
            href="#/"
            className="hidden min-h-11 items-center rounded-nav px-3 font-heading text-sm font-medium text-text-muted transition-colors duration-200 ease-in-out hover:bg-tint hover:text-text-heading sm:inline-flex"
          >
            Home
          </a>
          <a
            href="#/studio"
            aria-label="Back to studio"
            title="Back to studio"
            className="inline-flex min-h-11 items-center gap-2 rounded-nav px-3 font-heading text-sm font-medium text-text-muted transition-colors duration-200 ease-in-out hover:bg-tint hover:text-text-heading"
          >
            <ArrowLeft size={15} aria-hidden="true" />
            <span className="hidden sm:inline">Back to studio</span>
          </a>
          <Button size="md" className="min-h-11" onClick={onOpenStudio}>
            Open studio
          </Button>
        </nav>
      </div>
    </header>
  );
}

/** The page's closing band — states the read-only rule, offers the way back. */
function TemplatePageFooter({ onOpenStudio }: { onOpenStudio: () => void }) {
  return (
    <footer className="border-t border-border-soft bg-surface">
      <div className="mx-auto flex max-w-content-xl flex-wrap items-center justify-between gap-3 px-4 py-5">
        <p className="type-meta">
          Built-in designs are read-only. Cloning always creates a new, editable template.
        </p>
        <Button size="xs" variant="outline" startIcon={<ArrowLeft size={13} aria-hidden="true" />} onClick={onOpenStudio}>
          Back to studio
        </Button>
      </div>
    </footer>
  );
}

export interface TemplatesPageProps {
  /** Navigate to the studio (`#/studio`). */
  onOpenStudio: () => void;
}

export default function TemplatesPage({ onOpenStudio }: TemplatesPageProps) {
  const [rows, setRows] = useState<StoredTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** One in-flight operation at a time, keyed (`clone:<id>`, `rename:<id>`, …). */
  const [busy, setBusy] = useState<string | null>(null);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // M12 Stage A — the structural editor (PRD §5.5b). Only a custom row can be
  // edited; a built-in has no Edit affordance at all (PRD §5.5 read-only rule).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editErrors, setEditErrors] = useState<string[] | null>(null);

  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteValue, setPasteValue] = useState('');

  // M11 Stage B — describe-and-generate (PRD §5.5a).
  const [description, setDescription] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genNotice, setGenNotice] = useState<Notice | null>(null);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);

  /** Fetch the template rows, validating shape (GOTCHA #15). Throws on failure. */
  const fetchTemplateRows = useCallback(async (): Promise<StoredTemplate[]> => {
    const res = await fetch('/api/templates');
    const data = await readJson(res);
    // GOTCHA #15: in dev an unmatched `/api/*` path returns `index.html` with
    // HTTP 200, so shape — not status — is the honest signal.
    if (!res.ok || !Array.isArray(data)) {
      throw new Error(
        `The template service responded with an unexpected shape (HTTP ${res.status}).`
      );
    }
    return data as StoredTemplate[];
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setRows(await fetchTemplateRows());
    } catch (err) {
      setRows([]);
      setLoadError(
        err instanceof Error ? err.message : 'Could not load your templates.'
      );
    } finally {
      setLoading(false);
    }
  }, [fetchTemplateRows]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * The provider state the page needs to speak honestly *before* a submit.
   * This mirrors the studio's own rule (App.tsx `getAiNotice`): no key means no
   * structured generation. The response is shape-checked, so a missing route
   * (GOTCHA #15) reads as "unknown" rather than "configured".
   */
  const refreshProviderStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      const data = await readJson(res);
      if (!res.ok || !data || typeof data !== 'object' || typeof data.provider !== 'string') {
        setProviderStatus(null);
        return;
      }
      setProviderStatus({
        hasApiKey: data.hasApiKey === true,
        capability: (data.capability as CapabilityTier) || 'unknown'
      });
    } catch {
      setProviderStatus(null);
    }
  }, []);

  useEffect(() => {
    refreshProviderStatus();
  }, [refreshProviderStatus]);

  /** Parse + validate each row's stored schema. Invalid rows render a notice. */
  const schemaById = useMemo(() => {
    const map: Record<string, TemplateSchema | null> = {};
    for (const row of rows) {
      try {
        const result = validateTemplateSchema(JSON.parse(row.schema_json));
        map[row.id] = result.ok ? result.schema : null;
      } catch {
        map[row.id] = null;
      }
    }
    return map;
  }, [rows]);

  /**
   * The row being edited and its parsed schema. Both are derived from `rows`, so
   * a successful save — which replaces the row with the server's response —
   * re-syncs the editor's draft against the persisted document.
   */
  const editingRow = editingId ? rows.find((row) => row.id === editingId) ?? null : null;
  const editingSchema = editingRow ? schemaById[editingRow.id] ?? null : null;

  /**
   * Persist the editor's edited schema (M12, PRD §5.5b). The server is the only
   * validator: a 400 returns its own `errors[]`, which the editor renders
   * verbatim rather than inventing a message. Resolves `true` only on an
   * accepted write, so the editor's "saved" state cannot lie.
   */
  const handleSaveTemplate = async (schema: TemplateSchema): Promise<boolean> => {
    if (!editingRow) return false;
    setSavingEdit(true);
    setEditErrors(null);
    try {
      const res = await fetch(`/api/templates/${editingRow.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schema })
      });
      const data = await readJson(res);
      if (res.ok && data && typeof data.id === 'string') {
        setRows((current) => current.map((row) => (row.id === data.id ? data : row)));
        setNotice({ tone: 'success', message: `Saved “${editingRow.name}”.` });
        return true;
      }
      setEditErrors(
        asErrorList(data) ?? [data?.error || `Could not save the template (HTTP ${res.status}).`]
      );
      return false;
    } catch (err) {
      setEditErrors([
        err instanceof Error
          ? `Could not reach the server: ${err.message}`
          : 'Could not reach the server.'
      ]);
      return false;
    } finally {
      setSavingEdit(false);
    }
  };

  const handleClone = async (schema: TemplateSchema, name: string, busyKey: string) => {
    setBusy(busyKey);
    setNotice(null);
    try {
      const res = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${name} (copy)`, origin: 'cloned', schema })
      });
      const data = await readJson(res);
      if (res.ok && data && typeof data.id === 'string') {
        setNotice({ tone: 'success', message: `Cloned “${name}”.` });
        await load();
      } else {
        setNotice({
          tone: 'danger',
          message: data?.error || `Could not clone “${name}” (HTTP ${res.status}).`,
          details: asErrorList(data)
        });
      }
    } catch (err) {
      setNotice({
        tone: 'danger',
        message: err instanceof Error ? `Could not reach the server: ${err.message}` : 'Could not reach the server.'
      });
    } finally {
      setBusy(null);
    }
  };

  const startRename = (row: StoredTemplate) => {
    setRenamingId(row.id);
    setRenameValue(row.name);
    setDeletingId(null);
    setNotice(null);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };

  const commitRename = async (row: StoredTemplate) => {
    const name = renameValue.trim();
    if (!name) return;
    const busyKey = `rename:${row.id}`;
    setBusy(busyKey);
    setNotice(null);
    try {
      const res = await fetch(`/api/templates/${row.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await readJson(res);
      if (res.ok && data && typeof data.id === 'string') {
        setNotice({ tone: 'success', message: `Renamed to “${name}”.` });
        setRenamingId(null);
        setRenameValue('');
        await load();
      } else {
        setNotice({
          tone: 'danger',
          message: data?.error || `Could not rename the template (HTTP ${res.status}).`,
          details: asErrorList(data)
        });
      }
    } catch (err) {
      setNotice({
        tone: 'danger',
        message: err instanceof Error ? `Could not reach the server: ${err.message}` : 'Could not reach the server.'
      });
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (row: StoredTemplate) => {
    const busyKey = `delete:${row.id}`;
    setBusy(busyKey);
    setNotice(null);
    try {
      const res = await fetch(`/api/templates/${row.id}`, { method: 'DELETE' });
      const data = await readJson(res);
      if (res.ok) {
        setNotice({ tone: 'success', message: `Deleted “${row.name}”.` });
        setDeletingId(null);
        await load();
      } else {
        setNotice({
          tone: 'danger',
          message: data?.error || `Could not delete the template (HTTP ${res.status}).`
        });
      }
    } catch (err) {
      setNotice({
        tone: 'danger',
        message: err instanceof Error ? `Could not reach the server: ${err.message}` : 'Could not reach the server.'
      });
    } finally {
      setBusy(null);
    }
  };

  /** §5.5 portability: one template is one `.json` file. No dependency. */
  const handleExport = (row: StoredTemplate) => {
    const schema = schemaById[row.id];
    if (!schema) {
      setNotice({
        tone: 'danger',
        message: `“${row.name}” could not be read, so it cannot be exported.`
      });
      return;
    }
    const blob = new Blob([JSON.stringify(schema, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${slugify(row.name)}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setNotice({ tone: 'success', message: `Exported “${row.name}”.` });
  };

  /**
   * Import forwards the raw document to the server and renders its verdict.
   * A file that is not JSON at all is caught here; schema validity is the
   * server's call and its `errors[]` is shown verbatim on a 400.
   */
  const handleImportText = async (text: string, sourceLabel: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      JSON.parse(trimmed);
    } catch {
      setNotice({ tone: 'danger', message: `${sourceLabel} is not valid JSON.` });
      return;
    }
    setBusy('import');
    setNotice(null);
    try {
      const res = await fetch('/api/templates/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: trimmed })
      });
      const data = await readJson(res);
      if (res.ok && data && typeof data.id === 'string') {
        setNotice({ tone: 'success', message: `Imported “${data.name ?? 'template'}”.` });
        setPasteValue('');
        setPasteOpen(false);
        await load();
      } else {
        setNotice({
          tone: 'danger',
          message: data?.error || `The template was rejected (HTTP ${res.status}).`,
          details: asErrorList(data)
        });
      }
    } catch (err) {
      setNotice({
        tone: 'danger',
        message: err instanceof Error ? `Could not reach the server: ${err.message}` : 'Could not reach the server.'
      });
    } finally {
      setBusy(null);
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset first so selecting the same file twice still fires a change.
    event.target.value = '';
    if (!file) return;
    const text = await file.text();
    await handleImportText(text, `“${file.name}”`);
  };

  /**
   * Describe-and-generate (PRD §5.5a). The marked seam for how generation is
   * wired — see the file header. There is no dedicated generation endpoint yet,
   * so the turn runs in a throwaway session that is deleted in `finally`; the
   * page never borrows an unrelated session id. A save is reported by diffing
   * `GET /api/templates` before and after the turn, so the new row appears in
   * "Your templates" with no manual reload.
   */
  const handleGenerate = async (event: React.FormEvent) => {
    event.preventDefault();
    const descriptionText = description.trim();
    if (!descriptionText || generating) return;

    setGenerating(true);
    setGenNotice(null);

    const beforeIds = new Set(rows.map((row) => row.id));
    let sessionId: string | null = null;

    try {
      const sessionRes = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: sessionTitleFor(descriptionText) })
      });
      const sessionData = await readJson(sessionRes);
      if (!sessionRes.ok || !sessionData || typeof sessionData.id !== 'string') {
        setGenNotice({
          tone: 'danger',
          message: describeAiError({
            code: 'AI_BAD_RESPONSE',
            message: `Could not start a generation session (HTTP ${sessionRes.status}).`
          })
        });
        return;
      }
      sessionId = sessionData.id;

      const messageRes = await fetch(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: buildTemplatePrompt(descriptionText) })
      });
      const messageData = await readJson(messageRes);

      if (!messageRes.ok) {
        // The chat route's failure shape is `{ error, code }` (PRD §5.2). The
        // copy comes from the same table the studio uses — never a second one.
        const code = typeof messageData?.code === 'string' ? messageData.code : 'AI_PROVIDER_ERROR';
        const rawMessage = typeof messageData?.error === 'string' ? messageData.error : '';
        setGenNotice({
          tone: 'danger',
          message: describeAiError({ code, message: rawMessage }),
          details: asErrorList(messageData),
          settingsAction: code === 'AI_NOT_CONFIGURED' || code === 'AI_AUTH'
        });
        return;
      }

      // GOTCHA #15: shape, not status, is the honest signal.
      if (
        !messageData ||
        !messageData.session ||
        typeof messageData.session.id !== 'string' ||
        !Array.isArray(messageData.messages)
      ) {
        setGenNotice({
          tone: 'danger',
          message: describeAiError({
            code: 'AI_BAD_RESPONSE',
            message: `Generation returned an unexpected response (HTTP ${messageRes.status}).`
          })
        });
        return;
      }

      // Did the turn actually persist a template? Diff, rather than trusting
      // prose (the server is the only authority on what was saved).
      let after: StoredTemplate[];
      try {
        after = await fetchTemplateRows();
      } catch {
        setGenNotice({
          tone: 'warn',
          message:
            'The assistant finished, but your template list could not be refreshed. Reload the page to see whether a template was saved.'
        });
        return;
      }
      setRows(after);
      const created = after.filter((row) => !beforeIds.has(row.id));
      if (created.length > 0) {
        setGenNotice({
          tone: 'success',
          message: `Created “${created[0].name}” — it is in your templates below.`
        });
        setDescription('');
      } else {
        setGenNotice({
          tone: 'warn',
          message:
            'The assistant replied but did not save a template. Try describing the layout more concretely — for example “two columns, navy sidebar, serif headings”.'
        });
      }
    } catch (err) {
      setGenNotice({
        tone: 'danger',
        message: describeAiError({
          code: 'AI_UNREACHABLE',
          message:
            err instanceof Error
              ? `Could not reach the server: ${err.message}`
              : 'Could not reach the server.'
        })
      });
    } finally {
      // The throwaway session must not outlive the turn — even on failure
      // (GOTCHA #26). A failed cleanup is harmless: the template itself is
      // stored separately, so it must never mask the generation result.
      if (sessionId) {
        try {
          await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
        } catch {
          /* best-effort cleanup */
        }
      }
      setGenerating(false);
    }
  };

  const importBusy = busy === 'import';
  /**
   * The server often repeats its first validation error as the top-level
   * `error`, so the list is filtered against the message to avoid stating the
   * same sentence twice.
   */
  const noticeDetails = notice ? (notice.details ?? []).filter((d) => d !== notice.message) : [];
  const genNoticeDetails = genNotice
    ? (genNotice.details ?? []).filter((d) => d !== genNotice.message)
    : [];

  /**
   * The honest pre-submit state. Mirrors the studio's `getAiNotice`, including
   * its copy — which comes from `describeAiError`, the one vocabulary this app
   * has. `null` means "nothing to say" (configured, or the state is unknown).
   */
  const providerAdvisory = useMemo(() => {
    if (!providerStatus) return null;
    if (!providerStatus.hasApiKey) {
      return {
        tone: 'warn' as const,
        text: describeAiError({ code: 'AI_NOT_CONFIGURED', message: '' })
      };
    }
    if (providerStatus.capability === 'chat-only') {
      return {
        tone: 'danger' as const,
        text: 'This model can converse but cannot create structured templates. Switch to a tool-calling model in AI settings.'
      };
    }
    return null;
  }, [providerStatus]);

  // ---- M12 Stage A: the structural editor view ---------------------------
  // Rendered instead of the gallery so the drag surface has the room it needs
  // (PRD §19.10 rule 4 — the canvas is the hero). Every hook is above this
  // point, so the early return is safe and the gallery's effects stay dormant.
  if (editingRow && editingSchema) {
    return (
      <div className="min-h-screen overflow-x-clip bg-page-app font-body text-text-body">
        <TemplatePageHeader onOpenStudio={onOpenStudio} />
        <main className="mx-auto max-w-content-xl px-4 pb-16 pt-8 md:pt-10">
          <TemplateEditor
            name={editingRow.name}
            schema={editingSchema}
            saving={savingEdit}
            saveErrors={editErrors}
            onSave={handleSaveTemplate}
            onDismissErrors={() => setEditErrors(null)}
            onClose={() => {
              setEditingId(null);
              setEditErrors(null);
            }}
          />
        </main>
        <TemplatePageFooter onOpenStudio={onOpenStudio} />
      </div>
    );
  }

  return (
    <div className="min-h-screen overflow-x-clip bg-page-app font-body text-text-body">
      {/* 72px top bar — the same chrome height as every other surface (PRD §19.5).
          No gradient ramp, no account chrome: this is a product surface, so it
          stays flat and light (PRD §19.10 rule 1). Shared with the editor view. */}
      <TemplatePageHeader onOpenStudio={onOpenStudio} />

      <main className="mx-auto max-w-content-xl px-4 pb-16 pt-8 md:pt-10">
        <div className="max-w-content-sm">
          <h1 className="type-h3">Templates</h1>
          <p className="mt-2 text-text-muted">
            Ten designs ship with the app. Clone one, import a template file, or describe a new
            design in words — then reuse it in any resume session.
          </p>
        </div>

        {loadError && (
          <Banner
            tone="warn"
            role="status"
            className="mt-6"
            action={
              <Button
                size="xs"
                variant="ghost"
                startIcon={<RefreshCw size={11} aria-hidden="true" />}
                onClick={() => void load()}
              >
                Retry
              </Button>
            }
          >
            {loadError}
          </Banner>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Built-in designs — read-only. The affordance is Clone, not Edit.  */}
        {/* ---------------------------------------------------------------- */}
        <section aria-labelledby="builtin-templates-heading" className="mt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="builtin-templates-heading" className="type-h5">
              Built-in designs
            </h2>
            <p className="type-meta">Read-only — clone one to make it yours.</p>
          </div>

          <ul className="mt-6 grid grid-cols-2 justify-items-center gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {TEMPLATES.map((template) => {
              const busyKey = `clone:${template.id}`;
              return (
                <li key={template.id} className="flex w-full flex-col items-center gap-3">
                  <TemplateThumb
                    templateId={template.id}
                    width={BUILTIN_THUMB_WIDTH}
                    className="border-border"
                  />
                  <div className="flex w-full max-w-[220px] flex-col items-center">
                    <p className="text-center font-heading text-sm font-medium text-text-heading">
                      {template.name}
                    </p>
                    <Button
                      size="xs"
                      variant="outline"
                      className="mt-2"
                      startIcon={<Copy size={13} aria-hidden="true" />}
                      aria-label={`Clone ${template.name}`}
                      loading={busy === busyKey}
                      disabled={busy !== null && busy !== busyKey}
                      onClick={() =>
                        handleClone(getBuiltinTemplateSchema(template.id), template.name, busyKey)
                      }
                    >
                      Clone
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Your templates                                                   */}
        {/* ---------------------------------------------------------------- */}
        <section aria-labelledby="custom-templates-heading" className="mt-12">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="custom-templates-heading" className="type-h5">
              Your templates
            </h2>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={handleFileChange}
              />
              <Button
                size="xs"
                variant="outline"
                startIcon={<FileUp size={13} aria-hidden="true" />}
                loading={importBusy}
                disabled={busy !== null && busy !== 'import'}
                onClick={() => fileInputRef.current?.click()}
              >
                Import JSON file
              </Button>
            </div>
          </div>

          {/* M11 Stage B — the describe-and-generate entry point (PRD §5.5a).
              One line in, one template out. No modal and no new vocabulary:
              a failure is reported with the studio's own error copy
              (`../aiErrorCopy`), and a provider that is not configured says so
              up front rather than presenting a dead control. */}
          <div className="mt-5 rounded-card border border-border-soft bg-surface p-4 sm:p-5">
            <h3 className="type-h6">Describe a template</h3>
            <p className="mt-1.5 max-w-content-sm text-sm leading-relaxed text-text-muted">
              Say what the design should look like — layout, columns, colours, heading style —
              and the assistant drafts it and saves it to your collection.
            </p>

            <form onSubmit={handleGenerate} className="mt-4 flex flex-col gap-2 sm:flex-row">
              <Input
                type="text"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="e.g. clean two-column, navy sidebar, serif headings"
                aria-label="Describe the template you want"
                className="min-w-0 flex-1"
                disabled={generating}
              />
              <Button
                type="submit"
                size="lg"
                className="min-h-11 w-full sm:w-auto"
                startIcon={<Send size={16} aria-hidden="true" />}
                loading={generating}
                disabled={!description.trim()}
              >
                Generate
              </Button>
            </form>

            {/* In flight — the UI must never look frozen (PRD §6). */}
            {generating && (
              <p className="mt-3 flex items-center gap-2 text-sm text-text-muted" role="status">
                <Loader2 size={14} className="animate-spin text-primary" aria-hidden="true" />
                Drafting your template — this can take a moment.
              </p>
            )}

            {/* Result — the server's verdict, including its `errors[]`. */}
            {!generating && genNotice && (
              <Banner
                tone={genNotice.tone}
                role={genNotice.tone === 'danger' ? 'alert' : 'status'}
                className="mt-3"
                onDismiss={() => setGenNotice(null)}
                dismissLabel="Dismiss generation notice"
                action={
                  genNotice.settingsAction ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      startIcon={<Settings size={11} aria-hidden="true" />}
                      onClick={() => setSettingsOpen(true)}
                    >
                      Open AI settings
                    </Button>
                  ) : undefined
                }
              >
                <p>{genNotice.message}</p>
                {genNoticeDetails.length > 0 && (
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm">
                    {genNoticeDetails.map((detail, index) => (
                      <li key={`${index}-${detail}`}>{detail}</li>
                    ))}
                  </ul>
                )}
              </Banner>
            )}

            {/* Idle, no provider configured — stated plainly, never a dead
                control. Same copy and action as the studio's own notice. */}
            {!generating && !genNotice && providerAdvisory && (
              <Banner
                tone={providerAdvisory.tone}
                role="status"
                className="mt-3"
                action={
                  <Button
                    size="xs"
                    variant="ghost"
                    startIcon={<Settings size={11} aria-hidden="true" />}
                    onClick={() => setSettingsOpen(true)}
                  >
                    Open AI settings
                  </Button>
                }
              >
                {providerAdvisory.text}
              </Banner>
            )}
          </div>

          {/* Feedback lives with the section that owns the actions — every
              clone / rename / delete / import lands here, so the notice is
              never stranded far from the control that produced it. */}
          {notice && (
            <Banner
              tone={notice.tone}
              role={notice.tone === 'danger' ? 'alert' : 'status'}
              className="mt-4"
              onDismiss={() => setNotice(null)}
              dismissLabel="Dismiss notice"
            >
              <p>{notice.message}</p>
              {noticeDetails.length > 0 && (
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm">
                  {noticeDetails.map((detail, index) => (
                    <li key={`${index}-${detail}`}>{detail}</li>
                  ))}
                </ul>
              )}
            </Banner>
          )}

          {loading ? (
            <p className="mt-4 flex items-center gap-2 type-meta" role="status">
              <Loader2 size={14} className="animate-spin text-primary" aria-hidden="true" />
              Loading your templates…
            </p>
          ) : rows.length === 0 && !loadError ? (
            /* Only when the list genuinely loaded empty. After a failed load an
               empty list means "unknown", not "none" — the two are different
               sentences and must not be conflated. */
            <div className="mt-4">
              <EmptyState
                icon={<FolderOpen size={18} aria-hidden="true" />}
                title="No custom templates yet"
                description="Clone one of the designs above, import a template JSON file, or describe a design, to start your own collection. Templates you save here are available in every session."
              />
            </div>
          ) : rows.length === 0 ? null : (
            <ul className="mt-6 space-y-3">
              {rows.map((row) => {
                const schema = schemaById[row.id];
                const renameBusy = busy === `rename:${row.id}`;
                const deleteBusy = busy === `delete:${row.id}`;
                const cloneBusy = busy === `clone:${row.id}`;
                const rowBusy = renameBusy || deleteBusy || cloneBusy;

                return (
                  <li
                    key={row.id}
                    className="rounded-card border border-border-soft bg-surface p-3 sm:p-4"
                  >
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                      {schema ? (
                        <TemplateThumb
                          templateId={row.id}
                          schema={schema}
                          width={ROW_THUMB_WIDTH}
                          className="border-border"
                        />
                      ) : (
                        /* Never render a broken design: a row whose schema the
                           server let through but we cannot read says so. */
                        <div
                          className="flex shrink-0 items-center justify-center rounded-button border border-border bg-page-alt"
                          style={{ width: ROW_THUMB_WIDTH, height: ROW_THUMB_HEIGHT }}
                        >
                          <span className="type-meta px-2 text-center">Schema unreadable</span>
                        </div>
                      )}

                      <div className="min-w-0 flex-1">
                        {renamingId === row.id ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <Input
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitRename(row);
                                if (e.key === 'Escape') cancelRename();
                              }}
                              aria-label={`Rename ${row.name}`}
                              autoFocus
                              className="max-w-xs"
                            />
                            <Button
                              size="xs"
                              startIcon={<Check size={13} aria-hidden="true" />}
                              loading={renameBusy}
                              disabled={!renameValue.trim()}
                              onClick={() => commitRename(row)}
                            >
                              Save
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              iconOnly
                              aria-label="Cancel rename"
                              title="Cancel"
                              disabled={renameBusy}
                              onClick={cancelRename}
                            >
                              <X size={14} />
                            </Button>
                          </div>
                        ) : (
                          <>
                            <p className="truncate font-heading text-base font-medium text-text-heading">
                              {row.name}
                            </p>
                            {/* Plain text, not a badge — a badge would repeat
                                what the row already states (PRD §19.9.8). */}
                            <p className="type-meta mt-0.5">{originLabel(row.origin)}</p>
                          </>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0">
                        {deletingId === row.id ? (
                          <>
                            <span className="type-meta mr-1">Delete this template?</span>
                            <Button
                              size="xs"
                              variant="danger"
                              loading={deleteBusy}
                              onClick={() => handleDelete(row)}
                            >
                              Delete
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={deleteBusy}
                              onClick={() => setDeletingId(null)}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="xs"
                              variant="outline"
                              startIcon={<SlidersHorizontal size={13} aria-hidden="true" />}
                              aria-label={`Edit the structure of ${row.name}`}
                              disabled={rowBusy || !schema}
                              onClick={() => {
                                setEditingId(row.id);
                                setSavingEdit(false);
                                setEditErrors(null);
                                setNotice(null);
                                window.scrollTo({ top: 0 });
                              }}
                            >
                              Edit
                            </Button>
                            <Button
                              size="xs"
                              variant="outline"
                              startIcon={<Download size={13} aria-hidden="true" />}
                              aria-label={`Export ${row.name}`}
                              disabled={rowBusy || !schema}
                              onClick={() => handleExport(row)}
                            >
                              Export
                            </Button>
                            <Button
                              size="xs"
                              variant="outline"
                              startIcon={<Copy size={13} aria-hidden="true" />}
                              aria-label={`Clone ${row.name}`}
                              loading={cloneBusy}
                              disabled={!schema || (busy !== null && busy !== `clone:${row.id}`)}
                              onClick={() => schema && handleClone(schema, row.name, `clone:${row.id}`)}
                            >
                              Clone
                            </Button>
                            <Button
                              size="xs"
                              variant="outline"
                              startIcon={<Pencil size={13} aria-hidden="true" />}
                              aria-label={`Rename ${row.name}`}
                              disabled={rowBusy}
                              onClick={() => startRename(row)}
                            >
                              Rename
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              startIcon={<Trash2 size={13} aria-hidden="true" />}
                              aria-label={`Delete ${row.name}`}
                              disabled={rowBusy}
                              onClick={() => {
                                setDeletingId(row.id);
                                setRenamingId(null);
                                setNotice(null);
                              }}
                            >
                              Delete
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Paste path for a document copied from chat or a file browser. */}
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setPasteOpen((open) => !open)}
              aria-expanded={pasteOpen}
              aria-controls="template-paste-panel"
              className="cursor-pointer font-body text-sm font-medium text-primary transition-colors duration-200 ease-in-out hover:text-primary-active"
            >
              {pasteOpen ? 'Hide paste box' : 'Paste template JSON instead'}
            </button>

            {pasteOpen && (
              <div id="template-paste-panel" className="mt-3 flex flex-col gap-3">
                <Textarea
                  rows={6}
                  value={pasteValue}
                  onChange={(e) => setPasteValue(e.target.value)}
                  aria-label="Template JSON"
                  placeholder='{ "id": "…", "name": "…", "version": 1, … }'
                  spellCheck={false}
                  className="font-mono text-xs"
                />
                <div>
                  <Button
                    size="xs"
                    loading={importBusy}
                    disabled={!pasteValue.trim() || (busy !== null && busy !== 'import')}
                    onClick={() => handleImportText(pasteValue, 'The pasted text')}
                  >
                    Import pasted JSON
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Next stage — stated, not faked.                                   */}
        {/* ---------------------------------------------------------------- */}
        <section className="mt-12 rounded-card border border-dashed border-border-cool bg-page-alt p-5">
          <h2 className="type-h6">Design tokens are still fixed</h2>
          <p className="mt-2 max-w-content-sm text-sm leading-relaxed text-text-muted">
            The editor changes structure only — section order, column and visibility. Fonts,
            colours and spacing are not editable yet: each design carries its look as Tailwind
            class bundles inside its own data (PRD §10), so those values must first be resolved
            into semantic tokens before a control could meaningfully change them.
          </p>
        </section>
      </main>

      {/* Quick way back to the tool once a template is chosen. */}
      <TemplatePageFooter onOpenStudio={onOpenStudio} />

      {/* Provider settings, mounted here because this page is its own route and
          the studio's instance is not on screen. Saving re-reads the provider
          state from the saved payload so the notice above stays honest. */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={(saved) => {
          setGenNotice(null);
          setProviderStatus({ hasApiKey: saved.hasApiKey, capability: saved.capability });
        }}
      />
    </div>
  );
}

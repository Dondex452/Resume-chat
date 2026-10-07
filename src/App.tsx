/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Session,
  Message,
  ResumeJSON,
  PublicSettings,
  AiError
} from './types';
import { TEMPLATES, isResumeEmpty as isResumeDataEmpty } from './templates';
import { describeAiError } from './components/aiErrorCopy';
import SessionList from './components/SessionList';
import ChatArea, { type JobFetchOutcome, type UploadOutcome } from './components/ChatArea';
import CoverLetterView from './components/CoverLetterView';
import {
  PAGE_FORMATS,
  PAGE_ORIENTATIONS,
  parseStoredTemplates,
  resolveSessionRenderSchema,
  resolveTemplateSchema,
  type PaperFormat,
  type PageOrientation,
  type SelectableTemplate
} from './templates/customTemplates';
import type { TemplateSchema } from './templates/schema';
import {
  COUNTRY_PRESETS,
  getConformanceWarnings,
  getCountryPreset
} from './templates/countries';
import PreviewPaper from './components/PreviewPaper';
import TemplateThumb from './components/TemplateThumb';
import SettingsModal from './components/SettingsModal';
import HomePage from './components/home/HomePage';
import TemplatesPage from './components/templates/TemplatesPage';
import PrintView from './components/PrintView';
import {
  Download,
  Printer,
  FileCode,
  FileType,
  Sparkles,
  MessageSquare,
  FileText,
  Settings,
  Menu,
  PanelRight,
  ChevronDown,
  LayoutGrid,
  X
} from 'lucide-react';
import { Banner, Button, ToolTab } from './components/ui';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import { buildResumeDocxBlob } from './utils/resumeDocx';
import { buildResumeMarkdown } from './utils/resumeMarkdown';
import { resolveModernColorsForCapture } from './utils/resumeCapture';

/**
 * Disclosure id for the template picker panel. It is NOT a `role="menu"`:
 * the trigger uses `aria-expanded` + `aria-controls` (the disclosure pattern),
 * so do not re-add `aria-haspopup="true"` — that would promise a menu the panel
 * does not implement.
 */
const TEMPLATE_PICKER_ID = 'studio-template-picker';

/**
 * Disclosure id for the country-format picker. Same disclosure contract as the
 * template picker: `aria-expanded` + `aria-controls`, never `aria-haspopup`.
 */
const COUNTRY_PICKER_ID = 'studio-country-picker';

/**
 * Disclosure id for the page tool (M16 — size + orientation). Same disclosure
 * contract, same text rail, never `aria-haspopup` (GOTCHA #45: the panel is a
 * `role="group"`, not a menu).
 */
const PAGE_PICKER_ID = 'studio-page-picker';

/**
 * M16 — the raster fallback's page geometry (`html2canvas` → `jsPDF`).
 *
 * The fallback must export the **same shape** the text engine would have, or a
 * degraded export silently changes the document's page (PRD §11). jsPDF takes
 * its own format names and works in millimetres, and `imgWidth` is the width of
 * the page *in its chosen orientation*, so landscape pages pass the long edge.
 */
const PDF_FORMATS: Record<PaperFormat, { format: string; widthMm: number; heightMm: number }> = {
  A4: { format: 'a4', widthMm: 210, heightMm: 297 },
  Letter: { format: 'letter', widthMm: 215.9, heightMm: 279.4 },
  Legal: { format: 'legal', widthMm: 215.9, heightMm: 355.6 },
  A5: { format: 'a5', widthMm: 148, heightMm: 210 }
};

/**
 * Rendered width of a template thumbnail, shared by the picker gallery and the
 * empty-state preview. 150px is the largest width that still fits two columns
 * inside the panel at a 390px viewport without overflow, so one size serves
 * every breakpoint.
 */
const TEMPLATE_THUMB_WIDTH = 150;


/**
 * Hash routing (PRD §5.12) — no router dependency.
 * `#/studio` is the tool, `#/templates` is the template suite (Decision #23),
 * `#/print` is the M15 print view (PRD §11), and everything else (including an
 * empty hash) is Home.
 *
 * The match is exact: a cache-buster belongs in the search, never the hash
 * (GOTCHA #47). The print view's session id is read from the search for exactly
 * this reason — `#/print?session=x` would never match.
 */
type AppRoute = 'home' | 'studio' | 'templates' | 'print';

function readRoute(): AppRoute {
  const path = window.location.hash.replace(/^#/, '').toLowerCase();
  if (path === '/studio') return 'studio';
  if (path === '/templates') return 'templates';
  if (path === '/print') return 'print';
  return 'home';
}

/**
 * Derives the persistent AI status notice (M8). Returns null when the current
 * configuration needs no warning.
 */
function getAiNotice(s: PublicSettings | null): { tone: 'amber' | 'red'; text: string } | null {
  if (!s) return null;
  if (!s.hasApiKey) {
    return {
      tone: 'amber',
      text: 'No AI provider configured. Chat is unavailable until you add a provider and API key, or point the app at a local model.'
    };
  }
  if (s.capability === 'chat-only') {
    return {
      tone: 'red',
      text: 'This model can converse but cannot make structured resume updates. Chatting will not change your resume. Switch to a tool-calling model in AI settings.'
    };
  }
  return null;
}

/**
 * M14 — whether the viewport is at Tailwind's `xl` breakpoint (1280px), the width
 * at which the preview pane is the permanent sidebar rather than the
 * narrow-screen overlay.
 *
 * Why it exists: `renderPreviewPane()` is mounted twice (the `xl` aside and the
 * `<xl` overlay) and `display:none` does not unmount a subtree (GOTCHA #46), so
 * an open picker would otherwise render two copies of every template thumbnail.
 * The picker panels are now rendered only in the pane that can actually be seen.
 * No breakpoint override exists in `src/index.css`, so this matches Tailwind's
 * default `xl`.
 */
function useIsXlUp(): boolean {
  const query = '(min-width: 1280px)';
  const [isXlUp, setIsXlUp] = useState<boolean>(
    () => typeof window === 'undefined' || window.matchMedia(query).matches
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setIsXlUp(event.matches);
    setIsXlUp(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return isXlUp;
}

/**
 * M15 — the server PDF request's result.
 *
 * A plain object with nullable fields rather than a boolean-discriminated union:
 * this project compiles with `strictNullChecks: false`, under which a union
 * narrowed on a boolean does not narrow (GOTCHA #52). Same shape as the
 * ingestion outcomes in `ChatArea.tsx`.
 */
interface ServerPdfOutcome {
  ok: boolean;
  blob: Blob | null;
  filename: string | null;
  code: string | null;
  error: string | null;
}

/** Pull the download name out of `Content-Disposition` without decoding a path. */
function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="?([^";]+)"?/i.exec(header);
  const name = match?.[1]?.trim();
  return name ? name : null;
}

/** Save a blob under `filename`. The object URL is revoked after the click. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoke on the next task so the browser has started the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The honest explanation shown when the text-based PDF engine failed and the
 * raster fallback ran (PRD §11: "never silently ship a text-less PDF"). The
 * server's own message is appended because it is the actionable part — it names
 * the fallback and `RESUME_BROWSER_PATH`.
 */
function describePdfFallback(outcome: ServerPdfOutcome, pageCount: number | null): string {
  const headline =
    outcome.code === 'PDF_ENGINE_UNAVAILABLE'
      ? 'Text-based PDF export needs an installed Chrome or Edge, and none was found.'
      : outcome.code === 'PDF_RENDER_FAILED'
        ? 'The text-based PDF engine could not render this resume.'
        : 'The server PDF export could not be used.';
  const detail = outcome.error ? ` ${outcome.error}` : '';
  // M16: `html2canvas` can only capture one sheet, so a multi-page resume loses
  // its later pages. Say it plainly — a silent truncation is exactly the failure
  // the pagination work exists to prevent (PRD §11).
  const truncated =
    pageCount !== null && pageCount > 1
      ? ` It contains the first of ${pageCount} pages only.`
      : '';
  return (
    `${headline} Your PDF was exported from an image instead, so it has no ` +
    `selectable text and applicant-tracking systems may not read it.${truncated}${detail}`
  );
}

export default function App() {
  // Routing: Home is the landing page; the studio is `#/studio` (PRD §5.12).
  const [route, setRoute] = useState<AppRoute>(readRoute);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeTab, setActiveTab] = useState<'chat' | 'cover_letter'>('chat');
  const [selectedTemplateId, setSelectedTemplateId] = useState('minimal');
  const [isSending, setIsSending] = useState(false);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);

  // M14 — the user's own templates (PRD §5.5). Loaded once per studio mount, so a
  // session whose stored `template_id` is a custom template resolves on load —
  // for the preview AND the export path — not only after the picker is opened.
  const [customTemplates, setCustomTemplates] = useState<SelectableTemplate[]>([]);
  const [customTemplatesError, setCustomTemplatesError] = useState<string | null>(null);
  const [isLoadingCustomTemplates, setIsLoadingCustomTemplates] = useState(false);

  // M8 — AI provider configuration + chat error surfacing
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [settingsNoticeDismissed, setSettingsNoticeDismissed] = useState(false);
  const [chatError, setChatError] = useState<AiError | null>(null);
  // Export failures are surfaced as an inline Banner, never a blocking alert
  // (PRD §19.10; the studio reports state, it does not interrupt).
  const [exportError, setExportError] = useState<string | null>(null);
  // M15 — a *degraded* export (the server's text engine was unavailable and the
  // raster fallback ran) is a warning, not an error: the user still gets a PDF,
  // it simply has no text layer (PRD §11).
  const [pdfExportNotice, setPdfExportNotice] = useState<string | null>(null);
  // The server-side print takes seconds, not milliseconds. The button must show
  // progress rather than appear frozen (PRD §6).
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  // Session-list load failure and session mutation failure. Both are stated as
  // an inline Banner — a failed request must never be console-only (PRD §5.2
  // "clear and actionable, never silent").
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);

  // M8.5 — narrow-viewport chrome (drawer + preview overlay)
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Which preview mount is on screen — lets the expensive picker render once
  // instead of in both copies (GOTCHA #46).
  const isXlUp = useIsXlUp();

  // §19.10 — the studio's one template tool: a rail control that discloses an
  // aligned grid (never a chip cloud, never a modal).
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const templatePickerRef = useRef<HTMLDivElement>(null);
  const templateTriggerRef = useRef<HTMLButtonElement>(null);

  // M10 — the country-format tool. Same disclosure pattern, same rail.
  const [countryPickerOpen, setCountryPickerOpen] = useState(false);
  const countryTriggerRef = useRef<HTMLButtonElement>(null);

  // M16 — the page tool (size + orientation). Same disclosure pattern, same rail.
  const [pagePickerOpen, setPagePickerOpen] = useState(false);
  const pageTriggerRef = useRef<HTMLButtonElement>(null);

  /** Measured page count of the rendered sheet, for §5.4 conformance advice. */
  const [resumePageCount, setResumePageCount] = useState<number | null>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || null;

  // M14 — the custom templates indexed by row id, for the resolver and the picker.
  // Parsed once per fetch rather than per render.
  const customTemplateIndex = useMemo(() => {
    const index: Record<string, TemplateSchema> = {};
    for (const template of customTemplates) index[template.id] = template.schema;
    return index;
  }, [customTemplates]);

  // M9/M14 — every template, built-in or user-created, is schema-backed and
  // renders through the one generic renderer. `resolveTemplateSchema` keeps the
  // built-in fallback: an id that matches nothing (a deleted custom template, a
  // hand-edited `template_id`) still renders a real sheet, never a blank one.
  const activeResumeSchema = resolveTemplateSchema(selectedTemplateId, customTemplateIndex);
  const activeTemplateName =
    TEMPLATES.find((t) => t.id === selectedTemplateId)?.name ??
    customTemplates.find((t) => t.id === selectedTemplateId)?.name ??
    activeResumeSchema.name;
  // M10 — the country preset is pure overrides folded onto the template schema.
  // With no country the base schema is used untouched, so the render is exactly
  // what it was before M10 (the preset engine never mutates module data).
  const activeCountryCode = activeSession?.country_code || null;
  const activeCountryPreset = getCountryPreset(activeCountryCode);
  // M15/M16 — the SAME resolution the print view (`#/print`) calls. Keeping it in
  // one function is what stops the preview and the exported PDF from drifting
  // (PRD §11); `activeResumeSchema` above stays the *pre-preset* template for the
  // picker's name and the empty-state thumbnail.
  //
  // The session's own page preference is applied last, so the user's choice wins
  // over the country preset (PRD §5.4 amended, M16). Passing the whole session
  // keeps this a single call rather than three lookups repeated in two files.
  const {
    schema: effectiveResumeSchema,
    pageSize: effectivePageSize,
    orientation: effectiveOrientation
  } = resolveSessionRenderSchema(
    selectedTemplateId,
    activeCountryCode,
    customTemplateIndex,
    activeSession
  );
  const activeCountryName = activeCountryPreset ? activeCountryPreset.name : 'None';

  // M16 — the Page tool's own labels. `page_size` absent means "follow the country
  // preset" (and, with no country selected, the design's own default). The
  // followed size is the resolved schema's `page.size`, i.e. what would be used
  // if the override were cleared — so the row can state it even while the user is
  // on an override.
  const isFollowingPageSize = !activeSession?.page_size;
  const followedPageSize: PaperFormat = effectiveResumeSchema.page.size;
  const effectiveOrientationLabel: string =
    effectiveOrientation === 'landscape' ? 'Landscape' : 'Portrait';
  const pageToolValue = isFollowingPageSize
    ? `Follow ${effectivePageSize} · ${effectiveOrientationLabel}`
    : `${effectivePageSize} · ${effectiveOrientationLabel}`;
  const aiNotice = settingsNoticeDismissed ? null : getAiNotice(settings);

  // Routing — keep state in step with the hash so back/forward and refresh work.
  useEffect(() => {
    const onHashChange = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // The tool-grid disclosures close on an outside click, and Escape returns
  // focus to the trigger that was open — a disclosure must be reachable and
  // dismissable by keyboard. `templatePickerRef` wraps the whole tool rail, so
  // "outside" means outside every panel (PRD §19.10 rule 2).
  useEffect(() => {
    if (!templatePickerOpen && !countryPickerOpen && !pagePickerOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!templatePickerRef.current?.contains(event.target as Node)) {
        setTemplatePickerOpen(false);
        setCountryPickerOpen(false);
        setPagePickerOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape returns focus to the trigger that was open, last-opened first.
      if (pagePickerOpen) pageTriggerRef.current?.focus();
      else if (countryPickerOpen) countryTriggerRef.current?.focus();
      else if (templatePickerOpen) templateTriggerRef.current?.focus();
      setTemplatePickerOpen(false);
      setCountryPickerOpen(false);
      setPagePickerOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [templatePickerOpen, countryPickerOpen, pagePickerOpen]);

  // 1. Fetch sessions on load (studio only — the home page needs no data)
  useEffect(() => {
    if (route !== 'studio') return;
    fetchSessions();
    fetchSettings();
    fetchCustomTemplates();
  }, [route]);

  // 2. Fetch messages & template when active session changes
  useEffect(() => {
    setChatError(null);
    setTemplatePickerOpen(false);
    setCountryPickerOpen(false);
    setPagePickerOpen(false);
    if (activeSessionId) {
      fetchMessages(activeSessionId);
      if (activeSession) {
        setSelectedTemplateId(activeSession.template_id || 'minimal');
      }
    } else {
      setMessages([]);
      // With no session the cover-letter tab has nothing to render, so the
      // header must not claim it is the active tool (PRD §19.10 rule 8).
      setActiveTab('chat');
    }
  }, [activeSessionId]);

  const fetchSessions = async () => {
    setIsLoadingSessions(true);
    setSessionsError(null);
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      if (Array.isArray(data)) {
        setSessions(data);
        if (data.length > 0 && !activeSessionId) {
          setActiveSessionId(data[0].id);
        }
      } else {
        // GOTCHA #15 — Vite's SPA fallback answers an unmatched `/api/*` path
        // with `index.html` at HTTP 200, so the body's shape is the real signal.
        console.error('Fetched sessions data is not an array:', data);
        setSessions([]);
        setSessionsError(
          'Your saved sessions could not be loaded: the server returned an unexpected response. The backend may not be running yet.'
        );
      }
    } catch (err) {
      console.error('Failed to fetch sessions:', err);
      setSessions([]);
      setSessionsError(
        err instanceof Error
          ? `Could not load your saved sessions: ${err.message}`
          : 'Could not load your saved sessions. Is the server running?'
      );
    } finally {
      setIsLoadingSessions(false);
    }
  };

  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (res.ok && data && typeof (data as PublicSettings).provider === 'string') {
        setSettings(data as PublicSettings);
      } else {
        setSettings(null);
      }
    } catch (err) {
      console.error('Failed to fetch AI settings:', err);
      setSettings(null);
    }
  };

  /**
   * M14 — the user's stored templates (PRD §5.5, "selectable in any session").
   * `parseStoredTemplates` shape-checks the body and validates each row, so a
   * malformed row is dropped and the built-in registry is unaffected. A failure
   * degrades to "built-ins only" and is reported, never silent.
   */
  const fetchCustomTemplates = async () => {
    setIsLoadingCustomTemplates(true);
    setCustomTemplatesError(null);
    try {
      const res = await fetch('/api/templates');
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      // GOTCHA #15 — Vite's SPA fallback answers an unmatched `/api/*` path with
      // `index.html` at HTTP 200, so the body's shape is the real signal.
      if (!res.ok || !Array.isArray(data)) {
        setCustomTemplates([]);
        setCustomTemplatesError('Your saved templates could not be loaded.');
        return;
      }
      setCustomTemplates(parseStoredTemplates(data));
    } catch (err) {
      console.error('Failed to fetch custom templates:', err);
      setCustomTemplates([]);
      setCustomTemplatesError(
        err instanceof Error
          ? `Your saved templates could not be loaded: ${err.message}`
          : 'Your saved templates could not be loaded.'
      );
    } finally {
      setIsLoadingCustomTemplates(false);
    }
  };

  const fetchMessages = async (sessionId: string) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/messages`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setMessages(data);
      } else {
        console.error('Fetched messages data is not an array:', data);
        setMessages([]);
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err);
      // Never keep the previous session's bubbles on screen under this
      // session's title — an empty list is honest, another session's history is
      // not.
      setMessages([]);
    }
  };

  const handleSelectSession = (id: string) => {
    setActiveSessionId(id);
    setActiveTab('chat');
    setSidebarOpen(false);
  };

  const handleCreateSession = async (title?: string) => {
    setSessionActionError(null);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title || `CV - ${new Date().toLocaleDateString()}`,
          template_id: selectedTemplateId
        })
      });
      const data = await res.json();
      if (res.ok && data && data.id) {
        setSessions((prev) => [data, ...prev]);
        setActiveSessionId(data.id);
        setActiveTab('chat');
        setSidebarOpen(false);
      } else {
        console.error('Failed to create session:', data);
        setSessionActionError(`Could not create a new resume session (HTTP ${res.status}). Nothing was saved.`);
      }
    } catch (err) {
      console.error('Failed to create session:', err);
      setSessionActionError(
        err instanceof Error
          ? `Could not create a new resume session: ${err.message}`
          : 'Could not create a new resume session. Is the server running?'
      );
    }
  };

  const handleDeleteSession = async (id: string) => {
    setSessionActionError(null);
    try {
      const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      // A failed DELETE must NOT remove the row from the list: doing so leaves
      // the UI showing a deletion the database never performed, and the session
      // reappears on the next load.
      if (!res.ok) {
        setSessionActionError(`Could not delete the session (HTTP ${res.status}). It has not been removed.`);
        return;
      }
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSessionId === id) {
        const remaining = sessions.filter((s) => s.id !== id);
        setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
      }
    } catch (err) {
      console.error('Failed to delete session:', err);
      setSessionActionError(
        err instanceof Error
          ? `Could not delete the session: ${err.message}`
          : 'Could not delete the session. Is the server running?'
      );
    }
  };

  const handleRenameSession = async (id: string, newTitle: string) => {
    setSessionActionError(null);
    try {
      const res = await fetch(`/api/sessions/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle })
      });
      const data = await res.json();
      if (res.ok && data && data.id) {
        setSessions((prev) => prev.map((s) => (s.id === id ? data : s)));
      } else {
        console.error('Failed to rename session:', data);
        setSessionActionError(`Could not rename the session (HTTP ${res.status}). The old name is unchanged.`);
      }
    } catch (err) {
      console.error('Failed to rename session:', err);
      setSessionActionError(
        err instanceof Error ? `Could not rename the session: ${err.message}` : 'Could not rename the session.'
      );
    }
  };

  const handleSendMessage = async (content: string) => {
    if (!activeSessionId || isSending) return;
    setIsSending(true);
    setChatError(null);

    // Optimistically insert user message in state
    const tempUserMsg: Message = {
      id: Math.random().toString(),
      session_id: activeSessionId,
      role: 'user',
      content,
      created_at: new Date().toISOString()
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const res = await fetch(`/api/sessions/${activeSessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (res.ok && data && data.session && Array.isArray(data.messages)) {
        setSessions((prev) => prev.map((s) => (s.id === activeSessionId ? data.session : s)));
        setMessages(data.messages);

        // Capability reported by the backend for this turn (M8).
        const capability = data.meta?.capability;
        if (capability) {
          setSettings((prev) => (prev ? { ...prev, capability } : prev));
          if (capability === 'chat-only') {
            setSettingsNoticeDismissed(false);
          }
        }
      } else {
        // Failed turn: drop the optimistic bubble (the server does not persist it).
        setMessages((prev) => prev.filter((m) => m.id !== tempUserMsg.id));
        setChatError({
          code: data?.code || 'AI_REQUEST_FAILED',
          message: data?.error || `The AI request failed (HTTP ${res.status}).`
        });
      }
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== tempUserMsg.id));
      setChatError({
        code: 'AI_UNREACHABLE',
        message:
          err instanceof Error
            ? `Could not reach the server: ${err.message}`
            : 'Could not reach the server. Is it running?'
      });
    } finally {
      setIsSending(false);
    }
  };

  /**
   * Document ingestion (PRD §5.8). Returns a typed outcome — never throws a
   * string and never trusts `res.ok` alone: Vite's SPA fallback answers an
   * unmatched `/api/*` path with `index.html` at HTTP 200 in dev (GOTCHA #15),
   * so the *shape* of the body is what decides success.
   */
  const handleUploadResume = async (filename: string, base64Data: string): Promise<UploadOutcome> => {
    let res: Response;
    try {
      res = await fetch('/api/upload-resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, data: base64Data })
      });
    } catch (err) {
      return {
        ok: false,
        code: 'NETWORK',
        error:
          err instanceof Error
            ? `Could not reach the server: ${err.message}`
            : 'Could not reach the server. Is it running?'
      };
    }

    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.ok && data && typeof data.text === 'string' && data.text.length > 0) {
      return {
        ok: true,
        text: data.text,
        chars: typeof data.chars === 'number' ? data.chars : data.text.length,
        format: typeof data.format === 'string' ? data.format : 'text'
      };
    }

    // A 200 whose body is not `{ text }` is the SPA-fallback trap, not a
    // successful extraction.
    return {
      ok: false,
      code: typeof data?.code === 'string' ? data.code : 'BAD_RESPONSE',
      error:
        typeof data?.error === 'string'
          ? data.error
          : 'The upload endpoint returned an unexpected response. The backend may not be running yet.'
    };
  };

  /**
   * Job context (PRD §5.9). The link path is best-effort and secondary; pasted
   * text is the primary path. Same shape-validated, non-throwing contract as
   * the upload above.
   */
  const handleFetchJobLink = async (url: string): Promise<JobFetchOutcome> => {
    let res: Response;
    try {
      res = await fetch('/api/fetch-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
    } catch (err) {
      return {
        ok: false,
        code: 'NETWORK',
        error:
          err instanceof Error
            ? `Could not reach the server: ${err.message}`
            : 'Could not reach the server. Is it running?'
      };
    }

    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.ok && data && typeof data.text === 'string' && data.text.length > 0) {
      return {
        ok: true,
        text: data.text,
        chars: typeof data.chars === 'number' ? data.chars : data.text.length,
        url: typeof data.url === 'string' ? data.url : url,
        truncated: data.truncated === true
      };
    }

    return {
      ok: false,
      code: typeof data?.code === 'string' ? data.code : 'BAD_RESPONSE',
      error:
        typeof data?.error === 'string'
          ? data.error
          : 'The job-fetch endpoint returned an unexpected response. The backend may not be running yet.'
    };
  };

  const handleUpdateSessionFields = async (fields: Partial<Session>) => {
    if (!activeSessionId) return;
    setSessionActionError(null);
    try {
      const res = await fetch(`/api/sessions/${activeSessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields)
      });
      const data = await res.json();
      if (res.ok && data && data.id) {
        setSessions((prev) => prev.map((s) => (s.id === activeSessionId ? data : s)));
      } else {
        console.error('Failed to update session fields:', data);
        setSessionActionError(`That change could not be saved to the session (HTTP ${res.status}).`);
      }
    } catch (err) {
      console.error('Update session fields error:', err);
      setSessionActionError(
        err instanceof Error
          ? `That change could not be saved to the session: ${err.message}`
          : 'That change could not be saved to the session.'
      );
    }
  };

  /**
   * M10 — country formats are stored on the session. `null` clears the choice
   * (`''` is the protocol's "none"; PRD §5.4 stores the code per session).
   */
  const handleSelectCountry = async (code: string | null) => {
    setCountryPickerOpen(false);
    countryTriggerRef.current?.focus();
    await handleUpdateSessionFields({ country_code: code ?? '' });
  };

  /**
   * M16 — the user's own page size (PRD §5.4 amended). `null` means "follow the
   * country preset", which is what the server stores for a cleared override, so
   * the whole preference round-trips through the existing session `PUT` with no
   * new endpoint.
   */
  const handleSelectPageSize = async (size: PaperFormat | null) => {
    setPagePickerOpen(false);
    pageTriggerRef.current?.focus();
    await handleUpdateSessionFields({ page_size: size });
  };

  const handleSelectPageOrientation = async (orientation: PageOrientation) => {
    setPagePickerOpen(false);
    pageTriggerRef.current?.focus();
    await handleUpdateSessionFields({ page_orientation: orientation });
  };

  const handleSelectTemplate = async (templateId: string) => {
    setSelectedTemplateId(templateId);
    if (activeSessionId) {
      await handleUpdateSessionFields({ template_id: templateId });
    }
  };

  // -------------------------------------------------------------
  // Resume Exports (PDF, DOCX, Markdown)
  // -------------------------------------------------------------
  /**
   * The preview sheet can be mounted twice (xl sidebar + narrow-screen overlay).
   * Always capture the one that is actually visible.
   */
  const getVisibleResumePaper = (): HTMLElement | null => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-resume-paper]'));
    return nodes.find((node) => node.getClientRects().length > 0) ?? nodes[0] ?? null;
  };

  /**
   * Resolves a design token from :root so the rasterised PDF keeps using the
   * same values as the on-screen preview.
   */
  const readToken = (name: string, fallback: string): string => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  };

  /**
   * M15 — ask the server for a true-text PDF (PRD §11). The server prints the
   * `#/print` view with an installed Chromium, so the result carries a real text
   * layer instead of being a bitmap.
   *
   * Never trusts the status alone: an unmatched `/api/*` path is answered by
   * Vite's SPA fallback with `index.html` at HTTP 200 in dev (GOTCHA #15), so
   * `Content-Type` is the real signal — a "successful" HTML body must be treated
   * as a failure, not downloaded and called a PDF.
   */
  const requestServerResumePdf = async (sessionId: string): Promise<ServerPdfOutcome> => {
    let res: Response;
    try {
      res = await fetch('/api/export/resume-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
    } catch (err) {
      return {
        ok: false,
        blob: null,
        filename: null,
        code: 'NETWORK',
        error:
          err instanceof Error
            ? `Could not reach the server: ${err.message}`
            : 'Could not reach the server. Is it running?'
      };
    }

    const contentType = (res.headers.get('Content-Type') || '').toLowerCase();
    if (res.ok && contentType.includes('application/pdf')) {
      try {
        const blob = await res.blob();
        if (blob.size > 0) {
          return {
            ok: true,
            blob,
            filename: parseContentDispositionFilename(res.headers.get('Content-Disposition')),
            code: null,
            error: null
          };
        }
      } catch {
        /* fall through to the failure result below */
      }
      return {
        ok: false,
        blob: null,
        filename: null,
        code: 'PDF_EMPTY',
        error: 'The server returned an empty PDF.'
      };
    }

    // The error contract is `{ error, code }`; anything else (including the SPA
    // fallback's HTML) is reported as an unexpected response.
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return {
      ok: false,
      blob: null,
      filename: null,
      code: typeof data?.code === 'string' ? data.code : 'BAD_RESPONSE',
      error:
        typeof data?.error === 'string'
          ? data.error
          : `The PDF export endpoint returned an unexpected response (HTTP ${res.status}).`
    };
  };

  /**
   * The original raster path, kept **as a fallback only** (PRD §11). It is the
   * same `html2canvas` → `jsPDF` capture it always was; `resumeCapture.ts`
   * normalises Tailwind 4's `oklch`/`color-mix` colours in the cloned tree
   * (GOTCHA #22) and must not be removed while this path exists.
   *
   * M16: `getVisibleResumePaper()` now returns **page 1** of the visible pane
   * (there is one `[data-resume-paper]` per page). `html2canvas` captures one
   * element, so this degraded path can only ever hold page 1 — the caller says
   * so in the `Banner` rather than shipping a silently truncated PDF.
   *
   * Returns `false` when there is nothing to capture or the capture throws, so
   * the caller can report an honest hard failure instead of a silent no-op.
   */
  const exportResumePdfRaster = async (): Promise<boolean> => {
    const element = getVisibleResumePaper();
    if (!element) return false;
    try {
      const canvas = await html2canvas(element, {
        scale: 2.2, // High resolution crisp PDF render
        useCORS: true,
        logging: false,
        // The paper itself is the one true-white surface (PRD §19.9 neutrals);
        // export it against paper-white, never the tinted app page.
        backgroundColor: readToken('--paper', 'white'),
        // html2canvas 1.4 cannot read CSS Color 4 values (oklch/color-mix) that
        // Tailwind 4 emits; normalise them in the cloned tree before parsing.
        onclone: (_clonedDoc, clonedElement) => {
          if (clonedElement) resolveModernColorsForCapture(clonedElement);
        }
      });
      const imgData = canvas.toDataURL('image/png');
      // §11: the fallback uses the SAME effective page as the preview and the
      // text engine — the format and the orientation both come from
      // `resolveSessionRenderSchema`, so a degraded export is not a different
      // shape from the real one.
      const format = PDF_FORMATS[effectivePageSize] ?? PDF_FORMATS.A4;
      const isLandscape = effectiveOrientation === 'landscape';
      const pdf = new jsPDF({
        orientation: isLandscape ? 'landscape' : 'portrait',
        unit: 'mm',
        format: format.format
      });
      // The width of the page *in its chosen orientation*: landscape passes the
      // long edge.
      const imgWidth = isLandscape ? format.heightMm : format.widthMm;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;

      pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight);
      pdf.save(`${activeSession?.title.replace(/\s+/g, '_')}_Resume.pdf`);
      return true;
    } catch (err) {
      console.error('Resume PDF download error:', err);
      return false;
    }
  };

  /**
   * Export the resume as PDF.
   *
   * Order matters (PRD §11): the server's true-text engine first, the raster
   * path only if that fails — and when it does, the user is told why the PDF
   * they just received has no text layer. The button is disabled and busy for
   * the whole operation, which the server measures at ~4.6 s (PRD §6).
   */
  const handleExportResumePDF = async () => {
    if (!activeSession || isExportingPdf) return;
    setIsExportingPdf(true);
    setExportError(null);
    setPdfExportNotice(null);
    try {
      const server = await requestServerResumePdf(activeSession.id);
      if (server.ok && server.blob) {
        downloadBlob(
          server.blob,
          server.filename || `${activeSession.title.replace(/\s+/g, '_')}_Resume.pdf`
        );
        return;
      }

      const fallbackOk = await exportResumePdfRaster();
      if (!fallbackOk) {
        setExportError(
          'Could not generate the PDF. Check the browser console for details and try again.'
        );
        return;
      }
      setPdfExportNotice(describePdfFallback(server, resumePageCount));
    } finally {
      setIsExportingPdf(false);
    }
  };

  /**
   * M16 Stage C — **Print / Save as PDF** (PRD §5.4 amended).
   *
   * Opens the print view in a new tab and hands it to the browser's own print
   * dialog, where the user controls paper size, scale, margins and printer. It
   * is the escape hatch for a printer or paper that does not match anything we
   * model, and it needs no server round-trip.
   *
   * The session id and the `print` flag ride in the **search**, never the hash:
   * `readRoute()` compares the hash exactly (GOTCHA #47), so `#/print?print=1`
   * would fall through to the home page.
   *
   * `window.open` is called **synchronously** inside the click handler — never
   * after an `await` — because a tab opened outside the user gesture is blocked
   * as a popup. Deliberately no `'noopener'` feature string: with it,
   * `window.open` returns `null` even on success, which would report a blocked
   * popup for a tab that actually opened. `opener` is severed on the handle
   * instead. A genuinely blocked popup is stated in a Banner, never silently
   * dropped (PRD §5.2 "clear and actionable, never silent").
   */
  const handlePrintResume = () => {
    if (!activeSession) return;
    const url = `/?session=${encodeURIComponent(activeSession.id)}&print=1#/print`;
    let opened: Window | null = null;
    try {
      opened = window.open(url, '_blank');
    } catch {
      opened = null;
    }
    if (!opened) {
      setExportError(
        'Your browser blocked the print tab. Allow pop-ups for this site and try again.'
      );
      return;
    }
    setExportError(null);
    try {
      opened.opener = null;
    } catch {
      /* cross-origin handle — harmless */
    }
  };

  const handleExportResumeDOCX = async () => {
    if (!activeSession) return;
    let data: ResumeJSON = {};
    try {
      data = JSON.parse(activeSession.resume_json || '{}');
    } catch (e) {
      console.error(e);
    }

    try {
      // PRD §11 — one model, three outputs. The DOCX is built from the **same
      // resolved schema** the preview and the PDF use (template × country preset
      // × the user's page choice), so a custom template's section order and a
      // preset's localised labels both reach the Word document. The previous
      // implementation hardcoded four sections and dropped projects,
      // certifications, languages, personal and signature entirely.
      const blob = await buildResumeDocxBlob({
        schema: effectiveResumeSchema,
        data,
        pageSize: effectivePageSize,
        orientation: effectiveOrientation
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `${activeSession.title.replace(/\s+/g, '_')}_Resume.docx`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Resume DOCX download error:', err);
      setPdfExportNotice(
        'The Word export could not be created. Your resume is unchanged — try again, or use the PDF or Markdown export.'
      );
    }
  };

  const handleExportResumeMarkdown = () => {
    if (!activeSession) return;
    let data: ResumeJSON = {};
    try {
      data = JSON.parse(activeSession.resume_json || '{}');
    } catch (e) {
      console.error(e);
    }
    // Same defect class as the DOCX export was: hardcoded sections dropped
    // projects, certifications, languages, personal and signature, and ignored
    // the country preset's labels and the template's order. Both now serialise
    // from the resolved schema (PRD §11 — one model, three outputs).
    const md = buildResumeMarkdown(effectiveResumeSchema, data);

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${activeSession.title.replace(/\s+/g, '_')}_Resume.md`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  let parsedResumeData: ResumeJSON = {};
  if (activeSession) {
    try {
      parsedResumeData = JSON.parse(activeSession.resume_json || '{}');
    } catch (e) {
      console.error('Failed to parse active resume state json', e);
    }
  }

  // Reuse the shared predicate rather than a local subset. The narrower check
  // that used to live here ignored `summary`, `projects`, `certifications` and
  // `languages`, so a resume holding only a summary — the outcome of the
  // "Draft summary" quick action — was reported as empty: the preview claimed
  // "blueprint pending" and the export actions stayed hidden over a resume that
  // genuinely had content.
  const isResumeEmpty = !activeSession || isResumeDataEmpty(parsedResumeData);

  // M16 — the page count for §5.4 conformance advice now comes from the pager
  // itself (`PagedResume` → `onPageCount`), which is the real page count rather
  // than a single-sheet height estimate. The old height/`pageHeight` division
  // could only ever approximate, and it disagreed with the printed result as
  // soon as a page had a header and the next did not.
  //
  // With no content there is nothing to count, so clear the value rather than
  // leave the previous session's count on screen.
  useEffect(() => {
    if (isResumeEmpty) setResumePageCount(null);
  }, [isResumeEmpty]);

  const conformanceWarnings =
    activeCountryPreset && !isResumeEmpty
      ? getConformanceWarnings({
          preset: activeCountryPreset,
          data: parsedResumeData,
          pageCount: resumePageCount
        })
      : [];

  const exportActions = activeSession && !isResumeEmpty ? (
    <div className="flex items-center gap-1.5">
      {/* M15 — the server print takes seconds; the button shows a spinner and
          disables itself so a second click cannot start a second render. */}
      <Button
        size="xs"
        iconOnly
        loading={isExportingPdf}
        disabled={isExportingPdf}
        aria-label={isExportingPdf ? 'Preparing PDF export' : 'Export resume as PDF'}
        title={isExportingPdf ? 'Preparing PDF…' : 'Export resume as PDF'}
        onClick={handleExportResumePDF}
      >
        <Download size={14} />
      </Button>
      {/* M16 Stage C — secondary to the PDF export: the browser's own dialog,
          for paper and printers we do not model. Opens a new tab, so it cannot
          block the studio. */}
      {/* Print opens the resume in a new tab and hands it to the browser's own
          print dialog — the user picks paper size, scale, margins and printer and
          saves the PDF themselves. Labelled (not icon-only) because the icon
          alone was not discoverable; the label is dropped below `xl` so the
          header cannot be pushed out of shape at 1024 (GOTCHA #29). */}
      <Button
        size="xs"
        variant="outline"
        startIcon={<Printer size={14} />}
        aria-label="Print or save as PDF"
        title="Print or save as PDF"
        onClick={handlePrintResume}
      >
        <span className="hidden xl:inline">Print</span>
      </Button>
      <Button
        size="xs"
        variant="white"
        iconOnly
        aria-label="Export resume as Word DOCX"
        title="Export resume as Word DOCX"
        onClick={handleExportResumeDOCX}
      >
        {/* A document glyph, not a printer: the printer now means "print", and
            two printer icons in one row would both be wrong (PRD §19.9.8). */}
        <FileType size={14} />
      </Button>
      <Button
        size="xs"
        variant="white"
        iconOnly
        aria-label="Export resume as Markdown"
        title="Export resume as Markdown"
        onClick={handleExportResumeMarkdown}
      >
        <FileCode size={14} />
      </Button>
    </div>
  ) : null;

  /**
   * The resume preview pane. Rendered once in the xl sidebar and, on narrower
   * viewports, inside the full-screen overlay.
   *
   * Studio register (PRD §19.10): light, flat, canvas-first. The template tool
   * is one rail control that discloses an aligned grid — no dark band, no
   * gradient, no chip cloud, no pane footer. The canvas is the hero.
   */
  /**
   * One selectable template in the picker. A built-in and a custom entry share
   * the exact same geometry, state treatment and thumbnail renderer, so the two
   * groups cannot drift (PRD §19.9.1). The only difference is that a custom entry
   * carries its own stored schema.
   */
  const renderTemplateChoice = (templateId: string, name: string, schema?: TemplateSchema) => {
    const isActive = templateId === selectedTemplateId;
    return (
      <button
        key={templateId}
        type="button"
        aria-pressed={isActive}
        onClick={() => {
          handleSelectTemplate(templateId);
          setTemplatePickerOpen(false);
          templateTriggerRef.current?.focus();
        }}
        className="group inline-flex cursor-pointer flex-col items-center gap-2 rounded-button p-1 transition-colors duration-200 ease-in-out"
      >
        {/* Real preview of the real template — the gallery shows the design,
            not just its name. Decorative: the label states the template, and
            the button carries the state. */}
        <TemplateThumb
          templateId={templateId}
          schema={schema}
          width={TEMPLATE_THUMB_WIDTH}
          className={isActive ? 'border-primary' : 'border-border group-hover:border-primary-border'}
        />
        {/* Active = primary name + a 1px primary thumbnail border, never a fill
            (PRD §19.9.9). */}
        <span
          className={`max-w-full truncate text-center font-heading text-meta font-medium ${
            isActive ? 'text-primary' : 'text-text-body'
          }`}
          style={{ maxWidth: TEMPLATE_THUMB_WIDTH }}
        >
          {name}
        </span>
      </button>
    );
  };

  const renderPreviewPane = (isLivePane: boolean) => (
    <div className="flex h-full min-h-0 w-full flex-col bg-page-app">
      {/* Tool rail — one control, one aligned grid (PRD §19.10 rules 2 and 3) */}
      <div
        ref={templatePickerRef}
        className="relative z-10 shrink-0 border-b border-border-soft bg-surface"
      >
        {/* `flex-wrap` (M16): a third tool with a value does not fit one 540px
            row alongside Templates + Country, and a rail that silently overflows
            its pane is worse than one that wraps. */}
        <div className="flex flex-wrap items-center px-2">
          <ToolTab
            ref={templateTriggerRef}
            active={templatePickerOpen}
            aria-expanded={templatePickerOpen}
            aria-controls={TEMPLATE_PICKER_ID}
            aria-pressed={undefined}
            title="Choose a resume template"
            onClick={() => {
              setCountryPickerOpen(false);
              setPagePickerOpen(false);
              setTemplatePickerOpen((open) => !open);
            }}
            endIcon={
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={`transition-transform duration-200 ease-in-out ${
                  templatePickerOpen ? 'rotate-180' : ''
                }`}
              />
            }
          >
            Templates
            <span className="font-body font-normal text-text-muted">{activeTemplateName}</span>
          </ToolTab>

          {/* M10 — country format: same text rail, same disclosure pattern. */}
          <ToolTab
            ref={countryTriggerRef}
            active={countryPickerOpen}
            aria-expanded={countryPickerOpen}
            aria-controls={COUNTRY_PICKER_ID}
            aria-pressed={undefined}
            title="Choose a country format"
            onClick={() => {
              setTemplatePickerOpen(false);
              setPagePickerOpen(false);
              setCountryPickerOpen((open) => !open);
            }}
            endIcon={
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={`transition-transform duration-200 ease-in-out ${
                  countryPickerOpen ? 'rotate-180' : ''
                }`}
              />
            }
          >
            Country
            <span className="font-body font-normal text-text-muted">{activeCountryName}</span>
          </ToolTab>

          {/* M16 — the page tool. Same text rail, same disclosure pattern: the
              user owns the page, and the preset remains advice (PRD §5.4). */}
          <ToolTab
            ref={pageTriggerRef}
            active={pagePickerOpen}
            aria-expanded={pagePickerOpen}
            aria-controls={PAGE_PICKER_ID}
            aria-pressed={undefined}
            title="Choose the page size and orientation"
            onClick={() => {
              setTemplatePickerOpen(false);
              setCountryPickerOpen(false);
              setPagePickerOpen((open) => !open);
            }}
            endIcon={
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={`transition-transform duration-200 ease-in-out ${
                  pagePickerOpen ? 'rotate-180' : ''
                }`}
              />
            }
          >
            Page
            <span className="font-body font-normal text-text-muted">{pageToolValue}</span>
          </ToolTab>
        </div>

        {templatePickerOpen && isLivePane && (
          <div
            id={TEMPLATE_PICKER_ID}
            role="group"
            aria-label="Resume templates"
            className="scroll-quiet absolute right-2 top-full z-20 mt-2 max-h-[70vh] w-[min(92vw,880px)] overflow-y-auto rounded-card border border-border bg-surface p-1 shadow-raised"
          >
            <div className="grid grid-cols-2 justify-items-center gap-2 md:grid-cols-4">
              {TEMPLATES.map((t) => renderTemplateChoice(t.id, t.name))}
            </div>

            {/* M14 — the user's own designs (PRD §5.5). A second group behind a
                hairline rule with one quiet label; no badges and no repeated
                kicker (PRD §19.9.8). Rendered only while the picker is open and
                only in the visible pane, so a custom template never doubles the
                thumbnail cost (GOTCHA #46). */}
            {isLoadingCustomTemplates && (
              <p className="type-meta mt-2 border-t border-border-soft px-1 pt-2">
                Loading your templates…
              </p>
            )}
            {!isLoadingCustomTemplates && customTemplatesError && (
              <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border-soft px-1 pt-2">
                <span className="type-meta">{customTemplatesError}</span>
                <Button size="xs" variant="ghost" onClick={() => void fetchCustomTemplates()}>
                  Retry
                </Button>
              </div>
            )}
            {!isLoadingCustomTemplates && !customTemplatesError && customTemplates.length > 0 && (
              <div className="mt-2 border-t border-border-soft pt-2">
                <p className="px-1 pb-1 font-heading text-meta font-medium text-text-muted">
                  Your templates
                </p>
                <div className="grid grid-cols-2 justify-items-center gap-2 md:grid-cols-4">
                  {customTemplates.map((t) => renderTemplateChoice(t.id, t.name, t.schema))}
                </div>
              </div>
            )}
          </div>
        )}

        {countryPickerOpen && isLivePane && (
          <div
            id={COUNTRY_PICKER_ID}
            role="group"
            aria-label="Country formats"
            className="scroll-quiet absolute left-2 top-full z-20 mt-2 max-h-[70vh] w-[min(92vw,280px)] overflow-y-auto rounded-card border border-border bg-surface p-1 shadow-raised"
          >
            <button
              type="button"
              aria-pressed={!activeCountryCode}
              onClick={() => handleSelectCountry(null)}
              className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-button px-3 py-2 text-left font-heading text-meta transition-colors duration-200 ease-in-out ${
                !activeCountryCode
                  ? 'bg-primary-soft font-medium text-primary'
                  : 'text-text-body hover:bg-tint'
              }`}
            >
              <span>None</span>
              <span className="font-body font-normal text-text-muted">No convention</span>
            </button>
            {COUNTRY_PRESETS.map((preset) => {
              const isActive = preset.code === activeCountryCode;
              return (
                <button
                  key={preset.code}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => handleSelectCountry(preset.code)}
                  className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-button px-3 py-2 text-left font-heading text-meta transition-colors duration-200 ease-in-out ${
                    isActive
                      ? 'bg-primary-soft font-medium text-primary'
                      : 'text-text-body hover:bg-tint'
                  }`}
                >
                  <span>{preset.name}</span>
                  <span className="font-body font-normal text-text-muted">{preset.documentName}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* M16 — the page panel. Two axes, each its own `role="group"` with a
            quiet label: a size list (five options, like Country) and a
            two-state orientation toggle. No badges repeat the heading
            (PRD §19.9.8); the check mark is the pressed state alone. */}
        {pagePickerOpen && isLivePane && (
          <div
            id={PAGE_PICKER_ID}
            role="group"
            aria-label="Page size and orientation"
            className="scroll-quiet absolute left-2 top-full z-20 mt-2 max-h-[70vh] w-[min(92vw,280px)] overflow-y-auto rounded-card border border-border bg-surface p-1 shadow-raised"
          >
            <p
              id={`${PAGE_PICKER_ID}-size`}
              className="px-1 pb-1 pt-1 font-heading text-meta font-medium text-text-muted"
            >
              Size
            </p>
            <div role="group" aria-labelledby={`${PAGE_PICKER_ID}-size`}>
              <button
                type="button"
                aria-pressed={isFollowingPageSize}
                onClick={() => handleSelectPageSize(null)}
                className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-button px-3 py-2 text-left font-heading text-meta transition-colors duration-200 ease-in-out ${
                  isFollowingPageSize
                    ? 'bg-primary-soft font-medium text-primary'
                    : 'text-text-body hover:bg-tint'
                }`}
              >
                <span>Follow country format</span>
                {/* What "follow" resolves to right now, so the row states the
                    outcome rather than only the policy (PRD §19.9.8). */}
                <span className="font-body font-normal text-text-muted">{followedPageSize}</span>
              </button>
              {PAGE_FORMATS.map((format) => {
                const isActive = !isFollowingPageSize && format === effectivePageSize;
                return (
                  <button
                    key={format}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => handleSelectPageSize(format)}
                    className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-button px-3 py-2 text-left font-heading text-meta transition-colors duration-200 ease-in-out ${
                      isActive
                        ? 'bg-primary-soft font-medium text-primary'
                        : 'text-text-body hover:bg-tint'
                    }`}
                  >
                    <span>{format}</span>
                  </button>
                );
              })}
            </div>

            <p
              id={`${PAGE_PICKER_ID}-orientation`}
              className="mt-2 border-t border-border-soft px-1 pb-1 pt-2 font-heading text-meta font-medium text-text-muted"
            >
              Orientation
            </p>
            <div role="group" aria-labelledby={`${PAGE_PICKER_ID}-orientation`}>
              {PAGE_ORIENTATIONS.map((option) => {
                const isActive = option === effectiveOrientation;
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => handleSelectPageOrientation(option)}
                    className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-button px-3 py-2 text-left font-heading text-meta transition-colors duration-200 ease-in-out ${
                      isActive
                        ? 'bg-primary-soft font-medium text-primary'
                        : 'text-text-body hover:bg-tint'
                    }`}
                  >
                    <span>{option === 'landscape' ? 'Landscape' : 'Portrait'}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* §5.4 conformance advice — it flags, it never blocks. A Banner, not a
          modal, and only for conditions that are actually true. */}
      {conformanceWarnings.length > 0 && (
        <div className="shrink-0 border-b border-border-soft bg-surface px-3 py-2">
          <Banner tone="warn" role="status" aria-label="Country format notices">
            <ul className="space-y-1">
              {conformanceWarnings.map((warning) => (
                <li key={warning.code}>{warning.text}</li>
              ))}
            </ul>
          </Banner>
        </div>
      )}

      {/* Canvas — one white sheet on the app backdrop (PRD §19.10 rule 4) */}
      {!activeSession || isResumeEmpty ? (
        <div className="scroll-quiet flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-md flex-col items-center gap-6 sm:flex-row sm:items-center">
            {/* One real preview of the active template — it shows the shape the
                CV will take, which is information, not decoration
                (PRD §19.10 rule 9). No invented portrait or avatar. */}
            <TemplateThumb
              templateId={selectedTemplateId}
              schema={activeResumeSchema}
              width={TEMPLATE_THUMB_WIDTH}
              className="border-border"
            />
            <div className="min-w-0 flex-1">
              <h2 className="type-h4">
                {activeSession ? 'CV blueprint pending' : 'Preview standby'}
              </h2>
              <p className="type-body mt-2">
                {activeSession
                  ? 'Describe your target job, or upload an old resume, to watch your CV compile dynamically.'
                  : 'Create a resume session and its live page layout will appear here.'}
              </p>
              {/* At most two actions, the primary being the next genuinely
                  useful step (PRD §19.10 rule 6). With no session, "Resume
                  interview" changed a tab back to the tab it was already on —
                  a control that did nothing. Starting a session is the real
                  next step. */}
              <div className="mt-5 flex flex-wrap items-center gap-3">
                {activeSession ? (
                  <>
                    <Button size="md" onClick={() => setSettingsOpen(true)}>
                      Open AI settings
                    </Button>
                    <Button size="md" variant="outline" onClick={() => setActiveTab('chat')}>
                      Resume interview
                    </Button>
                  </>
                ) : (
                  <>
                    <Button size="md" onClick={() => handleCreateSession()}>
                      Start a new resume
                    </Button>
                    <Button size="md" variant="outline" onClick={() => setSettingsOpen(true)}>
                      Open AI settings
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        // M16 — `PreviewPaper` paginates into discrete sheets and reports the
        // real page count upward for the §5.4 conformance notice.
        <PreviewPaper
          schema={effectiveResumeSchema}
          data={parsedResumeData}
          pageSize={effectivePageSize}
          orientation={effectiveOrientation}
          onPageCount={setResumePageCount}
        />
      )}
    </div>
  );

  // ---- Print view (M15, PRD §11) ---------------------------------------
  // The page the server prints to produce a true-text PDF. It is reached by
  // `/?session=<id>#/print` and owns its own data fetching. Returned before any
  // chrome so the page contains nothing but the sheet — no header, sidebar,
  // chat pane, rail, banner, drawer or blob backdrop. Because this is an early
  // return, the studio never mounts here, so the print view's own
  // `[data-resume-paper]` markers (one per page) can never be confused with the
  // studio's sheets by `getVisibleResumePaper` (GOTCHA #24): the two routes are
  // mutually exclusive.
  if (route === 'print') {
    return <PrintView />;
  }

  // ---- Home / landing page (PRD §5.12) ---------------------------------
  // Everything above is hooks; this early return is safe and keeps the studio
  // completely untouched when the landing page is showing.
  if (route === 'home') {
    return (
      <HomePage
        onOpenStudio={() => {
          window.location.hash = '#/studio';
        }}
      />
    );
  }

  // ---- Template suite (PRD §5.5, Decision #23) -------------------------
  // Template work is its own page, so the studio stays flat and canvas-first
  // (PRD §19.10). The page owns its own data fetching; the studio's effects are
  // all gated on `route === 'studio'` and stay dormant here.
  if (route === 'templates') {
    return (
      <TemplatesPage
        onOpenStudio={() => {
          window.location.hash = '#/studio';
        }}
      />
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-page-app font-body text-text-body">
      {/* 72px white header with a hairline shadow (PRD §19.5). No gradient
          ramp: a drenched surface is a `#/` device, not tool chrome
          (PRD §19.10 rule 1). */}
      <header className="relative z-20 h-header shrink-0 border-b border-border-soft bg-surface shadow-app-header">
        {/* `min-w-0` on every flex row that must shrink: without it a row refuses
            to go below its content's min-content width and the trailing actions
            are pushed past the viewport (GOTCHAS #29/#30 — this header was
            clipped at 1024–1048 px once the Print action was added). */}
        <div className="flex h-full min-w-0 items-center gap-3 px-4 lg:px-6">
          {/* Brand — doubles as the link back to the home page (PRD §5.12).
              It is the row that absorbs pressure: the title truncates rather
              than letting the tool rail or the action group overflow. It may
              NOT be `shrink-0` for that reason. */}
          <div className="flex min-w-0 items-center gap-2.5">
            <Button
              size="xs"
              variant="ghost"
              iconOnly
              aria-label="Open resume sessions"
              title="Resume sessions"
              className="lg:hidden"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={16} />
            </Button>
            <a
              href="#/"
              title="Back to home"
              className="flex min-w-0 items-center gap-2.5 rounded-nav px-1 py-1 transition-colors duration-200 hover:bg-tint"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-button bg-primary text-white">
                <Sparkles size={16} aria-hidden="true" />
              </span>
              <span className="hidden min-w-0 sm:block">
                <span className="block truncate font-heading text-sm font-medium leading-tight text-text-heading">
                  AI Conversational CV Suite
                </span>
                {/* `truncate`, so when the brand is squeezed the second line
                    ellipsises instead of wrapping and changing the 72px box. */}
                <span className="type-meta hidden truncate leading-tight lg:block">
                  Local-first · provider-agnostic resume studio
                </span>
              </span>
            </a>
          </div>

          {/* Tools — a text rail, not a chip cloud (PRD §19.10 rule 2).
              Left-aligned beside the brand, as in the reference's builder:
              tools lead, actions trail, nothing floats in the middle. */}
          <span className="mx-1 hidden h-6 w-px shrink-0 bg-border lg:block" aria-hidden="true" />
          <div className="flex items-center gap-2">
            <ToolTab
              active={activeTab === 'chat'}
              icon={<MessageSquare size={15} aria-hidden="true" />}
              onClick={() => setActiveTab('chat')}
            >
              <span className="hidden lg:inline">Resume interview</span>
            </ToolTab>
            <ToolTab
              active={activeTab === 'cover_letter'}
              disabled={!activeSession}
              icon={<FileText size={15} aria-hidden="true" />}
              onClick={() => setActiveTab('cover_letter')}
            >
              <span className="hidden lg:inline">Cover letter</span>
            </ToolTab>
            {/* M11 — template work lives on its own page (PRD §5.5, Decision
                #23). This is navigation, not a mode toggle, so it is an anchor
                with the same text-rail recipe as `ToolTab` rather than a button
                carrying `aria-pressed` (GOTCHA #45). */}
            <a
              href="#/templates"
              title="Browse and manage templates"
              className="type-label inline-flex min-w-11 shrink-0 items-center justify-center gap-2 border-b-2 border-transparent bg-transparent px-3 py-3 whitespace-nowrap text-text-muted transition-colors duration-200 ease-in-out hover:text-primary"
            >
              <LayoutGrid size={15} aria-hidden="true" />
              <span className="hidden lg:inline">Templates</span>
            </a>
          </div>

          {/* Actions — one group, no orphan rule when there is nothing to
              separate (the divider used to render beside an empty slot). */}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {exportActions && (
              <>
                <div className="hidden sm:flex">{exportActions}</div>
                <span className="mx-1 hidden h-6 w-px bg-border sm:block" aria-hidden="true" />
              </>
            )}
            <Button
              size="xs"
              variant="ghost"
              iconOnly
              aria-label="Open resume preview"
              title="Resume preview"
              className="xl:hidden"
              onClick={() => setPreviewOpen(true)}
            >
              <PanelRight size={16} />
            </Button>
            <Button
              size="xs"
              variant="outline"
              iconOnly
              aria-label="AI provider settings"
              title="AI provider settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={14} />
            </Button>
          </div>
        </div>
      </header>

      {/* Body — flat and opaque. Ambient blob art is a `#/` device and is not
          mounted in the studio (PRD §19.10 rule 7). The two flex rows carry
          `min-w-0` so the preview column can shrink (GOTCHAS #29). */}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div className="relative z-10 flex min-h-0 min-w-0 flex-1">
          {/* 1. Session sidebar (lg and up) */}
          <aside className="hidden w-sidebar shrink-0 lg:block">
            <SessionList
              sessions={sessions}
              activeSessionId={activeSessionId}
              isLoading={isLoadingSessions}
              error={sessionsError}
              onRetry={fetchSessions}
              onSelectSession={handleSelectSession}
              onCreateSession={handleCreateSession}
              onDeleteSession={handleDeleteSession}
              onRenameSession={handleRenameSession}
            />
          </aside>

          {/* 2. Chat / cover letter column */}
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* AI capability / configuration notice (M8) */}
            {aiNotice && (
              <div className="shrink-0 px-5 pt-4">
                <Banner
                  tone={aiNotice.tone === 'red' ? 'danger' : 'warn'}
                  role="status"
                  dismissLabel="Dismiss AI status notice"
                  onDismiss={() => setSettingsNoticeDismissed(true)}
                  action={
                    <Button size="xs" variant="ghost" onClick={() => setSettingsOpen(true)}>
                      Open AI settings
                    </Button>
                  }
                >
                  {aiNotice.text}
                </Banner>
              </div>
            )}

            {exportError && (
              <div className="shrink-0 px-5 pt-4">
                <Banner
                  tone="danger"
                  role="alert"
                  onDismiss={() => setExportError(null)}
                  dismissLabel="Dismiss export error"
                >
                  {exportError}
                </Banner>
              </div>
            )}

            {/* M15 — a degraded export, not a failed one: the PDF exists, it just
                has no text layer. `role="status"`, never "alert" (PRD §11). */}
            {pdfExportNotice && (
              <div className="shrink-0 px-5 pt-4">
                <Banner
                  tone="warn"
                  role="status"
                  onDismiss={() => setPdfExportNotice(null)}
                  dismissLabel="Dismiss PDF export notice"
                >
                  {pdfExportNotice}
                </Banner>
              </div>
            )}

            {/* The AI failure notice belongs to the session, not to one tab:
                it is rendered here so a failed cover-letter generation is
                visible on the cover-letter tab too, and there is exactly one
                such surface (PRD §5.2 "never silent"). */}
            {chatError && (
              <div className="shrink-0 px-5 pt-4">
                <Banner
                  tone="danger"
                  role="alert"
                  onDismiss={() => setChatError(null)}
                  dismissLabel="Dismiss AI error"
                  action={
                    chatError.code === 'AI_NOT_CONFIGURED' || chatError.code === 'AI_AUTH' ? (
                      <Button size="xs" variant="ghost" onClick={() => setSettingsOpen(true)}>
                        Open AI settings
                      </Button>
                    ) : undefined
                  }
                >
                  {describeAiError(chatError)}
                </Banner>
              </div>
            )}

            {sessionActionError && (
              <div className="shrink-0 px-5 pt-4">
                <Banner
                  tone="danger"
                  role="alert"
                  onDismiss={() => setSessionActionError(null)}
                  dismissLabel="Dismiss session error"
                >
                  {sessionActionError}
                </Banner>
              </div>
            )}

            {/* The session list owns its own loading / failure state on `lg`
                (where it is on screen); below `lg` it is behind the drawer, so
                the state is stated here instead. Never both — one fact, one
                place (PRD §19.9.8). */}
            {isLoadingSessions && (
              <div className="shrink-0 px-5 pt-4 lg:hidden">
                <Banner tone="info" role="status">
                  Loading your saved sessions…
                </Banner>
              </div>
            )}

            {sessionsError && !isLoadingSessions && (
              <div className="shrink-0 px-5 pt-4 lg:hidden">
                <Banner
                  tone="danger"
                  role="alert"
                  action={
                    <Button size="xs" variant="ghost" onClick={() => void fetchSessions()}>
                      Retry
                    </Button>
                  }
                >
                  {sessionsError}
                </Banner>
              </div>
            )}

            {activeTab === 'cover_letter' && activeSession ? (
              <CoverLetterView
                session={activeSession}
                onSendMessage={handleSendMessage}
                isSending={isSending}
              />
            ) : (
              <ChatArea
                session={activeSession}
                messages={messages}
                onSendMessage={handleSendMessage}
                onUploadResume={handleUploadResume}
                onFetchJobLink={handleFetchJobLink}
                onUpdateSessionFields={handleUpdateSessionFields}
                onCreateSession={() => handleCreateSession()}
                isSending={isSending}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            )}
          </main>

          {/* 3. Live resume preview (xl and up) */}
          <aside className="hidden w-preview shrink-0 border-l border-border xl:block">
            {renderPreviewPane(isXlUp)}
          </aside>
        </div>
      </div>

      {/* Narrow-viewport session drawer */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            data-scrim="true"
            className="absolute inset-0 bg-scrim"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute inset-y-0 left-0 w-sidebar max-w-[85vw] bg-surface shadow-modal">
            <SessionList
              sessions={sessions}
              activeSessionId={activeSessionId}
              isLoading={isLoadingSessions}
              error={sessionsError}
              onRetry={fetchSessions}
              onSelectSession={handleSelectSession}
              onCreateSession={handleCreateSession}
              onDeleteSession={handleDeleteSession}
              onRenameSession={handleRenameSession}
            />
          </div>
        </div>
      )}

      {/* Narrow-viewport full-screen preview */}
      {previewOpen && (
        <div className="fixed inset-0 z-40 flex flex-col bg-page-app xl:hidden">
          <div className="flex h-header shrink-0 items-center justify-between border-b border-border-soft bg-surface px-4">
            <span className="font-heading text-sm font-medium text-text-heading">Resume preview</span>
            <Button
              size="xs"
              variant="outline"
              iconOnly
              aria-label="Close resume preview"
              title="Close"
              onClick={() => setPreviewOpen(false)}
            >
              <X size={15} />
            </Button>
          </div>
          <div className="min-h-0 flex-1">{renderPreviewPane(!isXlUp)}</div>
        </div>
      )}

      {/* AI Provider Settings Modal (M8) */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={(s) => {
          setSettings(s);
          setSettingsNoticeDismissed(false);
        }}
      />
    </div>
  );
}

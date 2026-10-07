/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * ChatArea — the studio's interview pane, plus the two ingestion surfaces:
 *
 *  · Upload / paste an old CV (PRD §5.8). Extraction is **never** persisted
 *    automatically: a 200 outcome opens an inline review panel, the user
 *    confirms or corrects the text, and only then does it reach the session.
 *    An empty extraction (422 `EXTRACT_EMPTY`) opens the same panel in paste
 *    mode, because paste-as-text is the documented recovery.
 *  · Job context (PRD §5.9). Pasted description is the primary path; a link
 *    fetch is best-effort and secondary, and its failures are an inline Banner
 *    inside the panel — never a blocking browser alert.
 *
 * Both surfaces are flat `Card`s in the stream below the topbar (PRD §19.10):
 * no modal, no pills, no dark band, no shadow, no raw hex.
 */

import React, { useState, useRef, useEffect } from 'react';
import { Message, Session } from '../types';
import {
  Send,
  Upload,
  Sparkles,
  Loader2,
  Settings,
  Plus,
  PenLine,
  Mail,
  Scissors,
  ClipboardPaste,
  ChevronDown,
  FileText
} from 'lucide-react';
import { Badge, Banner, Button, Card, Divider, EmptyState, IconTile, Input, Textarea, ToolTab, cn } from './ui';

/**
 * Typed ingestion results (PRD §5.8 / §5.9). The handlers return one of these
 * instead of throwing a string, so the UI can branch on the server's machine
 * code — `EXTRACT_EMPTY` opens the paste recovery, `UNSUPPORTED_TYPE` is a
 * plain error.
 */
export type UploadOutcome =
  | { ok: true; text: string; chars: number; format: string }
  | { ok: false; code: string; error: string };

export type JobFetchOutcome =
  | { ok: true; text: string; chars: number; url: string; truncated: boolean }
  | { ok: false; code: string; error: string };

/**
 * User-defined type guards, not bare `if (outcome.ok)`. This project does not
 * enable `strictNullChecks`, and under that setting TypeScript refuses to
 * narrow a boolean-discriminated union (GOTCHA #52). A predicate narrows in
 * both branches under both compiler settings.
 */
function isUploadSuccess(
  outcome: UploadOutcome
): outcome is { ok: true; text: string; chars: number; format: string } {
  return outcome.ok === true;
}

function isJobFetchSuccess(
  outcome: JobFetchOutcome
): outcome is { ok: true; text: string; chars: number; url: string; truncated: boolean } {
  return outcome.ok === true;
}

interface ChatAreaProps {
  session: Session | null;
  messages: Message[];
  onSendMessage: (content: string) => void;
  onUploadResume: (filename: string, base64Data: string) => Promise<UploadOutcome>;
  onFetchJobLink: (url: string) => Promise<JobFetchOutcome>;
  onUpdateSessionFields: (fields: Partial<Session>) => Promise<void>;
  /** The zero-session empty state's primary action (PRD §19.10 rule 6). */
  onCreateSession: () => void;
  isSending: boolean;
  onOpenSettings?: () => void;
}

/** Disclosure ids — `aria-controls` targets, never `aria-haspopup` (GOTCHA #45). */
const REVIEW_PANEL_ID = 'studio-review-panel';
const JOB_PANEL_ID = 'studio-job-panel';

// `describeAiError` lives in `./aiErrorCopy` so the studio chat pane and the
// `#/templates` generator share one code→copy table (PRD §5.2).

const QUICK_ACTIONS: Array<{ label: string; icon: React.ReactNode; message: string; primary?: boolean }> = [
  {
    label: 'Add tech skills',
    icon: <Plus size={15} />,
    message: 'Add python, react, and node to my skills list'
  },
  {
    label: 'Draft summary',
    icon: <PenLine size={15} />,
    message: 'Draft a professional summary statement'
  },
  {
    label: 'Draft cover letter',
    icon: <Mail size={15} />,
    message: 'Can you generate a tailored cover letter for me now?',
    primary: true
  },
  {
    label: 'Polish summary',
    icon: <Scissors size={15} />,
    message: 'Shorten my summary and improve wording'
  }
];

export default function ChatArea({
  session,
  messages,
  onSendMessage,
  onUploadResume,
  onFetchJobLink,
  onUpdateSessionFields,
  onCreateSession,
  isSending,
  onOpenSettings
}: ChatAreaProps) {
  const [inputText, setInputText] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // §5.8 — the review step. `null` = closed, `'extracted'` = edit the parsed
  // text, `'paste'` = the scanned-PDF / no-file recovery.
  const [reviewMode, setReviewMode] = useState<'extracted' | 'paste' | null>(null);
  const [reviewText, setReviewText] = useState('');
  const [reviewFilename, setReviewFilename] = useState('');
  const [reviewChars, setReviewChars] = useState(0);

  // §5.9 — the job-context disclosure.
  const [jobPanelOpen, setJobPanelOpen] = useState(false);
  const [jobText, setJobText] = useState('');
  const [jobUrl, setJobUrl] = useState('');
  const [jobError, setJobError] = useState<{ code: string; message: string } | null>(null);
  const [isFetchingJob, setIsFetchingJob] = useState(false);

  const [dragActive, setDragActive] = useState(false);
  const messagesListRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Trigger wrappers, so Escape/Cancel can return focus (Button is not a
  // forwardRef component, so the span owns the ref and we focus its button).
  const uploadTriggerRef = useRef<HTMLSpanElement>(null);
  const pasteTriggerRef = useRef<HTMLSpanElement>(null);
  const jobTriggerRef = useRef<HTMLButtonElement>(null);
  const reviewReturnRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    // Scroll the message list itself. `scrollIntoView` also scrolled the app
    // root (overflow-hidden is still programmatically scrollable), which hid
    // the 72px header on load.
    const list = messagesListRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }, [messages, isSending]);

  const focusButtonIn = (wrapper: HTMLSpanElement | null) => {
    wrapper?.querySelector<HTMLButtonElement>('button')?.focus();
  };

  const closeReviewPanel = () => {
    setReviewMode(null);
    setReviewText('');
    setReviewFilename('');
    setReviewChars(0);
  };

  const dismissReview = () => {
    closeReviewPanel();
    // The trigger is disabled while a panel is open, so focus it after React
    // has re-enabled it.
    const target = reviewReturnRef.current;
    window.setTimeout(() => focusButtonIn(target), 0);
  };

  // Escape closes whichever panel is open and returns focus to its trigger.
  // This is a disclosure/region, not a modal — focus is returned because the
  // user is still in the tool rail, not because a dialog closed (PRD §19.7).
  useEffect(() => {
    if (!reviewMode && !jobPanelOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (reviewMode) {
        dismissReview();
      } else if (jobPanelOpen) {
        setJobPanelOpen(false);
        setJobError(null);
        window.setTimeout(() => jobTriggerRef.current?.focus(), 0);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewMode, jobPanelOpen]);

  if (!session) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-page-app p-8">
        <EmptyState
          icon={<FileText size={18} aria-hidden="true" />}
          title="No resume session open"
          description="Create a resume session and the assistant will interview you, filling the live preview as you go. Select a saved session to continue where you left off."
          action={
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={onCreateSession}>Start a new resume</Button>
              {onOpenSettings && (
                <Button
                  variant="outline"
                  startIcon={<Settings size={15} aria-hidden="true" />}
                  onClick={onOpenSettings}
                >
                  AI provider settings
                </Button>
              )}
            </div>
          }
        />
      </div>
    );
  }

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isSending) return;
    onSendMessage(inputText.trim());
    setInputText('');
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const readFileAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result;
        if (typeof result === 'string' && result.indexOf(',') !== -1) {
          resolve(result.slice(result.indexOf(',') + 1));
        } else {
          reject(new Error('The file could not be read.'));
        }
      };
      reader.onerror = () => reject(new Error('The file could not be read.'));
      reader.readAsDataURL(file);
    });

  /**
   * §5.8 — extract, then stop. A successful extraction opens the review panel
   * and **writes nothing**: no `source_text` PUT, no chat message. The old code
   * did both immediately, which handed the model text the user had never seen.
   */
  const processFile = async (file: File) => {
    if (reviewMode) return; // one upload at a time — the review step owns the pane
    setIsUploading(true);
    setUploadError(null);
    try {
      const base64 = await readFileAsBase64(file);
      const outcome = await onUploadResume(file.name, base64);
      if (isUploadSuccess(outcome)) {
        reviewReturnRef.current = uploadTriggerRef.current;
        setReviewMode('extracted');
        setReviewText(outcome.text);
        setReviewFilename(file.name);
        setReviewChars(outcome.chars);
      } else if (outcome.code === 'EXTRACT_EMPTY') {
        // Scanned / image-only: no text layer. Offer paste instead of passing
        // emptiness to the model (PRD §5.8).
        reviewReturnRef.current = uploadTriggerRef.current;
        setReviewMode('paste');
        setReviewText('');
        setReviewFilename(file.name);
        setReviewChars(0);
      } else {
        setUploadError(outcome.error);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to read file contents');
    } finally {
      setIsUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
    // Allow re-selecting the same file after a cancel.
    e.target.value = '';
  };

  const openPastePanel = () => {
    if (reviewMode) return;
    reviewReturnRef.current = pasteTriggerRef.current;
    setUploadError(null);
    setReviewMode('paste');
    setReviewText('');
    setReviewFilename('');
    setReviewChars(0);
  };

  /** Confirm the reviewed (or pasted) CV text — the only place `source_text` is written. */
  const handleUseReviewText = async () => {
    const text = reviewText.trim();
    if (!text) return;
    const cameFromFile = reviewMode === 'extracted' && !!reviewFilename;
    const filename = reviewFilename;
    await onUpdateSessionFields({ source_text: text });
    if (cameFromFile) {
      onSendMessage(
        `I uploaded my existing resume file: "${filename}". Please parse the experiences and structure it.`
      );
    } else {
      onSendMessage('I pasted my existing resume as text. Please parse the experiences and structure it.');
    }
    dismissReview();
  };

  const toggleJobPanel = () => {
    setJobError(null);
    if (jobPanelOpen) {
      setJobPanelOpen(false);
      window.setTimeout(() => jobTriggerRef.current?.focus(), 0);
    } else {
      setJobPanelOpen(true);
    }
  };

  /** §5.9 primary path — pasted description wins. */
  const handleUseJobText = async () => {
    const text = jobText.trim();
    if (!text) return;
    await onUpdateSessionFields({ job_text: text });
    onSendMessage(
      "I've pasted a target job posting description. Please analyze it and tailor my resume/cover letter towards it."
    );
    setJobText('');
    setJobError(null);
    setJobPanelOpen(false);
    window.setTimeout(() => jobTriggerRef.current?.focus(), 0);
  };

  const handleClearJobText = async () => {
    await onUpdateSessionFields({ job_text: '' });
    setJobError(null);
  };

  /** §5.9 secondary path — best effort. Failures are an inline Banner. */
  const handleFetchJob = async () => {
    const url = jobUrl.trim();
    if (!url || isFetchingJob) return;
    setIsFetchingJob(true);
    setJobError(null);
    const outcome = await onFetchJobLink(url);
    setIsFetchingJob(false);
    if (isJobFetchSuccess(outcome)) {
      await onUpdateSessionFields({ job_text: outcome.text });
      onSendMessage(
        "I've pasted a target job posting description. Please analyze it and tailor my resume/cover letter towards it."
      );
      setJobUrl('');
      setJobPanelOpen(false);
      window.setTimeout(() => jobTriggerRef.current?.focus(), 0);
    } else {
      setJobError({ code: outcome.code, message: outcome.error });
    }
  };

  const handleQuickAction = (actionText: string) => {
    onSendMessage(actionText);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-page-app text-text-body">
      {/* Target job link / source document status topbar */}
      <div className="flex shrink-0 flex-col gap-3 border-b border-border-soft bg-surface px-5 py-3.5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <h2 className="type-h5 truncate">{session.title}</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {session.source_text ? (
              <Badge tone="success">Original CV loaded</Badge>
            ) : (
              <Badge tone="neutral">No source CV uploaded</Badge>
            )}

            {session.job_text ? (
              <Badge tone="accent">Job spec tailoring on</Badge>
            ) : (
              <Badge tone="neutral">No target job tuning</Badge>
            )}
          </div>
        </div>

        {/* Action controls for importing or fetching. Tools are text/flat, not
            a chip cloud (PRD §19.10 rule 2). */}
        <div className="flex min-w-0 flex-wrap items-center gap-2 md:justify-end">
          {/* File Upload Trigger */}
          <span ref={uploadTriggerRef} className="contents">
            <Button
              size="xs"
              variant="outline"
              className="min-h-11"
              loading={isUploading}
              disabled={isUploading || reviewMode !== null}
              startIcon={<Upload size={12} />}
              onClick={() => fileInputRef.current?.click()}
            >
              Upload old CV
            </Button>
          </span>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept=".pdf,.docx,.txt,.md"
            className="hidden"
          />

          {/* §5.8 — a user with no file must still have the paste path. */}
          <span ref={pasteTriggerRef} className="contents">
            <Button
              size="xs"
              variant="ghost"
              className="min-h-11"
              disabled={reviewMode !== null}
              startIcon={<ClipboardPaste size={12} />}
              onClick={openPastePanel}
            >
              Paste CV text
            </Button>
          </span>

          {/* §5.9 — one text-rail disclosure, not an inline URL field. */}
          <ToolTab
            ref={jobTriggerRef}
            active={jobPanelOpen}
            aria-pressed={undefined}
            aria-expanded={jobPanelOpen}
            aria-controls={JOB_PANEL_ID}
            title="Job context"
            className="min-h-11"
            endIcon={
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={`transition-transform duration-200 ease-in-out ${jobPanelOpen ? 'rotate-180' : ''}`}
              />
            }
            onClick={toggleJobPanel}
          >
            Job context
          </ToolTab>
        </div>
      </div>

      {/* §5.8 review step — extraction is shown, corrected, then confirmed. */}
      {reviewMode && (
        <div className="shrink-0 px-5 pt-3">
          <Card
            id={REVIEW_PANEL_ID}
            role="region"
            aria-label={reviewMode === 'extracted' ? 'Review extracted text' : 'Paste your CV text'}
            className="min-w-0"
          >
            <div className="flex min-w-0 flex-col gap-3">
              <div className="min-w-0">
                <h3 className="type-h5">
                  {reviewMode === 'extracted' ? 'Review extracted text' : 'Paste your CV text'}
                </h3>
                <p className="type-meta mt-1">
                  {reviewMode === 'extracted'
                    ? `Extracted ${reviewChars} characters from ${reviewFilename}. PDFs with columns are often scrambled - check the order before using it.`
                    : reviewFilename
                      ? "We couldn't find any text in this file. It may be a scanned image or an image-only PDF. Paste the text instead - the assistant reads text only, so it never needs the file itself."
                      : 'The assistant reads text only. Paste the text of your existing CV here and it will structure the details from it.'}
                </p>
              </div>
              <Textarea
                rows={10}
                value={reviewText}
                onChange={(e) => setReviewText(e.target.value)}
                placeholder={reviewMode === 'extracted' ? undefined : 'Paste your CV text here…'}
                aria-label={reviewMode === 'extracted' ? 'Extracted CV text' : 'CV text'}
                className="min-w-0"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={handleUseReviewText} disabled={!reviewText.trim()}>
                  Use this text
                </Button>
                <Button variant="outline" onClick={dismissReview}>
                  Cancel
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* §5.9 job context — paste first, link second. */}
      {jobPanelOpen && (
        <div className="shrink-0 px-5 pt-3">
          <Card id={JOB_PANEL_ID} role="region" aria-label="Job context" className="min-w-0">
            <div className="flex min-w-0 flex-col gap-3">
              <div className="min-w-0">
                <h3 className="type-h5">Job context</h3>
                <p className="type-meta mt-1">
                  Paste the job description. The assistant tailors wording, surfaces relevant skills and flags gaps.
                </p>
              </div>

              <Textarea
                rows={6}
                value={jobText}
                onChange={(e) => setJobText(e.target.value)}
                placeholder="Paste the job description here…"
                aria-label="Job description text"
                className="min-w-0"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={handleUseJobText} disabled={!jobText.trim()}>
                  Use this text
                </Button>
              </div>

              {session.job_text && (
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <p className="type-meta min-w-0">Job tailoring is on for this session.</p>
                  <Button size="xs" variant="ghost" onClick={handleClearJobText}>
                    Clear job text
                  </Button>
                </div>
              )}

              <Divider />

              <div className="flex min-w-0 flex-col gap-2">
                <p className="type-meta min-w-0">
                  Or fetch from a link (best effort). Job boards are JavaScript-rendered, so a link often returns an
                  empty page - pasting the description above is more reliable.
                </p>
                <div className="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap">
                  <Input
                    type="url"
                    placeholder="Paste job listing URL…"
                    value={jobUrl}
                    onChange={(e) => setJobUrl(e.target.value)}
                    className="h-8 min-w-0 flex-1 px-2.5 py-0 text-xs"
                    onKeyDown={(e) => e.key === 'Enter' && handleFetchJob()}
                  />
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={isFetchingJob || !jobUrl.trim()}
                    loading={isFetchingJob}
                    onClick={handleFetchJob}
                  >
                    Fetch
                  </Button>
                </div>
                {jobError && (
                  <Banner tone="warn" role="status">
                    {jobError.message}
                  </Banner>
                )}
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Upload Error Banner */}
      {uploadError && (
        <div className="shrink-0 px-5 pt-3">
          <Banner tone="danger" role="alert" onDismiss={() => setUploadError(null)}>
            {uploadError}
          </Banner>
        </div>
      )}

      {/* The AI failure notice is rendered by the studio shell, not here, so it
          is visible on the cover-letter tab as well and exists exactly once
          (PRD §5.2 "never silent"). */}

      {/* Messages Scroll Area */}
      <div
        ref={messagesListRef}
        className={cn(
          'scroll-quiet relative min-h-0 flex-1 space-y-4 overflow-y-auto p-5',
          dragActive && 'bg-primary-soft'
        )}
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
      >
        {dragActive && (
          <div className="pointer-events-none absolute inset-3 z-30 flex flex-col items-center justify-center rounded-card border-2 border-dashed border-primary-border bg-primary-soft text-primary">
            <Upload size={40} className="mb-2" />
            <p className="font-heading text-base font-medium">Drop your old resume here</p>
            <p className="type-meta mt-1">PDF, DOCX, TXT or MD: the assistant will pre-fill the details.</p>
          </div>
        )}

        {/* Quiet empty state, h6 heading, at most two actions (PRD §19.10 rule
            6). Paste-as-text and upload stay permanently reachable in the
            topbar, so the third button was repetition, not a route. */}
        {messages.length === 0 && !isSending && (
          <div className="flex h-full items-center justify-center py-8">
            <EmptyState
              icon={<Sparkles size={18} aria-hidden="true" />}
              title="No messages yet"
              description="Tell the assistant about your target role, or upload an old CV to get started."
              action={
                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={() => onSendMessage("I'd like to start building my resume.")}>
                    Start the interview
                  </Button>
                  <Button
                    variant="outline"
                    startIcon={<Upload size={15} aria-hidden="true" />}
                    disabled={reviewMode !== null}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Upload old CV
                  </Button>
                </div>
              }
            />
          </div>
        )}

        {messages.map((m) => {
          const isUser = m.role === 'user';
          return (
            <div
              key={m.id}
              className={cn('flex animate-fade-in gap-2.5', isUser ? 'justify-end' : 'justify-start')}
            >
              {!isUser && (
                <IconTile size="sm" className="mt-0.5">
                  <Sparkles size={15} />
                </IconTile>
              )}
              <div
                className={cn(
                  'max-w-[80%] whitespace-pre-wrap rounded-card p-4 text-sm leading-relaxed',
                  isUser
                    ? 'bg-primary text-white'
                    : 'border border-border-soft bg-surface text-text-body'
                )}
              >
                {!isUser && (
                  <div className="mb-1.5 select-none font-heading text-meta font-medium uppercase tracking-eyebrow text-primary">
                    AI career assistant
                  </div>
                )}
                <div>{m.content}</div>
              </div>
            </div>
          );
        })}

        {isSending && (
          <div className="flex animate-pulse justify-start gap-2.5">
            <IconTile size="sm" className="mt-0.5">
              <Sparkles size={15} />
            </IconTile>
            <div className="flex items-center gap-2 rounded-card border border-border-soft bg-surface p-4 text-sm text-text-muted">
              <Loader2 size={16} className="animate-spin text-primary" />
              <span>Reviewing your details and updating the resume…</span>
            </div>
          </div>
        )}

      </div>

      {/* Suggested Quick Actions — wraps instead of scrolling so a chip label is
          never clipped mid-word (the old `overflow-x-auto` + fade cut "Polish
          summary" at 1440). */}
      <div
        data-quick-actions="true"
        className="flex shrink-0 select-none flex-wrap items-center gap-2 border-t border-border-soft bg-surface px-5 py-2.5"
      >
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            type="button"
            // A suggestion that silently swallows a click while a turn is in
            // flight is a dead control; disable it for the duration instead.
            disabled={isSending}
            onClick={() => handleQuickAction(action.message)}
            className={cn(
              'group inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-button border px-3 py-1.5 text-xs font-medium transition-colors duration-200 ease-in-out',
              'disabled:cursor-not-allowed disabled:opacity-50',
              action.primary
                ? 'border-primary-border bg-surface text-primary hover:border-primary hover:bg-primary-soft'
                : 'border-border bg-surface text-text-muted hover:border-primary-border hover:text-primary'
            )}
          >
            <span className={cn('shrink-0', action.primary ? 'text-accent' : 'text-primary')}>
              {action.icon}
            </span>
            {action.label}
          </button>
        ))}
      </div>

      {/* Chat input box */}
      <form onSubmit={handleSend} className="flex shrink-0 gap-2 border-t border-border-soft bg-surface p-4">
        <Input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Talk to the assistant… (e.g. 'add my Software Engineer role at Google from 2021 to 2024')"
          className="flex-1 px-4 py-3 text-sm"
          disabled={isSending}
        />
        <Button
          type="submit"
          iconOnly
          size="lg"
          aria-label="Send message"
          title="Send"
          disabled={!inputText.trim() || isSending}
          loading={isSending}
        >
          {!isSending && <Send size={16} />}
        </Button>
      </form>
    </div>
  );
}

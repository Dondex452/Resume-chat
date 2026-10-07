/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * M15 — true-text PDF export (PRD §11, amended 2026-09-21).
 *
 * The v1/v2 export captured the on-screen paper with `html2canvas` and wrapped
 * the resulting bitmap in `jsPDF`. Measured on a real export: **6,818,220 B for
 * one A4 page, 0 text operators, 0 characters extractable** — and the app's own
 * `/api/upload-resume` classified its own export as a scanned document
 * (`422 EXTRACT_EMPTY`). A resume's PDF exists to be parsed by machines, so the
 * export MUST carry a real text layer. See GOTCHA #56.
 *
 * The engine is a browser that is **already installed**. Chrome and Edge carry
 * `--headless=new --print-to-pdf`, so nothing is downloaded or bundled and no
 * HTML→PDF library is added (PRD §14 Decision #26). Measured on this machine:
 * one A4 page, 594.96 × 841.92 pt, 106/106 characters extracted, ≈23 KB.
 *
 * This module is a leaf: no DB, no HTTP, no session writes, no knowledge of the
 * resume. It discovers a browser, prints a URL to a file, validates the output,
 * and cleans up after itself. `findBrowser()` takes an injected existence probe
 * so the discovery ORDER is unit-testable without touching the disk, and
 * `renderPdf()` takes an injected spawn so its contract is testable too.
 *
 * House style (matching `server/ingestion/extract.ts` and `safeFetchText`):
 * failures are returned as `{ ok:false, code, error }`, never thrown as a stack
 * trace, and the code maps to an HTTP status in the route.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Codes and messages
// ---------------------------------------------------------------------------

export type PdfExportCode = 'PDF_ENGINE_UNAVAILABLE' | 'PDF_RENDER_FAILED';

/**
 * User-facing and actionable: it names the FALLBACK (the raster path the client
 * already carries) and the ESCAPE HATCH for a browser in a non-standard place.
 */
export const PDF_ENGINE_UNAVAILABLE_MESSAGE =
  'No usable PDF engine was found. PDF export needs a Chromium-based browser ' +
  '(Google Chrome or Microsoft Edge) installed on this machine. Exporting will ' +
  'fall back to an image-based PDF, which has no selectable text. To point the ' +
  'app at a browser yourself, set RESUME_BROWSER_PATH to its full executable path.';

export const PDF_RENDER_FAILED_MESSAGE =
  'The PDF engine could not render this resume. Exporting will fall back to an ' +
  'image-based PDF, which has no selectable text.';

/**
 * Smallest plausible COMPLETE PDF. Chrome's genuinely-blank one-page output
 * measures **871 B** on this machine, so the floor must sit below that — a size
 * threshold alone would report a render failure for an empty resume. The real
 * completeness signal is the `%%EOF` trailer below.
 */
export const MIN_PDF_BYTES = 512;

const PDF_MAGIC = Buffer.from('%PDF-');
const PDF_EOF_MARKER = Buffer.from('%%EOF');

/** How long to keep polling for the output after the browser process exits. */
export const PDF_WRITE_GRACE_MS = 2000;

/** Hard ceiling on a single render. Killing the tree, not just the parent. */
export const DEFAULT_RENDER_TIMEOUT_MS = 30_000;

/**
 * Virtual milliseconds granted to the page before it is printed. Chrome's
 * `--virtual-time-budget` pauses virtual time while network fetches are pending,
 * so this is a budget for *script + layout*, not for the network. The dev server
 * transforms modules on demand through Vite middleware (each a fetch), and the
 * print view waits on `document.fonts.ready` before signalling readiness, so a
 * value comfortably above a typical module graph is chosen rather than a tight
 * one. Overridable via `RESUME_PDF_VIRTUAL_TIME_BUDGET_MS` or the option.
 */
export const DEFAULT_VIRTUAL_TIME_BUDGET_MS = 8000;

// ---------------------------------------------------------------------------
// Browser discovery
// ---------------------------------------------------------------------------

export type BrowserSource = 'env' | 'standard' | 'path';

export interface BrowserCandidate {
  path: string;
  /** How it was found — so the caller/error can be specific. */
  source: BrowserSource;
}

export interface BrowserDiscoveryOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** The only thing that touches the disk. Injected for ordering tests. */
  exists?: (candidate: string) => boolean;
  /** Injected PATH value; defaults to the environment's PATH/Path. */
  pathValue?: string;
  pathDelimiter?: string;
}

function defaultExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Absolute install locations, in priority order. Windows follows PRD's list —
 * Edge (x86), Chrome (Program Files), Chrome (%LOCALAPPDATA%), Chrome (x86) —
 * then the x64 Edge location, which is where Edge actually lives on a 64-bit
 * install and would otherwise be missed.
 */
export function standardBrowserPaths(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = {},
): string[] {
  if (platform === 'win32') {
    const localAppData = (env.LOCALAPPDATA || env.LocalAppData || '').replace(/[\\/]+$/, '');
    const candidates = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      localAppData ? `${localAppData}\\Google\\Chrome\\Application\\chrome.exe` : '',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    return candidates.filter((value) => value !== '');
  }

  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }

  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
  ];
}

/** Command names to look for on `PATH`. */
export function pathLookupNames(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return ['chrome.exe', 'msedge.exe', 'chrome', 'msedge'];
  }
  return ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'chrome', 'msedge'];
}

/**
 * Find a Chromium-based browser, in a fixed order:
 *
 *   1. `RESUME_BROWSER_PATH` — when set AND the file exists,
 *   2. the standard install locations for this platform,
 *   3. a `PATH` lookup.
 *
 * Returns `null` when nothing is found. The decision is pure; all filesystem
 * access goes through the injectable `exists` probe.
 */
export function findBrowser(options: BrowserDiscoveryOptions = {}): BrowserCandidate | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? defaultExists;

  const fromEnv = (env.RESUME_BROWSER_PATH || '').trim();
  if (fromEnv && exists(fromEnv)) {
    return { path: fromEnv, source: 'env' };
  }

  for (const candidate of standardBrowserPaths(platform, env)) {
    if (exists(candidate)) return { path: candidate, source: 'standard' };
  }

  const pathValue = options.pathValue ?? (env.PATH || env.Path || '');
  const delimiter = options.pathDelimiter ?? (platform === 'win32' ? ';' : ':');
  // Build the join by hand rather than `path.join`, so a `linux` ordering test
  // does not get backslash-joined on a Windows host.
  const separator = platform === 'win32' ? '\\' : '/';

  for (const rawDir of pathValue.split(delimiter)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
    if (!dir) continue;
    for (const name of pathLookupNames(platform)) {
      const candidate = `${dir}${separator}${name}`;
      if (exists(candidate)) return { path: candidate, source: 'path' };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

/** Env `PORT` when it is a sane TCP port, else the app's default of 3000. */
export function resolvePort(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.PORT);
  return Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : 3000;
}

/** Env `RESUME_PDF_VIRTUAL_TIME_BUDGET_MS` when sane, else the default. */
export function resolveVirtualTimeBudgetMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.RESUME_PDF_VIRTUAL_TIME_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_VIRTUAL_TIME_BUDGET_MS;
}

/**
 * The URL the server prints. The session id goes in the **search** and the hash
 * is **exactly** `#/print`.
 *
 * `readRoute()` is an exact hash compare (GOTCHA #47), so `#/print?x=1` would
 * silently render the wrong route — a cache-buster belongs in the search.
 */
export function buildPrintViewUrl(sessionId: string, port: number = resolvePort()): string {
  return `http://localhost:${port}/?session=${encodeURIComponent(sessionId)}#/print`;
}

// ---------------------------------------------------------------------------
// Filename sanitising
// ---------------------------------------------------------------------------

/** The cap keeps the Content-Disposition header short and predictable. */
export const MAX_FILENAME_BASE_LENGTH = 80;
export const FALLBACK_FILENAME_BASE = 'resume';

/**
 * Turn a session title into a safe filename base.
 *
 * Anything outside `[A-Za-z0-9 _-]` is dropped (replaced by a space so words
 * stay separated: `CV/Resume` -> `CV Resume`), whitespace is collapsed, the
 * result is capped, and an empty result falls back to `resume` so the caller
 * always gets a usable name. Output is ASCII-only, so it is safe to quote in a
 * `Content-Disposition` header verbatim.
 */
export function sanitizeFilenameBase(title: unknown): string {
  const raw = typeof title === 'string' ? title : '';
  const stripped = raw.replace(/[^A-Za-z0-9 _-]/g, ' ');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  const capped = collapsed.slice(0, MAX_FILENAME_BASE_LENGTH).trim();
  return capped || FALLBACK_FILENAME_BASE;
}

/** The full download name, including the `.pdf` suffix. */
export function sanitizeFilename(title: unknown): string {
  return `${sanitizeFilenameBase(title)}.pdf`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export type SpawnLike = (command: string, args: string[], options: any) => any;

export interface RenderPdfOptions {
  url: string;
  outPath: string;
  timeoutMs?: number;
  virtualTimeBudgetMs?: number;
  /** Pre-resolved executable. When omitted, `findBrowser()` runs. */
  browserPath?: string;
  /** Injected for tests. Defaults to `child_process.spawn`. */
  spawnImpl?: SpawnLike;
  /** Root for the throwaway profile dir. Defaults to the OS temp dir. */
  tempDir?: string;
}

export interface RenderPdfResult {
  ok: boolean;
  outPath: string;
  byteLength: number;
  elapsedMs: number;
  code?: PdfExportCode;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Kill the whole process tree.
 *
 * On Windows `child.kill()` terminates only the launched process; Chrome spawns
 * a swarm of children that can survive and hold the profile dir open. `taskkill
 * /T /F` is the only reliable tree kill.
 */
function killProcessTree(child: any): void {
  const pid = child?.pid;
  if (process.platform === 'win32' && typeof pid === 'number') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      /* best effort */
    }
  }
  try {
    child?.kill?.('SIGKILL');
  } catch {
    /* already gone */
  }
}

interface RunOutcome {
  ok: boolean;
}

/**
 * Spawn the browser and resolve when it exits. The timer both kills the tree
 * and resolves the promise, so a process that never emits `close` after a kill
 * cannot hang the request.
 */
function runBrowser(
  spawnImpl: SpawnLike,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<RunOutcome> {
  return new Promise<RunOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let child: any = null;

    const finish = (result: RunOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawnImpl(command, args, { stdio: 'ignore', windowsHide: true });
    } catch {
      finish({ ok: false });
      return;
    }

    if (!child || typeof child.on !== 'function') {
      finish({ ok: false });
      return;
    }

    timer = setTimeout(() => {
      killProcessTree(child);
      finish({ ok: false });
    }, timeoutMs);

    child.on('error', () => finish({ ok: false }));
    child.on('close', (code: number | null) => finish({ ok: code === 0 }));
  });
}

interface PdfProbe {
  ok: boolean;
  buffer: Buffer | null;
  byteLength: number;
}

/**
 * Read the output and judge it: `%PDF-` magic, a non-trivial size, and the
 * `%%EOF` trailer every complete PDF ends with. The trailer is what separates a
 * finished document from a truncated write — a bare size floor cannot.
 */
function probePdf(outPath: string): PdfProbe {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(outPath);
  } catch {
    return { ok: false, buffer: null, byteLength: 0 };
  }
  if (!stat.isFile()) return { ok: false, buffer: null, byteLength: 0 };

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(outPath);
  } catch {
    return { ok: false, buffer: null, byteLength: stat.size };
  }

  if (buffer.length < MIN_PDF_BYTES) return { ok: false, buffer: null, byteLength: buffer.length };
  if (!buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return { ok: false, buffer: null, byteLength: buffer.length };
  }

  const tailStart = Math.max(0, buffer.length - 1024);
  if (!buffer.subarray(tailStart).includes(PDF_EOF_MARKER)) {
    return { ok: false, buffer: null, byteLength: buffer.length };
  }

  return { ok: true, buffer, byteLength: buffer.length };
}

/**
 * Wait for a valid PDF. The write normally lands before the process exits, but
 * the file handle can flush a beat later; polling a short grace window is
 * cheaper than a flaky "render failed" on a good render.
 */
async function waitForValidPdf(outPath: string, graceMs: number): Promise<PdfProbe> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const probe = probePdf(outPath);
    if (probe.ok) return probe;
    if (Date.now() >= deadline) return probe;
    await sleep(100);
  }
}

function removeQuietly(target: string, recursive = false): void {
  try {
    fs.rmSync(target, { recursive, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Print `url` to `outPath` with an installed Chromium.
 *
 * Never throws: a missing browser is `PDF_ENGINE_UNAVAILABLE`, everything else
 * (spawn failure, non-zero exit, timeout, missing/invalid output) is
 * `PDF_RENDER_FAILED`. The caller owns `outPath` on success; on any failure a
 * partial file is deleted so it cannot be mistaken for a real one.
 */
export async function renderPdf(options: RenderPdfOptions): Promise<RenderPdfResult> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const outPath = path.resolve(options.outPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const virtualTimeBudgetMs = options.virtualTimeBudgetMs ?? resolveVirtualTimeBudgetMs();

  let browserPath = options.browserPath;
  if (!browserPath) {
    const found = findBrowser();
    if (!found) {
      return {
        ok: false,
        outPath,
        byteLength: 0,
        elapsedMs: elapsed(),
        code: 'PDF_ENGINE_UNAVAILABLE',
        error: PDF_ENGINE_UNAVAILABLE_MESSAGE,
      };
    }
    browserPath = found.path;
  }

  const spawnImpl = options.spawnImpl ?? (spawn as unknown as SpawnLike);

  // A throwaway profile is mandatory: without it Chrome attaches to (or is
  // blocked by) the user's *running* profile, and the print either fails or
  // hijacks an existing window.
  let profileDir = '';
  try {
    profileDir = fs.mkdtempSync(path.join(options.tempDir ?? os.tmpdir(), 'resume-pdf-profile-'));
  } catch {
    return {
      ok: false,
      outPath,
      byteLength: 0,
      elapsedMs: elapsed(),
      code: 'PDF_RENDER_FAILED',
      error: PDF_RENDER_FAILED_MESSAGE,
    };
  }

  try {
    // A stale file must not be able to pass for this render's output.
    removeQuietly(outPath);

    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profileDir}`,
      // A deterministic, DESKTOP-width viewport.
      //
      // Chrome's headless default window is 800x600, and the resume templates use
      // responsive classes (`md:grid-cols-3` and friends). At 754 usable px the
      // `md:` breakpoint does not match, so the template lays itself out as its
      // **stacked, narrow-screen variant**: measured on the same document, the
      // content was **1777 px tall at the default window and 1300 px at a desktop
      // width**. The print then captured a layout the user never sees in the
      // preview, which cannot fit a page — the "preview shows one page, the PDF is
      // two" defect. The window must therefore be wide enough that every
      // breakpoint the templates use matches, and fixed so the output does not
      // depend on the machine. 1400 is comfortably above the widest breakpoint in
      // use (`lg` = 1024).
      '--window-size=1400,1200',
      `--virtual-time-budget=${virtualTimeBudgetMs}`,
      `--print-to-pdf=${outPath}`,
      options.url,
    ];

    const outcome = await runBrowser(spawnImpl, browserPath, args, timeoutMs);
    if (!outcome.ok) {
      removeQuietly(outPath);
      return {
        ok: false,
        outPath,
        byteLength: 0,
        elapsedMs: elapsed(),
        code: 'PDF_RENDER_FAILED',
        error: PDF_RENDER_FAILED_MESSAGE,
      };
    }

    const probe = await waitForValidPdf(outPath, PDF_WRITE_GRACE_MS);
    if (!probe.ok) {
      removeQuietly(outPath);
      return {
        ok: false,
        outPath,
        byteLength: probe.byteLength,
        elapsedMs: elapsed(),
        code: 'PDF_RENDER_FAILED',
        error: PDF_RENDER_FAILED_MESSAGE,
      };
    }

    return {
      ok: true,
      outPath,
      byteLength: probe.byteLength,
      elapsedMs: elapsed(),
    };
  } catch (error: any) {
    // Never log the URL or session content — only the failure shape.
    console.error('PDF render failed:', error?.message || error);
    removeQuietly(outPath);
    return {
      ok: false,
      outPath,
      byteLength: 0,
      elapsedMs: elapsed(),
      code: 'PDF_RENDER_FAILED',
      error: PDF_RENDER_FAILED_MESSAGE,
    };
  } finally {
    removeQuietly(profileDir, true);
  }
}

export interface RenderResumePdfOptions {
  url: string;
  timeoutMs?: number;
  virtualTimeBudgetMs?: number;
  browserPath?: string;
  spawnImpl?: SpawnLike;
  tempDir?: string;
}

export interface RenderResumePdfResult {
  ok: boolean;
  buffer: Buffer | null;
  code?: PdfExportCode;
  error?: string;
  elapsedMs: number;
}

/**
 * `renderPdf` with all temp-file handling owned internally: it creates a
 * throwaway output path, renders, reads the bytes, and removes the file
 * afterwards (success or failure). This is what the route calls.
 */
export async function renderResumePdf(
  options: RenderResumePdfOptions,
): Promise<RenderResumePdfResult> {
  const tempRoot = options.tempDir ?? os.tmpdir();
  const outPath = path.join(tempRoot, `resume-export-${randomUUID()}.pdf`);

  const result = await renderPdf({ ...options, outPath });

  try {
    if (!result.ok || !fs.existsSync(outPath)) {
      return {
        ok: false,
        buffer: null,
        code: result.code ?? 'PDF_RENDER_FAILED',
        error: result.error ?? PDF_RENDER_FAILED_MESSAGE,
        elapsedMs: result.elapsedMs,
      };
    }
    const buffer = fs.readFileSync(outPath);
    return { ok: true, buffer, elapsedMs: result.elapsedMs };
  } catch {
    return {
      ok: false,
      buffer: null,
      code: 'PDF_RENDER_FAILED',
      error: PDF_RENDER_FAILED_MESSAGE,
      elapsedMs: result.elapsedMs,
    };
  } finally {
    removeQuietly(outPath);
  }
}

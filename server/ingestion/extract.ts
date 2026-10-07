/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * M13 Stage A — text-only document ingestion (PRD §5.8).
 *
 * Design rule: the model only ever receives TEXT. No vision model is required
 * at any point, which is what keeps cheap and local models viable.
 *
 * This module is deliberately PURE with respect to the app: no HTTP, no DB, no
 * session writes. The upload route calls `extractDocumentText()` and maps its
 * result onto the frozen response contract. Extraction on its own never writes
 * anywhere (PRD §5.8 — "extraction never writes to the session on its own").
 *
 * The response contract (frozen 2026-09-20, M13):
 *
 *   Text found                    -> 200 { text, chars, format }
 *   Empty / degenerate extraction -> 422 { error, code:'EXTRACT_EMPTY', format, chars }
 *   Unsupported / magic mismatch  -> 415 { error, code:'UNSUPPORTED_TYPE' }
 *   Missing filename/data         -> 400 { error, code:'BAD_REQUEST' }   (route)
 *   Parser threw                  -> 500 { error, code:'EXTRACT_FAILED' }
 *
 * Accepted extensions: .pdf .docx .txt .md. `.doc` / `.rtf` / `.odt` are
 * rejected EXPLICITLY — v1 fell through to `buffer.toString('utf-8')` and fed
 * binary garbage to the model (GOTCHA #5's sibling). Magic bytes are checked,
 * not just the filename.
 */
import mammoth from 'mammoth';

/** A useful extraction needs at least this many non-whitespace characters. */
export const MIN_TEXT_CHARS = 40;

export type IngestFormat = 'pdf' | 'docx' | 'text';

export type ExtractionErrorCode = 'UNSUPPORTED_TYPE' | 'EXTRACT_EMPTY' | 'EXTRACT_FAILED';

/** Result of `extractDocumentText`. Non-discriminated on purpose (GOTCHA #52:
 *  this project compiles with `strictNullChecks: false`, where a boolean
 *  discriminant does not narrow). */
export interface ExtractDocumentResult {
  ok: boolean;
  format: IngestFormat | null;
  text: string;
  chars: number;
  code?: ExtractionErrorCode;
  error?: string;
}

// Magic bytes. `%PDF-` = 25 50 44 46 2D; a DOCX is a ZIP = 50 4B 03 04.
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Error messages are user-facing and actionable — never a stack trace. */
export const UNSUPPORTED_TYPE_MESSAGE =
  'That file type is not supported. Upload a PDF, DOCX, TXT or MD file - or paste your CV text instead.';
export const EXTRACT_EMPTY_MESSAGE =
  'No text could be read from this file. It may be a scanned image - paste your CV text instead.';
export const EXTRACT_FAILED_MESSAGE =
  'That file could not be read. Paste your CV text instead.';

/** Non-whitespace character count — what `chars` reports everywhere. */
export function countNonWhitespaceCharacters(value: string): number {
  if (!value) return 0;
  return value.replace(/\s+/g, '').length;
}

function startsWith(buffer: Buffer, magic: Buffer): boolean {
  if (buffer.length < magic.length) return false;
  return buffer.subarray(0, magic.length).equals(magic);
}

/** A NUL byte in the first 512 bytes means this is not a text file. */
function containsNulByte(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 512);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0x00) return true;
  }
  return false;
}

function extensionOf(filename: unknown): string {
  if (typeof filename !== 'string') return '';
  const lower = filename.toLowerCase().trim();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return '';
  return lower.slice(dot);
}

/**
 * Detect the effective format from BOTH the filename and the bytes.
 *
 * `ok:false` covers: an unsupported/unknown extension, an accepted extension
 * whose magic bytes belong to another format (e.g. a `.pdf` that is really a
 * ZIP), and a `.txt`/`.md` that is actually binary. The route maps that to 415.
 */
export function detectFormat(
  filename: string,
  buffer: Buffer,
): { ok: boolean; format: IngestFormat | null } {
  const ext = extensionOf(filename);
  const bytes = buffer && buffer.length ? buffer : Buffer.alloc(0);

  // A zero-byte file has no bytes to contradict its name, so the extension
  // decides: the type is fine, there is simply nothing in it. The caller
  // reports this as EXTRACT_EMPTY (PRD §5.8), never as an unsupported type -
  // "0 bytes uploaded" and "you uploaded a .doc" are different failures with
  // different recoveries.
  if (bytes.length === 0) {
    if (ext === '.pdf') return { ok: true, format: 'pdf' };
    if (ext === '.docx') return { ok: true, format: 'docx' };
    if (ext === '.txt' || ext === '.md') return { ok: true, format: 'text' };
    return { ok: false, format: null };
  }

  if (ext === '.pdf') {
    return startsWith(bytes, PDF_MAGIC)
      ? { ok: true, format: 'pdf' }
      : { ok: false, format: null };
  }

  if (ext === '.docx') {
    return startsWith(bytes, ZIP_MAGIC)
      ? { ok: true, format: 'docx' }
      : { ok: false, format: null };
  }

  if (ext === '.txt' || ext === '.md') {
    return containsNulByte(bytes)
      ? { ok: false, format: null }
      : { ok: true, format: 'text' };
  }

  // `.doc`, `.rtf`, `.odt` and anything unknown are rejected explicitly so they
  // can never fall through to a UTF-8 decode of binary data.
  return { ok: false, format: null };
}

/**
 * Judge an extracted string. A scanned PDF commonly yields a stray header
 * rather than a clean `''`, so this counts non-whitespace characters instead of
 * testing for emptiness (PRD §5.8).
 */
export function assessExtraction(
  rawText: string,
): { ok: boolean; text: string; chars: number } {
  const source = typeof rawText === 'string' ? rawText : '';
  const chars = countNonWhitespaceCharacters(source);
  if (chars < MIN_TEXT_CHARS) {
    return { ok: false, text: '', chars };
  }
  return { ok: true, text: source.trim(), chars };
}

// PDF text extraction, via Mozilla's maintained pdf.js (`pdfjs-dist`).
//
// This replaced `pdf-parse@1.1.x` during M13. That package bundles pdf.js
// **v1.10.100 from 2018** with `disableWorker = true`, and it is intermittently
// wrong inside a long-running process: measured **2/10 failures in a plain Node
// process** and **40/80 against the real server**, with pdf.js reporting
// `bad XRef entry` and `Illegal character: 41` ("the bytes I was given are not
// this PDF") on files that parse perfectly moments later. Vite-in-process was
// tested and ruled out, as were concurrency and Node's Buffer pooling - the
// library itself is the fault, so it is gone rather than worked around.
//
// `pdfjs-dist@6` runs the same algorithm with the bug fixed: measured **20/20
// sequential, 20/20 concurrent, 0/10 wrong** on a 6.8 MB image-only scan.
//
// `new Uint8Array(buffer)` gives pdf.js its own ArrayBuffer instead of a view
// into Node's shared 8 KB Buffer pool, so nothing it does to the data can
// disturb any other allocation in the process.
let pdfjsModule: Promise<any> | null = null;

function loadPdfjs(): Promise<any> {
  if (!pdfjsModule) pdfjsModule = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsModule;
}

async function pdfParse(buffer: Buffer): Promise<{ text: string }> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    // Keeps pdf.js strictly headless: no worker fetch, no eval, no font
    // loading, no console noise. Text extraction needs none of them.
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });

  const doc = await task.promise;
  try {
    let text = '';
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      text +=
        content.items
          .map((item: any) => (typeof item?.str === 'string' ? item.str : ''))
          .join(' ') + '\n';
      page.cleanup();
    }
    return { text };
  } finally {
    await task.destroy();
  }
}

/**
 * Extract plain text from a PDF / DOCX / TXT / MD buffer.
 *
 * Pure: never touches the DB or a session. The caller decides what to do with
 * `text` and must show it for confirmation before it is used (PRD §5.8).
 */
export async function extractDocumentText(
  filename: string,
  buffer: Buffer,
): Promise<ExtractDocumentResult> {
  const bytes = buffer && buffer.length ? buffer : Buffer.alloc(0);
  const detection = detectFormat(filename, bytes);

  if (!detection.ok || !detection.format) {
    return {
      ok: false,
      format: null,
      text: '',
      chars: 0,
      code: 'UNSUPPORTED_TYPE',
      error: UNSUPPORTED_TYPE_MESSAGE,
    };
  }

  const format = detection.format;
  let raw = '';

  // A zero-byte file never reaches a parser. `pdf-parse` throws "bad XRef entry"
  // on an empty buffer and `mammoth` throws too, which would surface as the
  // alarming, wrong EXTRACT_FAILED ("that file could not be read") when the
  // truth is simply that there was nothing in it.
  if (bytes.length === 0) {
    return {
      ok: false,
      format,
      text: '',
      chars: 0,
      code: 'EXTRACT_EMPTY',
      error: EXTRACT_EMPTY_MESSAGE,
    };
  }

  try {
    if (format === 'pdf') {
      const parsed = await pdfParse(bytes);
      raw = parsed.text || '';
    } else if (format === 'docx') {
      const parsed = await mammoth.extractRawText({ buffer: bytes });
      raw = parsed.value || '';
    } else {
      raw = bytes.toString('utf-8');
    }
  } catch (error: any) {
    console.error('Document extraction failed:', error);
    return {
      ok: false,
      format,
      text: '',
      chars: 0,
      code: 'EXTRACT_FAILED',
      error: EXTRACT_FAILED_MESSAGE,
    };
  }

  const assessment = assessExtraction(raw);
  if (!assessment.ok) {
    return {
      ok: false,
      format,
      text: '',
      chars: assessment.chars,
      code: 'EXTRACT_EMPTY',
      error: EXTRACT_EMPTY_MESSAGE,
    };
  }

  return {
    ok: true,
    format,
    text: assessment.text,
    chars: assessment.chars,
  };
}

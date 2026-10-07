/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * M13 Stage A — SSRF-safe URL fetching (PRD §5.9).
 *
 * The old `/api/fetch-job` did `fetch(url)` with ZERO validation (GOTCHA #4):
 * it would happily reach `http://169.254.169.254/` (cloud metadata),
 * `http://localhost:...`, `http://10.x.x.x`, etc. This module fixes that and
 * also detects the JS-rendered-job-board case where a plain fetch returns an
 * empty shell.
 *
 * Policy (binding):
 *   - Only `http:` / `https:`; no embedded credentials.
 *   - Resolve the host and check EVERY returned address (`{ all: true }`).
 *   - Redirects are followed MANUALLY (`redirect: 'manual'`), max 3 hops, and
 *     every hop is re-validated before it is fetched.
 *   - 10 s timeout via `AbortController`; the body is streamed and capped.
 *   - A present, non-HTML/text content type is rejected rather than stripped.
 *
 * Residual risk, recorded honestly (PRD §18): validation resolves the host and
 * *then* `fetch()` resolves it again, so a DNS-rebinding TOCTOU window remains.
 * Closing it needs connection pinning (which breaks TLS SNI), so it is not
 * closed here.
 *
 * Testability: `safeFetchText` accepts injected `fetchImpl` / `resolveHost` so
 * the whole policy is testable with NO network access and NO API key.
 */
import net from 'node:net';
import { promises as dnsPromises } from 'node:dns';
import { MIN_TEXT_CHARS, countNonWhitespaceCharacters } from './extract';

export const BLOCKED_TARGET_MESSAGE =
  'That link points to a private or local address, which is not allowed. Paste the job description as text instead - it is more reliable than a link.';
export const INVALID_URL_MESSAGE =
  'That does not look like a valid web link. Paste the job description as text instead - it is more reliable than a link.';
export const EMPTY_EXTRACT_MESSAGE =
  'No readable text could be found at that link. The page may need a browser to load. Paste the job description as text instead - it is more reliable than a link.';
export const FETCH_FAILED_MESSAGE =
  'Could not reach that link. Paste the job description as text instead - it is more reliable than a link.';
export const TOO_MANY_REDIRECTS_MESSAGE =
  'That link redirected too many times. Paste the job description as text instead - it is more reliable than a link.';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 2_000_000;
export const DEFAULT_MAX_REDIRECTS = 3;
/** The stored job text is capped at this many characters (PRD §5.9). */
export const MAX_STORED_TEXT_CHARS = 12_000;

// ---------------------------------------------------------------------------
// Address parsing / blocking
// ---------------------------------------------------------------------------

/** CIDR blocks that must never be fetched. `255.255.255.255` falls under 240/4. */
const BLOCKED_IPV4_RANGES: ReadonlyArray<{ base: number; bits: number }> = [
  { base: parseIPv4Unsafe('0.0.0.0'), bits: 8 },
  { base: parseIPv4Unsafe('10.0.0.0'), bits: 8 },
  { base: parseIPv4Unsafe('100.64.0.0'), bits: 10 }, // CGNAT
  { base: parseIPv4Unsafe('127.0.0.0'), bits: 8 },
  { base: parseIPv4Unsafe('169.254.0.0'), bits: 16 }, // link-local + metadata
  { base: parseIPv4Unsafe('172.16.0.0'), bits: 12 },
  { base: parseIPv4Unsafe('192.0.0.0'), bits: 24 },
  { base: parseIPv4Unsafe('192.0.2.0'), bits: 24 }, // TEST-NET-1
  { base: parseIPv4Unsafe('192.88.99.0'), bits: 24 },
  { base: parseIPv4Unsafe('192.168.0.0'), bits: 16 },
  { base: parseIPv4Unsafe('198.18.0.0'), bits: 15 },
  { base: parseIPv4Unsafe('198.51.100.0'), bits: 24 }, // TEST-NET-2
  { base: parseIPv4Unsafe('203.0.113.0'), bits: 24 }, // TEST-NET-3
  { base: parseIPv4Unsafe('224.0.0.0'), bits: 4 }, // multicast
  { base: parseIPv4Unsafe('240.0.0.0'), bits: 4 }, // reserved (incl. 255.255.255.255)
];

/** `a.b.c.d` -> unsigned 32-bit integer, or null when malformed. */
function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

// Used only to compute the module constants above (input is a literal).
function parseIPv4Unsafe(ip: string): number {
  return parseIPv4(ip) as number;
}

function inRange(value: number, base: number, maskBits: number): boolean {
  const mask = maskBits >= 32 ? 0xffffffff : (0xffffffff << (32 - maskBits)) >>> 0;
  return ((value & mask) >>> 0) === ((base & mask) >>> 0);
}

function isBlockedIPv4(value: number): boolean {
  for (const range of BLOCKED_IPV4_RANGES) {
    if (inRange(value, range.base, range.bits)) return true;
  }
  return false;
}

/**
 * Parse an IPv6 address into eight 16-bit groups.
 *
 * Handles `::` compression and an embedded dotted-quad tail. A naive
 * `split(':')` is not acceptable (it misreads compression as empty groups).
 * Returns `null` for anything that is not a valid address.
 */
function parseIPv6(input: string): number[] | null {
  let ip = input.trim().toLowerCase();
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (ip === '') return null;

  // Fold an embedded IPv4 tail (`::ffff:127.0.0.1`) into two hex groups.
  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':');
    if (lastColon === -1) return null;
    const v4 = ip.slice(lastColon + 1);
    const octets = v4.split('.');
    if (octets.length !== 4) return null;
    const nums = octets.map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : NaN));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const high = ((nums[0] << 8) | nums[1]).toString(16);
    const low = ((nums[2] << 8) | nums[3]).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const doubleIndex = ip.indexOf('::');
  let groups: string[];

  if (doubleIndex !== -1) {
    if (ip.indexOf('::', doubleIndex + 2) !== -1) return null; // more than one `::`
    const head = ip.slice(0, doubleIndex);
    const tail = ip.slice(doubleIndex + 2);
    const headParts = head === '' ? [] : head.split(':');
    const tailParts = tail === '' ? [] : tail.split(':');
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 1) return null; // `::` must stand for at least one group
    groups = [...headParts, ...new Array(missing).fill('0'), ...tailParts];
  } else {
    groups = ip.split(':');
  }

  if (groups.length !== 8) return null;

  const parsed: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    parsed.push(parseInt(group, 16));
  }
  return parsed;
}

function isBlockedIPv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  // `::ffff:a.b.c.d` (IPv4-mapped), `::ffff:0:a.b.c.d` (IPv4-translated) and
  // `::a.b.c.d` (IPv4-compatible) all carry the IPv4 address in the last 32
  // bits. Unwrap and re-check them against the IPv4 rules — otherwise a mapped
  // metadata address (`::ffff:169.254.169.254`) would slip past.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0) {
    const isMapped = g4 === 0 && g5 === 0xffff;
    const isTranslated = g4 === 0xffff && g5 === 0;
    const isCompatible = g4 === 0 && g5 === 0;
    if (isMapped || isTranslated || isCompatible) {
      const embedded = ((g6 << 16) | g7) >>> 0;
      if (isBlockedIPv4(embedded)) return true;
    }
  }

  if (groups.every((g) => g === 0)) return true; // unspecified ::
  if (groups.slice(0, 7).every((g) => g === 0) && g7 === 1) return true; // ::1
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xfe00) === 0xfc00) return true; // ULA fc00::/7 (fc00..fdff)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast ff00::/8

  return false;
}

/**
 * Pure. `true` means the address must not be fetched.
 *
 * Fails CLOSED: anything that does not parse as an IPv4/IPv6 address is
 * treated as blocked, because an unparseable address is not a safe one.
 */
export function isBlockedAddress(ip: string): boolean {
  if (typeof ip !== 'string') return true;
  const value = ip.trim();
  if (value === '') return true;

  const v4 = parseIPv4(value);
  if (v4 !== null) return isBlockedIPv4(v4);

  const groups = parseIPv6(value);
  if (!groups) return true;

  return isBlockedIPv6(groups);
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

function stripBrackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

export interface ParsedTarget {
  ok: boolean;
  url: URL | null;
  reason: string;
}

/**
 * Pure. Validates scheme, embedded credentials, and a LITERAL host that is
 * `localhost` or a blocked IP. Hostnames are resolved later by `safeFetchText`
 * (this function does no I/O).
 */
export function parseTargetUrl(raw: unknown): ParsedTarget {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, url: null, reason: INVALID_URL_MESSAGE };
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, url: null, reason: INVALID_URL_MESSAGE };
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, url: null, reason: INVALID_URL_MESSAGE };
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, url: null, reason: INVALID_URL_MESSAGE };
  }

  const hostname = stripBrackets(url.hostname).toLowerCase();
  if (hostname === '') {
    return { ok: false, url: null, reason: INVALID_URL_MESSAGE };
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { ok: false, url: null, reason: BLOCKED_TARGET_MESSAGE };
  }

  if (net.isIP(hostname) !== 0 && isBlockedAddress(hostname)) {
    return { ok: false, url: null, reason: BLOCKED_TARGET_MESSAGE };
  }

  return { ok: true, url, reason: '' };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export type ResolveHost = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export interface HttpResponseLike {
  status: number;
  headers?: { get(name: string): string | null } | Record<string, string | string[] | undefined>;
  body?: unknown;
  text?: () => Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: { redirect?: string; signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<HttpResponseLike>;

export interface SafeFetchOptions {
  fetchImpl?: FetchLike;
  resolveHost?: ResolveHost;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface SafeFetchResult {
  ok: boolean;
  text: string;
  chars: number;
  finalUrl: string;
  truncated: boolean;
  code?: 'INVALID_URL' | 'EMPTY_EXTRACT' | 'FETCH_FAILED';
  error?: string;
}

async function defaultResolveHost(
  hostname: string,
): Promise<Array<{ address: string; family: number }>> {
  return dnsPromises.lookup(hostname, { all: true, verbatim: true });
}

function getHeader(response: HttpResponseLike, name: string): string | null {
  const headers: any = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return typeof value === 'string' ? value : null;
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== lower) continue;
    const value = headers[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.join(', ');
    return null;
  }
  return null;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isTextualContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return lower.includes('text/html') || lower.includes('text/plain');
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read a response body, stopping at `maxBytes`. The primary path is the stream
 * reader (so a huge body is never buffered), with a `text()` fallback for
 * response fakes and older runtimes. `content-length` is never trusted.
 */
async function readCapped(
  response: HttpResponseLike,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const body: any = response?.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const chunk = Buffer.from(value);
        const remaining = maxBytes - total;
        if (chunk.length >= remaining) {
          const kept = Math.max(remaining, 0);
          chunks.push(chunk.subarray(0, kept));
          total += kept;
          truncated = true;
          break;
        }
        chunks.push(chunk);
        total += chunk.length;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }
    return { text: Buffer.concat(chunks).toString('utf-8'), truncated };
  }

  const text = typeof response?.text === 'function' ? await response.text() : '';
  const buffer = Buffer.from(text, 'utf-8');
  if (buffer.length > maxBytes) {
    return { text: buffer.subarray(0, maxBytes).toString('utf-8'), truncated: true };
  }
  return { text, truncated: false };
}

function invalidResult(error: string, finalUrl: string): SafeFetchResult {
  return { ok: false, text: '', chars: 0, finalUrl, truncated: false, code: 'INVALID_URL', error };
}

function emptyResult(error: string, finalUrl: string): SafeFetchResult {
  return { ok: false, text: '', chars: 0, finalUrl, truncated: false, code: 'EMPTY_EXTRACT', error };
}

function failedResult(error: string, finalUrl: string): SafeFetchResult {
  return { ok: false, text: '', chars: 0, finalUrl, truncated: false, code: 'FETCH_FAILED', error };
}

/**
 * Fetch a URL as plain text under the SSRF policy above.
 *
 * Never throws for a URL/network problem — it returns `{ ok:false, code }` so
 * the route can map the code to an HTTP status without leaking a stack trace.
 */
export async function safeFetchText(
  rawUrl: unknown,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const initial = parseTargetUrl(rawUrl);
  if (!initial.ok || !initial.url) {
    return invalidResult(initial.reason || INVALID_URL_MESSAGE, '');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let current: URL = initial.url;

  try {
    let redirects = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Re-validate EVERY hop before it is fetched (scheme, credentials, a
      // literal host). The initial URL went through this too.
      const literal = parseTargetUrl(current.toString());
      if (!literal.ok || !literal.url) {
        return invalidResult(literal.reason || BLOCKED_TARGET_MESSAGE, current.toString());
      }
      current = literal.url;

      const hostname = stripBrackets(current.hostname).toLowerCase();
      if (net.isIP(hostname) !== 0) {
        if (isBlockedAddress(hostname)) {
          return invalidResult(BLOCKED_TARGET_MESSAGE, current.toString());
        }
      } else {
        let addresses: Array<{ address: string; family: number }>;
        try {
          addresses = await resolveHost(hostname);
        } catch {
          // DNS failure / unreachable resolver is a fetch failure, not a
          // policy rejection.
          return failedResult(FETCH_FAILED_MESSAGE, current.toString());
        }
        if (!addresses || addresses.length === 0) {
          return failedResult(FETCH_FAILED_MESSAGE, current.toString());
        }
        for (const entry of addresses) {
          if (isBlockedAddress(entry.address)) {
            return invalidResult(BLOCKED_TARGET_MESSAGE, current.toString());
          }
        }
      }

      let response: HttpResponseLike;
      try {
        response = await fetchImpl(current.toString(), {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
            'user-agent': 'AI-Resume-Generator/1.0 (+local)',
          },
        });
      } catch {
        return controller.signal.aborted
          ? failedResult(
              'That link took too long to respond. Paste the job description as text instead - it is more reliable than a link.',
              current.toString(),
            )
          : failedResult(FETCH_FAILED_MESSAGE, current.toString());
      }

      const status = Number(response?.status ?? 0);

      if (isRedirectStatus(status)) {
        if (redirects >= maxRedirects) {
          return failedResult(TOO_MANY_REDIRECTS_MESSAGE, current.toString());
        }
        const location = getHeader(response, 'location');
        if (!location) {
          return failedResult(
            'That link redirected to nowhere. Paste the job description as text instead - it is more reliable than a link.',
            current.toString(),
          );
        }
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, current);
        } catch {
          return failedResult(
            'That link redirected to an invalid address. Paste the job description as text instead - it is more reliable than a link.',
            current.toString(),
          );
        }
        const validated = parseTargetUrl(nextUrl.toString());
        if (!validated.ok || !validated.url) {
          return invalidResult(validated.reason || BLOCKED_TARGET_MESSAGE, current.toString());
        }
        redirects += 1;
        current = validated.url;
        continue;
      }

      if (!(status >= 200 && status < 300)) {
        return failedResult(
          'That link returned an error. Paste the job description as text instead - it is more reliable than a link.',
          current.toString(),
        );
      }

      const contentType = getHeader(response, 'content-type');
      if (contentType && !isTextualContentType(contentType)) {
        return emptyResult(EMPTY_EXTRACT_MESSAGE, current.toString());
      }

      let body: { text: string; truncated: boolean };
      try {
        body = await readCapped(response, maxBytes);
      } catch {
        return failedResult(FETCH_FAILED_MESSAGE, current.toString());
      }

      const cleaned = stripHtmlToText(body.text);
      if (countNonWhitespaceCharacters(cleaned) < MIN_TEXT_CHARS) {
        return emptyResult(EMPTY_EXTRACT_MESSAGE, current.toString());
      }

      const stored =
        cleaned.length > MAX_STORED_TEXT_CHARS
          ? cleaned.slice(0, MAX_STORED_TEXT_CHARS)
          : cleaned;
      const truncated = body.truncated || cleaned.length > MAX_STORED_TEXT_CHARS;

      return {
        ok: true,
        text: stored,
        chars: countNonWhitespaceCharacters(stored),
        finalUrl: current.toString(),
        truncated,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

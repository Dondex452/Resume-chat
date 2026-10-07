/**
 * M13 Stage A — ingestion hardening tests (PRD §5.8, §5.9).
 *
 * These run with NO network access and NO API key: every DNS lookup and every
 * fetch is injected. They cover the two bugs being fixed —
 *   - GOTCHA #5: a `.doc`/scanned PDF fell through to a UTF-8 decode and the
 *     binary garbage was passed to the model; and
 *   - GOTCHA #4: `/api/fetch-job` fetched any URL, including cloud metadata.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MIN_TEXT_CHARS,
  assessExtraction,
  detectFormat,
  extractDocumentText,
} from '../../ingestion/extract';
import {
  isBlockedAddress,
  parseTargetUrl,
  safeFetchText,
} from '../../ingestion/urlSafety';

// ---------------------------------------------------------------------------
// Fakes — no network, no filesystem
// ---------------------------------------------------------------------------

interface FakeInit {
  status?: number;
  contentType?: string | null;
  headers?: Record<string, string>;
  bodyStream?: boolean;
}

function fakeResponse(body: string, init: FakeInit = {}) {
  const status = init.status ?? 200;
  const headers = new Map<string, string>();
  const contentType = init.contentType === undefined ? 'text/html; charset=utf-8' : init.contentType;
  if (contentType !== null) headers.set('content-type', contentType);
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    headers.set(key.toLowerCase(), value);
  }

  const encoded = Buffer.from(body, 'utf-8');
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    body: init.bodyStream
      ? {
          getReader() {
            let sent = false;
            return {
              async read() {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: new Uint8Array(encoded) };
              },
              async cancel() {
                /* no-op */
              },
            };
          },
        }
      : null,
    text: async () => body,
  };
}

/** A resolver that always answers with one public address. */
const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];

/** Build a throwaway fake fetch that records how many times it ran. */
function countingFetch(makeResponse: () => any) {
  const state = { calls: 0 };
  const fetchImpl = async () => {
    state.calls += 1;
    return makeResponse();
  };
  return { state, fetchImpl };
}

const LONG_HTML =
  '<html><head><script>var secret = 1;</script><style>.a{color:red}</style></head>' +
  '<body><h1>Senior Engineer</h1><p>Build reliable TypeScript and React systems for a growing company.</p></body></html>';

// ---------------------------------------------------------------------------
// isBlockedAddress
// ---------------------------------------------------------------------------

test('isBlockedAddress: blocks the private, loopback, link-local and reserved table', () => {
  const blocked = [
    '0.0.0.0',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'fc00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.1',
  ];
  for (const ip of blocked) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);
  }
});

test('isBlockedAddress: allows public addresses, including an IPv4-mapped public one', () => {
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111', '::ffff:93.184.216.34'];
  for (const ip of allowed) {
    assert.equal(isBlockedAddress(ip), false, `${ip} must be allowed`);
  }
});

test('isBlockedAddress: parses ::-compression and embedded dotted-quads correctly', () => {
  // A naive split(':') would misread compression as empty groups.
  assert.equal(isBlockedAddress('fd00:1234:5678:9abc:def0:1234:5678:9abc'), true, 'full ULA');
  assert.equal(isBlockedAddress('fe80:0:0:0:0:0:0:1'), true, 'expanded link-local');
  assert.equal(isBlockedAddress('2001:4860:4860::8888'), false, 'public Google DNS');
  assert.equal(isBlockedAddress('::ffff:0:10.1.2.3'), true, 'mapped-and-shifted private');
});

test('isBlockedAddress: fails closed on unparseable input', () => {
  assert.equal(isBlockedAddress('not-an-ip'), true);
  assert.equal(isBlockedAddress('999.1.1.1'), true);
  assert.equal(isBlockedAddress(''), true);
  assert.equal(isBlockedAddress('1::2::3'), true, 'two compressions is invalid');
});

// ---------------------------------------------------------------------------
// parseTargetUrl
// ---------------------------------------------------------------------------

test('parseTargetUrl: rejects dangerous schemes, credentials and blocked literals', () => {
  const rejected = [
    'file:///c:/x',
    'javascript:alert(1)',
    'data:text/html,x',
    'ftp://x/y',
    'http://user:pw@example.com/',
    'http://localhost:3000/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.1.2.3/',
    'not a url',
  ];
  for (const raw of rejected) {
    const result = parseTargetUrl(raw);
    assert.equal(result.ok, false, `${raw} must be rejected`);
    assert.ok(result.reason.length > 0, `${raw} must carry a reason`);
  }
});

test('parseTargetUrl: accepts a normal https link', () => {
  const result = parseTargetUrl('https://example.com/jobs/1');
  assert.equal(result.ok, true);
  assert.equal(result.url?.hostname, 'example.com');
});

// ---------------------------------------------------------------------------
// safeFetchText
// ---------------------------------------------------------------------------

test('safeFetchText: a host resolving to a private address is INVALID_URL and fetch never runs', async () => {
  const { state, fetchImpl } = countingFetch(() => fakeResponse(LONG_HTML));
  const result = await safeFetchText('https://evil.test/x', {
    fetchImpl,
    resolveHost: async () => [{ address: '10.1.2.3', family: 4 }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_URL');
  assert.equal(state.calls, 0, 'a blocked target must not be fetched');
});

test('safeFetchText: a redirect to cloud metadata is INVALID_URL after exactly one fetch', async () => {
  const { state, fetchImpl } = countingFetch(() =>
    fakeResponse('', { status: 302, contentType: null, headers: { location: 'http://169.254.169.254/' } }),
  );
  const result = await safeFetchText('https://example.com/job', {
    fetchImpl,
    resolveHost: publicResolver,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_URL');
  assert.equal(state.calls, 1, 'the blocked hop must not be fetched');
});

test('safeFetchText: a 4-hop redirect chain fails with FETCH_FAILED', async () => {
  const { state, fetchImpl } = countingFetch(() =>
    fakeResponse('', { status: 302, contentType: null, headers: { location: 'https://example.com/next' } }),
  );
  const result = await safeFetchText('https://example.com/a', {
    fetchImpl,
    resolveHost: publicResolver,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FETCH_FAILED');
  assert.equal(state.calls, 4, 'three redirects are allowed, the fourth is refused');
});

test('safeFetchText: three redirects followed by a 200 are accepted', async () => {
  const { state, fetchImpl } = countingFetch(() => {
    if (state.calls <= 3) {
      return fakeResponse('', { status: 302, contentType: null, headers: { location: 'https://example.com/next' } });
    }
    return fakeResponse(LONG_HTML);
  });
  const result = await safeFetchText('https://example.com/a', {
    fetchImpl,
    resolveHost: publicResolver,
  });
  assert.equal(result.ok, true);
  assert.equal(state.calls, 4);
});

test('safeFetchText: happy path strips tags and scripts and reports the final URL', async () => {
  const { fetchImpl } = countingFetch(() => fakeResponse(LONG_HTML));
  const result = await safeFetchText('https://example.com/jobs/1', {
    fetchImpl,
    resolveHost: publicResolver,
  });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, false);
  assert.equal(result.finalUrl, 'https://example.com/jobs/1');
  assert.ok(!result.text.includes('var secret'), 'script bodies must be removed');
  assert.ok(!result.text.includes('<h1>'), 'tags must be removed');
  assert.ok(result.text.includes('Senior Engineer'));
  assert.ok(result.chars > 0);
});

test('safeFetchText: a non-HTML content type is EMPTY_EXTRACT, never regex-stripped', async () => {
  const { fetchImpl } = countingFetch(() => fakeResponse('%PDF-1.4 binary', { contentType: 'application/pdf' }));
  const result = await safeFetchText('https://example.com/file', {
    fetchImpl,
    resolveHost: publicResolver,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EMPTY_EXTRACT');
});

test('safeFetchText: an HTML shell with too little visible text is EMPTY_EXTRACT', async () => {
  const { fetchImpl } = countingFetch(() => fakeResponse('<html><body>Hello there</body></html>'));
  const result = await safeFetchText('https://example.com/spa', {
    fetchImpl,
    resolveHost: publicResolver,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EMPTY_EXTRACT');
});

test('safeFetchText: a rejected fetch is FETCH_FAILED', async () => {
  const result = await safeFetchText('https://example.com/x', {
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    resolveHost: publicResolver,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FETCH_FAILED');
});

test('safeFetchText: a 500 response is FETCH_FAILED', async () => {
  const { fetchImpl } = countingFetch(() => fakeResponse('server error', { status: 500 }));
  const result = await safeFetchText('https://example.com/x', {
    fetchImpl,
    resolveHost: publicResolver,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FETCH_FAILED');
});

test('safeFetchText: an unresolvable host is FETCH_FAILED with no fetch', async () => {
  const { state, fetchImpl } = countingFetch(() => fakeResponse(LONG_HTML));
  const result = await safeFetchText('https://nonexistent.invalid/x', {
    fetchImpl,
    resolveHost: async () => {
      throw new Error('ENOTFOUND');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FETCH_FAILED');
  assert.equal(state.calls, 0);
});

test('safeFetchText: credentials in the URL are rejected before any fetch', async () => {
  const { state, fetchImpl } = countingFetch(() => fakeResponse(LONG_HTML));
  const result = await safeFetchText('http://user:pw@example.com/', { fetchImpl, resolveHost: publicResolver });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_URL');
  assert.equal(state.calls, 0);
});

test('safeFetchText: text/plain is accepted and a missing content type is accepted', async () => {
  const plain = await safeFetchText('https://example.com/plain', {
    fetchImpl: async () => fakeResponse('A'.repeat(80), { contentType: 'text/plain; charset=utf-8' }),
    resolveHost: publicResolver,
  });
  assert.equal(plain.ok, true);

  const missing = await safeFetchText('https://example.com/none', {
    fetchImpl: async () => fakeResponse('B'.repeat(80), { contentType: null }),
    resolveHost: publicResolver,
  });
  assert.equal(missing.ok, true);
});

test('safeFetchText: the stored text is capped at 12,000 chars and flagged truncated', async () => {
  const big = `<p>${'a'.repeat(13_000)}</p>`;
  const result = await safeFetchText('https://example.com/big', {
    fetchImpl: async () => fakeResponse(big),
    resolveHost: publicResolver,
  });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 12_000);
});

test('safeFetchText: the byte cap is enforced through the stream reader', async () => {
  const big = `<p>${'a'.repeat(5000)}</p>`;
  const result = await safeFetchText('https://example.com/stream', {
    fetchImpl: async () => fakeResponse(big, { bodyStream: true }),
    resolveHost: publicResolver,
    maxBytes: 20,
  });
  assert.equal(result.ok, false, 'a 20-byte cap leaves too little visible text');
  assert.equal(result.code, 'EMPTY_EXTRACT');
});

// ---------------------------------------------------------------------------
// detectFormat
// ---------------------------------------------------------------------------

test('detectFormat: recognises valid PDF and DOCX by magic bytes', () => {
  assert.deepEqual(detectFormat('cv.pdf', Buffer.from('%PDF-1.7 hello')), { ok: true, format: 'pdf' });
  assert.deepEqual(detectFormat('cv.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])), {
    ok: true,
    format: 'docx',
  });
});

test('detectFormat: rejects a name/magic mismatch', () => {
  assert.equal(detectFormat('cv.pdf', Buffer.from([0x50, 0x4b, 0x03, 0x04])).ok, false, '.pdf that is really a ZIP');
  assert.equal(detectFormat('cv.docx', Buffer.from('%PDF-1.4')).ok, false, '.docx that is really a PDF');
});

test('detectFormat: txt/md are text, and a binary .txt is rejected', () => {
  assert.deepEqual(detectFormat('notes.txt', Buffer.from('hello world')), { ok: true, format: 'text' });
  assert.deepEqual(detectFormat('notes.md', Buffer.from('# Heading')), { ok: true, format: 'text' });
  assert.equal(detectFormat('notes.txt', Buffer.from('hello\u0000world')).ok, false, 'NUL bytes = binary');
});

test('detectFormat: legacy and unknown extensions are rejected explicitly', () => {
  for (const name of ['old.doc', 'doc.rtf', 'doc.odt', 'script.exe', 'noextension']) {
    assert.equal(detectFormat(name, Buffer.from('anything')).ok, false, `${name} must be rejected`);
  }
});

test('detectFormat: the extension check is case-insensitive', () => {
  assert.deepEqual(detectFormat('CV.PDF', Buffer.from('%PDF-1.4')), { ok: true, format: 'pdf' });
});

test('detectFormat: a zero-byte file is typed by its name, not rejected as unsupported', () => {
  // There are no bytes to contradict the extension, so the name decides. The
  // caller then reports EXTRACT_EMPTY - "0 bytes" and "you uploaded a .doc" are
  // different failures with different recoveries (PRD §5.8).
  assert.deepEqual(detectFormat('cv.pdf', Buffer.alloc(0)), { ok: true, format: 'pdf' });
  assert.deepEqual(detectFormat('cv.docx', Buffer.alloc(0)), { ok: true, format: 'docx' });
  assert.deepEqual(detectFormat('cv.txt', Buffer.alloc(0)), { ok: true, format: 'text' });
  assert.deepEqual(detectFormat('cv.md', Buffer.alloc(0)), { ok: true, format: 'text' });
  assert.equal(detectFormat('old.doc', Buffer.alloc(0)).ok, false, 'legacy extension stays rejected');
  assert.equal(detectFormat('resume', Buffer.alloc(0)).ok, false, 'no extension stays rejected');
});

// ---------------------------------------------------------------------------
// assessExtraction
// ---------------------------------------------------------------------------

test('assessExtraction: empty and whitespace-only input is empty', () => {
  assert.deepEqual(assessExtraction(''), { ok: false, text: '', chars: 0 });
  assert.deepEqual(assessExtraction('   \n \t '), { ok: false, text: '', chars: 0 });
});

test(`assessExtraction: ${MIN_TEXT_CHARS - 1} non-whitespace chars is empty; ${MIN_TEXT_CHARS} is enough`, () => {
  const under = assessExtraction('a'.repeat(MIN_TEXT_CHARS - 1));
  assert.equal(under.ok, false);
  assert.equal(under.chars, MIN_TEXT_CHARS - 1);

  const at = assessExtraction('a'.repeat(MIN_TEXT_CHARS));
  assert.equal(at.ok, true);
  assert.equal(at.chars, MIN_TEXT_CHARS);
});

test('assessExtraction: whitespace is not counted toward the threshold', () => {
  const padded = `  \n  ${'z'.repeat(MIN_TEXT_CHARS)}  \n `;
  const result = assessExtraction(padded);
  assert.equal(result.ok, true);
  assert.equal(result.chars, MIN_TEXT_CHARS);
  assert.equal(result.text, 'z'.repeat(MIN_TEXT_CHARS), 'outer whitespace is trimmed');
});

// ---------------------------------------------------------------------------
// extractDocumentText — the pure orchestration the route calls
// ---------------------------------------------------------------------------

test('extractDocumentText: an unsupported extension returns UNSUPPORTED_TYPE', async () => {
  const result = await extractDocumentText('old.doc', Buffer.from('binary rubbish'));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_TYPE');
  assert.equal(result.format, null);
});

test('extractDocumentText: a .pdf whose bytes are not a PDF returns UNSUPPORTED_TYPE', async () => {
  const result = await extractDocumentText('cv.pdf', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_TYPE');
});

test('extractDocumentText: a short .txt returns EXTRACT_EMPTY with its format and chars', async () => {
  const result = await extractDocumentText('note.txt', Buffer.from('short'));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EXTRACT_EMPTY');
  assert.equal(result.format, 'text');
  assert.equal(result.chars, 5);
  assert.ok(result.error && result.error.length > 0);
});

test('extractDocumentText: a zero-byte file is EXTRACT_EMPTY, never UNSUPPORTED_TYPE', async () => {
  // Regression: the route used to reject `data: ''` as BAD_REQUEST, telling the
  // user a filename and content were required when they had picked an empty
  // file. The truthful outcome is "no text could be read" + paste recovery.
  for (const name of ['cv.pdf', 'cv.docx', 'cv.txt', 'cv.md']) {
    const result = await extractDocumentText(name, Buffer.alloc(0));
    assert.equal(result.ok, false, `${name} must fail`);
    assert.equal(result.code, 'EXTRACT_EMPTY', `${name} must be EXTRACT_EMPTY`);
    assert.equal(result.chars, 0);
    assert.ok(result.format, `${name} must still report a format`);
  }
});

test('extractDocumentText: a real PDF with a text layer is extracted', async () => {
  // Guards the M13 parser swap. `pdf-parse@1.1.x` (pdf.js v1.10.100, 2018) was
  // withdrawn after failing intermittently - 2/10 in a plain process and 40/80
  // against the live server - so this asserts that a genuine text-layer PDF
  // still comes back as text through `pdfjs-dist`.
  const pdf = readFileSync(new URL('./fixtures/sample-resume.pdf', import.meta.url));
  const result = await extractDocumentText('cv.pdf', pdf);

  assert.equal(result.ok, true, result.error || 'extraction failed');
  assert.equal(result.format, 'pdf');
  assert.ok(
    result.text.includes('Ada Lovelace'),
    `text layer must be readable, got: ${JSON.stringify(result.text.slice(0, 120))}`,
  );
  assert.ok(result.chars > MIN_TEXT_CHARS, 'a real document is not "empty"');
});

test('extractDocumentText: the same PDF parses on repeated calls (no first-call flake)', async () => {
  // The old library failed ~20% of the time, including on the very first call in
  // a fresh process. Ten in a row is the cheap version of that hammer.
  const pdf = readFileSync(new URL('./fixtures/sample-resume.pdf', import.meta.url));
  for (let i = 0; i < 10; i++) {
    const result = await extractDocumentText('cv.pdf', pdf);
    assert.equal(result.ok, true, `call ${i} failed: ${result.code} ${result.error || ''}`);
  }
});

// ---------------------------------------------------------------------------
// PDF extraction now runs on `pdfjs-dist` (M13). The previous `pdf-parse@1.1.x`
// bundled pdf.js v1.10.100 (2018) and failed intermittently - 2/10 in a plain
// process, 40/80 against the real server - so the workaround that used to be
// tested here (`isolatePdfBuffer`) is gone along with it. See the comment above
// `pdfParse` in `server/ingestion/extract.ts` for the measurements.
// ---------------------------------------------------------------------------

test('extractDocumentText: a long .txt succeeds and is pure', async () => {
  const text = 'A genuine resume line with plenty of content to pass the threshold.';
  const result = await extractDocumentText('cv.txt', Buffer.from(text));
  assert.equal(result.ok, true);
  assert.equal(result.format, 'text');
  assert.equal(result.text, text);
  assert.equal(result.chars, text.replace(/\s+/g, '').length);
});

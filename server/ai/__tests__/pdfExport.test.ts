/**
 * M15 — true-text PDF export tests (PRD §11, amended 2026-09-21).
 *
 * Discovery and the filename sanitiser are tested entirely with an INJECTED
 * existence probe: no disk, no browser, no network. The render path is tested
 * with an INJECTED spawn, so its contract (a valid `%PDF-` of non-trivial size
 * or `PDF_RENDER_FAILED`) is covered without Chrome being installed.
 *
 * The one test that really spawns a browser is marked SLOW and SKIPS when no
 * browser is present — a test suite must never require Chrome to be installed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_VIRTUAL_TIME_BUDGET_MS,
  FALLBACK_FILENAME_BASE,
  MAX_FILENAME_BASE_LENGTH,
  MIN_PDF_BYTES,
  buildPrintViewUrl,
  findBrowser,
  pathLookupNames,
  renderPdf,
  renderResumePdf,
  resolvePort,
  resolveVirtualTimeBudgetMs,
  sanitizeFilename,
  sanitizeFilenameBase,
  standardBrowserPaths,
} from '../../pdfExport';

// ---------------------------------------------------------------------------
// findBrowser — discovery ORDER, no disk
// ---------------------------------------------------------------------------

test('findBrowser: RESUME_BROWSER_PATH wins when it exists, and is probed first', () => {
  const calls: string[] = [];
  const found = findBrowser({
    platform: 'linux',
    env: { RESUME_BROWSER_PATH: '/opt/custom/chrome' },
    exists: (candidate) => {
      calls.push(candidate);
      return candidate === '/opt/custom/chrome';
    },
    pathValue: '/usr/bin',
  });

  assert.deepEqual(found, { path: '/opt/custom/chrome', source: 'env' });
  assert.equal(calls[0], '/opt/custom/chrome', 'the env path must be probed first');
  assert.equal(calls.length, 1, 'a hit must stop the search');
});

test('findBrowser: a set-but-missing RESUME_BROWSER_PATH is ignored, not fatal', () => {
  const calls: string[] = [];
  const found = findBrowser({
    platform: 'linux',
    env: { RESUME_BROWSER_PATH: '/does/not/exist' },
    exists: (candidate) => {
      calls.push(candidate);
      return candidate === '/usr/bin/chromium';
    },
    pathValue: '/nope',
  });

  assert.equal(found?.source, 'standard');
  assert.equal(found?.path, '/usr/bin/chromium');
  assert.equal(calls[0], '/does/not/exist');
});

test('findBrowser: a standard install location beats a PATH match', () => {
  const calls: string[] = [];
  const found = findBrowser({
    platform: 'linux',
    env: {},
    exists: (candidate) => {
      calls.push(candidate);
      return candidate === '/usr/bin/google-chrome' || candidate === '/opt/bin/chromium';
    },
    pathValue: '/opt/bin',
  });

  assert.equal(found?.source, 'standard');
  assert.equal(found?.path, '/usr/bin/google-chrome');
  assert.equal(
    calls.includes('/opt/bin/chromium'),
    false,
    'PATH must not be consulted once a standard location matched',
  );
});

test('findBrowser: falls back to PATH and joins with the platform separator', () => {
  const found = findBrowser({
    platform: 'linux',
    env: {},
    exists: (candidate) => candidate === '/opt/bin/chromium-browser',
    pathValue: '/usr/local/bin:/opt/bin',
  });

  assert.deepEqual(found, { path: '/opt/bin/chromium-browser', source: 'path' });
});

test('findBrowser: a Windows PATH lookup uses backslashes and finds chrome.exe', () => {
  const found = findBrowser({
    platform: 'win32',
    env: {},
    exists: (candidate) => candidate === 'C:\\Tools\\chrome.exe',
    pathValue: 'C:\\Tools',
  });

  assert.deepEqual(found, { path: 'C:\\Tools\\chrome.exe', source: 'path' });
});

test('findBrowser: nothing found returns null', () => {
  assert.equal(
    findBrowser({ platform: 'linux', env: {}, exists: () => false, pathValue: '/a:/b' }),
    null,
  );
  assert.equal(findBrowser({ platform: 'win32', env: {}, exists: () => false }), null);
});

test('standardBrowserPaths: Windows order is Edge, Chrome, local Chrome, x86 Chrome', () => {
  const paths = standardBrowserPaths('win32', {
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  });

  assert.equal(paths[0], 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(paths[1], 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.ok(
    paths.includes('C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
    'the per-user Chrome install must be in the list',
  );
  assert.ok(
    paths.includes('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'),
    'the x86 Chrome install must be in the list',
  );
});

test('standardBrowserPaths: macOS and Linux cover their conventional locations', () => {
  const mac = standardBrowserPaths('darwin', {});
  assert.ok(mac.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.ok(mac.includes('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));

  const linux = standardBrowserPaths('linux', {});
  for (const expected of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']) {
    assert.ok(linux.includes(expected), `${expected} must be a standard Linux location`);
  }
});

test('pathLookupNames: covers every documented command name', () => {
  const names = pathLookupNames('win32');
  for (const expected of ['chrome', 'chrome.exe', 'msedge', 'msedge.exe']) {
    assert.ok(names.includes(expected), `${expected} must be looked up on PATH`);
  }
  const posix = pathLookupNames('linux');
  for (const expected of ['google-chrome', 'chromium', 'chromium-browser']) {
    assert.ok(posix.includes(expected), `${expected} must be looked up on PATH`);
  }
});

// ---------------------------------------------------------------------------
// Filename sanitising
// ---------------------------------------------------------------------------

test('sanitizeFilename: keeps a normal title and appends the suffix', () => {
  assert.equal(sanitizeFilename('My Resume'), 'My Resume.pdf');
  assert.equal(sanitizeFilename('CV - 20 September 2026'), 'CV - 20 September 2026.pdf');
  assert.equal(sanitizeFilenameBase('My Resume'), 'My Resume');
});

test('sanitizeFilename: strips path separators and punctuation', () => {
  const name = sanitizeFilename('../../etc/passwd');
  assert.equal(name.includes('/'), false);
  assert.equal(name.includes('..'), false);
  assert.match(name, /^[A-Za-z0-9 _-]+\.pdf$/);
  assert.equal(sanitizeFilenameBase('a/b\\c'), 'a b c');
});

test('sanitizeFilename: collapses whitespace and trims', () => {
  assert.equal(sanitizeFilenameBase('   spaced    out   '), 'spaced out');
  assert.equal(sanitizeFilenameBase('tab\tand\nnewline'), 'tab and newline');
});

test('sanitizeFilename: caps a very long title', () => {
  const long = 'Senior Engineering Manager '.repeat(40);
  const base = sanitizeFilenameBase(long);
  assert.equal(base.length, MAX_FILENAME_BASE_LENGTH);
  assert.equal(sanitizeFilename(long).length, MAX_FILENAME_BASE_LENGTH + '.pdf'.length);
});

test('sanitizeFilename: a title that sanitises to nothing still yields a usable name', () => {
  assert.equal(sanitizeFilename('///'), `${FALLBACK_FILENAME_BASE}.pdf`);
  assert.equal(sanitizeFilename('...'), `${FALLBACK_FILENAME_BASE}.pdf`);
  assert.equal(sanitizeFilename(''), `${FALLBACK_FILENAME_BASE}.pdf`);
  assert.equal(sanitizeFilename('   '), `${FALLBACK_FILENAME_BASE}.pdf`);
  assert.equal(sanitizeFilename(null), `${FALLBACK_FILENAME_BASE}.pdf`);
  assert.equal(sanitizeFilename(undefined), `${FALLBACK_FILENAME_BASE}.pdf`);
  assert.equal(sanitizeFilename({ bad: true }), `${FALLBACK_FILENAME_BASE}.pdf`);
});

test('sanitizeFilename: non-ASCII content is dropped, never emitted raw', () => {
  const name = sanitizeFilename('Résumé – José');
  assert.match(name, /^[A-Za-z0-9 _-]+\.pdf$/);
});

// ---------------------------------------------------------------------------
// The print-view URL (GOTCHA #47) and configuration
// ---------------------------------------------------------------------------

test('buildPrintViewUrl: session id in the search, hash EXACTLY #/print', () => {
  const url = buildPrintViewUrl('abc-123', 3000);
  assert.equal(url, 'http://localhost:3000/?session=abc-123#/print');

  const parsed = new URL(url);
  assert.equal(parsed.hash, '#/print');
  assert.equal(parsed.searchParams.get('session'), 'abc-123');
  assert.equal(parsed.pathname, '/');
});

test('buildPrintViewUrl: an id with URL-significant characters stays in the search', () => {
  const url = buildPrintViewUrl('a b&c=d', 4123);
  const parsed = new URL(url);
  assert.equal(parsed.hash, '#/print');
  assert.equal(parsed.searchParams.get('session'), 'a b&c=d');
  assert.ok(url.includes('?session='), 'the id must be in the query string');
});

test('resolvePort: env PORT when sane, else the app default of 3000', () => {
  assert.equal(resolvePort({}), 3000);
  assert.equal(resolvePort({ PORT: '4100' }), 4100);
  assert.equal(resolvePort({ PORT: 'abc' }), 3000);
  assert.equal(resolvePort({ PORT: '0' }), 3000);
  assert.equal(resolvePort({ PORT: '-1' }), 3000);
  assert.equal(resolvePort({ PORT: '99999' }), 3000);
  assert.equal(resolvePort({ PORT: '3000.5' }), 3000);
});

test('resolveVirtualTimeBudgetMs: env override when sane, else the default', () => {
  assert.equal(resolveVirtualTimeBudgetMs({}), DEFAULT_VIRTUAL_TIME_BUDGET_MS);
  assert.equal(resolveVirtualTimeBudgetMs({ RESUME_PDF_VIRTUAL_TIME_BUDGET_MS: '15000' }), 15000);
  assert.equal(resolveVirtualTimeBudgetMs({ RESUME_PDF_VIRTUAL_TIME_BUDGET_MS: 'nope' }), DEFAULT_VIRTUAL_TIME_BUDGET_MS);
  assert.equal(resolveVirtualTimeBudgetMs({ RESUME_PDF_VIRTUAL_TIME_BUDGET_MS: '0' }), DEFAULT_VIRTUAL_TIME_BUDGET_MS);
});

// ---------------------------------------------------------------------------
// renderPdf — contract, with an injected spawn (no browser needed)
// ---------------------------------------------------------------------------

/**
 * A fake child process that fires `close` on the next tick. `write` receives the
 * argument list so a test can find the real `--print-to-pdf` target the module
 * chose, instead of guessing a filename.
 */
function fakeSpawn(options: {
  exitCode?: number;
  write?: (args: string[]) => void;
  silent?: boolean;
}): any {
  const exitCode = options.exitCode ?? 0;
  return (_command: string, args: string[]) => ({
    pid: 424242,
    on(event: string, cb: (...eventArgs: any[]) => void) {
      if (options.silent) return;
      if (event !== 'close') return;
      setImmediate(() => {
        if (options.write) options.write(args);
        cb(exitCode);
      });
    },
    kill() {
      /* no-op */
    },
  });
}

/** The path the module asked the browser to print to. */
function printTargetFrom(args: string[]): string {
  const flag = args.find((arg) => arg.startsWith('--print-to-pdf='));
  assert.ok(flag, 'the browser must be told where to print');
  return (flag as string).slice('--print-to-pdf='.length);
}

const tinyPdf = () =>
  Buffer.concat([
    Buffer.from('%PDF-1.7\n'),
    Buffer.alloc(MIN_PDF_BYTES + 64, 0x20),
    Buffer.from('\n%%EOF\n'),
  ]);

test('renderPdf: a browser that exits non-zero is PDF_RENDER_FAILED and leaves no file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfexport-nonzero-'));
  const outPath = path.join(dir, 'out.pdf');
  try {
    const result = await renderPdf({
      url: 'about:blank',
      outPath,
      browserPath: '/fake/browser',
      spawnImpl: fakeSpawn({ exitCode: 1 }),
      timeoutMs: 2000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PDF_RENDER_FAILED');
    assert.ok(result.error && result.error.length > 0, 'a failure must be actionable');
    assert.equal(fs.existsSync(outPath), false, 'a failed render must not leave a partial file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderPdf: an exit that produces no PDF at all is PDF_RENDER_FAILED', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfexport-empty-'));
  const outPath = path.join(dir, 'out.pdf');
  try {
    const result = await renderPdf({
      url: 'about:blank',
      outPath,
      browserPath: '/fake/browser',
      spawnImpl: fakeSpawn({ exitCode: 0 }),
      timeoutMs: 2000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PDF_RENDER_FAILED');
    assert.equal(fs.existsSync(outPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderPdf: a valid PDF written by the process is accepted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfexport-ok-'));
  const outPath = path.join(dir, 'out.pdf');
  const bytes = tinyPdf();
  try {
    const result = await renderPdf({
      url: 'about:blank',
      outPath,
      browserPath: '/fake/browser',
      spawnImpl: fakeSpawn({ exitCode: 0, write: () => fs.writeFileSync(outPath, bytes) }),
      timeoutMs: 2000,
    });
    assert.equal(result.ok, true, result.error || 'render should succeed');
    assert.equal(result.byteLength, bytes.length);
    assert.ok(typeof result.elapsedMs === 'number');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderPdf: a process that never exits hits the timeout and is PDF_RENDER_FAILED', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfexport-timeout-'));
  const outPath = path.join(dir, 'out.pdf');
  try {
    const started = Date.now();
    const result = await renderPdf({
      url: 'about:blank',
      outPath,
      browserPath: '/fake/browser',
      spawnImpl: fakeSpawn({ silent: true }),
      timeoutMs: 400,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PDF_RENDER_FAILED');
    assert.ok(Date.now() - started >= 350, 'the timeout must actually be waited out');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderPdf: a file that is not a PDF (bad magic) is rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfexport-badmagic-'));
  const outPath = path.join(dir, 'out.pdf');
  try {
    const result = await renderPdf({
      url: 'about:blank',
      outPath,
      browserPath: '/fake/browser',
      spawnImpl: fakeSpawn({
        exitCode: 0,
        write: () => fs.writeFileSync(outPath, Buffer.alloc(MIN_PDF_BYTES + 64, 0x41)),
      }),
      timeoutMs: 2000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PDF_RENDER_FAILED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderPdf: a truncated PDF with no %%EOF trailer is rejected', async () => {
  // The size floor alone cannot tell a finished document from a half-written
  // one; the trailer can. Chrome writes `%%EOF` last.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfexport-truncated-'));
  const outPath = path.join(dir, 'out.pdf');
  try {
    const result = await renderPdf({
      url: 'about:blank',
      outPath,
      browserPath: '/fake/browser',
      spawnImpl: fakeSpawn({
        exitCode: 0,
        write: () =>
          fs.writeFileSync(
            outPath,
            Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(MIN_PDF_BYTES + 64, 0x20)]),
          ),
      }),
      timeoutMs: 2000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PDF_RENDER_FAILED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderPdf: a small but complete PDF (a blank page is 871 B) is accepted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfexport-small-'));
  const outPath = path.join(dir, 'out.pdf');
  // Mirrors the measured blank-page output: 871 bytes, `%PDF-1.4`, `%%EOF`.
  const bytes = Buffer.concat([
    Buffer.from('%PDF-1.4\n'),
    Buffer.alloc(871 - 9 - 6, 0x0a),
    Buffer.from('%%EOF\n'),
  ]);
  try {
    const result = await renderPdf({
      url: 'about:blank',
      outPath,
      browserPath: '/fake/browser',
      spawnImpl: fakeSpawn({
        exitCode: 0,
        write: () => fs.writeFileSync(outPath, bytes),
      }),
      timeoutMs: 2000,
    });
    assert.equal(result.ok, true, result.error || 'a complete small PDF must be accepted');
    assert.equal(result.byteLength, bytes.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderResumePdf: owns its temp files and cleans up on success', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfexport-resume-'));
  const bytes = tinyPdf();
  try {
    const result = await renderResumePdf({
      url: 'about:blank',
      tempDir: dir,
      browserPath: '/fake/browser',
      spawnImpl: fakeSpawn({
        exitCode: 0,
        write: (args) => fs.writeFileSync(printTargetFrom(args), bytes),
      }),
      timeoutMs: 2000,
    });
    assert.equal(result.ok, true, result.error || 'render should succeed');
    assert.ok(result.buffer, 'the bytes must be returned');
    assert.equal(result.buffer?.length, bytes.length);
    assert.deepEqual(fs.readdirSync(dir), [], 'the temp output must be removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The real thing — SLOW, and skipped when no browser is installed
// ---------------------------------------------------------------------------

test('renderPdf: an installed browser prints a real PDF (slow; skips when absent)', async (t) => {
  const browser = findBrowser();
  if (!browser) {
    t.skip('no Chromium-based browser is installed on this machine');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfexport-e2e-'));
  const htmlPath = path.join(dir, 'page.html');
  const outPath = path.join(dir, 'out.pdf');

  // `@page` proves the print path honours a CSS page box; the marker text gives
  // the manual text-layer check something to find.
  fs.writeFileSync(
    htmlPath,
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
      '@page{size:A4;margin:0}body{font-family:monospace;font-size:28px;padding:24px}' +
      '</style></head><body><div>PDF_EXPORT_E2E_MARKER</div><div>' +
      'The quick brown fox jumps over the lazy dog. '.repeat(8) +
      '</div></body></html>',
  );

  try {
    const startedAt = Date.now();
    const result = await renderPdf({
      url: `file:///${htmlPath.replace(/\\/g, '/')}`,
      outPath,
      browserPath: browser.path,
      timeoutMs: 60_000,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.ok, true, result.error || 'the real browser render failed');
    const buffer = fs.readFileSync(outPath);
    assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(buffer.length >= MIN_PDF_BYTES, 'a real PDF is never a few bytes');

    // Report the measurement: the module is only as good as this number.
    console.log(
      `[pdfExport] real render via ${browser.source} (${browser.path}) took ${elapsedMs} ms, ` +
        `${buffer.length} bytes -> ${outPath}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

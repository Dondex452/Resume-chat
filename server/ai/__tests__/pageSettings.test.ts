/**
 * M16 (PRD §5.4 amended) — `sessions.page_size` / `sessions.page_orientation`.
 *
 * These tests exist for two reasons, both learned the hard way in this repo:
 *
 *   1. **GOTCHA #55.** `PUT /api/sessions/:id` once returned 200 while
 *      `source_text` / `job_text` were absent from both the destructure and the
 *      `UPDATE ... SET` list — the write silently did nothing for two versions.
 *      The `PUT` here is a deliberate mirror of the route, and one test asserts a
 *      PUT that touches only `title` leaves every other column intact.
 *   2. **GOTCHA #14.** `CREATE TABLE IF NOT EXISTS` does not add columns to a
 *      database that already exists, and the old JSON mock needed six
 *      coordinated edits per column with a miss failing silently. The migration
 *      tests below start from the *pre-change* 12-column table and prove the two
 *      new columns are added and the existing row survives byte-for-byte.
 *
 * The SQL strings mirror `server.ts` / `server/migrate.ts`. If production SQL
 * changes, it must change here too; the second test below fails if this file's
 * mirror falls out of step with the declared column list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  SqliteDatabase,
  PAGE_SIZES,
  PAGE_ORIENTATIONS,
  normalizePageSize,
  normalizePageOrientation,
} from '../../store';
import {
  SESSION_COLUMNS,
  SESSION_COLUMN_DEFINITIONS,
  ensureColumns,
  ensureSchema,
} from '../../migrate';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm16-page-'));
}

function run(
  db: SqliteDatabase,
  sql: string,
  params: any[] = [],
): Promise<{ lastID?: number; changes?: number }> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (this: any, err: Error | null) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db: SqliteDatabase, sql: string, params: any[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err: Error | null, row: any) => (err ? reject(err) : resolve(row)));
  });
}

function all(db: SqliteDatabase, sql: string, params: any[] = []): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err: Error | null, rows: any[]) => (err ? reject(err) : resolve(rows)));
  });
}

/** Mirrors POST /api/sessions (server.ts) — all 14 PRD §8 columns. */
const INSERT_SESSION_SQL = `
  INSERT INTO sessions (id, title, status, resume_json, template_id, country_code, page_size, page_orientation, cover_letter_json, cover_letter_text, source_text, job_text, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/** Mirrors PUT /api/sessions/:id (server.ts). SET order MUST equal params order. */
const UPDATE_SESSION_SQL = `
  UPDATE sessions
  SET title = ?, status = ?, resume_json = ?, template_id = ?, country_code = ?, page_size = ?, page_orientation = ?, cover_letter_json = ?, cover_letter_text = ?, source_text = ?, job_text = ?, updated_at = ?
  WHERE id = ?
`;

function sessionValues(o: any): any[] {
  return [
    o.id,
    o.title,
    o.status,
    o.resume_json,
    o.template_id,
    o.country_code,
    o.page_size,
    o.page_orientation,
    o.cover_letter_json,
    o.cover_letter_text,
    o.source_text,
    o.job_text,
    o.created_at,
    o.updated_at,
  ];
}

function insertSession(db: SqliteDatabase, overrides: any = {}): Promise<any> {
  const now = new Date().toISOString();
  return run(
    db,
    INSERT_SESSION_SQL,
    sessionValues({
      id: crypto.randomUUID(),
      title: 'M16-TEST',
      status: 'draft',
      resume_json: '{}',
      template_id: 'minimal',
      country_code: null,
      page_size: null,
      page_orientation: null,
      cover_letter_json: '{}',
      cover_letter_text: '',
      source_text: null,
      job_text: null,
      created_at: now,
      updated_at: now,
      ...overrides,
    }),
  );
}

/**
 * Mirror of the `PUT /api/sessions/:id` fallback semantics: a field absent from
 * the body (`undefined`) keeps its stored value; the page fields are normalised
 * on write exactly as the route does.
 */
async function applyPut(db: SqliteDatabase, id: string, body: Record<string, any>): Promise<any> {
  const existing = await get(db, 'SELECT * FROM sessions WHERE id = ?', [id]);
  await run(db, UPDATE_SESSION_SQL, [
    body.title !== undefined ? body.title : existing.title,
    body.status !== undefined ? body.status : existing.status,
    body.resume_json !== undefined ? body.resume_json : existing.resume_json,
    body.template_id !== undefined ? body.template_id : existing.template_id,
    body.country_code !== undefined ? body.country_code : existing.country_code,
    body.page_size !== undefined ? normalizePageSize(body.page_size) : existing.page_size,
    body.page_orientation !== undefined
      ? normalizePageOrientation(body.page_orientation)
      : existing.page_orientation,
    body.cover_letter_json !== undefined ? body.cover_letter_json : existing.cover_letter_json,
    body.cover_letter_text !== undefined ? body.cover_letter_text : existing.cover_letter_text,
    body.source_text !== undefined ? body.source_text : existing.source_text,
    body.job_text !== undefined ? body.job_text : existing.job_text,
    new Date().toISOString(),
    id,
  ]);
  return get(db, 'SELECT * FROM sessions WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// The declaration and the mirrored SQL agree
// ---------------------------------------------------------------------------

test('pageSettings: the declared session columns carry both M16 page fields', () => {
  assert.ok(SESSION_COLUMNS.includes('page_size'), 'page_size must be declared');
  assert.ok(SESSION_COLUMNS.includes('page_orientation'), 'page_orientation must be declared');
  // They sit beside country_code — all three are per-session document settings.
  const countryAt = SESSION_COLUMNS.indexOf('country_code');
  assert.equal(SESSION_COLUMNS[countryAt + 1], 'page_size');
  assert.equal(SESSION_COLUMNS[countryAt + 2], 'page_orientation');
});

test('pageSettings: the mirrored INSERT/UPDATE column lists match SESSION_COLUMNS', () => {
  // Keeps this file's mirror honest if the declaration grows a column.
  const insertColumns = INSERT_SESSION_SQL.slice(
    INSERT_SESSION_SQL.indexOf('(') + 1,
    INSERT_SESSION_SQL.indexOf(')'),
  )
    .split(',')
    .map((c) => c.trim());
  assert.deepEqual(insertColumns, SESSION_COLUMNS);

  // The UPDATE deliberately does not set `id` (WHERE) or `created_at`.
  const updateColumns = UPDATE_SESSION_SQL.slice(
    UPDATE_SESSION_SQL.indexOf('SET ') + 4,
    UPDATE_SESSION_SQL.indexOf('WHERE'),
  )
    .split(',')
    .map((assignment) => assignment.trim().split('=')[0].trim())
    .filter(Boolean);
  assert.deepEqual(
    updateColumns,
    SESSION_COLUMNS.filter((c) => c !== 'id' && c !== 'created_at'),
  );
});

// ---------------------------------------------------------------------------
// Normalisation (advisory: never throws, unrecognised -> NULL)
// ---------------------------------------------------------------------------

test('pageSettings: normalizePageSize accepts the four sizes case-insensitively', () => {
  assert.equal(normalizePageSize('A4'), 'A4');
  assert.equal(normalizePageSize('a4'), 'A4');
  assert.equal(normalizePageSize('letter'), 'Letter');
  assert.equal(normalizePageSize('LETTER'), 'Letter');
  assert.equal(normalizePageSize('  Legal '), 'Legal');
  assert.equal(normalizePageSize('a5'), 'A5');
  assert.deepEqual(PAGE_SIZES, ['A4', 'Letter', 'Legal', 'A5']);
});

test('pageSettings: an unrecognised page size clears to NULL, never throws', () => {
  assert.equal(normalizePageSize('A3'), null);
  assert.equal(normalizePageSize(''), null);
  assert.equal(normalizePageSize('   '), null);
  assert.equal(normalizePageSize(null), null);
  assert.equal(normalizePageSize(undefined), null);
  assert.equal(normalizePageSize(4), null);
  assert.equal(normalizePageSize({ size: 'A4' }), null);
});

test('pageSettings: normalizePageOrientation accepts the two values, canonically', () => {
  assert.equal(normalizePageOrientation('portrait'), 'portrait');
  assert.equal(normalizePageOrientation('Portrait'), 'portrait');
  assert.equal(normalizePageOrientation('LANDSCAPE'), 'landscape');
  assert.equal(normalizePageOrientation('  landscape '), 'landscape');
  assert.deepEqual(PAGE_ORIENTATIONS, ['portrait', 'landscape']);

  assert.equal(normalizePageOrientation('horizontal'), null);
  assert.equal(normalizePageOrientation(''), null);
  assert.equal(normalizePageOrientation(null), null);
  assert.equal(normalizePageOrientation(undefined), null);
});

// ---------------------------------------------------------------------------
// Round-trip through disk
// ---------------------------------------------------------------------------

test('pageSettings: page size and orientation round-trip through disk and update', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    const id = crypto.randomUUID();

    const writer = new SqliteDatabase(file);
    await insertSession(writer, { id, page_size: 'A4', page_orientation: 'landscape' });
    writer.close();

    // Re-opened from disk: proves the values were serialised, not held in memory.
    const reader = new SqliteDatabase(file);
    const created = await get(reader, 'SELECT * FROM sessions WHERE id = ?', [id]);
    assert.equal(created.page_size, 'A4');
    assert.equal(created.page_orientation, 'landscape');

    const updated = await applyPut(reader, id, { page_size: 'legal', page_orientation: 'Portrait' });
    assert.equal(updated.page_size, 'Legal', 'normalised on write');
    assert.equal(updated.page_orientation, 'portrait', 'normalised on write');
    reader.close();

    const final = new SqliteDatabase(file);
    const afterReopen = await get(final, 'SELECT * FROM sessions WHERE id = ?', [id]);
    final.close();
    assert.equal(afterReopen.page_size, 'Legal');
    assert.equal(afterReopen.page_orientation, 'portrait');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pageSettings: an explicit bad value clears the choice to NULL', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    const id = crypto.randomUUID();
    const db = new SqliteDatabase(file);
    try {
      await insertSession(db, { id, page_size: 'A5', page_orientation: 'landscape' });

      const cleared = await applyPut(db, id, { page_size: 'A3', page_orientation: 'sideways' });
      assert.equal(cleared.page_size, null, 'an unknown size clears the override');
      assert.equal(cleared.page_orientation, null, 'an unknown orientation clears the override');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Partial update — the GOTCHA #55 regression
// ---------------------------------------------------------------------------

test('pageSettings: a PUT touching only title preserves the page fields (GOTCHA #55)', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    const id = crypto.randomUUID();
    const db = new SqliteDatabase(file);
    try {
      await insertSession(db, {
        id,
        title: 'Before',
        country_code: 'DE',
        page_size: 'Legal',
        page_orientation: 'landscape',
        source_text: 'the old CV',
        job_text: 'the job post',
      });

      const updated = await applyPut(db, id, { title: 'After' });

      assert.equal(updated.title, 'After');
      assert.equal(updated.page_size, 'Legal', 'page_size must survive a title-only PUT');
      assert.equal(
        updated.page_orientation,
        'landscape',
        'page_orientation must survive a title-only PUT',
      );
      // The columns GOTCHA #55 was actually about must still survive too.
      assert.equal(updated.source_text, 'the old CV', 'source_text must survive a title-only PUT');
      assert.equal(updated.job_text, 'the job post', 'job_text must survive a title-only PUT');
      assert.equal(updated.country_code, 'DE');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pageSettings: an absent page field stays absent across a disk re-open', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    const id = crypto.randomUUID();

    const writer = new SqliteDatabase(file);
    await insertSession(writer, { id, page_size: null, page_orientation: null });
    writer.close();

    const reader = new SqliteDatabase(file);
    try {
      const row = await get(reader, 'SELECT * FROM sessions WHERE id = ?', [id]);
      assert.ok('page_size' in row, 'page_size must be a column');
      assert.equal(row.page_size, null);
      assert.equal(row.page_orientation, null);

      // A PUT that omits both must leave them NULL, not materialise a value.
      const updated = await applyPut(reader, id, { title: 'No page choice' });
      assert.equal(updated.page_size, null);
      assert.equal(updated.page_orientation, null);
    } finally {
      reader.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The migration: pre-change shape -> current shape
// ---------------------------------------------------------------------------

/** The 12-column `sessions` table exactly as it existed before M16. */
const PRE_M16_SESSIONS_SQL = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'draft',
    resume_json TEXT DEFAULT '{}',
    template_id TEXT DEFAULT 'minimal',
    country_code TEXT,
    cover_letter_json TEXT DEFAULT '{}',
    cover_letter_text TEXT DEFAULT '',
    source_text TEXT,
    job_text TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

test('migration: adds the M16 columns to a pre-change database without touching the row', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'database.sqlite');
  const seed: Record<string, string | null> = {
    id: 'preexisting-session',
    title: 'Real Data',
    status: 'complete',
    resume_json: JSON.stringify({ basics: { fullName: 'Ada Lovelace' }, work: [{ company: 'X' }] }),
    template_id: 'slate',
    country_code: 'UK',
    cover_letter_json: JSON.stringify({ intro: 'hello', tone: 'warm' }),
    cover_letter_text: 'Hello\n\nBody',
    source_text: 'the original CV text',
    job_text: 'the original job text',
    created_at: '2026-01-02T03:04:05.006Z',
    updated_at: '2026-02-03T04:05:06.007Z',
  };
  try {
    // 1. Build the OLD shape by hand and insert a row with real values.
    const legacy = new DatabaseSync(file);
    const seedColumns = Object.keys(seed);
    legacy.exec(PRE_M16_SESSIONS_SQL);
    legacy
      .prepare(
        `INSERT INTO sessions (${seedColumns.join(', ')}) VALUES (${seedColumns
          .map(() => '?')
          .join(', ')})`,
      )
      .run(...Object.values(seed));
    // Prove the starting point really is the pre-change shape.
    const before: string[] = legacy
      .prepare('PRAGMA table_info(sessions)')
      .all()
      .map((r: any) => r.name);
    assert.ok(!before.includes('page_size'), 'the fixture must start without page_size');
    legacy.close();

    // 2. Run the migration path (the store's constructor calls ensureSchema).
    const db = new SqliteDatabase(file);
    const row = await get(db, 'SELECT * FROM sessions WHERE id = ?', ['preexisting-session']);
    const columns: string[] = (await all(db, 'PRAGMA table_info(sessions)')).map((r) => r.name);
    db.close();

    // 3. The columns exist, as NULL...
    assert.ok(columns.includes('page_size'), 'page_size must be added to an existing table');
    assert.ok(columns.includes('page_orientation'), 'page_orientation must be added');
    assert.equal(row.page_size, null, 'a migrated row has no page-size override');
    assert.equal(row.page_orientation, null, 'a migrated row has no orientation override');

    // 4. ...and every pre-existing value survived byte-for-byte.
    for (const [column, expected] of Object.entries(seed)) {
      assert.equal(row[column], expected, `${column} must survive the migration unchanged`);
    }

    // 5. And the row was not duplicated.
    const reopened = new SqliteDatabase(file);
    const count = await get(reopened, 'SELECT COUNT(*) AS n FROM sessions');
    reopened.close();
    assert.equal(count.n, 1, 'the migration must not duplicate the row');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration: ensureSchema is idempotent — a second run changes no data', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');

    // First setup + a row whose values must survive the second setup.
    const first = new SqliteDatabase(file);
    await insertSession(first, {
      id: 'idempotence',
      title: 'Stable',
      page_size: 'Letter',
      page_orientation: 'portrait',
      source_text: 'keep me',
    });
    first.close();

    // Second setup, via a fresh store (as every server boot is).
    const second = new SqliteDatabase(file);
    const row = await get(second, 'SELECT * FROM sessions WHERE id = ?', ['idempotence']);
    const columns: string[] = (await all(second, 'PRAGMA table_info(sessions)')).map((r) => r.name);
    second.close();

    assert.equal(columns.filter((c) => c === 'page_size').length, 1, 'no duplicate column');
    assert.equal(columns.filter((c) => c === 'page_orientation').length, 1);
    assert.equal(row.title, 'Stable');
    assert.equal(row.page_size, 'Letter');
    assert.equal(row.page_orientation, 'portrait');
    assert.equal(row.source_text, 'keep me');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration: ensureColumns is declaration-driven and adds nothing on a second call', () => {
  const dir = tempDir();
  const file = path.join(dir, 'database.sqlite');
  try {
    const db = new DatabaseSync(file);
    try {
      db.exec(PRE_M16_SESSIONS_SQL);

      // Reads the real shape, adds exactly the declared-but-missing columns.
      const added = ensureColumns(db, 'sessions', SESSION_COLUMN_DEFINITIONS);
      assert.deepEqual(added.slice().sort(), ['page_orientation', 'page_size']);

      // Idempotent: nothing is missing the second time, so no ALTER is issued.
      const again = ensureColumns(db, 'sessions', SESSION_COLUMN_DEFINITIONS);
      assert.deepEqual(again, []);

      // A fresh table created by ensureSchema is already complete.
      ensureSchema(db);
      assert.deepEqual(
        ensureColumns(db, 'sessions', SESSION_COLUMN_DEFINITIONS),
        [],
        'ensureSchema must leave nothing for ensureColumns to add',
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

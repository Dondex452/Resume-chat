/**
 * M11 — persistence tests for the REAL SQLite store.
 *
 * The whole danger of the old `MockDatabase` (GOTCHA #14) was that a missed
 * column edit or an unrecognised query failed SILENTLY: the write "succeeded",
 * the value was dropped, and the next read returned the old object with no
 * error. These tests exist to make that class of failure impossible:
 *
 *   - every session column and every message column is written and re-read
 *     through a FRESH instance (i.e. from disk);
 *   - the file itself is asserted to be real SQLite, not JSON;
 *   - a malformed statement, an unknown table and a parameter-count mismatch
 *     must all throw;
 *   - the legacy-JSON migration is asserted field-by-field and idempotent.
 *
 * The SQL strings here deliberately mirror `server.ts` / `server/migrate.ts`.
 * If the production SQL changes, it must change here too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteDatabase, mergeResume, renderCoverLetterText } from '../../store';
import {
  MIGRATION_BACKUP_NAME,
  SQLITE_MAGIC_HEADER,
  isLegacyJsonDatabase,
  migrateLegacyJsonIfNeeded,
} from '../../migrate';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm11-store-'));
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

// Mirrors POST /api/sessions (server.ts) — all twelve PRD §8 columns.
const INSERT_SESSION_SQL = `
  INSERT INTO sessions (id, title, status, resume_json, template_id, country_code, cover_letter_json, cover_letter_text, source_text, job_text, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

// Mirrors PUT /api/sessions/:id (server.ts).
const UPDATE_SESSION_SQL = `
  UPDATE sessions
  SET title = ?, status = ?, resume_json = ?, template_id = ?, country_code = ?, cover_letter_json = ?, cover_letter_text = ?, updated_at = ?
  WHERE id = ?
`;

const INSERT_MESSAGE_SQL = `
  INSERT INTO messages (id, session_id, role, content, created_at)
  VALUES (?, ?, ?, ?, ?)
`;

function sessionValues(o: any): any[] {
  return [
    o.id,
    o.title,
    o.status,
    o.resume_json,
    o.template_id,
    o.country_code,
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
      title: 'M11-TEST',
      status: 'draft',
      resume_json: '{}',
      template_id: 'minimal',
      country_code: null,
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

function insertMessage(db: SqliteDatabase, overrides: any = {}): Promise<any> {
  return run(db, INSERT_MESSAGE_SQL, [
    overrides.id ?? crypto.randomUUID(),
    overrides.session_id,
    overrides.role ?? 'user',
    overrides.content ?? 'hello',
    overrides.created_at ?? new Date().toISOString(),
  ]);
}

// ---------------------------------------------------------------------------
// The file is real SQLite
// ---------------------------------------------------------------------------

test('store: the on-disk file is a real SQLite database, not the JSON mock', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    const db = new SqliteDatabase(file);
    try {
      const bytes = fs.readFileSync(file);
      assert.equal(bytes.subarray(0, 16).toString('latin1'), SQLITE_MAGIC_HEADER);
      assert.notEqual(bytes.subarray(0, 1).toString('utf8'), '{', 'must no longer be a JSON document');
      assert.equal(isLegacyJsonDatabase(file), false);

      const tables = await all(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      );
      const names = tables.map((t) => t.name);
      assert.ok(names.includes('sessions'), 'sessions table must exist');
      assert.ok(names.includes('messages'), 'messages table must exist');
      assert.ok(names.includes('templates'), 'templates table (M11) must exist');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: the database reports real SQLite version info', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    const db = new SqliteDatabase(file);
    try {
      const row = await get(db, 'SELECT sqlite_version() AS v');
      assert.match(row.v, /^\d+\.\d+\.\d+/, 'sqlite_version() must return a real version');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Column round-trips
// ---------------------------------------------------------------------------

test('store: every session column round-trips through disk', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    const id = crypto.randomUUID();
    const values: Record<string, any> = {
      id,
      title: 'Round Trip',
      status: 'complete',
      resume_json: JSON.stringify({ basics: { fullName: 'Ada' }, work: [{ company: 'X' }] }),
      template_id: 'tech',
      country_code: 'JP',
      cover_letter_json: JSON.stringify({ intro: 'hi', tone: 'warm' }),
      cover_letter_text: 'Hi\n\nBody',
      source_text: 'old cv text',
      job_text: 'job description',
      created_at: '2026-01-02T03:04:05.006Z',
      updated_at: '2026-02-03T04:05:06.007Z',
    };

    const writer = new SqliteDatabase(file);
    await run(writer, INSERT_SESSION_SQL, sessionValues(values));
    writer.close();

    // Re-open from disk: proves it was serialised, not merely held in memory.
    const reader = new SqliteDatabase(file);
    try {
      const row = await get(reader, 'SELECT * FROM sessions WHERE id = ?', [id]);
      for (const [column, expected] of Object.entries(values)) {
        assert.equal(row[column], expected, `${column} must round-trip`);
      }
      assert.deepEqual(Object.getPrototypeOf(row), Object.prototype, 'rows must be plain objects');
    } finally {
      reader.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: NULL session columns round-trip as null, not as a missing key', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    const id = crypto.randomUUID();
    const db = new SqliteDatabase(file);
    try {
      await insertSession(db, { id });
      const row = await get(db, 'SELECT * FROM sessions WHERE id = ?', [id]);
      for (const column of ['country_code', 'source_text', 'job_text']) {
        assert.ok(column in row, `${column} must be present as a column`);
        assert.equal(row[column], null, `${column} must be null`);
      }
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: every message column round-trips through disk, in order', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    const sessionId = crypto.randomUUID();
    const db = new SqliteDatabase(file);
    const messages = [
      { id: crypto.randomUUID(), role: 'assistant', content: 'Hi there', created_at: '2026-01-01T00:00:01.000Z' },
      { id: crypto.randomUUID(), role: 'user', content: 'Add python', created_at: '2026-01-01T00:00:02.000Z' },
      { id: crypto.randomUUID(), role: 'system', content: 'note', created_at: '2026-01-01T00:00:03.000Z' },
    ];
    try {
      await insertSession(db, { id: sessionId });
      for (const message of messages) {
        await insertMessage(db, { ...message, session_id: sessionId });
      }
    } finally {
      db.close();
    }

    const reader = new SqliteDatabase(file);
    try {
      const rows = await all(
        reader,
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC',
        [sessionId],
      );
      assert.equal(rows.length, messages.length);
      rows.forEach((row, index) => {
        const expected = messages[index];
        assert.equal(row.id, expected.id);
        assert.equal(row.session_id, sessionId);
        assert.equal(row.role, expected.role);
        assert.equal(row.content, expected.content);
        assert.equal(row.created_at, expected.created_at);
      });
    } finally {
      reader.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: country_code survives insert, a disk re-read, and an update', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    const id = crypto.randomUUID();

    // NOTE (Windows): every DatabaseSync must be closed before the temp dir can
    // be removed — an open handle locks the file and `rmSync` fails EPERM.
    const writer = new SqliteDatabase(file);
    await insertSession(writer, { id, country_code: 'DE' });
    writer.close();

    const reopened = new SqliteDatabase(file);
    const row = await get(reopened, 'SELECT * FROM sessions WHERE id = ?', [id]);
    assert.equal(row.country_code, 'DE', 'country_code must persist to disk');

    await run(reopened, UPDATE_SESSION_SQL, [
      row.title,
      row.status,
      row.resume_json,
      row.template_id,
      'JP',
      row.cover_letter_json,
      row.cover_letter_text,
      new Date().toISOString(),
      id,
    ]);
    reopened.close();

    const reader = new SqliteDatabase(file);
    const afterUpdate = await get(reader, 'SELECT * FROM sessions WHERE id = ?', [id]);
    reader.close();
    assert.equal(afterUpdate.country_code, 'JP', 'country_code must be updatable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: a partial update that omits country_code leaves it intact', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    const id = crypto.randomUUID();
    const writer = new SqliteDatabase(file);
    await insertSession(writer, { id, country_code: 'AE' });
    writer.close();

    // The chat tool path writes only resume_json + updated_at.
    const db = new SqliteDatabase(file);
    await run(db, 'UPDATE sessions SET resume_json = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify({ basics: { fullName: 'Ada' } }),
      new Date().toISOString(),
      id,
    ]);
    db.close();

    const reader = new SqliteDatabase(file);
    const row = await get(reader, 'SELECT * FROM sessions WHERE id = ?', [id]);
    reader.close();
    assert.equal(row.country_code, 'AE');
    assert.equal(JSON.parse(row.resume_json).basics.fullName, 'Ada');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// templates table (M11)
// ---------------------------------------------------------------------------

test('store: templates CRUD round-trips', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    const db = new SqliteDatabase(file);
    try {
      const id = crypto.randomUUID();
      const schema = JSON.stringify({ id, name: 'Two Column', version: 1, origin: 'generated' });
      await run(
        db,
        'INSERT INTO templates (id, name, origin, schema_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, 'Two Column', 'generated', schema, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'],
      );

      const inserted = await get(db, 'SELECT * FROM templates WHERE id = ?', [id]);
      assert.equal(inserted.name, 'Two Column');
      assert.equal(inserted.origin, 'generated');
      assert.equal(inserted.schema_json, schema);

      await run(db, 'UPDATE templates SET name = ?, schema_json = ?, updated_at = ? WHERE id = ?', [
        'Two Column v2',
        JSON.stringify({ id, name: 'Two Column v2', version: 2 }),
        '2026-03-02T00:00:00.000Z',
        id,
      ]);
      const updated = await get(db, 'SELECT * FROM templates WHERE id = ?', [id]);
      assert.equal(updated.name, 'Two Column v2');
      assert.equal(JSON.parse(updated.schema_json).version, 2);

      const listed = await all(db, 'SELECT * FROM templates ORDER BY updated_at DESC');
      assert.equal(listed.length, 1);

      await run(db, 'DELETE FROM templates WHERE id = ?', [id]);
      assert.equal(await get(db, 'SELECT * FROM templates WHERE id = ?', [id]), null);
      assert.equal((await all(db, 'SELECT * FROM templates')).length, 0);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: deleting a session cascades to its messages (foreign key)', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    const sessionId = crypto.randomUUID();
    const db = new SqliteDatabase(file);
    try {
      await insertSession(db, { id: sessionId });
      await insertMessage(db, { session_id: sessionId, content: 'one' });
      await insertMessage(db, { session_id: sessionId, content: 'two' });
      assert.equal((await all(db, 'SELECT * FROM messages WHERE session_id = ?', [sessionId])).length, 2);

      await run(db, 'DELETE FROM sessions WHERE id = ?', [sessionId]);
      assert.equal(
        (await all(db, 'SELECT * FROM messages WHERE session_id = ?', [sessionId])).length,
        0,
        'messages must cascade with their session',
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Loud failure — the whole point of replacing the mock
// ---------------------------------------------------------------------------

test('store: a malformed SQL statement throws instead of being swallowed', async () => {
  const dir = tempDir();
  try {
    const db = new SqliteDatabase(path.join(dir, 'database.sqlite'));
    try {
      // No callback: the caller asked for the throw.
      assert.throws(() => db.run('SELEC * FROM sessions'), /syntax error|near/i);

      // With a callback: the error is delivered, never replaced by silence.
      const callbackError = await new Promise<Error | null>((resolve) => {
        db.run('SELEC * FROM sessions', [], function (err: Error | null) {
          resolve(err);
        });
      });
      assert.ok(callbackError, 'the callback must receive the error');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: an unknown table throws (the mock returned null/[] here)', async () => {
  const dir = tempDir();
  try {
    const db = new SqliteDatabase(path.join(dir, 'database.sqlite'));
    try {
      await assert.rejects(all(db, 'SELECT * FROM definitely_not_a_table'), /no such table/i);
      await assert.rejects(get(db, 'SELECT * FROM definitely_not_a_table'), /no such table/i);
      assert.throws(() => db.all('SELECT * FROM definitely_not_a_table'), /no such table/i);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: a parameter-count mismatch is loud in both directions', async () => {
  const dir = tempDir();
  try {
    const db = new SqliteDatabase(path.join(dir, 'database.sqlite'));
    try {
      // TOO MANY — exactly the historical server bug (role passed twice).
      await assert.rejects(
        run(
          db,
          `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`,
          ['id', 'sid', 'user', 'hello', 'now'],
        ),
        /parameter count mismatch/i,
      );

      // TOO FEW — SQLite would silently bind the missing value to NULL.
      assert.throws(
        () => db.all('SELECT * FROM messages WHERE session_id = ?'),
        /parameter count mismatch/i,
      );

      // A `?` inside a string literal must not be miscounted.
      const literal = await get(db, "SELECT '?' AS q, ? AS a", ['ok']);
      assert.equal(literal.q, '?');
      assert.equal(literal.a, 'ok');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: binding an unsupported value throws rather than storing undefined', async () => {
  const dir = tempDir();
  try {
    const db = new SqliteDatabase(path.join(dir, 'database.sqlite'));
    try {
      assert.throws(
        () => db.run('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)', [
          'id',
          'sid',
          'user',
          undefined,
          'now',
        ]),
        /cannot be bound/i,
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Legacy JSON migration
// ---------------------------------------------------------------------------

const LEGACY_JSON = JSON.stringify(
  {
    sessions: [
      {
        id: 'legacy-1',
        title: 'Legacy Session',
        status: 'draft',
        resume_json: JSON.stringify({ basics: { fullName: 'Ada' }, personal: { dob: '1990-05-14' } }),
        template_id: 'tech',
        country_code: 'DE',
        cover_letter_json: '{}',
        cover_letter_text: '',
        source_text: null,
        job_text: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
      {
        // A row written before M10 existed — no country_code key at all, and no
        // source_text / job_text either.
        id: 'legacy-2',
        title: 'Legacy Session Two',
        status: 'draft',
        resume_json: '{}',
        template_id: 'executive',
        cover_letter_json: '{}',
        cover_letter_text: '',
        created_at: '2026-02-01T00:00:00.000Z',
        updated_at: '2026-02-02T00:00:00.000Z',
      },
    ],
    messages: [
      {
        id: 'legacy-m1',
        session_id: 'legacy-1',
        role: 'assistant',
        content: 'Hi!',
        created_at: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 'legacy-m2',
        session_id: 'legacy-1',
        role: 'user',
        content: 'Add python',
        created_at: '2026-01-01T00:00:02.000Z',
      },
    ],
  },
  null,
  2,
);

test('migration: the constructor converts legacy JSON and preserves every field', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    fs.writeFileSync(file, LEGACY_JSON, 'utf8');
    assert.equal(isLegacyJsonDatabase(file), true);

    const db = new SqliteDatabase(file);
    try {
      assert.equal(db.migrationReport.migrated, true);
      assert.equal(db.migrationReport.reason, 'migrated');
      assert.equal(db.migrationReport.sessions, 2);
      assert.equal(db.migrationReport.messages, 2);

      const source = JSON.parse(LEGACY_JSON);
      for (const expected of source.sessions) {
        const row = await get(db, 'SELECT * FROM sessions WHERE id = ?', [expected.id]);
        assert.ok(row, `session ${expected.id} must survive`);
        assert.equal(row.title, expected.title);
        assert.equal(row.resume_json, expected.resume_json);
        assert.equal(row.template_id, expected.template_id);
        assert.equal(row.created_at, expected.created_at);
        assert.equal(row.updated_at, expected.updated_at);
        // Absence stays absence: a missing key migrates to NULL, not to a value.
        assert.equal(row.country_code, expected.country_code ?? null);
      }

      for (const expected of source.messages) {
        const row = await get(db, 'SELECT * FROM messages WHERE id = ?', [expected.id]);
        assert.ok(row, `message ${expected.id} must survive`);
        assert.equal(row.session_id, expected.session_id);
        assert.equal(row.role, expected.role);
        assert.equal(row.content, expected.content);
        assert.equal(row.created_at, expected.created_at);
      }
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration: is idempotent — running it twice does not duplicate rows', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    fs.writeFileSync(file, LEGACY_JSON, 'utf8');

    const first = migrateLegacyJsonIfNeeded(file);
    assert.equal(first.migrated, true);
    assert.equal(first.sessions, 2);
    assert.equal(first.messages, 2);

    const second = migrateLegacyJsonIfNeeded(file);
    assert.equal(second.migrated, false);
    assert.equal(second.reason, 'already-sqlite');

    // Opening (which migrates again internally) must not add rows either.
    const db = new SqliteDatabase(file);
    try {
      assert.equal((await all(db, 'SELECT * FROM sessions')).length, 2);
      assert.equal((await all(db, 'SELECT * FROM messages')).length, 2);
    } finally {
      db.close();
    }

    // Pre-existing new data is untouched by a later no-op migration run.
    const reopened = new SqliteDatabase(file);
    await insertSession(reopened, { title: 'Post-migration' });
    reopened.close();
    assert.equal(migrateLegacyJsonIfNeeded(file).migrated, false);
    const finalDb = new SqliteDatabase(file);
    assert.equal((await all(finalDb, 'SELECT * FROM sessions')).length, 3);
    finalDb.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration: preserves the original JSON in a git-ignored backup file', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    fs.writeFileSync(file, LEGACY_JSON, 'utf8');

    const report = migrateLegacyJsonIfNeeded(file);
    const backupPath = path.join(dir, MIGRATION_BACKUP_NAME);
    assert.equal(report.backupPath, backupPath);
    assert.ok(fs.existsSync(backupPath), 'the JSON backup must be written');
    assert.equal(fs.readFileSync(backupPath, 'utf8'), LEGACY_JSON, 'backup must be byte-identical');

    const gitignorePath = path.join(process.cwd(), '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const lines = fs.readFileSync(gitignorePath, 'utf8').split(/\r?\n/);
      assert.ok(
        lines.includes(MIGRATION_BACKUP_NAME),
        `.gitignore must cover ${MIGRATION_BACKUP_NAME}`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration: a corrupt JSON file is not mistaken for a legacy store', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    fs.writeFileSync(file, '{ this is not valid json', 'utf8');
    assert.equal(isLegacyJsonDatabase(file), false);
    const report = migrateLegacyJsonIfNeeded(file);
    assert.equal(report.migrated, false);
    assert.equal(report.reason, 'already-sqlite');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration: an absent file is a no-op and leaves schema creation to the store', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'database.sqlite');
    const report = migrateLegacyJsonIfNeeded(file);
    assert.equal(report.migrated, false);
    assert.equal(report.reason, 'absent');

    const db = new SqliteDatabase(file);
    try {
      assert.equal((await all(db, 'SELECT * FROM sessions')).length, 0);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// mergeResume — the M10 nested fields, round-tripped through real SQLite
// ---------------------------------------------------------------------------

test('mergeResume: personal.dob is kept and survives a store round-trip', async () => {
  const dir = tempDir();
  try {
    const merged = mergeResume({}, { personal: { dob: '1990-05-14', nationality: 'German' } });
    assert.deepEqual(merged.personal, { dob: '1990-05-14', nationality: 'German' });

    const file = path.join(dir, 'database.sqlite');
    const id = crypto.randomUUID();
    const writer = new SqliteDatabase(file);
    await insertSession(writer, { id, resume_json: JSON.stringify(merged) });
    writer.close();

    const reader = new SqliteDatabase(file);
    const row = await get(reader, 'SELECT * FROM sessions WHERE id = ?', [id]);
    reader.close();
    assert.equal(JSON.parse(row.resume_json).personal.dob, '1990-05-14');
    assert.equal(JSON.parse(row.resume_json).personal.nationality, 'German');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeResume: signature.place is kept and survives a store round-trip', async () => {
  const dir = tempDir();
  try {
    const merged = mergeResume({}, { signature: { place: 'Berlin', date: '2026-09-20', signed: true } });
    assert.deepEqual(merged.signature, { place: 'Berlin', date: '2026-09-20', signed: true });

    const file = path.join(dir, 'database.sqlite');
    const id = crypto.randomUUID();
    const writer = new SqliteDatabase(file);
    await insertSession(writer, { id, resume_json: JSON.stringify(merged) });
    writer.close();

    const reader = new SqliteDatabase(file);
    const row = await get(reader, 'SELECT * FROM sessions WHERE id = ?', [id]);
    reader.close();
    assert.equal(JSON.parse(row.resume_json).signature.place, 'Berlin');
    assert.equal(JSON.parse(row.resume_json).signature.signed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeResume: basics.photo is kept and survives a store round-trip', async () => {
  const dir = tempDir();
  try {
    const photo = 'data:image/png;base64,AAAA';
    const merged = mergeResume({ basics: { fullName: 'Ada' } }, { basics: { photo } });
    assert.equal(merged.basics.photo, photo);
    assert.equal(merged.basics.fullName, 'Ada');

    const file = path.join(dir, 'database.sqlite');
    const id = crypto.randomUUID();
    const writer = new SqliteDatabase(file);
    await insertSession(writer, { id, resume_json: JSON.stringify(merged) });
    writer.close();

    const reader = new SqliteDatabase(file);
    const row = await get(reader, 'SELECT * FROM sessions WHERE id = ?', [id]);
    reader.close();
    assert.equal(JSON.parse(row.resume_json).basics.photo, photo);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeResume: patching one field does not wipe its siblings', () => {
  const existing = {
    basics: { fullName: 'Ada', photo: 'data:image/png;base64,AAAA' },
    personal: { dob: '1990-05-14', nationality: 'British' },
    signature: { place: 'Berlin', date: '2026-09-20', signed: true },
    work: [{ company: 'X' }],
  };

  const merged = mergeResume(existing, { basics: { summary: 'Engineer' } });
  assert.equal(merged.basics.fullName, 'Ada');
  assert.equal(merged.basics.photo, 'data:image/png;base64,AAAA');
  assert.equal(merged.basics.summary, 'Engineer');
  assert.deepEqual(merged.personal, { dob: '1990-05-14', nationality: 'British' });
  assert.deepEqual(merged.signature, { place: 'Berlin', date: '2026-09-20', signed: true });
  assert.deepEqual(merged.work, [{ company: 'X' }]);

  const merged2 = mergeResume(existing, { personal: { nationality: 'German' } });
  assert.equal(merged2.personal.dob, '1990-05-14');
  assert.equal(merged2.personal.nationality, 'German');
  assert.equal(merged2.signature.place, 'Berlin');

  const merged3 = mergeResume(existing, { signature: { date: '2027-01-01' } });
  assert.equal(merged3.signature.place, 'Berlin');
  assert.equal(merged3.signature.signed, true);
  assert.equal(merged3.signature.date, '2027-01-01');
});

test('mergeResume: absent fields stay absent (no undefined keys leak into JSON)', () => {
  const merged = mergeResume({}, { basics: { fullName: 'Ada' } });
  assert.ok(!('personal' in merged));
  assert.ok(!('signature' in merged));
  const serialised = JSON.stringify(merged);
  assert.ok(!serialised.includes('undefined'));
  assert.deepEqual(JSON.parse(serialised), { basics: { fullName: 'Ada' } });

  // An explicit `undefined` in the patch must not materialise a key either.
  const merged2 = mergeResume({}, { personal: { dob: undefined } });
  const serialised2 = JSON.stringify(merged2);
  assert.ok(!serialised2.includes('undefined'));
  assert.ok(!('dob' in JSON.parse(serialised2).personal));
});

// ---------------------------------------------------------------------------
// renderCoverLetterText — the M14 duplicated-sign-off fix
//
// Before M14 the function appended `Sincerely,\n\n[Your Name]` unconditionally,
// so a letter whose model-authored closing already ended with its own real
// sign-off shipped a SECOND one carrying a literal placeholder. These tests pin
// the three properties that must hold: no duplicate, a real name when we have
// one, and never the placeholder.
// ---------------------------------------------------------------------------

function signOffCount(text: string): number {
  return (text.match(/sincerely/gi) || []).length;
}

test('cover letter: a closing that already ends with a sign-off is not given a second one', () => {
  const cl = {
    recipient: { name: 'Ms. Hiring Manager', company: 'Acme' },
    intro: 'I am writing to apply for the role.',
    body: 'Here is why I am a strong fit.',
    closing: 'Thank you for your time.\n\nSincerely,\nJane Doe',
  };

  const text = renderCoverLetterText(cl, 'Jane Doe');
  assert.equal(signOffCount(text), 1, 'exactly one sign-off must remain');
  assert.ok(!text.includes('[Your Name]'), 'the placeholder must never appear');
  assert.ok(text.includes('Sincerely,\nJane Doe'), "the model's own sign-off must be preserved verbatim");
  // The recipient block and date behaviour are untouched.
  assert.ok(text.includes('Ms. Hiring Manager\nAcme'));
});

test('cover letter: no sign-off in the body gets exactly one, using the real resume name', () => {
  const cl = {
    intro: 'I am writing to apply for the role.',
    body: 'Here is why I am a strong fit.',
    closing: 'I look forward to discussing this with you.',
  };

  const text = renderCoverLetterText(cl, 'Jane Doe');
  assert.equal(signOffCount(text), 1, 'exactly one sign-off must be appended');
  assert.ok(text.trim().endsWith('Sincerely,\n\nJane Doe'), 'the real name must be used');
  assert.ok(!text.includes('[Your Name]'));
});

test('cover letter: with no known name the fallback is a bare sign-off, never a placeholder', () => {
  const cl = { closing: 'I look forward to discussing this with you.' };

  const unnamed = renderCoverLetterText(cl);
  assert.equal(signOffCount(unnamed), 1);
  assert.ok(unnamed.trim().endsWith('Sincerely,'), 'a bare "Sincerely," is the fallback');
  assert.ok(!unnamed.includes('[Your Name]'));

  // A blank / whitespace name must behave exactly like "no name".
  for (const blank of ['', '   ']) {
    const blankText = renderCoverLetterText(cl, blank);
    assert.ok(blankText.trim().endsWith('Sincerely,'));
    assert.ok(!blankText.includes('[Your Name]'));
  }
});

test('cover letter: sign-off detection is case-insensitive', () => {
  const closings = [
    'Looking forward to your reply.\n\nYours Faithfully,\nJane Doe',
    'Looking forward to your reply.\n\nBEST REGARDS,\nJane Doe',
    'Looking forward to your reply.\n\nyours sincerely',
  ];

  for (const closing of closings) {
    const text = renderCoverLetterText({ closing }, 'Jane Doe');
    assert.ok(
      !/^Sincerely,$/m.test(text),
      `an added "Sincerely," must not appear after: ${JSON.stringify(closing)}`,
    );
    assert.equal(
      (text.match(/sincerely/gi) || []).length <= 1,
      true,
      `no second "Sincerely" after: ${JSON.stringify(closing)}`,
    );
    assert.ok(!text.includes('[Your Name]'));
  }
});

test('cover letter: a casual "regards" mid-paragraph does NOT suppress the real sign-off', () => {
  const closing =
    'I am excited about this role and how my background regards your roadmap. I look forward to hearing from you.';

  const text = renderCoverLetterText({ closing }, 'Jane Doe');
  assert.equal(signOffCount(text), 1, 'the real sign-off must still be appended');
  assert.ok(text.includes('Sincerely,\n\nJane Doe'));
  assert.ok(!text.includes('[Your Name]'));
});

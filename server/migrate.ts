/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * M11 — real SQLite (PRD §7/§8, Decision Log #24). Replaces the hand-rolled
 * `MockDatabase` JSON store described in GOTCHA #14.
 *
 * `node:sqlite` ships inside Node 24 (`DatabaseSync` / `StatementSync`), so this
 * is *real SQLite* with no dependency and no native build.
 *
 * This module owns two things:
 *   1. the schema — one source of truth for `sessions`, `messages`, and the M11
 *      `templates` table (PRD §8);
 *   2. the one-time, idempotent migration off the legacy JSON file, including a
 *      field-by-field verification before the new file replaces the old one.
 *
 * ⚠️ `node:sqlite` is marked experimental in Node 24 and prints an
 * `ExperimentalWarning` on first import. That is expected (PRD Decision #24).
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The 16-byte magic that begins every real SQLite file. */
export const SQLITE_MAGIC_HEADER = 'SQLite format 3\u0000';

/** Legacy JSON is preserved here before conversion. Git-ignored. */
export const MIGRATION_BACKUP_NAME = 'database.json.pre-sqlite.bak';

/**
 * The declared `sessions` columns, in canonical order, each with the SQL
 * fragment used to create it.
 *
 * This is the SINGLE source of truth for the table shape:
 *   - `SESSION_COLUMNS` (below) is derived from it;
 *   - the `CREATE TABLE` is generated from it, so a fresh database is correct;
 *   - `ensureSchema` reconciles an EXISTING table against it, issuing
 *     `ALTER TABLE ... ADD COLUMN` for anything missing.
 *
 * That last point is the whole reason this declaration exists (GOTCHA #14).
 * `CREATE TABLE IF NOT EXISTS` is a **no-op** on a database that already
 * exists, so before this, adding a column reached fresh databases only — the
 * live store would keep the old shape forever, and the old JSON mock needed
 * **six** coordinated edits per column with a miss failing silently. Now a new
 * column is one line here.
 *
 * ⚠️ Order matters: it is the order `normalizeSession` emits and the order the
 * migration INSERT uses. `page_size` / `page_orientation` (M16) sit beside
 * `country_code` because all three are per-session document settings.
 */
export const SESSION_COLUMN_DEFINITIONS = [
  { name: 'id', definition: 'TEXT PRIMARY KEY' },
  { name: 'title', definition: 'TEXT NOT NULL' },
  { name: 'status', definition: "TEXT DEFAULT 'draft'" },
  { name: 'resume_json', definition: "TEXT DEFAULT '{}'" },
  { name: 'template_id', definition: "TEXT DEFAULT 'minimal'" },
  { name: 'country_code', definition: 'TEXT' },
  // M16 (PRD §5.4 amended) — the page the user owns. NULL = "follow the
  // country preset" for size, and the portrait default for orientation.
  { name: 'page_size', definition: 'TEXT' },
  { name: 'page_orientation', definition: 'TEXT' },
  { name: 'cover_letter_json', definition: "TEXT DEFAULT '{}'" },
  { name: 'cover_letter_text', definition: "TEXT DEFAULT ''" },
  { name: 'source_text', definition: 'TEXT' },
  { name: 'job_text', definition: 'TEXT' },
  { name: 'created_at', definition: 'TEXT NOT NULL' },
  { name: 'updated_at', definition: 'TEXT NOT NULL' },
] as const;

/** Column names, derived from the declaration above. */
export const SESSION_COLUMNS: string[] = SESSION_COLUMN_DEFINITIONS.map((c) => c.name);

export const MESSAGE_COLUMNS = ['id', 'session_id', 'role', 'content', 'created_at'] as const;

export const TEMPLATE_COLUMNS = ['id', 'name', 'origin', 'schema_json', 'created_at', 'updated_at'] as const;

/**
 * The `sessions` CREATE TABLE, generated from the declaration above so the two
 * can never drift. Only used for a **fresh** database; an existing table is
 * reconciled by `ensureColumns` (see below).
 */
export const CREATE_SESSIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sessions (
  ${SESSION_COLUMN_DEFINITIONS.map((c) => `${c.name} ${c.definition}`).join(',\n  ')}
);`;

/**
 * The schema, as real SQL. Running this on every open is idempotent.
 *
 * Notes:
 * - `foreign_keys` is enabled per connection so `ON DELETE CASCADE` on
 *   `messages` actually fires. The mock performed that cascade by hand; a real
 *   engine only does it when the pragma is on. `node:sqlite` defaults it on and
 *   `SqliteDatabase` also passes it explicitly — belt and braces.
 * - No `CHECK` constraints on `status`/`role`. PRD §8 lists the expected values
 *   but the previous store did not enforce them, and the mission forbids an API
 *   response-shape change; enforcement is left to the application.
 * - Index `(session_id, created_at)` serves the message-history query exactly
 *   (`WHERE session_id = ? ORDER BY created_at ASC`).
 */
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

${CREATE_SESSIONS_TABLE_SQL}

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  origin TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_templates_updated_at ON templates(updated_at);
`;

/** The columns a table actually has today. Empty when the table does not exist. */
function existingColumnNames(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/**
 * Reconcile an EXISTING table against its declared columns, adding any that are
 * missing with `ALTER TABLE ... ADD COLUMN`.
 *
 * Generic by design: it is driven entirely by `definitions`, so the next column
 * is a one-line change to `SESSION_COLUMN_DEFINITIONS` rather than another hand
 * edit (GOTCHA #14).
 *
 * Idempotent: a column that already exists is skipped, so a second run issues
 * no ALTER at all. Existing rows are never rewritten — a new nullable column
 * reads back as NULL, and a column with a constant DEFAULT is backfilled by
 * SQLite.
 *
 * Returns the names it added, which makes "did this run change anything?"
 * observable (and testable) without a second schema read.
 *
 * ⚠️ SQLite refuses `ADD COLUMN` for a PRIMARY KEY, or for a NOT NULL column
 * with no constant default. Those constraints only matter for the original
 * columns (`id`, `title`, `created_at`, `updated_at`), which cannot be missing
 * from a real `sessions` table — if one ever were, the database is corrupt and
 * failing loudly is correct.
 */
export function ensureColumns(
  db: DatabaseSync,
  table: string,
  definitions: ReadonlyArray<{ name: string; definition: string }>,
): string[] {
  const present = existingColumnNames(db, table);
  const added: string[] = [];
  for (const column of definitions) {
    if (present.has(column.name)) continue;
    db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column.name}" ${column.definition}`);
    added.push(column.name);
  }
  return added;
}

/**
 * Create every table/index if absent, then bring an existing `sessions` table
 * up to the declared column list. Idempotent.
 *
 * Only `sessions` is reconciled: `messages` and `templates` have no missing
 * columns, so adding the same call for them would be speculative machinery.
 */
export function ensureSchema(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
  ensureColumns(db, 'sessions', SESSION_COLUMN_DEFINITIONS);
}

/**
 * True only when the file on disk is the legacy `{ sessions, messages }` JSON.
 *
 * Detection is by content, never by extension: the JSON store, a real SQLite
 * file, an empty file and a corrupt file are all named `database.sqlite`.
 * Opening a JSON file with `DatabaseSync` does not fail at open time — it fails
 * lazily with "file is not a database" on the first query (verified), so the
 * check has to happen before we open the database.
 */
export function isLegacyJsonDatabase(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const buffer = fs.readFileSync(filePath);
  if (buffer.length === 0) return false;
  if (buffer.subarray(0, SQLITE_MAGIC_HEADER.length).toString('latin1') === SQLITE_MAGIC_HEADER) {
    return false;
  }
  const text = buffer.toString('utf8').trim();
  if (!text.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(text);
    return !!parsed && Array.isArray(parsed.sessions) && Array.isArray(parsed.messages);
  } catch {
    return false;
  }
}

/**
 * Legacy row -> canonical column values. Used for BOTH the INSERT and the
 * post-insert verification, so the expectation cannot drift from what was
 * written. Defaults mirror the legacy store's behaviour of treating an absent
 * key as absent (NULL) or as the column's schema default.
 */
export function normalizeSession(raw: any): Record<string, any> {
  const now = new Date().toISOString();
  return {
    id: raw?.id != null ? String(raw.id) : null,
    title: raw?.title ?? '',
    status: raw?.status ?? 'draft',
    resume_json: raw?.resume_json ?? '{}',
    template_id: raw?.template_id ?? 'minimal',
    country_code: raw?.country_code ?? null,
    // M16 — absent on every pre-M16 row (legacy JSON and existing SQLite alike),
    // and absence means "follow the country preset" / portrait.
    page_size: raw?.page_size ?? null,
    page_orientation: raw?.page_orientation ?? null,
    cover_letter_json: raw?.cover_letter_json ?? '{}',
    cover_letter_text: raw?.cover_letter_text ?? '',
    source_text: raw?.source_text ?? null,
    job_text: raw?.job_text ?? null,
    created_at: raw?.created_at ?? now,
    updated_at: raw?.updated_at ?? now,
  };
}

export function normalizeMessage(raw: any): Record<string, any> {
  const now = new Date().toISOString();
  return {
    id: raw?.id != null ? String(raw.id) : null,
    session_id: raw?.session_id != null ? String(raw.session_id) : null,
    role: raw?.role ?? 'assistant',
    content: raw?.content ?? '',
    created_at: raw?.created_at ?? now,
  };
}

export interface MigrationReport {
  filePath: string;
  migrated: boolean;
  reason: 'absent' | 'already-sqlite' | 'not-legacy-json' | 'migrated';
  sessions?: number;
  messages?: number;
  backupPath?: string;
}

/**
 * Convert `filePath` from the legacy JSON store to real SQLite, once.
 *
 * Idempotent by construction: after a successful run the file starts with the
 * SQLite magic header, so `isLegacyJsonDatabase` returns false and every
 * subsequent call is a no-op. A second run can therefore never duplicate rows.
 *
 * The source file is never partially rewritten: the new database is built at
 * `filePath + '.migrate-tmp'`, fully verified (row counts *and* every column of
 * every row), and only then copied over the original.
 */
export function migrateLegacyJsonIfNeeded(
  filePath: string,
  opts: { log?: (message: string) => void } = {},
): MigrationReport {
  const log = opts.log ?? (() => {});

  if (!fs.existsSync(filePath)) {
    return { filePath, migrated: false, reason: 'absent' };
  }
  if (!isLegacyJsonDatabase(filePath)) {
    return { filePath, migrated: false, reason: 'already-sqlite' };
  }

  const jsonText = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(jsonText);
  const sessions: Record<string, any>[] = (Array.isArray(parsed.sessions) ? parsed.sessions : []).map(
    normalizeSession,
  );
  const messages: Record<string, any>[] = (Array.isArray(parsed.messages) ? parsed.messages : []).map(
    normalizeMessage,
  );

  // 1. Preserve the JSON before the database file is touched, so a failure at
  //    any later step is fully recoverable. The path is git-ignored.
  const backupPath = path.join(path.dirname(filePath), MIGRATION_BACKUP_NAME);
  fs.writeFileSync(backupPath, jsonText, 'utf8');
  log(`[migrate] legacy JSON store detected: ${sessions.length} session(s), ${messages.length} message(s).`);
  log(`[migrate] original JSON preserved at ${backupPath}`);

  // 2. Build and verify the SQLite database beside the source.
  const tempPath = `${filePath}.migrate-tmp`;
  fs.rmSync(tempPath, { force: true });
  const temp = new DatabaseSync(tempPath, { enableForeignKeyConstraints: true });
  try {
    ensureSchema(temp);

    const insertSessionSql = `INSERT INTO sessions (${SESSION_COLUMNS.join(', ')}) VALUES (${SESSION_COLUMNS.map(() => '?').join(', ')})`;
    const insertMessageSql = `INSERT INTO messages (${MESSAGE_COLUMNS.join(', ')}) VALUES (${MESSAGE_COLUMNS.map(() => '?').join(', ')})`;

    temp.exec('BEGIN');
    try {
      const insertSession = temp.prepare(insertSessionSql);
      for (const session of sessions) insertSession.run(...SESSION_COLUMNS.map((c) => session[c]));
      const insertMessage = temp.prepare(insertMessageSql);
      for (const message of messages) insertMessage.run(...MESSAGE_COLUMNS.map((c) => message[c]));
      temp.exec('COMMIT');
    } catch (err) {
      try {
        temp.exec('ROLLBACK');
      } catch {
        /* the transaction may already be rolled back */
      }
      throw err;
    }

    // 3. Verify — counts first, then every column of every row.
    const sessionCount = Number((temp.prepare('SELECT COUNT(*) AS n FROM sessions').get() as any).n);
    const messageCount = Number((temp.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n);
    if (sessionCount !== sessions.length) {
      throw new Error(
        `Migration verification failed: ${sessionCount} sessions stored, expected ${sessions.length}`,
      );
    }
    if (messageCount !== messages.length) {
      throw new Error(
        `Migration verification failed: ${messageCount} messages stored, expected ${messages.length}`,
      );
    }

    const readSession = temp.prepare('SELECT * FROM sessions WHERE id = ?');
    for (const expected of sessions) {
      const stored: any = readSession.get(expected.id);
      if (!stored) throw new Error(`Migration verification failed: session ${expected.id} is missing`);
      for (const column of SESSION_COLUMNS) {
        if ((stored[column] ?? null) !== (expected[column] ?? null)) {
          throw new Error(
            `Migration verification failed: session ${expected.id}.${column} = ${JSON.stringify(
              stored[column],
            )}, expected ${JSON.stringify(expected[column])}`,
          );
        }
      }
    }

    const readMessage = temp.prepare('SELECT * FROM messages WHERE id = ?');
    for (const expected of messages) {
      const stored: any = readMessage.get(expected.id);
      if (!stored) throw new Error(`Migration verification failed: message ${expected.id} is missing`);
      for (const column of MESSAGE_COLUMNS) {
        if ((stored[column] ?? null) !== (expected[column] ?? null)) {
          throw new Error(
            `Migration verification failed: message ${expected.id}.${column} = ${JSON.stringify(
              stored[column],
            )}, expected ${JSON.stringify(expected[column])}`,
          );
        }
      }
    }
  } finally {
    temp.close();
  }

  // 4. Swap the verified file in. `copyFileSync` overwrites in place, so the
  //    final name is never a half-written database.
  fs.copyFileSync(tempPath, filePath);
  fs.rmSync(tempPath, { force: true });

  log(
    `[migrate] ${path.basename(filePath)} is now real SQLite — ${sessions.length} session(s), ${messages.length} message(s), verified.`,
  );

  return {
    filePath,
    migrated: true,
    reason: 'migrated',
    sessions: sessions.length,
    messages: messages.length,
    backupPath,
  };
}

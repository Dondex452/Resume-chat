/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * M11 — the persistence layer is now **real SQLite**, via Node's built-in
 * `node:sqlite` (PRD Decision Log #24). It replaces the hand-rolled JSON
 * `MockDatabase` described in GOTCHA #14, whose central sin was silence: an
 * unrecognised query returned `null`/`[]`, and a missed column edit dropped the
 * value with no error at all.
 *
 * The public shape is deliberately the same callback API the rest of the server
 * already used (`run` / `get` / `all` with `?` placeholders, plus `serialize`),
 * so `server.ts` needed almost no change. What changed underneath:
 *
 *   - a real SQL engine validates every statement — a typo now throws;
 *   - a parameter-count guard turns "too few / too many values" into a loud
 *     error instead of a silently NULL-bound or rejected write;
 *   - rows are returned as plain objects (SQLite hands back null-prototype
 *     objects, which would be a surprise for `assert.deepStrictEqual` and for
 *     any `instanceof`/prototype logic downstream).
 *
 * `mergeResume` / `mergeCoverLetter` / `renderCoverLetterText` stay
 * provider-neutral: they are the only writers of `resume_json` /
 * `cover_letter_json`.
 */

import { DatabaseSync } from 'node:sqlite';
import {
  ensureSchema,
  migrateLegacyJsonIfNeeded,
  type MigrationReport,
} from './migrate';

/**
 * Count the `?` placeholders a statement expects.
 *
 * String literals are stripped first so a `?` inside a quoted prompt cannot be
 * miscounted. Named parameters (`:name`, `@name`, `$name`) are not used anywhere
 * in this codebase; if one appears the guard steps aside rather than guess.
 */
function expectedParameterCount(sql: string): number | null {
  const withoutLiterals = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
  if (/[@:$][A-Za-z_]/.test(withoutLiterals)) return null;
  return (withoutLiterals.match(/\?/g) || []).length;
}

/**
 * SQLite binds any unbound placeholder to NULL without complaining, so a
 * too-short parameter array is a silent data-loss bug (SQLite itself only
 * catches the too-long case). Make both directions loud.
 */
function assertParameterCount(sql: string, params: any[]): void {
  const expected = expectedParameterCount(sql);
  if (expected === null || expected === params.length) return;
  throw new Error(
    `SQL parameter count mismatch: statement expects ${expected} '?' placeholder(s) ` +
      `but ${params.length} value(s) were provided. SQL: ${sql.trim().replace(/\s+/g, ' ').slice(0, 160)}`,
  );
}

export class SqliteDatabase {
  readonly filePath: string;
  /** What the constructor's migration check decided (diagnostics + tests). */
  readonly migrationReport: MigrationReport;
  private db: DatabaseSync;

  constructor(filePath: string) {
    this.filePath = filePath;

    // One-time, idempotent conversion of the legacy JSON store. On a normal
    // (already-SQLite, empty, or absent) file this is a no-op.
    this.migrationReport = migrateLegacyJsonIfNeeded(filePath, {
      log: (message) => console.log(message),
    });

    this.db = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
    ensureSchema(this.db);
    // Applied per connection; the option above already does this, but an
    // explicit pragma documents the dependency and survives option changes.
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  /** Kept so `server.ts` can keep calling `db.serialize(...)`. */
  serialize(callback: () => void): void {
    callback();
  }

  run(
    sql: string,
    params: any[] = [],
    callback?: (this: any, err: Error | null) => void,
  ): { lastID: number; changes: number } {
    const context = { lastID: 0, changes: 0 };
    try {
      assertParameterCount(sql, params);
      const result = this.db.prepare(sql).run(...params);
      context.lastID = Number(result.lastInsertRowid);
      context.changes = Number(result.changes);
    } catch (err: any) {
      // With no callback the caller asked for the throw; do not swallow it.
      if (!callback) throw err;
      callback.call(context, err);
      return context;
    }
    if (callback) callback.call(context, null);
    return context;
  }

  get(sql: string, params: any[] = [], callback?: (err: Error | null, row: any) => void): any {
    try {
      assertParameterCount(sql, params);
      const row = this.db.prepare(sql).get(...params);
      // SQLite rows are null-prototype objects; normalise to plain objects and
      // match the legacy contract of `null` (not `undefined`) for "no row".
      const plain = row === undefined ? null : { ...row };
      if (callback) callback(null, plain);
      return plain;
    } catch (err: any) {
      if (!callback) throw err;
      callback(err, null);
      return null;
    }
  }

  all(sql: string, params: any[] = [], callback?: (err: Error | null, rows: any[]) => void): any[] {
    try {
      assertParameterCount(sql, params);
      const rows = this.db.prepare(sql).all(...params).map((row) => ({ ...row }));
      if (callback) callback(null, rows);
      return rows;
    } catch (err: any) {
      if (!callback) throw err;
      callback(err, []);
      return [];
    }
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Session page settings (M16, PRD §5.4 amended)
// ---------------------------------------------------------------------------

/**
 * The accepted page sizes and orientations, in their **canonical** casing.
 *
 * A country preset's page size is a default, not a constraint: the user's own
 * choice wins (§5.4). These two columns are the user's choice, and `NULL` means
 * "I have not chosen" — for size that is "follow the country preset"; for
 * orientation it is the portrait default.
 */
export const PAGE_SIZES = ['A4', 'Letter', 'Legal', 'A5'] as const;
export const PAGE_ORIENTATIONS = ['portrait', 'landscape'] as const;

/**
 * Normalise a user-supplied page size to its canonical value, or `NULL`.
 *
 * Advisory by design: this is a preference, not a validated enum that may
 * reject a request. Anything unrecognised — including `''`, a whitespace string
 * and any non-string — becomes `NULL`, which the renderer reads as "follow the
 * country preset". Matching is case-insensitive and surrounding whitespace is
 * ignored, so `'letter'` stores as `'Letter'`.
 */
export function normalizePageSize(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  if (!lower) return null;
  return PAGE_SIZES.find((size) => size.toLowerCase() === lower) ?? null;
}

/**
 * Normalise a user-supplied orientation to `'portrait'` / `'landscape'`, or
 * `NULL`. Same advisory rules as `normalizePageSize`: case-insensitive, trimmed,
 * never throws, and anything unrecognised is `NULL` (= portrait).
 */
export function normalizePageOrientation(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  if (!lower) return null;
  return PAGE_ORIENTATIONS.find((orientation) => orientation === lower) ?? null;
}

// ---------------------------------------------------------------------------
// Resume / cover-letter merge helpers
// ---------------------------------------------------------------------------

/**
 * Deep merge ResumeJSON.
 *
 * `basics`, `personal`, and `signature` are shallow-merged so a patch touching
 * one nested key cannot wipe its siblings. Array-valued sections are replaced
 * wholesale. A key absent from the patch is left untouched — absence stays
 * absence (PRD §8).
 */
export function mergeResume(existing: any, patch: any): any {
  const merged = { ...existing };
  if (patch.basics) {
    merged.basics = { ...(existing.basics || {}), ...patch.basics };
  }
  if (patch.personal) {
    merged.personal = { ...(existing.personal || {}), ...patch.personal };
  }
  if (patch.work) merged.work = patch.work;
  if (patch.education) merged.education = patch.education;
  if (patch.skills) merged.skills = patch.skills;
  if (patch.projects) merged.projects = patch.projects;
  if (patch.certifications) merged.certifications = patch.certifications;
  if (patch.languages) merged.languages = patch.languages;
  if (patch.signature) {
    merged.signature = { ...(existing.signature || {}), ...patch.signature };
  }
  return merged;
}

// Deep merge CoverLetterJSON
export function mergeCoverLetter(existing: any, patch: any): any {
  const merged = { ...existing };
  if (patch.recipient) {
    merged.recipient = { ...(existing.recipient || {}), ...patch.recipient };
  }
  if (patch.intro !== undefined) merged.intro = patch.intro;
  if (patch.body !== undefined) merged.body = patch.body;
  if (patch.closing !== undefined) merged.closing = patch.closing;
  if (patch.tone !== undefined) merged.tone = patch.tone;
  return merged;
}

// ---------------------------------------------------------------------------
// Cover letter plain text (M14)
// ---------------------------------------------------------------------------

/**
 * Sign-off openers, matched case-insensitively at the **start** of a line.
 *
 * The anchor is the whole point: a paragraph that merely *mentions* regards
 * ("...how my experience regards your roadmap...") must not be read as a
 * sign-off. Only a line that opens with one of these phrases counts.
 */
const SIGN_OFF_OPENER =
  /^(?:yours\s+(?:sincerely|faithfully)|sincerely|best\s+regards|kind\s+regards|warm\s+regards|regards|respectfully)\b/i;

/**
 * How many trailing non-empty lines are inspected. The rule is "the last couple
 * of lines"; three (rather than two) also covers a standard ending of
 * `Sincerely,` / name / job title, which a two-line window would miss.
 */
const SIGN_OFF_LOOKBACK_LINES = 3;

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** True when the text's tail already carries a sign-off line. */
function hasSignOff(text: string): boolean {
  if (!text) return false;
  return nonEmptyLines(text)
    .slice(-SIGN_OFF_LOOKBACK_LINES)
    .some((line) => SIGN_OFF_OPENER.test(line));
}

/**
 * Build the sign-off to append. Uses the resume's real name when we know it and
 * degrades to a bare `Sincerely,` otherwise — the literal `[Your Name]`
 * placeholder must never reach a user's exported letter (M14, Defect 1).
 */
function signOffBlock(fullName?: string | null): string {
  const name = typeof fullName === 'string' ? fullName.trim() : '';
  return name ? `Sincerely,\n\n${name}` : 'Sincerely,';
}

/**
 * Format a CoverLetterJSON as plain text.
 *
 * `fullName` is the **resume's** name (the sender), not
 * `cl.recipient.name` (the person being written to). It is optional so the
 * function stays callable from anywhere, but every call site should pass it.
 *
 * M14: a model-authored `closing` usually already ends with its own real
 * sign-off ("Sincerely,\nJane Doe"). The old code appended a second one
 * unconditionally, so the exported letter read "Sincerely, Jane Doe" followed
 * by a literal "[Your Name]". We now append only when the tail is unsigned.
 */
export function renderCoverLetterText(cl: any, fullName?: string | null): string {
  const recipientBlock = cl?.recipient
    ? [cl.recipient.name, cl.recipient.company, cl.recipient.role].filter(Boolean).join('\n')
    : '';

  const dateBlock = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const paragraphs = [recipientBlock, dateBlock, cl?.intro, cl?.body, cl?.closing].filter(Boolean);

  const assembled = paragraphs.join('\n\n');
  if (hasSignOff(assembled)) return assembled;

  const signOff = signOffBlock(fullName);
  return assembled ? `${assembled}\n\n${signOff}` : signOff;
}

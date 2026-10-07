/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * M11 Stage A — CRUD for **user-created / cloned** templates (PRD §5.5, §8).
 *
 * Built-in designs are static data in `src/templates/builtin.ts` and are NEVER
 * stored in the `templates` table (PRD §8). This router is the API surface the
 * new `#/templates` page talks to (PRD §5.5, Decision #23).
 *
 * The contract is frozen:
 *
 *   GET    /api/templates        -> 200 [{ id, name, origin, schema_json, created_at, updated_at }]
 *   POST   /api/templates        -> 201 row | 400 TEMPLATE_INVALID
 *   GET    /api/templates/:id    -> 200 row | 404 TEMPLATE_NOT_FOUND
 *   PUT    /api/templates/:id    -> 200 row | 400 | 404
 *   DELETE /api/templates/:id    -> 200 { ok: true } | 404
 *   POST   /api/templates/import -> 201 row | 400 TEMPLATE_INVALID
 *
 * Rules enforced here:
 *   - `validateTemplateSchema()` (src/templates/schema.ts) is the SINGLE
 *     validator. There is deliberately no second copy of the schema rules: a
 *     write is persisted only when that function accepts it (PRD §5.5 — an
 *     invalid template is rejected with a clear message, never rendered broken).
 *   - `id` is a server-owned uuid; `created_at`/`updated_at` are ISO strings.
 *   - `origin` on the row is `generated` | `cloned` (built-ins never reach this
 *     table).
 *   - Deleting an unknown id is a 404, never a silent 200.
 *
 * The router is a factory over the store so it can be unit-tested against a
 * temporary database without booting `server.ts` (which opens the real store).
 * `node:sqlite` is synchronous, so `db.run/get/all` are called directly.
 */

import express, { type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { validateTemplateSchema, type TemplateSchema } from '../src/templates/schema';
import { formatTemplateSchemaErrors } from './ai/schema';
import type { SqliteDatabase } from './store';

/** Row-level origins. `builtin` is intentionally absent — see PRD §8. */
export const TEMPLATE_ORIGINS = ['generated', 'cloned'] as const;
export type TemplateRowOrigin = (typeof TEMPLATE_ORIGINS)[number];

type SchemaValidation = ReturnType<typeof validateTemplateSchema>;

/**
 * Narrow a `validateTemplateSchema` result explicitly.
 *
 * This project compiles with `strictNullChecks: false` (see `tsconfig.json`),
 * and under that setting TypeScript does NOT narrow a discriminated union on a
 * boolean discriminant — `if (!result.ok) result.errors` is a type error even
 * though it is obviously correct. A user-defined type guard works in both
 * directions and both compiler settings, so it is used instead of a cast at
 * every call site.
 */
export function isValidTemplateSchemaResult(
  result: SchemaValidation,
): result is { ok: true; schema: TemplateSchema } {
  return result.ok === true;
}

/**
 * The schema validator's error list, or `[]` when the document is valid.
 * Exposed for tests so they can assert the endpoint uses the SAME validator
 * without repeating the narrowing dance.
 */
export function templateSchemaErrors(value: unknown): string[] {
  const result = validateTemplateSchema(value);
  return isValidTemplateSchemaResult(result) ? [] : result.errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** The one invalid-write response shape: `{ error, code, errors }` at 400. */
function sendInvalidTemplate(res: Response, errors: string[], error?: string): Response {
  const message =
    error ?? (errors.length === 1 ? errors[0] : `Template is invalid (${errors.length} errors)`);
  return res.status(400).json({ error: message, code: 'TEMPLATE_INVALID', errors });
}

function sendNotFound(res: Response): Response {
  return res.status(404).json({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
}

interface CreateInput {
  name: string;
  origin: TemplateRowOrigin;
  schema: TemplateSchema;
}

/**
 * Validate a `POST /api/templates` body.
 *
 * Order matters: the cheap structural checks (name/origin/schema present) run
 * first, then — and only then — `validateTemplateSchema`. A missing `schema`
 * therefore produces a message about the request, not a wall of
 * `id/name/version/... must be...` noise about `undefined`.
 *
 * The result is deliberately NOT a discriminated union: this project's
 * `strictNullChecks: false` tsconfig does not narrow `if (!parsed.ok)`. A
 * nullable `value` plus an always-present `errors` array avoids the trap.
 */
interface CreateParseResult {
  value: CreateInput | null;
  errors: string[];
}

function parseCreateInput(body: unknown): CreateParseResult {
  const errors: string[] = [];
  const record = isRecord(body) ? body : {};

  const name = isNonEmptyString(record.name) ? record.name : '';
  if (name === '') errors.push('name: must be a non-empty string');

  const rawOrigin = record.origin;
  if (rawOrigin !== undefined && !TEMPLATE_ORIGINS.includes(rawOrigin as TemplateRowOrigin)) {
    errors.push(`origin: must be one of ${TEMPLATE_ORIGINS.join(' | ')}`);
  }

  if (record.schema === undefined) {
    errors.push('schema: is required');
  } else if (!isRecord(record.schema)) {
    errors.push('schema: must be an object');
  }

  if (errors.length > 0) return { value: null, errors };

  const result = validateTemplateSchema(record.schema);
  if (!isValidTemplateSchemaResult(result)) return { value: null, errors: result.errors };

  // Absent `origin` falls back to the schema's own origin when that is a row
  // origin; a `builtin` schema (an unedited clone of a built-in) is recorded as
  // `generated` because it was not created by the app's generator.
  const origin: TemplateRowOrigin =
    rawOrigin !== undefined
      ? (rawOrigin as TemplateRowOrigin)
      : result.schema.origin === 'cloned'
        ? 'cloned'
        : 'generated';

  return { value: { name, origin, schema: result.schema }, errors: [] };
}

/** Insert a validated template and return the persisted row. */
function insertTemplate(db: SqliteDatabase, input: CreateInput): any {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO templates (id, name, origin, schema_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.name, input.origin, JSON.stringify(input.schema), now, now],
  );
  return db.get('SELECT * FROM templates WHERE id = ?', [id]);
}

/**
 * M11 Stage B — the persistence half of the `create_template` chat tool
 * (PRD §5.5(a), §9).
 *
 * `validateTemplateSchema` is the gate: an invalid document is returned as
 * `{ ok:false, error }` carrying the validator's own messages, and **nothing is
 * written** — "invalid output is repaired or rejected with a clear message,
 * never rendered broken" (PRD §5.5). A valid document is stored exactly once
 * with `origin: 'generated'`.
 *
 * The stored origin is normalised to `generated` both on the row and inside
 * `schema_json`. Built-ins are static data and are never in this table (PRD §8),
 * so a chat-created row must not be able to claim `builtin` even if the model
 * emitted that value. The mistake is otherwise invisible in the gallery.
 *
 * Kept free of Express so the chat tool and the tests share one insertion path.
 */
export function createGeneratedTemplate(
  db: SqliteDatabase,
  value: unknown,
): { ok: boolean; template_id?: string; error?: string } {
  const result = validateTemplateSchema(value);
  if (!isValidTemplateSchemaResult(result)) {
    return { ok: false, error: formatTemplateSchemaErrors(result.errors) };
  }

  const schema: TemplateSchema = { ...result.schema, origin: 'generated' };
  const row = insertTemplate(db, { name: schema.name, origin: 'generated', schema });
  return { ok: true, template_id: row.id };
}

/**
 * Build the `/api/templates` router. Mount with
 * `app.use('/api/templates', createTemplateRouter(db))`.
 */
export function createTemplateRouter(db: SqliteDatabase) {
  const router = express.Router();

  // GET /api/templates — newest first. `rowid` is the tie-breaker so two rows
  // written in the same millisecond still list in a stable order.
  router.get('/', (_req, res) => {
    try {
      const rows = db.all('SELECT * FROM templates ORDER BY updated_at DESC, rowid DESC');
      res.json(rows);
    } catch (error: any) {
      console.error('Failed to list templates:', error);
      res.status(500).json({ error: error?.message || 'Failed to list templates' });
    }
  });

  // POST /api/templates/import — registered before the `/` handlers so the
  // literal path is unambiguous. Accepts `{ json: string }` where the string is
  // either a raw TemplateSchema or an envelope `{ name, schema }` (PRD §5.5).
  router.post('/import', (req, res) => {
    try {
      const body = isRecord(req.body) ? req.body : {};
      const json = body.json;

      if (!isNonEmptyString(json)) {
        return sendInvalidTemplate(
          res,
          ['json: must be a non-empty string'],
          'json must be a non-empty string',
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (err: any) {
        const message = `Invalid JSON: ${err?.message || 'could not be parsed'}`;
        return sendInvalidTemplate(res, [message], message);
      }

      // Envelope detection: a wrapped payload carries `schema`; anything else is
      // treated as the raw TemplateSchema.
      let rawSchema: unknown = parsed;
      let envelopeName: unknown;
      if (isRecord(parsed) && parsed.schema !== undefined) {
        rawSchema = parsed.schema;
        envelopeName = parsed.name;
      }

      if (!isRecord(rawSchema)) {
        return sendInvalidTemplate(res, ['schema: must be an object']);
      }

      if (!isNonEmptyString(envelopeName) && !isNonEmptyString(rawSchema.name)) {
        return sendInvalidTemplate(res, [
          'name: provide { name, schema } or a schema whose name is a non-empty string',
        ]);
      }

      const result = validateTemplateSchema(rawSchema);
      if (!isValidTemplateSchemaResult(result)) return sendInvalidTemplate(res, result.errors);

      // A `builtin` origin in an imported file means the file is a copy of a
      // built-in; built-ins live in static data, so the copy is stored as
      // `cloned` (PRD §8).
      const origin: TemplateRowOrigin =
        result.schema.origin === 'generated' ? 'generated' : 'cloned';
      const name = isNonEmptyString(envelopeName) ? envelopeName : result.schema.name;

      const row = insertTemplate(db, { name, origin, schema: result.schema });
      res.status(201).json(row);
    } catch (error: any) {
      console.error('Failed to import template:', error);
      res.status(500).json({ error: error?.message || 'Failed to import template' });
    }
  });

  // POST /api/templates — create a template.
  router.post('/', (req, res) => {
    try {
      const parsed = parseCreateInput(req.body);
      if (!parsed.value) return sendInvalidTemplate(res, parsed.errors);
      const row = insertTemplate(db, parsed.value);
      res.status(201).json(row);
    } catch (error: any) {
      console.error('Failed to create template:', error);
      res.status(500).json({ error: error?.message || 'Failed to create template' });
    }
  });

  // GET /api/templates/:id — this is also the "export" path; the client
  // serialises `schema_json` to a file itself. No separate export endpoint.
  router.get('/:id', (req, res) => {
    try {
      const row = db.get('SELECT * FROM templates WHERE id = ?', [req.params.id]);
      if (!row) return sendNotFound(res);
      res.json(row);
    } catch (error: any) {
      console.error('Failed to load template:', error);
      res.status(500).json({ error: error?.message || 'Failed to load template' });
    }
  });

  // PUT /api/templates/:id — partial update of `name` and/or `schema`. A write
  // only happens after every provided field validates, so a rejected update
  // cannot leave the row half-modified.
  router.put('/:id', (req, res) => {
    try {
      const { id } = req.params;
      const existing = db.get('SELECT * FROM templates WHERE id = ?', [id]);
      if (!existing) return sendNotFound(res);

      const body = isRecord(req.body) ? req.body : {};
      const errors: string[] = [];

      let name = existing.name;
      if (body.name !== undefined) {
        if (!isNonEmptyString(body.name)) errors.push('name: must be a non-empty string');
        else name = body.name;
      }

      let schemaJson = existing.schema_json;
      if (body.schema !== undefined) {
        if (!isRecord(body.schema)) {
          errors.push('schema: must be an object');
        } else {
          const result = validateTemplateSchema(body.schema);
          if (!isValidTemplateSchemaResult(result)) errors.push(...result.errors);
          else schemaJson = JSON.stringify(result.schema);
        }
      }

      if (errors.length > 0) return sendInvalidTemplate(res, errors);

      db.run('UPDATE templates SET name = ?, schema_json = ?, updated_at = ? WHERE id = ?', [
        name,
        schemaJson,
        new Date().toISOString(),
        id,
      ]);
      res.json(db.get('SELECT * FROM templates WHERE id = ?', [id]));
    } catch (error: any) {
      console.error('Failed to update template:', error);
      res.status(500).json({ error: error?.message || 'Failed to update template' });
    }
  });

  // DELETE /api/templates/:id — 404 for an unknown id, never a silent 200.
  router.delete('/:id', (req, res) => {
    try {
      const result = db.run('DELETE FROM templates WHERE id = ?', [req.params.id]);
      if (!result.changes) return sendNotFound(res);
      res.json({ ok: true });
    } catch (error: any) {
      console.error('Failed to delete template:', error);
      res.status(500).json({ error: error?.message || 'Failed to delete template' });
    }
  });

  return router;
}

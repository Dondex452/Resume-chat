/**
 * M11 Stage A â€” HTTP tests for the custom-template CRUD API (PRD Â§5.5, Â§8).
 *
 * These tests drive the REAL router (`server/templateRoutes.ts`) over a REAL
 * ephemeral HTTP server backed by a REAL temporary SQLite database â€” no mocks
 * (GOTCHA #20) and no import of `server.ts` (which would boot the app and open
 * the real `database.sqlite`, per the note in `store.test.ts`).
 *
 * What they pin down:
 *   - the frozen response shapes and status codes;
 *   - that `validateTemplateSchema` is the ONLY validator â€” a rejected write
 *     matches its `errors` exactly and persists nothing;
 *   - that `GET /api/templates`/`/:id`, update, delete and import all behave,
 *     including the 404s (never a silent 200).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { SqliteDatabase } from '../../store';
import { createTemplateRouter, templateSchemaErrors } from '../../templateRoutes';
import { getBuiltinTemplateSchema } from '../../../src/templates/builtin';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Api {
  baseUrl: string;
  db: SqliteDatabase;
  close: () => Promise<void>;
}

/**
 * Boot one router on an ephemeral port over a fresh temporary database. The
 * caller must `await close()` â€” it closes the HTTP server (and its sockets),
 * closes the database handle (Windows locks the file otherwise) and removes the
 * temp directory.
 */
async function startApi(): Promise<Api> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm11-templates-'));
  const db = new SqliteDatabase(path.join(dir, 'database.sqlite'));

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/templates', createTemplateRouter(db));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    db,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function request(
  api: Api,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(api.baseUrl + urlPath, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* leave the raw text */
  }
  return { status: response.status, body: parsed };
}

/** A valid schema for tests: a real built-in, so the fixture cannot drift. */
function validSchema(): any {
  return JSON.parse(JSON.stringify(getBuiltinTemplateSchema('minimal')));
}

const ROW_KEYS = ['created_at', 'id', 'name', 'origin', 'schema_json', 'updated_at'];

// ---------------------------------------------------------------------------
// List + create
// ---------------------------------------------------------------------------

test('templates API: an empty table lists as []', async () => {
  const api = await startApi();
  try {
    const res = await request(api, 'GET', '/api/templates');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  } finally {
    await api.close();
  }
});

test('templates API: POST creates a row, 201, and persists the schema unchanged', async () => {
  const api = await startApi();
  try {
    const schema = validSchema();
    const res = await request(api, 'POST', '/api/templates', {
      name: 'My Minimal',
      origin: 'cloned',
      schema,
    });

    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body).sort(), ROW_KEYS, 'row shape is frozen');
    assert.match(res.body.id, /^[0-9a-f-]{36}$/i, 'id must be a uuid');
    assert.equal(res.body.name, 'My Minimal');
    assert.equal(res.body.origin, 'cloned');
    assert.ok(!Number.isNaN(Date.parse(res.body.created_at)), 'created_at must be ISO');
    assert.ok(!Number.isNaN(Date.parse(res.body.updated_at)), 'updated_at must be ISO');
    // The stored document is exactly what was submitted (no hidden stamping).
    assert.deepEqual(JSON.parse(res.body.schema_json), schema);

    const fetched = await request(api, 'GET', `/api/templates/${res.body.id}`);
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.body, res.body);
  } finally {
    await api.close();
  }
});

test('templates API: POST defaults origin to generated when absent', async () => {
  const api = await startApi();
  try {
    const res = await request(api, 'POST', '/api/templates', {
      name: 'Generated One',
      schema: validSchema(),
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.origin, 'generated');
  } finally {
    await api.close();
  }
});

test('templates API: POST rejects a malformed schema with TEMPLATE_INVALID and persists nothing', async () => {
  const api = await startApi();
  try {
    const malformed = {};
    const res = await request(api, 'POST', '/api/templates', {
      name: 'Broken',
      schema: malformed,
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'TEMPLATE_INVALID');
    assert.ok(Array.isArray(res.body.errors) && res.body.errors.length > 0);
    // Proves the endpoint uses the SAME validator â€” not a second, weaker copy.
    assert.deepEqual(res.body.errors, templateSchemaErrors(malformed));

    const list = await request(api, 'GET', '/api/templates');
    assert.deepEqual(list.body, [], 'a rejected template must never be persisted');
  } finally {
    await api.close();
  }
});

test('templates API: POST rejects an unknown origin and a missing name', async () => {
  const api = await startApi();
  try {
    const badOrigin = await request(api, 'POST', '/api/templates', {
      name: 'X',
      origin: 'builtin',
      schema: validSchema(),
    });
    assert.equal(badOrigin.status, 400);
    assert.equal(badOrigin.body.code, 'TEMPLATE_INVALID');
    assert.ok(badOrigin.body.errors.some((e: string) => e.startsWith('origin:')));

    const noName = await request(api, 'POST', '/api/templates', { schema: validSchema() });
    assert.equal(noName.status, 400);
    assert.ok(noName.body.errors.some((e: string) => e.startsWith('name:')));

    const noSchema = await request(api, 'POST', '/api/templates', { name: 'X' });
    assert.equal(noSchema.status, 400);
    assert.ok(noSchema.body.errors.some((e: string) => e.startsWith('schema:')));

    assert.deepEqual((await request(api, 'GET', '/api/templates')).body, []);
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// Get / update / delete
// ---------------------------------------------------------------------------

test('templates API: GET of an unknown id is 404 TEMPLATE_NOT_FOUND', async () => {
  const api = await startApi();
  try {
    const res = await request(api, 'GET', '/api/templates/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'TEMPLATE_NOT_FOUND');
    assert.equal(typeof res.body.error, 'string');
  } finally {
    await api.close();
  }
});

test('templates API: PUT updates name and schema; an invalid schema writes nothing', async () => {
  const api = await startApi();
  try {
    const created = await request(api, 'POST', '/api/templates', {
      name: 'Before',
      origin: 'generated',
      schema: validSchema(),
    });
    const { id } = created.body;

    // Name only.
    const renamed = await request(api, 'PUT', `/api/templates/${id}`, { name: 'After' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'After');
    assert.deepEqual(JSON.parse(renamed.body.schema_json), validSchema());

    // Name + a genuinely modified (still valid) schema.
    const newSchema = { ...validSchema(), name: 'Renamed Document', version: 2 };
    const updated = await request(api, 'PUT', `/api/templates/${id}`, {
      name: 'After Two',
      schema: newSchema,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'After Two');
    assert.equal(JSON.parse(updated.body.schema_json).version, 2);

    // Invalid schema â€” rejected, and the stored row is untouched.
    const invalid = await request(api, 'PUT', `/api/templates/${id}`, { schema: {} });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'TEMPLATE_INVALID');
    assert.deepEqual(invalid.body.errors, templateSchemaErrors({}));

    const after = await request(api, 'GET', `/api/templates/${id}`);
    assert.equal(after.body.name, 'After Two');
    assert.equal(JSON.parse(after.body.schema_json).version, 2);

    const unknown = await request(api, 'PUT', '/api/templates/nope', { name: 'x' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'TEMPLATE_NOT_FOUND');
  } finally {
    await api.close();
  }
});

test('templates API: DELETE removes the row; a repeat delete and a get are 404', async () => {
  const api = await startApi();
  try {
    const created = await request(api, 'POST', '/api/templates', {
      name: 'Doomed',
      schema: validSchema(),
    });
    const { id } = created.body;

    const deleted = await request(api, 'DELETE', `/api/templates/${id}`);
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body, { ok: true });

    const again = await request(api, 'DELETE', `/api/templates/${id}`);
    assert.equal(again.status, 404);
    assert.equal(again.body.code, 'TEMPLATE_NOT_FOUND');

    const fetched = await request(api, 'GET', `/api/templates/${id}`);
    assert.equal(fetched.status, 404);
    assert.deepEqual((await request(api, 'GET', '/api/templates')).body, []);
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

test('templates API: import accepts a raw TemplateSchema', async () => {
  const api = await startApi();
  try {
    // A generated document keeps its origin.
    const generated = { ...validSchema(), origin: 'generated' };
    const res = await request(api, 'POST', '/api/templates/import', {
      json: JSON.stringify(generated),
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, generated.name, 'name falls back to schema.name');
    assert.equal(res.body.origin, 'generated');
    assert.deepEqual(JSON.parse(res.body.schema_json), generated);

    // A builtin document is a copy of a built-in, so it is recorded as cloned.
    const builtin = validSchema();
    const builtinRes = await request(api, 'POST', '/api/templates/import', {
      json: JSON.stringify(builtin),
    });
    assert.equal(builtinRes.status, 201);
    assert.equal(builtinRes.body.name, builtin.name);
    assert.equal(builtinRes.body.origin, 'cloned');
    assert.notEqual(builtinRes.body.id, res.body.id, 'each import is a new row');
  } finally {
    await api.close();
  }
});

test('templates API: import accepts an envelope { name, schema }', async () => {
  const api = await startApi();
  try {
    const schema = validSchema();
    const res = await request(api, 'POST', '/api/templates/import', {
      json: JSON.stringify({ name: 'Imported Navy', schema }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Imported Navy');
    assert.deepEqual(JSON.parse(res.body.schema_json), schema);

    // A builtin-origin file is a copy, so the row is recorded as cloned.
    const builtinCopy = await request(api, 'POST', '/api/templates/import', {
      json: JSON.stringify({ name: 'Builtin Copy', schema: { ...schema, origin: 'builtin' } }),
    });
    assert.equal(builtinCopy.status, 201);
    assert.equal(builtinCopy.body.origin, 'cloned');
  } finally {
    await api.close();
  }
});

test('templates API: import rejects bad JSON and an invalid schema', async () => {
  const api = await startApi();
  try {
    const badJson = await request(api, 'POST', '/api/templates/import', {
      json: '{ this is not json',
    });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.code, 'TEMPLATE_INVALID');
    assert.ok(Array.isArray(badJson.body.errors) && badJson.body.errors.length > 0);
    assert.match(badJson.body.error, /invalid json/i, 'the parse failure must be readable');

    const brokenSchema = { id: '', name: 'Broken', version: 1 };
    const invalid = await request(api, 'POST', '/api/templates/import', {
      json: JSON.stringify(brokenSchema),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'TEMPLATE_INVALID');
    assert.deepEqual(invalid.body.errors, templateSchemaErrors(brokenSchema));

    const missingJson = await request(api, 'POST', '/api/templates/import', {});
    assert.equal(missingJson.status, 400);
    assert.equal(missingJson.body.code, 'TEMPLATE_INVALID');

    assert.deepEqual((await request(api, 'GET', '/api/templates')).body, []);
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test('templates API: the list is newest-first by updated_at', async () => {
  const api = await startApi();
  try {
    const first = await request(api, 'POST', '/api/templates', {
      name: 'First',
      schema: validSchema(),
    });
    const second = await request(api, 'POST', '/api/templates', {
      name: 'Second',
      schema: validSchema(),
    });

    // Two creates can share a millisecond; make the ordering deterministic.
    await api.db.run('UPDATE templates SET updated_at = ? WHERE id = ?', [
      '2099-01-01T00:00:00.000Z',
      first.body.id,
    ]);

    const list = await request(api, 'GET', '/api/templates');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 2);
    assert.equal(list.body[0].id, first.body.id, 'the most recently updated row lists first');
    assert.equal(list.body[1].id, second.body.id);
    for (const row of list.body) {
      assert.deepEqual(Object.keys(row).sort(), ROW_KEYS);
    }
  } finally {
    await api.close();
  }
});

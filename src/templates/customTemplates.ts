/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * M14 — resolving a session's `template_id` against BOTH the built-in registry
 * and the user's own stored templates (PRD §5.5: "Custom templates persist
 * locally and are **selectable in any session**").
 *
 * Before this module the studio resolved the active template with
 * `getBuiltinTemplateSchema()` alone, so a template created on `#/templates`
 * could never be selected in a session — and the `#/templates` page's own copy
 * ("available in every session") was false. The preview paper and the PDF/DOCX
 * export both read the one `activeResumeSchema` value, so a custom id has to
 * resolve there together or the two paths drift (PRD §11).
 *
 * The module is pure and dependency-free apart from the schema validator:
 *   - `parseStoredTemplates` turns the frozen `GET /api/templates` body into
 *     selectable templates. An unreadable or invalid row is dropped, never
 *     handed to the renderer (PRD §5.5 "never rendered broken").
 *   - `resolveTemplateSchema` is the single lookup the studio uses. An id that
 *     matches neither registry falls back to `minimal`, preserving the property
 *     `getBuiltinTemplateSchema` already had: a stale stored `template_id` (a
 *     deleted custom template, or a hand-edited row) degrades to a real sheet
 *     instead of a blank one.
 */

import { BUILTIN_TEMPLATE_SCHEMAS } from './builtin';
import { applyCountryPreset, getCountryPreset } from './countries';
import { validateTemplateSchema, type TemplateSchema } from './schema';

/**
 * M16 (PRD §5.4 amended, 2026-09-21) — "the user owns the page".
 *
 * A **page format** is the paper the document is authored and printed on. It is
 * deliberately broader than `schema.PageSize` (`'A4' | 'Letter'`), which is the
 * schema's own two-value enum and is owned by `schema.ts` (a built-in design's
 * default, and the only two values a country preset ever asks for). The user's
 * own choice may be Legal or A5, so it needs its own type.
 *
 * The **server is the write-time authority** (`server/store.ts` normalises
 * these on every POST/PUT and stores `NULL` for anything unrecognised). The
 * helpers and lists below are the read-side guard — the same relationship
 * `parseStoredTemplates` has with the templates API (GOTCHA #15: shape-check
 * what the API actually returned, never trust it).
 */
export type PaperFormat = 'A4' | 'Letter' | 'Legal' | 'A5';

/** PRD §5.4 amended — `portrait` is the default; `landscape` is the other option. */
export type PageOrientation = 'portrait' | 'landscape';

/** Every page format a user may choose, in the order the Page tool lists them. */
export const PAGE_FORMATS: readonly PaperFormat[] = ['A4', 'Letter', 'Legal', 'A5'];

/** Both orientations, in the order the Page tool lists them. */
export const PAGE_ORIENTATIONS: readonly PageOrientation[] = ['portrait', 'landscape'];

/** Case/whitespace-tolerant read of a stored `page_size`; `null` = follow the preset. */
export function normalizePageFormat(value: unknown): PaperFormat | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  if (!lower) return null;
  return PAGE_FORMATS.find((format) => format.toLowerCase() === lower) ?? null;
}

/** Case/whitespace-tolerant read of a stored `page_orientation`; `null` = portrait. */
export function normalizePageOrientation(value: unknown): PageOrientation | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  if (!lower) return null;
  return PAGE_ORIENTATIONS.find((orientation) => orientation === lower) ?? null;
}

/**
 * The page preferences a session may carry (PRD §5.4 amended, M16).
 *
 * `null` / absent for the size means **"follow the country preset"** — today's
 * behaviour, unchanged. `null` / absent for the orientation means `portrait`.
 * A `Session` satisfies this structurally, so callers may pass the session.
 */
export interface SessionPagePreference {
  page_size?: string | null;
  page_orientation?: string | null;
}

/** A row as returned by `GET /api/templates` (frozen contract, PRD §8). */
export interface StoredTemplateRow {
  id: string;
  name: string;
  origin: 'generated' | 'cloned';
  /** Serialised `TemplateSchema`. */
  schema_json: string;
  created_at?: string;
  updated_at?: string;
}

/** A stored template with its schema parsed and validated — ready to select. */
export interface SelectableTemplate {
  id: string;
  name: string;
  origin: 'generated' | 'cloned';
  schema: TemplateSchema;
}

/**
 * Parse the `GET /api/templates` body into selectable templates.
 *
 * Shape-first (GOTCHA #15 — Vite's SPA fallback answers an unmatched `/api/*`
 * path with `index.html` at HTTP 200) and defensive per row: the server is the
 * write-time authority, this is the read-time guard.
 */
export function parseStoredTemplates(value: unknown): SelectableTemplate[] {
  if (!Array.isArray(value)) return [];

  const templates: SelectableTemplate[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const { id, name, origin, schema_json } = row;

    if (typeof id !== 'string' || id.length === 0) continue;
    if (typeof schema_json !== 'string' || schema_json.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(schema_json);
    } catch {
      continue;
    }

    // A ternary, not `if (!validated.ok)`: this project compiles with
    // `strictNullChecks: false`, under which a boolean-discriminated union does
    // not narrow on a guard clause (GOTCHA #52).
    const validated = validateTemplateSchema(parsed);
    const schema = validated.ok ? validated.schema : null;
    if (!schema) continue;

    templates.push({
      id,
      name: typeof name === 'string' && name.trim().length > 0 ? name : schema.name,
      origin: origin === 'cloned' ? 'cloned' : 'generated',
      schema,
    });
  }
  return templates;
}

/**
 * Resolve a stored `template_id` to a `TemplateSchema`.
 *
 * Order: built-in registry first (a built-in id is never a uuid), then the
 * user's stored templates, then `minimal`. Keeping the built-in lookup ahead of
 * the custom one means the ten shipped designs can never be shadowed, and the
 * `minimal` fallback keeps the "unknown id still renders a real sheet" property.
 */
export function resolveTemplateSchema(
  templateId: string,
  customById: Record<string, TemplateSchema>,
): TemplateSchema {
  const builtin = BUILTIN_TEMPLATE_SCHEMAS[templateId];
  if (builtin) return builtin;

  const custom = customById[templateId];
  if (custom) return custom;

  return BUILTIN_TEMPLATE_SCHEMAS.minimal;
}

/** The whole effective render for a session: template + country + the user's page. */
export interface ResolvedSessionRender {
  /**
   * Built-in → custom → `minimal`, with the country preset folded on.
   *
   * `schema.page.size` is the **design/preset default**, not the user's choice:
   * `PageSize` cannot express Legal or A5. Read the effective format from
   * `pageSize` below, never from here.
   */
  schema: TemplateSchema;
  /** The effective page format after the user's own choice is applied last. */
  pageSize: PaperFormat;
  /** The effective orientation; `portrait` unless the user chose otherwise. */
  orientation: PageOrientation;
}

/**
 * M15/M16 — the complete "what does this session render as" resolution, in ONE
 * place.
 *
 * The on-screen preview, the print view (PRD §11, `#/print`) and the raster
 * export fallback must all resolve the exact same template + country + page, or
 * preview and export drift — the one thing §11 forbids by construction. They all
 * call this function rather than repeating the steps, so a change to the
 * pipeline reaches every path at once. **Do not add a second resolution path.**
 *
 * Precedence, lowest to highest (PRD §5.4 amended — "the user owns the page"):
 *
 *   1. **the design's own default** — already baked into `schema.page.size`;
 *   2. **the country preset** — folded on by `applyCountryPreset` (page size,
 *      enabled sections, order, localised labels);
 *   3. **the user's own choice** — applied last, so it always wins.
 *
 * A preset's page size is a **default, not a constraint**: a user who picks A5
 * for a US application gets the §5.4 notice, never a blocked export.
 *
 * With no preset `applyCountryPreset` returns the input untouched, so the
 * no-country render is byte-identical to pre-M10 output, and with no user
 * preference the effective format is the preset's own (`A4` or `Letter`) and the
 * orientation is `portrait` — also byte-identical to pre-M16 output.
 */
export function resolveSessionRenderSchema(
  templateId: string | null | undefined,
  countryCode: string | null | undefined,
  customById: Record<string, TemplateSchema>,
  page?: SessionPagePreference | null,
): ResolvedSessionRender {
  const base = resolveTemplateSchema(templateId ?? '', customById);
  const preset = getCountryPreset(countryCode);
  const schema = preset ? applyCountryPreset(base, preset) : base;

  // Layer three: the user's choice, last so it wins over the preset.
  const pageSize = normalizePageFormat(page?.page_size) ?? schema.page.size;
  const orientation = normalizePageOrientation(page?.page_orientation) ?? 'portrait';

  return { schema, pageSize, orientation };
}

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * M12 Stage A — pure section-structure operations for the visual template editor
 * (PRD §5.5(b), §10, §17).
 *
 * The editor is constrained to the schema's own vocabulary: it can reorder a
 * section within its column, move it to another column, and toggle `enabled`.
 * Every one of those is a field on `SectionSpec` (`order`, `column`, `enabled`),
 * so the whole feature is a set of pure array transforms over `TemplateSchema`
 * data — no renderer change, no new schema field, no per-template branch.
 *
 * ## The invariant: contiguous `order` per column
 *
 * The generic renderer groups sections by `column` and then sorts each group by
 * `order` (`src/templates/render.tsx`). The shipped built-ins use *globally*
 * unique order values, so a single column reads e.g. `[0, 4, 7]` — correct for
 * rendering, but it gives a later operation (a country preset's `sections.order`
 * overrides) no structure to reason about.
 *
 * Every move therefore runs {@link normalizeSectionOrders}, which renumbers each
 * column `0..n-1` in its current visual order. Relative order is preserved, so
 * the render is unchanged, but `order` becomes a contiguous run per column —
 * exactly the invariant the editor must maintain (and the one `applyCountryPreset`
 * expects when it folds its own overrides on top).
 *
 * ## Why the array order does not matter
 *
 * The renderer never consumes `schema.sections` in raw array order: it filters
 * by column and sorts by `order` first. Rebuilding the array grouped by column
 * is therefore safe and makes the structure easier to read.
 */

import type {
  SectionColumn,
  SectionKey,
  SectionSpec,
  TemplateLayout,
} from '../../templates/schema';

/**
 * The display order of the columns, top-to-bottom as the sheet is laid out:
 * the header region, then full-width lead sections, then the body split.
 */
export const COLUMN_ORDER: SectionColumn[] = ['header', 'full', 'main', 'sidebar'];

/** Human labels for the editor's column groups. */
export const COLUMN_LABELS: Record<SectionColumn, string> = {
  header: 'Header band',
  full: 'Full width',
  main: 'Main column',
  sidebar: 'Sidebar',
};

/**
 * A readable name per section key. Used only when the section's own `label` is
 * empty (e.g. `basics` and `signature`, which carry no heading on the sheet).
 */
export const SECTION_DISPLAY_NAMES: Record<SectionKey, string> = {
  basics: 'Name and contacts',
  personal: 'Personal details',
  summary: 'Summary',
  work: 'Work experience',
  education: 'Education',
  skills: 'Skills',
  projects: 'Projects',
  certifications: 'Certifications',
  languages: 'Languages',
  signature: 'Signature',
};

/** The name shown for a section row: its own label, else the readable default. */
export function sectionDisplayName(section: SectionSpec): string {
  const label = section.label.trim();
  return label || SECTION_DISPLAY_NAMES[section.key] || section.key;
}

/** Only these keys are rendered by the header region (`render.tsx`). */
const HEADER_KEYS: SectionKey[] = ['basics', 'summary'];

/**
 * Which columns a section may be moved to, for a given template layout.
 *
 * This is not cosmetic — it states what the renderer can actually draw:
 *   - A `sidebar` layout never renders the `header` region or the `full` lead
 *     (see `SchemaResumeRenderer`), so those columns are not offered.
 *   - The header region maps only `basics` and `summary`; another key dropped
 *     there would silently vanish from the sheet, which is the "never rendered
 *     broken" rule (PRD §5.5) applied to a control that could break it.
 */
export function allowedColumns(layout: TemplateLayout, key: SectionKey): SectionColumn[] {
  if (layout === 'sidebar') return ['main', 'sidebar'];
  return HEADER_KEYS.includes(key)
    ? ['header', 'full', 'main', 'sidebar']
    : ['full', 'main', 'sidebar'];
}

/** A column's sections in visual order (by `order`, then array position). */
export function orderedSections(
  sections: SectionSpec[],
  column: SectionColumn
): SectionSpec[] {
  return sections
    .map((section, index) => ({ section, index }))
    .filter((entry) => entry.section.column === column)
    .sort(
      (a, b) => a.section.order - b.section.order || a.index - b.index
    )
    .map((entry) => entry.section);
}

/**
 * Renumber every column `0..n-1` in its current visual order, preserving the
 * relative sequence. Returns the sections rebuilt grouped by {@link COLUMN_ORDER}.
 */
export function normalizeSectionOrders(sections: SectionSpec[]): SectionSpec[] {
  const indexed = sections.map((section, index) => ({ section, index }));
  const rebuilt: SectionSpec[] = [];

  for (const column of COLUMN_ORDER) {
    const members = indexed
      .filter((entry) => entry.section.column === column)
      .sort((a, b) => a.section.order - b.section.order || a.index - b.index);
    members.forEach((entry, order) => {
      rebuilt.push(entry.section.order === order ? entry.section : { ...entry.section, order });
    });
  }

  // Defensive: an unknown column value is kept rather than dropped. The schema
  // validator forbids it, but losing a section would be far worse than showing
  // an unstyled one.
  for (const entry of indexed) {
    if (!COLUMN_ORDER.includes(entry.section.column)) rebuilt.push(entry.section);
  }

  return rebuilt;
}

/**
 * Move `key` into `targetColumn` at `targetIndex`, where the index is counted in
 * the destination column **excluding the moved section**. Both the source and
 * the destination column are renumbered, so the result always satisfies the
 * contiguous-order invariant.
 *
 * An out-of-range index is clamped, so callers may pass
 * `Number.MAX_SAFE_INTEGER` to mean "append to the end".
 */
export function reorderSection(
  sections: SectionSpec[],
  key: SectionKey,
  targetColumn: SectionColumn,
  targetIndex: number
): SectionSpec[] {
  const moved = sections.find((section) => section.key === key);
  if (!moved) return sections;

  const columnMembers = (column: SectionColumn): SectionSpec[] =>
    sections
      .map((section, index) => ({ section, index }))
      .filter((entry) => entry.section.column === column && entry.section.key !== key)
      .sort((a, b) => a.section.order - b.section.order || a.index - b.index)
      .map((entry) => entry.section);

  const destination = columnMembers(targetColumn);
  const clamped = Math.max(0, Math.min(targetIndex, destination.length));
  destination.splice(clamped, 0, { ...moved, column: targetColumn });

  const rebuilt: SectionSpec[] = [];
  for (const column of COLUMN_ORDER) {
    const members = column === targetColumn ? destination : columnMembers(column);
    members.forEach((section, order) => {
      rebuilt.push(section.order === order ? section : { ...section, order });
    });
  }
  return rebuilt;
}

/** Move a section to the end of another column (the `Select` control's action). */
export function moveSectionToColumn(
  sections: SectionSpec[],
  key: SectionKey,
  column: SectionColumn
): SectionSpec[] {
  return reorderSection(sections, key, column, Number.MAX_SAFE_INTEGER);
}

/** Move a section one place up (`delta` -1) or down (`delta` +1) its column. */
export function moveSectionWithinColumn(
  sections: SectionSpec[],
  key: SectionKey,
  delta: number
): SectionSpec[] {
  const section = sections.find((entry) => entry.key === key);
  if (!section) return sections;
  const members = orderedSections(sections, section.column);
  const index = members.findIndex((entry) => entry.key === key);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= members.length) return sections;
  return reorderSection(sections, key, section.column, target);
}

/** Toggle a section's visibility. Pure — an unchanged value returns the input. */
export function setSectionEnabled(
  sections: SectionSpec[],
  key: SectionKey,
  enabled: boolean
): SectionSpec[] {
  let changed = false;
  const next = sections.map((section) => {
    if (section.key !== key || section.enabled === enabled) return section;
    changed = true;
    return { ...section, enabled };
  });
  return changed ? next : sections;
}

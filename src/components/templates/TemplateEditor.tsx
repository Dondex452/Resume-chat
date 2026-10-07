/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * TemplateEditor — M12 Stage A: the **structural** visual editor for a custom
 * template (PRD §5.5(b), §10, §17).
 *
 * What it mutates is exactly the schema's own vocabulary — a `SectionSpec`'s
 * `order`, `column` and `enabled`. Nothing else. There is no second data model
 * and no renderer branch: the `<TemplateThumb schema>` preview beside the
 * controls draws the same edited document the studio will, through the one
 * generic renderer (PRD §11 — preview and export share one render path).
 *
 * ## Two ways to operate everything
 *
 * Drag-and-drop is an **enhancement**, never the only route (PRD §5.5 keyboard
 * requirement; the mobile path is the controls):
 *   - **Reorder** — drag a row, or `Move up` / `Move down` per row.
 *   - **Move column** — drag across column groups, or the per-row `Column`
 *     select.
 *   - **Show / hide** — a `role="switch"` toggle per row.
 * Every one of those announces its result in a polite live region.
 *
 * ## What this deliberately does NOT do
 *
 * Design-token tuning (fonts, colours, spacing) is absent, and the editor says
 * so in one plain line. It is a genuine prerequisite rather than laziness: each
 * design's look is carried as Tailwind **class bundles** inside its data
 * (`rootClass`, `headingClass`, `splitClass`, …), so there is no semantic colour
 * or spacing value for a control to write (PRD §10). A colour picker here would
 * write nothing — so there isn't one.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, Undo2 } from 'lucide-react';
import { Banner, Button, Select } from '../ui';
import TemplateThumb from '../TemplateThumb';
import type {
  SectionColumn,
  SectionKey,
  SectionSpec,
  TemplateSchema,
} from '../../templates/schema';
import {
  COLUMN_LABELS,
  COLUMN_ORDER,
  allowedColumns,
  moveSectionToColumn,
  moveSectionWithinColumn,
  normalizeSectionOrders,
  orderedSections,
  reorderSection,
  sectionDisplayName,
  setSectionEnabled,
} from './sectionEditing';

/** Rendered live-preview width. Narrow enough to fit a 390px viewport. */
const PREVIEW_WIDTH = 276;

export interface TemplateEditorProps {
  /** The row's stored name (renaming stays on the gallery row). */
  name: string;
  /** The persisted schema — the editor starts from this and never mutates it. */
  schema: TemplateSchema;
  saving: boolean;
  /** The server's `errors[]` from a rejected save, or `null`. */
  saveErrors: string[] | null;
  /** Resolves `true` when the server accepted the document. */
  onSave: (schema: TemplateSchema) => Promise<boolean>;
  onClose: () => void;
  onDismissErrors: () => void;
}

interface DropTarget {
  key: SectionKey;
  position: 'before' | 'after';
}

export default function TemplateEditor({
  name,
  schema,
  saving,
  saveErrors,
  onSave,
  onClose,
  onDismissErrors,
}: TemplateEditorProps) {
  const [draft, setDraft] = useState<SectionSpec[]>(() => normalizeSectionOrders(schema.sections));
  const [baseline, setBaseline] = useState<SectionSpec[]>(() =>
    normalizeSectionOrders(schema.sections)
  );
  const [announcement, setAnnouncement] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const [dragKey, setDragKey] = useState<SectionKey | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  /**
   * Re-sync from the persisted document. Normalising on load means the order
   * invariant holds from the moment the editor opens, and the baseline is the
   * same shape as any draft the user produces, so `dirty` is honest.
   */
  useEffect(() => {
    const initial = normalizeSectionOrders(schema.sections);
    setDraft(initial);
    setBaseline(initial);
  }, [schema]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(baseline),
    [draft, baseline]
  );

  /** Apply a structural change and announce it. */
  const apply = (next: SectionSpec[], message: string) => {
    setDraft(next);
    setAnnouncement(message);
    setJustSaved(false);
  };

  /** Which column groups to render: every column a section may move to or is in. */
  const columns = useMemo(() => {
    const allowed = new Set<SectionColumn>();
    for (const section of draft) {
      for (const column of allowedColumns(schema.layout, section.key)) allowed.add(column);
    }
    return COLUMN_ORDER.filter(
      (column) => allowed.has(column) || draft.some((section) => section.column === column)
    );
  }, [draft, schema.layout]);

  const columnOptionsFor = (section: SectionSpec): SectionColumn[] => {
    const allowed = allowedColumns(schema.layout, section.key);
    // Keep the current column selectable even if the layout would not offer it,
    // so the control never shows a value that is not in its own list.
    return allowed.includes(section.column) ? allowed : [section.column, ...allowed];
  };

  const announceMove = (sections: SectionSpec[], key: SectionKey, column: SectionColumn) => {
    const members = orderedSections(sections, column);
    const position = members.findIndex((section) => section.key === key) + 1;
    const moved = sections.find((section) => section.key === key);
    const label = moved ? sectionDisplayName(moved) : key;
    return `Moved ${label} to ${COLUMN_LABELS[column]}, position ${position} of ${members.length}.`;
  };

  // ---- keyboard / pointer-free operations --------------------------------

  const handleToggle = (section: SectionSpec, enabled: boolean) => {
    const next = setSectionEnabled(draft, section.key, enabled);
    if (next === draft) return;
    apply(next, `${sectionDisplayName(section)} is now ${enabled ? 'shown on' : 'hidden from'} the sheet.`);
  };

  const handleMoveWithinColumn = (section: SectionSpec, delta: number) => {
    const next = moveSectionWithinColumn(draft, section.key, delta);
    if (next === draft) return;
    apply(next, announceMove(next, section.key, section.column));
  };

  const handleColumnChange = (section: SectionSpec, column: SectionColumn) => {
    if (section.column === column) return;
    const next = moveSectionToColumn(draft, section.key, column);
    apply(next, announceMove(next, section.key, column));
  };

  // ---- native HTML5 drag & drop (an enhancement over the controls) --------

  const handleDragStart = (event: React.DragEvent<HTMLLIElement>, section: SectionSpec) => {
    setDragKey(section.key);
    event.dataTransfer.effectAllowed = 'move';
    // Some browsers will not begin a drag unless data is set.
    try {
      event.dataTransfer.setData('text/plain', section.key);
    } catch {
      /* not fatal — `dragKey` is the authoritative source */
    }
  };

  const positionInRow = (
    event: React.DragEvent<HTMLLIElement>
  ): 'before' | 'after' => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
  };

  const handleRowDragOver = (event: React.DragEvent<HTMLLIElement>, section: SectionSpec) => {
    if (!dragKey) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const position = positionInRow(event);
    setDropTarget((current) =>
      current && current.key === section.key && current.position === position
        ? current
        : { key: section.key, position }
    );
  };

  const handleRowDrop = (event: React.DragEvent<HTMLLIElement>, section: SectionSpec) => {
    event.preventDefault();
    const key = dragKey;
    const position = positionInRow(event);
    setDropTarget(null);
    setDragKey(null);
    if (!key || key === section.key) return;

    const members = orderedSections(draft, section.column).filter((entry) => entry.key !== key);
    const index = members.findIndex((entry) => entry.key === section.key);
    const targetIndex =
      index < 0 ? members.length : position === 'after' ? index + 1 : index;
    const next = reorderSection(draft, key, section.column, targetIndex);
    apply(next, announceMove(next, key, section.column));
  };

  const handleColumnDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!dragKey) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };

  const handleColumnDrop = (event: React.DragEvent<HTMLDivElement>, column: SectionColumn) => {
    event.preventDefault();
    const key = dragKey;
    setDropTarget(null);
    setDragKey(null);
    if (!key) return;
    const next = moveSectionToColumn(draft, key, column);
    apply(next, announceMove(next, key, column));
  };

  const handleDragEnd = () => {
    setDragKey(null);
    setDropTarget(null);
  };

  const handleSave = async () => {
    setJustSaved(false);
    const ok = await onSave({ ...schema, sections: draft });
    if (ok) setJustSaved(true);
  };

  const errorList = (saveErrors ?? []).filter((error) => error.trim().length > 0);

  return (
    <div className="mt-8" data-template-editor="true">
      {/* ---- Editor header: identity, save state, actions ---------------- */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer font-body text-sm font-medium text-primary transition-colors duration-200 ease-in-out hover:text-primary-active"
          >
            Back to templates
          </button>
          <h2 className="type-h5 mt-1.5 truncate">{name}</h2>
          <p className="type-meta mt-0.5">
            {justSaved && !dirty
              ? 'All changes saved.'
              : dirty
                ? 'Unsaved changes.'
                : 'No unsaved changes.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="md"
            variant="ghost"
            startIcon={<Undo2 size={14} aria-hidden="true" />}
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(baseline);
              setJustSaved(false);
              setAnnouncement('Discarded unsaved changes.');
            }}
          >
            Discard
          </Button>
          <Button size="md" loading={saving} disabled={!dirty} onClick={handleSave}>
            Save changes
          </Button>
        </div>
      </div>

      {/* The one plain line about what is *not* here (and why). */}
      <p className="mt-3 max-w-content-sm text-sm leading-relaxed text-text-muted">
        Reorder sections, move them between columns, and hide the ones you do not use. Fonts,
        colours and spacing are not editable yet: each design stores its look as Tailwind class
        bundles inside its own data (PRD §10), so there is no colour or spacing value for a
        control to change.
      </p>

      {errorList.length > 0 && (
        <Banner
          tone="danger"
          role="alert"
          className="mt-4"
          onDismiss={onDismissErrors}
          dismissLabel="Dismiss save errors"
        >
          <p>Your changes were not saved — the server rejected the template.</p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm">
            {errorList.map((error, index) => (
              <li key={`${index}-${error}`}>{error}</li>
            ))}
          </ul>
        </Banner>
      )}

      {/* Move announcements (keyboard, drag and select alike). */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* ---- The structural controls --------------------------------- */}
        <div className="min-w-0">
          <h3 className="type-h6">Structure</h3>
          <p className="type-meta mt-1">
            Drag a row to reorder it, or use the controls on each row. Changes appear in the
            preview immediately and are saved only when you press Save changes.
          </p>

          <div className="mt-5 space-y-6">
            {columns.map((column) => {
              const members = orderedSections(draft, column);
              return (
                <section key={column} aria-label={COLUMN_LABELS[column]} data-editor-column={column} className="min-w-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <h4 className="font-heading text-sm font-medium text-text-heading">
                      {COLUMN_LABELS[column]}
                    </h4>
                    {/* Only stated when true — an empty column's emptiness is
                        already shown by its drop area below, and two labels for
                        one fact is the banned kind of repetition (PRD §19.9.8). */}
                    {members.length > 0 && (
                      <p className="type-meta">
                        {members.length} section{members.length === 1 ? '' : 's'}
                      </p>
                    )}
                  </div>

                  {members.length > 0 ? (
                    <ul className="mt-2 space-y-2">
                      {members.map((section, index) => {
                        const display = sectionDisplayName(section);
                        const options = columnOptionsFor(section);
                        const indicator =
                          dropTarget && dropTarget.key === section.key ? dropTarget.position : null;
                        return (
                          <li
                            key={section.key}
                            draggable
                            data-section-key={section.key}
                            data-section-column={section.column}
                            data-section-order={section.order}
                            data-section-enabled={section.enabled ? 'true' : 'false'}
                            onDragStart={(event) => handleDragStart(event, section)}
                            onDragEnd={handleDragEnd}
                            onDragOver={(event) => handleRowDragOver(event, section)}
                            onDragLeave={(event) => {
                              // `dragleave` also fires when the pointer crosses
                              // into a child node; only a real exit clears the
                              // indicator, otherwise it flickers.
                              if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
                                return;
                              }
                              setDropTarget(null);
                            }}
                            onDrop={(event) => handleRowDrop(event, section)}
                            className={
                              'min-w-0 rounded-card border bg-surface p-2.5 transition-colors duration-200 ' +
                              (dragKey === section.key
                                ? 'border-primary '
                                : 'border-border-soft ') +
                              (indicator === 'before'
                                ? 'border-t-2 border-t-primary '
                                : indicator === 'after'
                                  ? 'border-b-2 border-b-primary '
                                  : '')
                            }
                          >
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
                              <span
                                aria-hidden="true"
                                title="Drag to reorder"
                                className="shrink-0 cursor-grab text-text-muted"
                              >
                                <GripVertical size={15} />
                              </span>

                              <div className="min-w-0 flex-1">
                                <p className="truncate font-heading text-sm font-medium text-text-heading">
                                  {display}
                                </p>
                                <p className="type-meta truncate">
                                  {section.key}
                                  {section.enabled ? '' : ' · hidden'}
                                </p>
                              </div>

                              <div className="flex shrink-0 items-center gap-1">
                                <Button
                                  size="xs"
                                  variant="outline"
                                  startIcon={
                                    section.enabled ? (
                                      <Eye size={12} aria-hidden="true" />
                                    ) : (
                                      <EyeOff size={12} aria-hidden="true" />
                                    )
                                  }
                                  role="switch"
                                  aria-checked={section.enabled}
                                  aria-label={`${display} on the sheet`}
                                  onClick={() => handleToggle(section, !section.enabled)}
                                >
                                  {section.enabled ? 'Shown' : 'Hidden'}
                                </Button>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  iconOnly
                                  aria-label={`Move ${display} up`}
                                  title="Move up"
                                  disabled={index === 0}
                                  onClick={() => handleMoveWithinColumn(section, -1)}
                                >
                                  <ArrowUp size={14} />
                                </Button>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  iconOnly
                                  aria-label={`Move ${display} down`}
                                  title="Move down"
                                  disabled={index === members.length - 1}
                                  onClick={() => handleMoveWithinColumn(section, 1)}
                                >
                                  <ArrowDown size={14} />
                                </Button>
                              </div>

                              {/* The keyboard route to a column change. It sits on
                                  its own line below `sm` (a full-width, easy-to-tap
                                  control) and inline from `sm` up. No visible label:
                                  the select's own value names the column, and the
                                  `aria-label` carries the accessible name. */}
                              <div className="w-full min-w-0 sm:w-40 sm:shrink-0">
                                <Select
                                  aria-label={`Column for ${display}`}
                                  value={section.column}
                                  onChange={(event) =>
                                    handleColumnChange(section, event.target.value as SectionColumn)
                                  }
                                >
                                  {options.map((option) => (
                                    <option key={option} value={option}>
                                      {COLUMN_LABELS[option]}
                                    </option>
                                  ))}
                                </Select>
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}

                  {/* Trailing drop zone, rendered for an EMPTY column only.
                      It is the "place it last" target where there is no row to
                      drop onto, and it is present at rest as well as during a
                      drag — a target that appears mid-drag shifts the layout
                      under the pointer, which is a real usability bug, not just
                      a test problem. A non-empty column needs no trailing zone:
                      dropping on the lower half of its last row appends. */}
                  {members.length === 0 && (
                    <div
                      data-drop-zone={column}
                      onDragOver={handleColumnDragOver}
                      onDrop={(event) => handleColumnDrop(event, column)}
                      className={
                        'mt-2 rounded-card border border-dashed p-3 text-center transition-colors duration-200 ' +
                        (dragKey
                          ? 'border-primary bg-primary-soft'
                          : 'border-border-soft bg-page-alt')
                      }
                    >
                      <span className="type-meta">
                        {dragKey
                          ? `Drop to place it last in ${COLUMN_LABELS[column]}`
                          : 'No sections'}
                      </span>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>

        {/* ---- Live preview -------------------------------------------- */}
        <div className="min-w-0">
          <div className="lg:sticky lg:top-24">
            <h3 className="type-h6">Live preview</h3>
            <p className="type-meta mt-1">
              The built-in sample resume, drawn from your edited structure.
            </p>
            <div className="mt-3 w-fit rounded-card border border-border-soft bg-page-alt p-3">
              <TemplateThumb
                templateId={schema.id}
                schema={{ ...schema, sections: draft }}
                width={PREVIEW_WIDTH}
                className="border-border"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

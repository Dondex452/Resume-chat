/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * TemplateThumb — a miniature, non-interactive render of one resume template.
 *
 * This is honest imagery: rather than a grey box or a stock photograph, the
 * thumbnail is the real schema-driven renderer drawing the real template against
 * a fixed fictional sample. At thumbnail scale it reads as a page preview, which
 * is exactly what a template gallery needs (PRD §19.10 rule 9 — imagery that
 * belongs to content, not chrome).
 *
 * It mirrors `PreviewPaper`'s technique — author at true A4 pixels inside a
 * `transform: scale()` with `origin-top-left` — but the scale is a *prop*
 * because thumbnails are fixed-size and have nothing to observe.
 *
 * It is decorative repetition of the label beside it, so the whole tree is
 * `aria-hidden`, `inert` and `pointer-events-none`: it can be neither focused
 * nor read, while clicks still fall through to the button wrapping it.
 *
 * It deliberately does NOT carry `data-resume-paper`: that marker belongs to
 * the real sheet only, and the export path picks the visible copy (GOTCHA #24).
 */

import React from 'react';
import SchemaResumeRenderer from '../templates/render';
import { getBuiltinTemplateSchema } from '../templates/builtin';
import type { TemplateSchema } from '../templates/schema';
import { A4_WIDTH, A4_HEIGHT } from './PreviewPaper';
import { TEMPLATE_THUMB_SAMPLE } from './templateThumbSample';
import { cn } from './ui';

export interface TemplateThumbProps {
  /** Which template to draw. Resolved to a `TemplateSchema` (unknown → minimal). */
  templateId: string;
  /**
   * M11 — a user-created template is drawn from its own stored `schema_json`
   * rather than the built-in registry. When absent the built-in lookup is used
   * unchanged, so the ten ship designs render exactly as before.
   */
  schema?: TemplateSchema;
  /** On-screen width in CSS px. Height follows the A4 aspect ratio. */
  width: number;
  /**
   * Caller-owned decoration — border colour is the active-state signal, so the
   * thumbnail itself never decides which template is selected.
   */
  className?: string;
}

/**
 * React 18 does not type the `inert` attribute. Rendering it as a bare
 * attribute (`inert=""`) removes the subtree from the tab order and the
 * accessibility tree; browsers that do not support it ignore it harmlessly.
 */
const INERT_ATTR = { inert: '' } as unknown as React.HTMLAttributes<HTMLDivElement>;

export default function TemplateThumb({ templateId, schema, width, className }: TemplateThumbProps) {
  const scale = width / A4_WIDTH;
  const height = A4_HEIGHT * scale;
  // A stored custom schema wins; otherwise the built-in registry resolves the id.
  const effectiveSchema = schema ?? getBuiltinTemplateSchema(templateId);

  return (
    <div
      aria-hidden="true"
      {...INERT_ATTR}
      data-template-thumb="true"
      className={cn(
        // The border width lives here; the colour is the caller's signal.
        'pointer-events-none shrink-0 select-none overflow-hidden rounded-button border bg-paper',
        className
      )}
      style={{ width, height }}
    >
      <div
        className="origin-top-left"
        style={{ width: A4_WIDTH, minHeight: A4_HEIGHT, transform: `scale(${scale})` }}
      >
        <div
          className="text-gray-800"
          style={{ width: A4_WIDTH, minHeight: A4_HEIGHT }}
        >
          <SchemaResumeRenderer schema={effectiveSchema} data={TEMPLATE_THUMB_SAMPLE} />
        </div>
      </div>
    </div>
  );
}

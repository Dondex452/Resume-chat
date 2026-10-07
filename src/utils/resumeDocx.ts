/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The DOCX export (PRD §11).
 *
 * **Why this module exists.** The previous implementation was an inline block in
 * `App.tsx` that hardcoded its own section list and read only `basics`, `work`,
 * `education` and `skills`. Three consequences, all user-visible:
 *
 *  - `projects`, `certifications`, `languages`, `personal` and `signature` were
 *    **silently dropped** from the Word document;
 *  - the **country preset was ignored**, so a German `Lebenslauf` exported with
 *    English headings and with sections the user had disabled;
 *  - the **template was ignored** — a custom template's section order and labels
 *    had no effect on the export at all.
 *
 * So the export is now built from the **same resolved schema the preview and the
 * PDF use** (`resolveSessionRenderSchema`): the sections that are enabled, in the
 * order the template puts them, with the labels the country preset localises. A
 * template created from scratch on `#/templates` therefore exports correctly with
 * no code of its own — the export is driven by data, exactly like the renderer.
 *
 * It is deliberately **structural, not pixel-faithful**: a Word document is an
 * editable document, so the goal is a clean, correct, well-ordered resume with
 * real Word bullets and right-aligned dates — not a copy of the chosen design.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  TabStopType,
  TextRun,
  type ISectionOptions,
} from 'docx';
import type { ResumeJSON } from '../types';
import type { SectionSpec, TemplateSchema } from '../templates/schema';
import type { PaperFormat, PageOrientation } from '../templates/customTemplates';
import { paperDimensions } from '../components/PreviewPaper';

/** CSS px → twips (1/1440 in), at the 96 dpi the sheets are authored at. */
const pxToTwips = (px: number) => Math.round((px * 1440) / 96);

/** Half-points, because `docx` sizes are in half-points. */
const pt = (points: number) => Math.round(points * 2);

const BODY_SIZE = pt(10.5);
const META_SIZE = pt(9.5);
const HEADING_SIZE = pt(11.5);

/** 0.5 in — the same inset the print path defaults to (§11). */
const DEFAULT_MARGIN_TWIPS = pxToTwips(48);

type TokenStyle = {
  family?: string;
  heading?: string;
};

/**
 * A best-effort body/heading font from the schema's `tokens`, falling back to
 * Word's default. The tokens are Tailwind class bundles in practice, so a font is
 * only used when the value looks like a plain family name.
 */
function resolveFonts(schema: TemplateSchema): TokenStyle {
  const tokens = (schema.tokens || {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = tokens[key];
      if (typeof value === 'string' && value.length > 0 && !value.includes('class') && value.length < 60) {
        return value;
      }
    }
    return undefined;
  };
  return {
    family: pick('fontBody', 'fontFamily', 'bodyFont'),
    heading: pick('fontHeading', 'headingFont') ?? pick('fontBody', 'fontFamily', 'bodyFont'),
  };
}

const SECTION_HEADING_KEYS = new Set(['summary', 'work', 'education', 'skills', 'projects', 'certifications', 'languages', 'personal', 'signature']);

/**
 * A section heading: bold, slightly spaced, with a hairline rule under it — the
 * one piece of styling every template shares. The label comes from the schema, so
 * it is already localised by the country preset (`Berufserfahrung`, `Formation`).
 */
function heading(label: string, fonts: TokenStyle): Paragraph {
  return new Paragraph({
    spacing: { before: 260, after: 100 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D0D5DD', space: 4 },
    },
    children: [
      new TextRun({
        text: label.toUpperCase(),
        bold: true,
        size: HEADING_SIZE,
        characterSpacing: 20,
        font: fonts.heading,
      }),
    ],
  });
}

function metaRun(text: string, fonts: TokenStyle): TextRun {
  return new TextRun({ text: `\t${text}`, italics: true, size: META_SIZE, color: '555555', font: fonts.family });
}

function bullet(text: string, fonts: TokenStyle): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { before: 40 },
    children: [new TextRun({ text, size: BODY_SIZE, font: fonts.family })],
  });
}

/** A `label: value` row, used by the personal block and by skills. */
function labelValue(label: string, value: string, fonts: TokenStyle): Paragraph {
  return new Paragraph({
    spacing: { before: 40 },
    children: [
      new TextRun({ text: `${label}: `, bold: true, size: BODY_SIZE, font: fonts.family }),
      new TextRun({ text: value, size: BODY_SIZE, font: fonts.family }),
    ],
  });
}

/**
 * Some presets leave a section label empty (the DE `signature` block has no
 * localised heading). Falling straight back to the raw key would print
 * `SIGNATURE` in caps, so a small English default covers the gap — the same
 * "absent data must not render as an empty heading" rule the renderer follows.
 */
const DEFAULT_LABELS: Record<string, string> = {
  signature: 'Signature',
  personal: 'Personal Details',
};

/**
 * One section's paragraphs, in schema order. Unknown keys render nothing rather
 * than throwing, so a future `SectionSpec.key` cannot break the export.
 */
function renderSection(
  section: SectionSpec,
  data: ResumeJSON,
  fonts: TokenStyle,
  tabStop: number,
): Paragraph[] {
  const out: Paragraph[] = [];
  const label = section.label || DEFAULT_LABELS[section.key] || section.key;
  const first = <T,>(list: T[] | undefined): T[] => (Array.isArray(list) ? list : []);

  switch (section.key) {
    case 'basics': {
      const basics = data.basics || {};
      if (basics.fullName) {
        out.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 60 },
            children: [new TextRun({ text: basics.fullName, bold: true, size: pt(20), font: fonts.heading })],
          }),
        );
      }
      const contact = [basics.email, basics.phone, basics.location].filter(Boolean).join('  •  ');
      if (contact) {
        out.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 40 },
            children: [new TextRun({ text: contact, size: META_SIZE, font: fonts.family })],
          }),
        );
      }
      const links = first(basics.links);
      if (links.length) {
        out.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 120 },
            children: [
              new TextRun({
                text: links.map((l) => [l.label, l.url].filter(Boolean).join(': ')).join('   '),
                size: META_SIZE,
                color: '555555',
                font: fonts.family,
              }),
            ],
          }),
        );
      }
      break;
    }

    case 'summary': {
      const summary = data.basics?.summary;
      if (!summary) break;
      if (SECTION_HEADING_KEYS.has(section.key)) out.push(heading(label, fonts));
      out.push(
        new Paragraph({
          spacing: { after: 60 },
          children: [new TextRun({ text: summary, size: BODY_SIZE, font: fonts.family })],
        }),
      );
      break;
    }

    case 'personal': {
      const personal = data.personal;
      if (!personal) break;
      const rows: [string, string | undefined][] = [
        ['Date of birth', personal.dob],
        ['Nationality', personal.nationality],
        ['Marital status', personal.maritalStatus],
        ['Visa status', personal.visaStatus],
        ["Father's name", personal.fatherName],
        ['Gender', personal.gender],
      ];
      const present = rows.filter(([, value]) => Boolean(value));
      if (!present.length) break;
      out.push(heading(label, fonts));
      for (const [name, value] of present) out.push(labelValue(name, String(value), fonts));
      break;
    }

    case 'work': {
      const work = first(data.work);
      if (!work.length) break;
      out.push(heading(label, fonts));
      for (const job of work) {
        const title = [job.role, job.company].filter(Boolean).join('  —  ');
        const dates = [job.start, job.end || 'Present'].filter(Boolean).join(' - ');
        out.push(
          new Paragraph({
            spacing: { before: 140, after: 40 },
            tabStops: [{ type: TabStopType.RIGHT, position: tabStop }],
            children: [
              new TextRun({ text: title, bold: true, size: BODY_SIZE, font: fonts.family }),
              ...(dates ? [metaRun(dates, fonts)] : []),
            ],
          }),
        );
        for (const highlight of first(job.highlights)) out.push(bullet(highlight, fonts));
      }
      break;
    }

    case 'education': {
      const education = first(data.education);
      if (!education.length) break;
      out.push(heading(label, fonts));
      for (const entry of education) {
        const qualification = [entry.degree, entry.field].filter(Boolean).join(', ');
        const where = [qualification, entry.school].filter(Boolean).join('  —  ');
        const dates = [entry.start, entry.end].filter(Boolean).join(' - ');
        out.push(
          new Paragraph({
            spacing: { before: 100, after: 20 },
            tabStops: [{ type: TabStopType.RIGHT, position: tabStop }],
            children: [
              new TextRun({ text: where, bold: true, size: BODY_SIZE, font: fonts.family }),
              ...(dates ? [metaRun(dates, fonts)] : []),
            ],
          }),
        );
      }
      break;
    }

    case 'skills': {
      const skills = first(data.skills);
      if (!skills.length) break;
      out.push(heading(label, fonts));
      for (const group of skills) {
        const items = first(group.items).join(', ');
        if (!items) continue;
        out.push(labelValue(group.category || 'Skills', items, fonts));
      }
      break;
    }

    case 'projects': {
      const projects = first(data.projects);
      if (!projects.length) break;
      out.push(heading(label, fonts));
      for (const project of projects) {
        const link = project.link ? `  ${project.link}` : '';
        out.push(
          new Paragraph({
            spacing: { before: 100, after: 20 },
            children: [new TextRun({ text: `${project.name || ''}${link}`, bold: true, size: BODY_SIZE, font: fonts.family })],
          }),
        );
        if (project.description) {
          out.push(
            new Paragraph({
              spacing: { after: 20 },
              children: [new TextRun({ text: project.description, size: BODY_SIZE, font: fonts.family })],
            }),
          );
        }
      }
      break;
    }

    case 'certifications': {
      const certifications = first(data.certifications);
      if (!certifications.length) break;
      out.push(heading(label, fonts));
      for (const certification of certifications) {
        const text = [certification.name, certification.issuer].filter(Boolean).join('  —  ');
        out.push(
          new Paragraph({
            spacing: { before: 60 },
            tabStops: [{ type: TabStopType.RIGHT, position: tabStop }],
            children: [
              new TextRun({ text, size: BODY_SIZE, font: fonts.family }),
              ...(certification.date ? [metaRun(certification.date, fonts)] : []),
            ],
          }),
        );
      }
      break;
    }

    case 'languages': {
      const languages = first(data.languages);
      if (!languages.length) break;
      out.push(heading(label, fonts));
      for (const language of languages) {
        const text = [language.name, language.proficiency].filter(Boolean).join('  —  ');
        out.push(
          new Paragraph({
            spacing: { before: 40 },
            children: [new TextRun({ text, size: BODY_SIZE, font: fonts.family })],
          }),
        );
      }
      break;
    }

    case 'signature': {
      const signature = data.signature;
      if (!signature) break;
      const place = [signature.place, signature.date].filter(Boolean).join(', ');
      if (!place && !signature.signed) break;
      out.push(heading(label, fonts));
      out.push(
        new Paragraph({
          spacing: { before: 200, after: 40 },
          children: [new TextRun({ text: '_______________________', size: BODY_SIZE, font: fonts.family })],
        }),
      );
      if (place) {
        out.push(
          new Paragraph({
            children: [new TextRun({ text: place, size: META_SIZE, color: '555555', font: fonts.family })],
          }),
        );
      }
      break;
    }

    default:
      break;
  }

  return out;
}

export interface DocxExportInput {
  /** The **resolved** schema — template × country preset × user page choice. */
  schema: TemplateSchema;
  data: ResumeJSON;
  pageSize: PaperFormat;
  orientation: PageOrientation;
}

/**
 * Build the Word document. Sections are taken from the resolved schema, so the
 * export follows the same enabled flags, order and localised labels as the
 * preview and the PDF (PRD §11 — one model, three outputs).
 */
export function buildResumeDocx({ schema, data, pageSize, orientation }: DocxExportInput): Document {
  const fonts = resolveFonts(schema);
  const { width, height } = paperDimensions(pageSize, orientation);
  const contentWidthTwips = pxToTwips(width) - DEFAULT_MARGIN_TWIPS * 2;

  const sections = (schema.sections || [])
    .filter((section) => section.enabled)
    .slice()
    .sort((a, b) => a.order - b.order);

  const children: Paragraph[] = [];
  for (const section of sections) {
    // The header region wraps `basics`; the summary may sit inside it. Both are
    // rendered by the same switch, so the export keeps the schema's order.
    children.push(...renderSection(section, data, fonts, contentWidthTwips));
  }

  const options: ISectionOptions = {
    properties: {
      page: {
        size: { width: pxToTwips(width), height: pxToTwips(height) },
        margin: {
          top: DEFAULT_MARGIN_TWIPS,
          right: DEFAULT_MARGIN_TWIPS,
          bottom: DEFAULT_MARGIN_TWIPS,
          left: DEFAULT_MARGIN_TWIPS,
        },
      },
    },
    children,
  };

  return new Document({
    creator: 'AI Resume Generator',
    title: data.basics?.fullName ? `${data.basics.fullName} - Resume` : 'Resume',
    sections: [options],
  });
}

/** Pack to a Blob for the browser download path. */
export async function buildResumeDocxBlob(input: DocxExportInput): Promise<Blob> {
  return Packer.toBlob(buildResumeDocx(input));
}

/** Pack to a Buffer — used by the offline verification harness. */
export async function buildResumeDocxBuffer(input: DocxExportInput): Promise<Buffer> {
  return Packer.toBuffer(buildResumeDocx(input));
}

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * TemplateSchema — the data model that replaces the hardcoded JSX `switch` in
 * `src/components/ResumeRenderer.tsx` (PRD §5.3, §10, M9).
 *
 * A template is a JSON document. The generic renderer (`./render.tsx`) consumes
 * `TemplateSchema` + `ResumeJSON`; it contains no per-template branches.
 *
 * Spec conformance notes (M9):
 *   Stage 1 proved PRD §10's `SectionSpec` necessary but not sufficient and
 *   added four things: `column: 'header'`, `group?`, a per-section
 *   `headingClass` override, and per-section `props`.
 *
 *   Stage 2 (the structurally harder six) added the following, all recorded in
 *   PRD §10:
 *     - `column: 'full'` — a full-width lead section inside a split body
 *       (slate's `Executive Summary` sits above the two-column grid).
 *     - `SidebarSpec` grows `position` / `containerClass` / `innerClass` /
 *       `footerText` / `footerClass` — a real sidebar is a styled column with
 *       its own padding, borders and a pinned caption, not just a width.
 *     - `tokens` grows `splitClass` / `splitMainClass` / `splitSidebarClass`
 *       — the body split of a header-band design (slate).
 *     - Contacts gain real layouts (`icon-stack`, `icon-line`, `inline-labels`,
 *       `inline`), an explicit `linkMode`, and link prefix/suffix/fallback.
 *     - Skills gain an `itemsMode` of `inline | chips`.
 *     - Languages gain `stacked` / `inline` variants.
 *     - Education gains a `stacked` layout and a configurable degree/field
 *       separator.
 *     - Work gains an optional absolutely-positioned `markerClass` (timeline).
 *
 *   The §10 caveat still stands: the renderer consumes Tailwind class bundles
 *   carried inside template data (`rootClass`, `bodyClass`, `groupClass`,
 *   `headingClass`, the per-section bags). That keeps output exact. M10 must
 *   resolve them into semantic values before country presets can override a
 *   colour that lives inside a class string.
 */

import type { ResumeJSON } from '../types';

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export type TemplateOrigin = 'builtin' | 'generated' | 'cloned';

export type PageSize = 'A4' | 'Letter';

/** PRD §10 layout modes. */
export type TemplateLayout = 'single' | 'sidebar' | 'header-band' | 'tabular';

/** PRD §10 section keys. */
export type SectionKey =
  | 'basics'
  | 'personal'
  | 'summary'
  | 'work'
  | 'education'
  | 'skills'
  | 'projects'
  | 'certifications'
  | 'languages'
  | 'signature';

/**
 * `header` is an M9 extension of PRD §10's `main | sidebar`. The header block
 * (name, headline, contacts, links and — in every shipped design — the summary)
 * is not a free-standing section: it is a distinct region that must be styled as
 * a unit and is always first. Modelling it as `column: 'header'` keeps the
 * section list canonical (sections still carry order/label/enabled) while
 * letting the renderer wrap the whole region in one container.
 *
 * `full` is the Stage 2 addition: a section that spans the body width above a
 * main/sidebar split (slate's `Executive Summary`).
 */
export type SectionColumn = 'main' | 'sidebar' | 'header' | 'full';

/** PRD §10 section variants. */
export type SectionVariant = 'list' | 'timeline' | 'table' | 'tags' | 'chips' | 'grid';

// ---------------------------------------------------------------------------
// Page & tokens
// ---------------------------------------------------------------------------

export interface TemplatePage {
  size: PageSize;
  /** CSS length applied to the sheet, e.g. `'40px'`. */
  margins: string;
  targetPages: number;
}

/**
 * §10 `tokens { fonts, scale, lineHeight, colors, spacing, radius, borders }`.
 *
 * The resolved, concrete class bundles (`rootClass`, `bodyClass`, `groupClass`,
 * `headingClass`) are carried alongside the semantic axes because the renderer
 * consumes them directly to stay pixel-identical. The axes describe the design
 * for later milestones (country presets must be able to reason about
 * `colors`/`spacing` without parsing Tailwind classes).
 */
export interface TemplateTokens {
  fonts: { heading: string; body: string };
  /** Base type scale multiplier; 1 = the template's own default. */
  scale: number;
  lineHeight: number;
  /**
   * Palette keys, not rendered values. The concrete colour is carried by the
   * class bundles so the output matches the pre-port design exactly.
   */
  colors: {
    heading: string;
    body: string;
    muted: string;
    accent: string;
    rule: string;
    background: string;
  };
  spacing: { page: number; section: number; item: number };
  radius: number;
  borders: { ruleWidth: number; ruleStyle: string };
  /** Root sheet classes (font, padding, background, borders, leading, layout). */
  rootClass: string;
  /** Class for the wrapper that stacks the body sections. */
  bodyClass: string;
  /** Class for a side-by-side group of sections (see `SectionSpec.group`). */
  groupClass: string;
  /** Default section-heading class; a section may override it. */
  headingClass: string;
  /**
   * M9 Stage 2 — the main column of a body split (a header-band design such as
   * `slate`, and the body column of a full-height sidebar design).
   */
  splitMainClass?: string;
  /** The sidebar column of a body split (slate). */
  splitSidebarClass?: string;
  /** The wrapper that holds the main + sidebar columns (slate). */
  splitClass?: string;
}

export interface SidebarSpec {
  widthPct: number;
  background: string;
  /**
   * M9 Stage 2 — a real sidebar is a styled column, not just a width. The
   * renderer consumes `containerClass` (width, background, padding, flex
   * behaviour, borders) so the exact pre-port output is preserved.
   */
  position?: 'left' | 'right';
  containerClass?: string;
  /** Inner wrapper of the column (e.g. `space-y-6`). */
  innerClass?: string;
  /** Static caption pinned to the bottom of the column (creative). */
  footerText?: string;
  footerClass?: string;
}

// ---------------------------------------------------------------------------
// Per-section style bags (the M9 extension — see the file header)
// ---------------------------------------------------------------------------

/**
 * How the contact entries render.
 *   icon-row      — one wrapping flex row, each entry `icon + value`
 *   icon-stack    — one line per entry, `icon` then a value `<span>`
 *   icon-line     — one line per entry, `icon` then a bare space + value
 *   dotted        — plain spans separated by a bullet prefix
 *   labelled-box  — boxed rows with a `[EMAIL] `-style prefix
 *   inline-labels — plain spans with an `EMAIL: `-style prefix
 *   inline        — plain spans with a bullet prefix; links share the row
 */
export type ContactLayout =
  | 'icon-row'
  | 'icon-stack'
  | 'icon-line'
  | 'dotted'
  | 'labelled-box'
  | 'inline-labels'
  | 'inline';

/** Where the basic links render relative to the contact entries. */
export type ContactLinkMode = 'row' | 'box' | 'inline' | 'none';

export interface ContactsProps {
  layout: ContactLayout;
  /** Row (icon-row / dotted / inline) or box (labelled-box) class. */
  rowClass: string;
  itemClass: string;
  iconClass: string;
  /** Prefix applied to each contact after the first (e.g. `'• '`). */
  bulletPrefix: string;
  bulletSkipFirst: boolean;
  /** Prefix applied to each contact in `labelled-box` / `inline-labels`. */
  labelPrefixes: { email: string; phone: string; location: string };
  /** Truncate the email value — narrow sidebars only (creative, sidebar). */
  truncateEmail?: boolean;
  linksRowClass: string;
  linkMode: ContactLinkMode;
  linkClass: string;
  /** Render the leading link glyph (minimal, ivory, bold, startup). */
  linkIcon: boolean;
  linkIconClass: string;
  /** Rendered before the link text (e.g. `'_'`, `'['`). */
  linkPrefix: string;
  /** Rendered after the link text (e.g. `']'`). */
  linkSuffix: string;
  /** Used when the link has no label and is non-empty (slate: `'Link'`). */
  linkFallback: string;
}

export interface BasicsProps {
  containerClass: string;
  nameClass: string;
  nameFallback: string;
  /**
   * `stack` = name, headline, contacts in flow (the default).
   * `split` = name + headline beside the contacts block (slate's header band).
   */
  layout?: 'stack' | 'split';
  splitRowClass?: string;
  splitLeftClass?: string;
  splitRightClass?: string;
  /** A leading status pill (startup's `Available for work`). */
  badge?: { text: string; className: string };
  /**
   * M10 — optional header photo (PRD §8, §5.4). The country presets that
   * expect a photo turn `basics.photo` on; the renderer only emits an image
   * when the data is present, so a resume without one is byte-identical to
   * pre-M10 output. `className` lets a design set its own crop/size, and
   * `enabled` lets a country preset suppress a stored photo for a market that
   * does not use one (US/CA/UK/NL/AU) — absent means enabled.
   */
  photo?: {
    className?: string;
    enabled?: boolean;
  };
  headline: {
    enabled: boolean;
    className: string;
    prefix: string;
    fallback: string;
  };
  contacts: ContactsProps;
}

export interface SummaryProps {
  className: string;
  /** Body-wrapper class for a summary rendered as a body section. */
  containerClass?: string;
  /** Heading class when rendered as a body section (overrides tokens). */
  headingClass?: string;
}

/** Work-item layouts the shipped designs need. */
export type WorkLayout =
  | 'role-company-block' // role + company stacked in the left cell, date right
  | 'role-date-then-company' // role + date on one line, company below
  | 'inline-role-company'; // `role @ company` on one line, date right

export interface WorkProps {
  headingClass?: string;
  containerClass?: string;
  listClass: string;
  itemClass: string;
  rowClass: string;
  layout: WorkLayout;
  roleClass: string;
  roleTag: 'h3' | 'span';
  inlineSeparator: string;
  companyClass: string;
  companyTag: 'p' | 'div';
  dateClass: string;
  dateSeparator: string;
  endFallback: string;
  highlightsClass: string;
  highlightItemClass: string;
  /** Rendered before each highlight (e.g. `'* '`); empty when using list-disc. */
  highlightPrefix: string;
  /** Absolutely-positioned timeline dot (startup). */
  markerClass?: string;
}

export type EducationLayout = 'degree-field-block' | 'inline-degree-field' | 'stacked';

export interface EducationProps {
  headingClass?: string;
  containerClass?: string;
  listClass: string;
  itemClass: string;
  rowClass: string;
  layout: EducationLayout;
  degreeClass: string;
  degreeTag: 'h3' | 'span' | 'div';
  /**
   * Rendered between the degree and the field in the row layouts.
   * `degree-field-block` puts it inside the degree tag; `inline-degree-field`
   * puts it after the degree tag (`' in '` / `' / '` / `' ('`).
   */
  degreeFieldSeparator: string;
  /** Rendered after the field in `inline-degree-field` (e.g. `')'`). */
  degreeFieldSuffix?: string;
  /** Stacked layout only — the field line. */
  fieldClass?: string;
  /** Stacked layout only — the field tag. */
  fieldTag?: 'p' | 'div';
  /** Stacked layout only — render the field line (default true). */
  includeField?: boolean;
  schoolClass: string;
  schoolTag: 'p' | 'div';
  dateClass: string;
  dateSeparator: string;
  endFallback: string;
  /** Stacked layout only — the date tag (defaults to `span`). */
  dateTag?: 'span' | 'p' | 'div';
}

export interface SkillsProps {
  headingClass?: string;
  containerClass?: string;
  listClass: string;
  itemClass: string;
  categoryClass: string;
  /** Rendered inside the category span, before the label (e.g. `'> '`). */
  categoryPrefix: string;
  /** Rendered inside the category span, after the label (e.g. `': '`). */
  categorySuffix: string;
  /**
   * Rendered between the category span and the items span. Kept separate from
   * `categorySuffix` because in `tech` the separating space sits OUTSIDE the
   * bold category span, and a bold space renders a fraction differently.
   */
  itemsPrefix: string;
  itemsClass: string;
  /** `inline` = comma-joined text; `chips` = wrapped pill spans. */
  itemsMode?: 'inline' | 'chips';
  /** Chips only — the wrapper around the chip spans. */
  itemsWrapClass?: string;
  /** Chips only — one class per chip. */
  chipClass?: string;
}

export interface ProjectsProps {
  headingClass?: string;
  containerClass?: string;
  listClass: string;
  itemClass: string;
  rowClass: string;
  nameClass: string;
  nameTag: 'h3' | 'span';
  linkClass: string;
  linkLabel: string;
  descriptionClass: string;
}

export interface CertificationsProps {
  headingClass?: string;
  containerClass?: string;
  listClass: string;
  itemClass: string;
  /** `full` = `name — issuer (date)`; `compact` = `* name (issuer)`. */
  variant: 'full' | 'compact';
  primaryClass: string;
}

export type LanguagesVariant = 'full' | 'compact' | 'stacked' | 'inline';

export interface LanguagesProps {
  headingClass?: string;
  containerClass?: string;
  listClass: string;
  itemClass: string;
  /**
   * `full`/`compact` render a `ul`/`li`; `stacked`/`inline` render `div`s.
   * `stacked` = name above proficiency; `inline` = `name: proficiency`.
   */
  variant: LanguagesVariant;
  primaryClass: string;
  /** `stacked` / `inline` only. */
  secondaryClass?: string;
}

/**
 * M10 — the personal-detail fields a country preset may require (PRD §8). The
 * photo and the signature are deliberately *not* here: the photo lives on
 * `basics` and the signature is its own section.
 */
export type PersonalFieldKey =
  | 'dob'
  | 'nationality'
  | 'maritalStatus'
  | 'visaStatus'
  | 'fatherName'
  | 'gender';

/**
 * M10 — a personal-details block (PRD §8, §5.4).
 *
 * `fields` is the ordered list the active country preset expects. The renderer
 * emits a row only for a field that actually holds a value, and emits nothing
 * at all — not even the heading — when none do (PRD §8's hard rule).
 */
export interface PersonalProps {
  /** Heading class override (defaults to `tokens.headingClass`). */
  headingClass?: string;
  containerClass?: string;
  listClass?: string;
  rowClass?: string;
  labelClass?: string;
  valueClass?: string;
  /** Rendered between a field's label and its value. Defaults to `': '`. */
  separator?: string;
  /** Ordered fields to render. Defaults to every present field. */
  fields?: PersonalFieldKey[];
}

/**
 * M10 — the signature block (Germany's Lebenslauf convention, PRD §8).
 *
 * Only fields that are present render; the ruled line is the block's purpose,
 * so it renders whenever the section has any signature data at all. A section
 * with no data renders nothing, heading included.
 */
export interface SignatureProps {
  headingClass?: string;
  containerClass?: string;
  rowClass?: string;
  placeClass?: string;
  dateClass?: string;
  /** The ruled line the user signs above. */
  lineClass?: string;
  /** Caption beside/below the line (e.g. `'Signature'`). */
  lineLabel?: string;
}

export interface SectionPropsMap {
  basics: BasicsProps;
  personal: PersonalProps;
  summary: SummaryProps;
  work: WorkProps;
  education: EducationProps;
  skills: SkillsProps;
  projects: ProjectsProps;
  certifications: CertificationsProps;
  languages: LanguagesProps;
  signature: SignatureProps;
}

// ---------------------------------------------------------------------------
// Section & schema
// ---------------------------------------------------------------------------

export interface SectionSpecOf<K extends SectionKey = SectionKey> {
  key: K;
  label: string;
  enabled: boolean;
  order: number;
  column: SectionColumn;
  variant: SectionVariant;
  /**
   * Sections sharing a non-empty `group` value render together inside one
   * `tokens.groupClass` wrapper (e.g. certifications + languages side by side).
   * PRD §10 cannot express this; it is an M9 extension.
   */
  group?: string;
  props?: SectionPropsMap[K];
}

export type SectionSpec = { [K in SectionKey]: SectionSpecOf<K> }[SectionKey];

export interface TemplateSchema {
  id: string;
  name: string;
  version: number;
  origin: TemplateOrigin;
  page: TemplatePage;
  tokens: TemplateTokens;
  layout: TemplateLayout;
  sidebar?: SidebarSpec;
  sections: SectionSpec[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type SchemaValidationResult =
  | { ok: true; schema: TemplateSchema }
  | { ok: false; errors: string[] };

const ORIGINS: TemplateOrigin[] = ['builtin', 'generated', 'cloned'];
const PAGE_SIZES: PageSize[] = ['A4', 'Letter'];
const LAYOUTS: TemplateLayout[] = ['single', 'sidebar', 'header-band', 'tabular'];
const COLUMNS: SectionColumn[] = ['main', 'sidebar', 'header', 'full'];
const VARIANTS: SectionVariant[] = ['list', 'timeline', 'table', 'tags', 'chips', 'grid'];
const CONTACT_LAYOUTS: ContactLayout[] = [
  'icon-row',
  'icon-stack',
  'icon-line',
  'dotted',
  'labelled-box',
  'inline-labels',
  'inline',
];
const LINK_MODES: ContactLinkMode[] = ['row', 'box', 'inline', 'none'];
const WORK_LAYOUTS: WorkLayout[] = [
  'role-company-block',
  'role-date-then-company',
  'inline-role-company',
];
const EDUCATION_LAYOUTS: EducationLayout[] = [
  'degree-field-block',
  'inline-degree-field',
  'stacked',
];
const LANGUAGE_VARIANTS: LanguagesVariant[] = ['full', 'compact', 'stacked', 'inline'];
const PERSONAL_FIELD_KEYS: PersonalFieldKey[] = [
  'dob',
  'nationality',
  'maritalStatus',
  'visaStatus',
  'fatherName',
  'gender',
];
const SECTION_KEYS: SectionKey[] = [
  'basics',
  'personal',
  'summary',
  'work',
  'education',
  'skills',
  'projects',
  'certifications',
  'languages',
  'signature',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/**
 * Validate an arbitrary value as a `TemplateSchema`.
 *
 * Strict on structure (types, enumerations, required fields) but forgiving on
 * unknown keys, so later milestones can add fields without breaking older
 * documents. Returns the narrowed schema on success.
 */
export function validateTemplateSchema(value: unknown): SchemaValidationResult {
  const errors: string[] = [];

  const check = (condition: boolean, path: string, message: string) => {
    if (!condition) errors.push(`${path}: ${message}`);
  };

  if (!isRecord(value)) {
    return { ok: false, errors: ['schema: must be an object'] };
  }

  check(isNonEmptyString(value.id), 'id', 'must be a non-empty string');
  check(isNonEmptyString(value.name), 'name', 'must be a non-empty string');
  check(isFiniteNumber(value.version), 'version', 'must be a finite number');
  check(
    typeof value.origin === 'string' && ORIGINS.includes(value.origin as TemplateOrigin),
    'origin',
    `must be one of ${ORIGINS.join(' | ')}`
  );
  check(
    typeof value.layout === 'string' && LAYOUTS.includes(value.layout as TemplateLayout),
    'layout',
    `must be one of ${LAYOUTS.join(' | ')}`
  );

  // --- page ---------------------------------------------------------------
  if (!isRecord(value.page)) {
    errors.push('page: must be an object');
  } else {
    const page = value.page;
    check(
      typeof page.size === 'string' && PAGE_SIZES.includes(page.size as PageSize),
      'page.size',
      `must be one of ${PAGE_SIZES.join(' | ')}`
    );
    check(isNonEmptyString(page.margins), 'page.margins', 'must be a non-empty string');
    check(isFiniteNumber(page.targetPages), 'page.targetPages', 'must be a finite number');
  }

  // --- tokens -------------------------------------------------------------
  if (!isRecord(value.tokens)) {
    errors.push('tokens: must be an object');
  } else {
    const tokens = value.tokens;

    if (!isRecord(tokens.fonts)) {
      errors.push('tokens.fonts: must be an object');
    } else {
      check(
        isNonEmptyString((tokens.fonts as Record<string, unknown>).heading),
        'tokens.fonts.heading',
        'must be a non-empty string'
      );
      check(
        isNonEmptyString((tokens.fonts as Record<string, unknown>).body),
        'tokens.fonts.body',
        'must be a non-empty string'
      );
    }

    check(isFiniteNumber(tokens.scale), 'tokens.scale', 'must be a finite number');
    check(isFiniteNumber(tokens.lineHeight), 'tokens.lineHeight', 'must be a finite number');
    check(isFiniteNumber(tokens.radius), 'tokens.radius', 'must be a finite number');

    const requiredColors = ['heading', 'body', 'muted', 'accent', 'rule', 'background'];
    if (!isRecord(tokens.colors)) {
      errors.push('tokens.colors: must be an object');
    } else {
      for (const key of requiredColors) {
        check(
          isNonEmptyString((tokens.colors as Record<string, unknown>)[key]),
          `tokens.colors.${key}`,
          'must be a non-empty string'
        );
      }
    }

    if (!isRecord(tokens.spacing)) {
      errors.push('tokens.spacing: must be an object');
    } else {
      for (const key of ['page', 'section', 'item']) {
        check(
          isFiniteNumber((tokens.spacing as Record<string, unknown>)[key]),
          `tokens.spacing.${key}`,
          'must be a finite number'
        );
      }
    }

    if (!isRecord(tokens.borders)) {
      errors.push('tokens.borders: must be an object');
    } else {
      check(
        isFiniteNumber((tokens.borders as Record<string, unknown>).ruleWidth),
        'tokens.borders.ruleWidth',
        'must be a finite number'
      );
      check(
        isNonEmptyString((tokens.borders as Record<string, unknown>).ruleStyle),
        'tokens.borders.ruleStyle',
        'must be a non-empty string'
      );
    }

    for (const key of ['rootClass', 'bodyClass', 'groupClass', 'headingClass']) {
      check(isNonEmptyString(tokens[key]), `tokens.${key}`, 'must be a non-empty string');
    }
    for (const key of ['splitClass', 'splitMainClass', 'splitSidebarClass']) {
      check(isOptionalString(tokens[key]), `tokens.${key}`, 'must be a string when present');
    }
  }

  // --- sidebar ------------------------------------------------------------
  if (value.sidebar !== undefined) {
    if (!isRecord(value.sidebar)) {
      errors.push('sidebar: must be an object when present');
    } else {
      const sidebar = value.sidebar;
      check(isFiniteNumber(sidebar.widthPct), 'sidebar.widthPct', 'must be a finite number');
      check(isNonEmptyString(sidebar.background), 'sidebar.background', 'must be a non-empty string');
      check(
        sidebar.position === undefined || sidebar.position === 'left' || sidebar.position === 'right',
        'sidebar.position',
        'must be left | right'
      );
      for (const key of ['containerClass', 'innerClass', 'footerText', 'footerClass']) {
        check(isOptionalString(sidebar[key]), `sidebar.${key}`, 'must be a string when present');
      }
    }
  }

  // --- sections -----------------------------------------------------------
  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    errors.push('sections: must be a non-empty array');
  } else {
    value.sections.forEach((section, index) => {
      const at = `sections[${index}]`;
      if (!isRecord(section)) {
        errors.push(`${at}: must be an object`);
        return;
      }
      check(
        typeof section.key === 'string' && SECTION_KEYS.includes(section.key as SectionKey),
        `${at}.key`,
        `must be one of ${SECTION_KEYS.join(' | ')}`
      );
      check(typeof section.label === 'string', `${at}.label`, 'must be a string');
      check(typeof section.enabled === 'boolean', `${at}.enabled`, 'must be a boolean');
      check(isFiniteNumber(section.order), `${at}.order`, 'must be a finite number');
      check(
        typeof section.column === 'string' && COLUMNS.includes(section.column as SectionColumn),
        `${at}.column`,
        `must be one of ${COLUMNS.join(' | ')}`
      );
      check(
        typeof section.variant === 'string' && VARIANTS.includes(section.variant as SectionVariant),
        `${at}.variant`,
        `must be one of ${VARIANTS.join(' | ')}`
      );
      if (section.group !== undefined) {
        check(isNonEmptyString(section.group), `${at}.group`, 'must be a non-empty string');
      }
      if (section.props !== undefined) {
        check(isRecord(section.props), `${at}.props`, 'must be an object when present');
      }
    });

    // Per-key structural checks for the sections the renderer supports.
    const byKey = new Map<string, Record<string, unknown>>();
    for (const section of value.sections) {
      if (isRecord(section) && typeof section.key === 'string') {
        byKey.set(section.key, section);
      }
    }

    const requireProps = (key: SectionKey) => {
      const section = byKey.get(key);
      if (!section || section.enabled === false) return undefined;
      if (!isRecord(section.props)) {
        errors.push(`sections(${key}).props: required for an enabled section`);
        return undefined;
      }
      return section.props;
    };

    const basicsProps = requireProps('basics');
    if (basicsProps) {
      check(isString(basicsProps.containerClass), 'basics.containerClass', 'must be a string');
      check(isNonEmptyString(basicsProps.nameClass), 'basics.nameClass', 'must be a non-empty string');
      check(isNonEmptyString(basicsProps.nameFallback), 'basics.nameFallback', 'must be a non-empty string');
      check(
        basicsProps.layout === undefined || basicsProps.layout === 'stack' || basicsProps.layout === 'split',
        'basics.layout',
        'must be stack | split'
      );
      if (basicsProps.badge !== undefined) {
        check(isRecord(basicsProps.badge), 'basics.badge', 'must be an object when present');
      }
      if (!isRecord(basicsProps.headline)) {
        errors.push('basics.headline: must be an object');
      } else {
        check(
          typeof basicsProps.headline.enabled === 'boolean',
          'basics.headline.enabled',
          'must be a boolean'
        );
      }
      if (!isRecord(basicsProps.contacts)) {
        errors.push('basics.contacts: must be an object');
      } else {
        check(
          typeof basicsProps.contacts.layout === 'string' &&
            CONTACT_LAYOUTS.includes(basicsProps.contacts.layout as ContactLayout),
          'basics.contacts.layout',
          `must be one of ${CONTACT_LAYOUTS.join(' | ')}`
        );
        check(
          isNonEmptyString(basicsProps.contacts.rowClass),
          'basics.contacts.rowClass',
          'must be a non-empty string'
        );
        check(
          typeof basicsProps.contacts.linkMode === 'string' &&
            LINK_MODES.includes(basicsProps.contacts.linkMode as ContactLinkMode),
          'basics.contacts.linkMode',
          `must be one of ${LINK_MODES.join(' | ')}`
        );
      }
    }

    const summaryProps = requireProps('summary');
    if (summaryProps) {
      check(isNonEmptyString(summaryProps.className), 'summary.className', 'must be a non-empty string');
    }

    const workProps = requireProps('work');
    if (workProps) {
      check(
        typeof workProps.layout === 'string' &&
          WORK_LAYOUTS.includes(workProps.layout as WorkLayout),
        'work.layout',
        `must be one of ${WORK_LAYOUTS.join(' | ')}`
      );
      check(isNonEmptyString(workProps.listClass), 'work.listClass', 'must be a non-empty string');
      check(isNonEmptyString(workProps.rowClass), 'work.rowClass', 'must be a non-empty string');
    }

    const educationProps = requireProps('education');
    if (educationProps) {
      check(
        typeof educationProps.layout === 'string' &&
          EDUCATION_LAYOUTS.includes(educationProps.layout as EducationLayout),
        'education.layout',
        `must be one of ${EDUCATION_LAYOUTS.join(' | ')}`
      );
      check(
        isNonEmptyString(educationProps.listClass),
        'education.listClass',
        'must be a non-empty string'
      );
    }

    for (const key of ['skills', 'projects', 'certifications', 'languages'] as const) {
      const props = requireProps(key);
      if (props) {
        check(isNonEmptyString(props.listClass), `${key}.listClass`, 'must be a non-empty string');
      }
    }

    const skillsProps = requireProps('skills');
    if (skillsProps) {
      check(
        skillsProps.itemsMode === undefined || skillsProps.itemsMode === 'inline' || skillsProps.itemsMode === 'chips',
        'skills.itemsMode',
        'must be inline | chips'
      );
    }

    const certProps = requireProps('certifications');
    if (certProps) {
      check(
        certProps.variant === 'full' || certProps.variant === 'compact',
        'certifications.variant',
        'must be full | compact'
      );
    }
    const langProps = requireProps('languages');
    if (langProps) {
      check(
        typeof langProps.variant === 'string' &&
          LANGUAGE_VARIANTS.includes(langProps.variant as LanguagesVariant),
        'languages.variant',
        `must be one of ${LANGUAGE_VARIANTS.join(' | ')}`
      );
    }

    const personalProps = requireProps('personal');
    if (personalProps && personalProps.fields !== undefined) {
      check(Array.isArray(personalProps.fields), 'personal.fields', 'must be an array when present');
      if (Array.isArray(personalProps.fields)) {
        personalProps.fields.forEach((field, index) => {
          check(
            typeof field === 'string' && PERSONAL_FIELD_KEYS.includes(field as PersonalFieldKey),
            `personal.fields[${index}]`,
            `must be one of ${PERSONAL_FIELD_KEYS.join(' | ')}`
          );
        });
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, schema: value as unknown as TemplateSchema };
}

/** Convenience: find one section by key. */
export function findSection(
  schema: TemplateSchema,
  key: SectionKey
): SectionSpec | undefined {
  return schema.sections.find((section) => section.key === key);
}

/**
 * Runtime shape guard for callers that receive parsed JSON (chat-generated
 * templates land here first — PRD §5.5).
 */
export function isTemplateSchema(value: unknown): value is TemplateSchema {
  return validateTemplateSchema(value).ok;
}

/** Type re-export so renderer callers do not need `../types` directly. */
export type { ResumeJSON };

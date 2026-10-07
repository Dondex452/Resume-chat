/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The ONE generic renderer (PRD §5.3, §10, M9).
 *
 * It consumes a `TemplateSchema` + `ResumeJSON` and produces the resume. There
 * is no per-template branch anywhere in this file: every class it applies comes
 * either from `schema.tokens` or from a section's `props` bag. Adding a design
 * is adding data (`./builtin.ts`), never code.
 *
 * M9 Stage 1 supported `layout: 'single'` with the `list` variant. Stage 2 adds
 * the structurally harder designs:
 *   - `layout: 'sidebar'` — a full-height flex row (creative, sidebar), where
 *     `column: 'sidebar'` sections (including `basics`) form a styled column.
 *   - the body split — `column: 'full'` lead sections plus a main/sidebar two-
 *     column grid (slate, `layout: 'header-band'`).
 *   - `icon-stack` / `icon-line` / `inline-labels` / `inline` contacts,
 *     `chips` skills, `stacked` / `inline` languages, `stacked` education, a
 *     work timeline `markerClass`, and a `split` basics block.
 * Still zero per-template-id branches.
 */

import React from 'react';
import { Mail, Phone, MapPin, Link as LinkIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ResumeJSON } from '../types';
import type {
  TemplateSchema,
  SectionSpec,
  BasicsProps,
  ContactsProps,
  SummaryProps,
  WorkProps,
  EducationProps,
  SkillsProps,
  ProjectsProps,
  CertificationsProps,
  LanguagesProps,
  PersonalProps,
  PersonalFieldKey,
  SignatureProps,
} from './schema';

export interface SchemaResumeRendererProps {
  schema: TemplateSchema;
  data: ResumeJSON | null | undefined;
}

function joinClasses(...parts: Array<string | undefined | null | false>): string | undefined {
  const joined = parts.filter((part): part is string => Boolean(part && part.trim())).join(' ');
  return joined.length > 0 ? joined : undefined;
}

/** Section wrappers use `|| undefined` so an empty class never renders `class=""`. */
function cn(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

/**
 * Inert pagination markers (PRD §11, amended 2026-09-21 — M16).
 *
 * A measuring pass needs to find the section wrappers, their headings and the
 * repeatable blocks without a second, bespoke DOM walk. The renderer therefore
 * emits **only `data-*` attributes** — never a class, a style or a wrapper
 * element — so the ten pixel-verified built-in baselines cannot move.
 *
 *   - `data-paginate-section` on a section wrapper (and repeated on each of its
 *     blocks so a block stays self-describing once it is moved to a new page);
 *   - `data-paginate-heading` on a section's heading, when the design has one
 *     (its height must be measurable separately from the blocks);
 *   - `data-paginate-block` + `data-paginate-section` + `data-paginate-index`
 *     on each repeatable block (work entry, education row, project, …);
 *   - `data-paginate-block` + `data-paginate-atomic` on a section whose body is
 *     one unbreakable unit (a skills blob, the signature).
 *
 * Empty-string values are used for presence-only markers; nothing reads the
 * value, only the attribute's presence.
 */
type PaginateAttrs = Record<string, string>;

/** A section wrapper marker. */
function sectionAttrs(sectionKey: string): PaginateAttrs {
  return { 'data-paginate-section': sectionKey };
}

/** A repeatable block: the section it belongs to plus its 0-based index. */
function blockAttrs(sectionKey: string, index: number): PaginateAttrs {
  return {
    'data-paginate-section': sectionKey,
    'data-paginate-block': '',
    'data-paginate-index': String(index),
  };
}

/**
 * An atomic section body that also anchors its own section (used where the
 * section has no separate wrapper element — the header basics block and the
 * signature line block).
 */
function atomicSectionAttrs(sectionKey: string): PaginateAttrs {
  return {
    'data-paginate-section': sectionKey,
    'data-paginate-block': '',
    'data-paginate-atomic': '',
  };
}

/** An atomic block inside a section that already has a wrapper. */
function atomicBlockAttrs(): PaginateAttrs {
  return { 'data-paginate-block': '', 'data-paginate-atomic': '' };
}

function hasHeaderBasics(data: ResumeJSON): boolean {
  const basics = data.basics || {};
  return Boolean(basics.fullName || basics.email || basics.phone || basics.location || basics.summary);
}

/** Neutral photo treatment; a design may override it via `basics.props.photo`. */
const DEFAULT_PHOTO_CLASS = 'h-24 w-20 shrink-0 rounded object-cover';

/**
 * The personal-detail fields, in canonical order, with their labels. Labels are
 * English: PRD §5.4 localises *section* labels only, and §5.4.1 lists no
 * per-field translations, so nothing is invented here.
 */
const PERSONAL_FIELD_ORDER: PersonalFieldKey[] = [
  'dob',
  'nationality',
  'maritalStatus',
  'visaStatus',
  'fatherName',
  'gender',
];

const PERSONAL_FIELD_LABELS: Record<PersonalFieldKey, string> = {
  dob: 'Date of birth',
  nationality: 'Nationality',
  maritalStatus: 'Marital status',
  visaStatus: 'Visa status',
  fatherName: "Father's name",
  gender: 'Gender',
};

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

type ContactKey = 'email' | 'phone' | 'location';

interface ContactEntry {
  key: ContactKey;
  Icon: LucideIcon;
  value: string;
}

function contactEntries(basics: ResumeJSON['basics']): ContactEntry[] {
  const entries: ContactEntry[] = [];
  if (!basics) return entries;
  if (basics.email) entries.push({ key: 'email', Icon: Mail, value: basics.email });
  if (basics.phone) entries.push({ key: 'phone', Icon: Phone, value: basics.phone });
  if (basics.location) entries.push({ key: 'location', Icon: MapPin, value: basics.location });
  return entries;
}

function Contacts({ props, data }: { props: ContactsProps; data: ResumeJSON }) {
  const basics = data.basics || {};
  const entries = contactEntries(basics);
  // The pre-M9 renderer treated `links` as `{label,url}` objects; real stored
  // data has also contained bare strings. Accessing `.label`/`.url` on a string
  // yields `undefined`, which renders nothing — the schema renderer must
  // reproduce that exactly rather than falling back to the raw value.
  const links = (basics.links || []) as unknown as Array<{ label?: string; url?: string }>;

  const items = entries.map((entry, index) => {
    const bullet = props.bulletSkipFirst && index === 0 ? '' : props.bulletPrefix;

    if (props.layout === 'labelled-box') {
      return (
        <div key={entry.key}>
          {props.labelPrefixes[entry.key]}
          {entry.value}
        </div>
      );
    }

    if (props.layout === 'inline-labels') {
      return (
        <span key={entry.key} className={cn(props.itemClass)}>
          {props.labelPrefixes[entry.key]}
          {entry.value}
        </span>
      );
    }

    if (props.layout === 'icon-line') {
      const Icon = entry.Icon;
      return (
        <div key={entry.key} className={cn(props.itemClass)}>
          <Icon size={12} className={cn(props.iconClass)} />
          {' '}
          {entry.value}
        </div>
      );
    }

    if (props.layout === 'icon-stack') {
      const Icon = entry.Icon;
      return (
        <div key={entry.key} className={cn(props.itemClass)}>
          <Icon size={12} className={cn(props.iconClass)} />
          <span className={props.truncateEmail && entry.key === 'email' ? 'truncate' : undefined}>
            {entry.value}
          </span>
        </div>
      );
    }

    if (props.layout === 'icon-row') {
      const Icon = entry.Icon;
      return (
        <span key={entry.key} className={cn(props.itemClass)}>
          <Icon size={12} className={cn(props.iconClass)} />
          {' '}
          {bullet}
          {entry.value}
        </span>
      );
    }

    // dotted | inline — plain spans, bullet-prefixed after the first.
    return (
      <span key={entry.key} className={cn(props.itemClass)}>
        {bullet}
        {entry.value}
      </span>
    );
  });

  const linkNodes =
    props.linkMode === 'none'
      ? []
      : links.map((link, index) => {
          const text = link.label || props.linkFallback || link.url;

          if (props.linkMode === 'inline') {
            return (
              <span key={index}>
                {props.bulletPrefix}
                <a href={link.url} target="_blank" rel="noreferrer noopener" className={cn(props.linkClass)}>
                  {text}
                </a>
              </span>
            );
          }

          if (props.linkIcon) {
            return (
              <a key={index} href={link.url} target="_blank" rel="noreferrer noopener" className={cn(props.linkClass)}>
                <LinkIcon size={12} className={cn(props.linkIconClass)} />
                <span>{text}</span>
              </a>
            );
          }

          return (
            <a key={index} href={link.url} target="_blank" rel="noreferrer noopener" className={cn(props.linkClass)}>
              {props.linkPrefix}
              {text}
              {props.linkSuffix}
            </a>
          );
        });

  if (props.layout === 'labelled-box') {
    return (
      <div className={cn(props.rowClass)}>
        {items}
        {props.linkMode === 'box' && linkNodes.length > 0 && (
          <div className={cn(props.linksRowClass)}>{linkNodes}</div>
        )}
      </div>
    );
  }

  if (props.layout === 'inline') {
    return (
      <div className={cn(props.rowClass)}>
        {items}
        {props.linkMode === 'inline' ? linkNodes : null}
      </div>
    );
  }

  return (
    <>
      <div className={cn(props.rowClass)}>{items}</div>
      {props.linkMode === 'row' && linkNodes.length > 0 && (
        <div className={cn(props.linksRowClass)}>{linkNodes}</div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Basics / header region
// ---------------------------------------------------------------------------

function BasicsBlock({
  props,
  data,
  sectionAnchor,
}: {
  props: BasicsProps;
  data: ResumeJSON;
  /**
   * True only in the header region, where `BasicsBlock` is rendered without a
   * section wrapper. It then anchors the `basics` section (and its single atomic
   * block) on the outermost element it already renders: the split row, the
   * photo row, or — in the plain stack layout, which has no container element at
   * all — the name heading. The body (`renderBodySection`) wraps the block in a
   * marked div instead, so the anchor is never duplicated.
   */
  sectionAnchor?: boolean;
}) {
  const basics = data.basics || {};
  const headlineRole = data.work?.[0]?.role;

  // PRD §8: the photo is emitted only when the data is present, and only when
  // the active country preset does not suppress it (US/CA/UK/NL/AU carry no
  // photo). Absent `props.photo.enabled` means enabled.
  const photo =
    basics.photo && (props.photo?.enabled ?? true) ? (
      <img
        src={basics.photo}
        alt=""
        className={props.photo?.className || DEFAULT_PHOTO_CLASS}
      />
    ) : null;

  // Which existing element anchors the section when the caller has no wrapper.
  // The split row wins (everything is inside it); then the photo row; then the
  // name heading, which is the only element guaranteed in the stack layout.
  const anchorOnPhoto = sectionAnchor === true && props.layout !== 'split' && Boolean(photo);
  const anchorOnName = sectionAnchor === true && props.layout !== 'split' && !photo;

  const identityCore = (
    <>
      {props.badge && <span className={cn(props.badge.className)}>{props.badge.text}</span>}
      <h1 className={props.nameClass} {...(anchorOnName ? atomicSectionAttrs('basics') : {})}>
        {basics.fullName || props.nameFallback}
      </h1>
      {props.headline.enabled && (
        <p className={props.headline.className}>
          {props.headline.prefix}
          {headlineRole || props.headline.fallback}
        </p>
      )}
    </>
  );

  const identity = photo ? (
    <div
      className="flex items-start justify-between gap-4"
      {...(anchorOnPhoto ? atomicSectionAttrs('basics') : {})}
    >
      <div className="min-w-0 flex-1">{identityCore}</div>
      {photo}
    </div>
  ) : (
    identityCore
  );

  if (props.layout === 'split') {
    return (
      <div
        className={cn(props.splitRowClass)}
        {...(sectionAnchor ? atomicSectionAttrs('basics') : {})}
      >
        <div className={cn(props.splitLeftClass)}>{identity}</div>
        <div className={cn(props.splitRightClass)}>
          <Contacts props={props.contacts} data={data} />
        </div>
      </div>
    );
  }

  return (
    <>
      {identity}
      <Contacts props={props.contacts} data={data} />
    </>
  );
}

function HeaderRegion({ schema, data }: { schema: TemplateSchema; data: ResumeJSON }) {
  const headerSections = schema.sections
    .filter((section) => section.enabled && section.column === 'header')
    .sort((a, b) => a.order - b.order);

  if (headerSections.length === 0 || !hasHeaderBasics(data)) return null;

  const basicsSection = headerSections.find((section) => section.key === 'basics');
  const containerClass = (basicsSection?.props as BasicsProps | undefined)?.containerClass;

  return (
    // The header is a region, not a peer section, so it carries a column marker
    // rather than a section one; the sections inside it are marked by
    // `BasicsBlock` (which has no wrapper element of its own) and by the summary
    // paragraph below.
    <div className={cn(containerClass)} data-paginate-column="header">
      {headerSections.map((section) => {
        if (section.key === 'basics') {
          return (
            <BasicsBlock
              key="basics"
              props={section.props as BasicsProps}
              data={data}
              sectionAnchor
            />
          );
        }
        if (section.key === 'summary') {
          const props = section.props as SummaryProps | undefined;
          if (!data.basics?.summary || !props) return null;
          // A header summary is bare by default; a country preset may give it a
          // label (UK's "Personal Statement"), which renders as a heading. No
          // built-in sets one, so pre-M10 output is unchanged.
          return (
            <React.Fragment key="summary">
              <SectionHeading schema={schema} section={section} override={props.headingClass} />
              <p className={props.className} {...atomicSectionAttrs('summary')}>
                {data.basics.summary}
              </p>
            </React.Fragment>
          );
        }
        return null;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section heading
// ---------------------------------------------------------------------------

function SectionHeading({
  schema,
  section,
  override,
}: {
  schema: TemplateSchema;
  section: SectionSpec;
  override?: string;
}) {
  if (!section.label) return null;
  return (
    <h2 className={override ?? schema.tokens.headingClass} data-paginate-heading="">
      {section.label}
    </h2>
  );
}

// ---------------------------------------------------------------------------
// Body sections
// ---------------------------------------------------------------------------

function WorkSection({
  props,
  items,
  heading,
}: {
  props: WorkProps;
  items: NonNullable<ResumeJSON['work']>;
  heading: React.ReactNode;
}) {
  const RoleTag = props.roleTag;
  const CompanyTag = props.companyTag;
  return (
    <div className={cn(props.containerClass)} {...sectionAttrs('work')}>
      {heading}
      <div className={props.listClass}>
        {items.map((work, index) => {
          // Rendered as three separate text nodes, exactly like the original
          // JSX (`{start} — {end}`); collapsing them into one string shifts the
          // glyph shaping by a sub-pixel amount (GOTCHA-style trap).
          const dates = (
            <>
              {work.start}
              {props.dateSeparator}
              {work.end || props.endFallback}
            </>
          );
          const marker = props.markerClass ? <div className={props.markerClass} /> : null;
          const highlights =
            work.highlights && work.highlights.length > 0 ? (
              <ul className={props.highlightsClass}>
                {work.highlights.map((highlight, highlightIndex) => (
                  <li key={highlightIndex} className={cn(props.highlightItemClass)}>
                    {props.highlightPrefix}
                    {highlight}
                  </li>
                ))}
              </ul>
            ) : null;

          if (props.layout === 'role-company-block') {
            return (
              <div key={index} className={cn(props.itemClass)} {...blockAttrs('work', index)}>
                {marker}
                <div className={props.rowClass}>
                  <div>
                    <RoleTag className={props.roleClass}>{work.role}</RoleTag>
                    <CompanyTag className={props.companyClass}>{work.company}</CompanyTag>
                  </div>
                  <span className={props.dateClass}>{dates}</span>
                </div>
                {highlights}
              </div>
            );
          }

          if (props.layout === 'role-date-then-company') {
            return (
              <div key={index} className={cn(props.itemClass)} {...blockAttrs('work', index)}>
                {marker}
                <div className={props.rowClass}>
                  <RoleTag className={props.roleClass}>{work.role}</RoleTag>
                  <span className={props.dateClass}>{dates}</span>
                </div>
                <CompanyTag className={props.companyClass}>{work.company}</CompanyTag>
                {highlights}
              </div>
            );
          }

          return (
            <div key={index} className={cn(props.itemClass)} {...blockAttrs('work', index)}>
              {marker}
              <div className={props.rowClass}>
                <span className={props.roleClass}>
                  {work.role}
                  {props.inlineSeparator}
                  {work.company}
                </span>
                <span className={props.dateClass}>{dates}</span>
              </div>
              {highlights}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EducationSection({
  props,
  items,
  heading,
}: {
  props: EducationProps;
  items: NonNullable<ResumeJSON['education']>;
  heading: React.ReactNode;
}) {
  const DegreeTag = props.degreeTag;
  const FieldTag = props.fieldTag ?? 'p';
  const SchoolTag = props.schoolTag;
  const DateTag = props.dateTag ?? 'span';
  return (
    <div className={cn(props.containerClass)} {...sectionAttrs('education')}>
      {heading}
      <div className={props.listClass}>
        {items.map((entry, index) => {
          const dates = (
            <>
              {entry.start}
              {props.dateSeparator}
              {entry.end || props.endFallback}
            </>
          );

          if (props.layout === 'stacked') {
            return (
              <div key={index} className={cn(props.itemClass)} {...blockAttrs('education', index)}>
                <DegreeTag className={props.degreeClass}>{entry.degree}</DegreeTag>
                {props.includeField !== false && (
                  <FieldTag className={cn(props.fieldClass)}>{entry.field}</FieldTag>
                )}
                <SchoolTag className={props.schoolClass}>{entry.school}</SchoolTag>
                <DateTag className={props.dateClass}>{dates}</DateTag>
              </div>
            );
          }

          if (props.layout === 'degree-field-block') {
            return (
              <div
                key={index}
                className={joinClasses(props.rowClass, props.itemClass)}
                {...blockAttrs('education', index)}
              >
                <div>
                  <DegreeTag className={props.degreeClass}>
                    {entry.degree}
                    {props.degreeFieldSeparator}
                    {entry.field}
                    {props.degreeFieldSuffix}
                  </DegreeTag>
                  <SchoolTag className={props.schoolClass}>{entry.school}</SchoolTag>
                </div>
                <span className={props.dateClass}>{dates}</span>
              </div>
            );
          }

          return (
            <div
              key={index}
              className={joinClasses(props.rowClass, props.itemClass)}
              {...blockAttrs('education', index)}
            >
              <div>
                <span className={props.degreeClass}>{entry.degree}</span>
                {props.degreeFieldSeparator}
                {entry.field}
                {props.degreeFieldSuffix}
                <SchoolTag className={props.schoolClass}>{entry.school}</SchoolTag>
              </div>
              <span className={props.dateClass}>{dates}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SkillsSection({
  props,
  items,
  heading,
}: {
  props: SkillsProps;
  items: NonNullable<ResumeJSON['skills']>;
  heading: React.ReactNode;
}) {
  const chips = props.itemsMode === 'chips';
  return (
    <div className={cn(props.containerClass)} {...sectionAttrs('skills')}>
      {heading}
      {/* Skills flow as one blob — a category split from its items reads wrong,
          so the whole body is a single atomic block. */}
      <div className={props.listClass} {...atomicBlockAttrs()}>
        {items.map((skill, index) => (
          <div key={index} className={cn(props.itemClass)}>
            {chips ? (
              <>
                <div className={cn(props.categoryClass)}>{skill.category}</div>
                <div className={cn(props.itemsWrapClass)}>
                  {(skill.items || []).map((item, itemIndex) => (
                    <span key={itemIndex} className={cn(props.chipClass)}>
                      {item}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <>
                <span className={props.categoryClass}>
                  {props.categoryPrefix}
                  {skill.category}
                  {props.categorySuffix}
                </span>
                {props.itemsPrefix}
                <span className={cn(props.itemsClass)}>{(skill.items || []).join(', ')}</span>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProjectsSection({
  props,
  items,
  heading,
}: {
  props: ProjectsProps;
  items: NonNullable<ResumeJSON['projects']>;
  heading: React.ReactNode;
}) {
  const NameTag = props.nameTag;
  return (
    <div className={cn(props.containerClass)} {...sectionAttrs('projects')}>
      {heading}
      <div className={props.listClass}>
        {items.map((project, index) => (
          <div key={index} className={cn(props.itemClass)} {...blockAttrs('projects', index)}>
            <div className={props.rowClass}>
              <NameTag className={cn(props.nameClass)}>{project.name}</NameTag>
              {project.link && (
                <a href={project.link} target="_blank" rel="noreferrer" className={props.linkClass}>
                  {props.linkLabel}
                </a>
              )}
            </div>
            <p className={props.descriptionClass}>{project.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function CertificationsSection({
  props,
  items,
  heading,
}: {
  props: CertificationsProps;
  items: NonNullable<ResumeJSON['certifications']>;
  heading: React.ReactNode;
}) {
  return (
    <div className={cn(props.containerClass)} {...sectionAttrs('certifications')}>
      {heading}
      <ul className={props.listClass}>
        {items.map((cert, index) => (
          <li key={index} className={cn(props.itemClass)} {...blockAttrs('certifications', index)}>
            {props.variant === 'compact' ? (
              <>
                * <span className={props.primaryClass}>{cert.name}</span> ({cert.issuer})
              </>
            ) : (
              <>
                <span className={props.primaryClass}>{cert.name}</span> — {cert.issuer} ({cert.date})
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LanguagesSection({
  props,
  items,
  heading,
}: {
  props: LanguagesProps;
  items: NonNullable<ResumeJSON['languages']>;
  heading: React.ReactNode;
}) {
  const listVariant = props.variant === 'full' || props.variant === 'compact';
  return (
    <div className={cn(props.containerClass)} {...sectionAttrs('languages')}>
      {heading}
      {listVariant ? (
        <ul className={props.listClass}>
          {items.map((language, index) => (
            <li key={index} className={cn(props.itemClass)} {...blockAttrs('languages', index)}>
              {props.variant === 'compact' ? (
                <>
                  * {language.name} [{language.proficiency}]
                </>
              ) : (
                <>
                  <span className={props.primaryClass}>{language.name}</span> — {language.proficiency}
                </>
              )}
            </li>
          ))}
        </ul>
      ) : props.variant === 'stacked' ? (
        <div className={props.listClass}>
          {items.map((language, index) => (
            <div key={index} className={cn(props.itemClass)} {...blockAttrs('languages', index)}>
              <div className={props.primaryClass}>{language.name}</div>
              <div className={cn(props.secondaryClass)}>{language.proficiency}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className={props.listClass}>
          {items.map((language, index) => (
            <div key={index} className={cn(props.itemClass)} {...blockAttrs('languages', index)}>
              <span className={props.primaryClass}>{language.name}</span>: <span className={cn(props.secondaryClass)}>{language.proficiency}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Country-preset blocks: personal details + signature (M10)
// ---------------------------------------------------------------------------

function PersonalSection({
  schema,
  section,
  data,
}: {
  schema: TemplateSchema;
  section: SectionSpec;
  data: ResumeJSON;
}) {
  const props = section.props as PersonalProps | undefined;
  const personal = data.personal;
  if (!props || !personal) return null;

  const fields =
    props.fields && props.fields.length > 0 ? props.fields : PERSONAL_FIELD_ORDER;
  const entries = fields
    .map((key) => ({ key, value: personal[key] }))
    .filter(
      (entry): entry is { key: PersonalFieldKey; value: string } =>
        typeof entry.value === 'string' && entry.value.trim().length > 0
    );

  // PRD §8: no present field means no block and no heading at all.
  if (entries.length === 0) return null;

  return (
    <div className={cn(props.containerClass)} {...sectionAttrs('personal')}>
      <SectionHeading schema={schema} section={section} override={props.headingClass} />
      <div className={cn(props.listClass)}>
        {entries.map((entry, index) => (
          <div key={entry.key} className={cn(props.rowClass)} {...blockAttrs('personal', index)}>
            <span className={cn(props.labelClass)}>
              {PERSONAL_FIELD_LABELS[entry.key]}
              {props.separator ?? ': '}
            </span>
            <span className={cn(props.valueClass)}>{entry.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SignatureSection({
  schema,
  section,
  data,
}: {
  schema: TemplateSchema;
  section: SectionSpec;
  data: ResumeJSON;
}) {
  const props = section.props as SignatureProps | undefined;
  const signature = data.signature;
  if (!props || !signature) return null;

  const place = typeof signature.place === 'string' ? signature.place.trim() : '';
  const date = typeof signature.date === 'string' ? signature.date.trim() : '';
  const hasSignedFlag = typeof signature.signed === 'boolean';

  // An object with no place, date or signed flag is not a signature.
  if (!place && !date && !hasSignedFlag) return null;

  // The ruled line and the place/date row are one unbreakable unit. The block
  // marker sits on the section wrapper because the body has no single inner
  // container element. The default label is empty, so `headingHeight` is 0 for
  // every shipped design and preset; a template that adds a label would need the
  // heading height subtracted by the caller.
  return (
    <div className={cn(props.containerClass)} {...atomicSectionAttrs('signature')}>
      <SectionHeading schema={schema} section={section} override={props.headingClass} />
      {(place || date) && (
        <div className={cn(props.rowClass)}>
          {place && <span className={cn(props.placeClass)}>{place}</span>}
          {date && <span className={cn(props.dateClass)}>{date}</span>}
        </div>
      )}
      <div className={cn(props.lineClass)}>{props.lineLabel}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dispatch + top-level
// ---------------------------------------------------------------------------

function renderBodySection(
  schema: TemplateSchema,
  section: SectionSpec,
  data: ResumeJSON
): React.ReactNode {
  const headingFor = (override?: string) => (
    <SectionHeading schema={schema} section={section} override={override} />
  );

  switch (section.key) {
    case 'basics': {
      const props = section.props as BasicsProps | undefined;
      if (!props || !hasHeaderBasics(data)) return null;
      return (
        <div key="basics" className={cn(props.containerClass)} {...atomicSectionAttrs('basics')}>
          <BasicsBlock props={props} data={data} />
        </div>
      );
    }
    case 'summary': {
      const props = section.props as SummaryProps | undefined;
      if (!props || !data.basics?.summary) return null;
      return (
        <div key="summary" className={cn(props.containerClass)} {...sectionAttrs('summary')}>
          <SectionHeading schema={schema} section={section} override={props.headingClass} />
          <p className={props.className} {...atomicBlockAttrs()}>
            {data.basics.summary}
          </p>
        </div>
      );
    }
    case 'work': {
      const items = data.work;
      const props = section.props;
      if (!items || items.length === 0 || !props) return null;
      return <WorkSection key="work" props={props} items={items} heading={headingFor(props.headingClass)} />;
    }
    case 'education': {
      const items = data.education;
      const props = section.props;
      if (!items || items.length === 0 || !props) return null;
      return (
        <EducationSection key="education" props={props} items={items} heading={headingFor(props.headingClass)} />
      );
    }
    case 'skills': {
      const items = data.skills;
      const props = section.props;
      if (!items || items.length === 0 || !props) return null;
      return <SkillsSection key="skills" props={props} items={items} heading={headingFor(props.headingClass)} />;
    }
    case 'projects': {
      const items = data.projects;
      const props = section.props;
      if (!items || items.length === 0 || !props) return null;
      return (
        <ProjectsSection key="projects" props={props} items={items} heading={headingFor(props.headingClass)} />
      );
    }
    case 'certifications': {
      const items = data.certifications;
      const props = section.props;
      if (!items || items.length === 0 || !props) return null;
      return (
        <CertificationsSection
          key="certifications"
          props={props}
          items={items}
          heading={headingFor(props.headingClass)}
        />
      );
    }
    case 'languages': {
      const items = data.languages;
      const props = section.props;
      if (!items || items.length === 0 || !props) return null;
      return (
        <LanguagesSection key="languages" props={props} items={items} heading={headingFor(props.headingClass)} />
      );
    }
    case 'personal':
      return <PersonalSection key="personal" schema={schema} section={section} data={data} />;
    case 'signature':
      return <SignatureSection key="signature" schema={schema} section={section} data={data} />;
    default:
      return null;
  }
}

/** Render an ordered run of sections, honouring `group` wrappers. */
function renderSections(
  schema: TemplateSchema,
  sections: SectionSpec[],
  data: ResumeJSON
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let index = 0;
  while (index < sections.length) {
    const section = sections[index];
    if (section.group) {
      const grouped: SectionSpec[] = [];
      while (index < sections.length && sections[index].group === section.group) {
        grouped.push(sections[index]);
        index += 1;
      }
      const rendered = grouped
        .map((groupedSection) => renderBodySection(schema, groupedSection, data))
        .filter((node): node is React.ReactElement => Boolean(node));
      if (rendered.length > 0) {
        nodes.push(
          <div key={section.group} className={schema.tokens.groupClass}>
            {rendered}
          </div>
        );
      }
    } else {
      const rendered = renderBodySection(schema, section, data);
      if (rendered) nodes.push(rendered);
      index += 1;
    }
  }
  return nodes;
}

function byOrder(a: SectionSpec, b: SectionSpec): number {
  return a.order - b.order;
}

/**
 * Render a schema-driven resume. The root and body classes come from the
 * schema's tokens; nothing here is template-specific.
 */
export default function SchemaResumeRenderer({ schema, data }: SchemaResumeRendererProps) {
  const resume = data || {};
  const sidebarSections = schema.sections
    .filter((section) => section.enabled && section.column === 'sidebar')
    .sort(byOrder);
  const mainSections = schema.sections
    .filter((section) => section.enabled && section.column === 'main')
    .sort(byOrder);
  const fullSections = schema.sections
    .filter((section) => section.enabled && section.column === 'full')
    .sort(byOrder);

  // Full-height sidebar: the sidebar column spans the sheet and holds the
  // identity block, mirroring the original flex-row designs (creative, sidebar).
  if (schema.layout === 'sidebar' && schema.sidebar) {
    const sidebar = schema.sidebar;
    return (
      <div className={schema.tokens.rootClass}>
        <div className={cn(sidebar.containerClass)} data-resume-sidebar="true">
          <div className={cn(sidebar.innerClass)}>{renderSections(schema, sidebarSections, resume)}</div>
          {sidebar.footerText ? (
            <div className={cn(sidebar.footerClass)}>{sidebar.footerText}</div>
          ) : null}
        </div>
        <div className={cn(schema.tokens.splitMainClass)} data-paginate-column="main">
          {renderSections(schema, mainSections, resume)}
        </div>
      </div>
    );
  }

  // Stacked root (single / header-band / tabular). `full` sections lead the
  // body; a body split is emitted only when there are sidebar-column sections.
  const bodyNodes: React.ReactNode[] = [...renderSections(schema, fullSections, resume)];
  if (sidebarSections.length > 0) {
    bodyNodes.push(
      <div key="__body-split" className={cn(schema.tokens.splitClass)} data-paginate-split="true">
        <div className={cn(schema.tokens.splitMainClass)} data-paginate-column="main">
          {renderSections(schema, mainSections, resume)}
        </div>
        {/* Inert on screen. `data-paginate-column="sidebar"` lets the print CSS
            take the sidebar out of the fragmentation flow: a grid cell stretches
            to the row height, the row is taller than a page, and the browser then
            relocates the whole cell to the next page — which puts a template's
            Education/Skills sections on page 2 and leaves a blank column where the
            preview shows them. See GOTCHA #64. */}
        <div
          className={cn(schema.tokens.splitSidebarClass)}
          data-paginate-column="sidebar"
          data-resume-sidebar="true"
        >
          {renderSections(schema, sidebarSections, resume)}
        </div>
      </div>
    );
  } else {
    bodyNodes.push(...renderSections(schema, mainSections, resume));
  }

  return (
    <div className={schema.tokens.rootClass}>
      <HeaderRegion schema={schema} data={resume} />
      <div className={schema.tokens.bodyClass}>{bodyNodes}</div>
    </div>
  );
}

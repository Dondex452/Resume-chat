/**
 * Neutral (standard JSON Schema) tool definitions + per-adapter converters.
 *
 * Ported exactly from the Gemini `Type.OBJECT` definitions that previously lived
 * in `server.ts`. Names, descriptions, and properties are unchanged.
 *
 * M11 Stage B adds `create_template` (PRD §5.5(a), §9). Its argument is a whole
 * `TemplateSchema` document (PRD §10), declared here in standard JSON Schema and
 * converted per adapter — exactly like the other two tools. The validator lives
 * in ONE place (`src/templates/schema.ts` → `validateTemplateSchema`) and is the
 * same gate the `/api/templates` CRUD router uses; this file must never grow a
 * second copy of the schema rules.
 */

import type { NeutralTool } from './types';
import { validateTemplateSchema, type TemplateSchema } from '../../src/templates/schema';

// Enum values mirror `src/templates/schema.ts` verbatim. They are duplicated
// here because the validator's arrays are module-private; the
// `create-template` test suite pins that no enum value declared here is
// rejected by the validator, so a drift becomes a failing test.
const SECTION_KEY_VALUES = [
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
const ORIGIN_VALUES = ['builtin', 'generated', 'cloned'];
const PAGE_SIZE_VALUES = ['A4', 'Letter'];
const LAYOUT_VALUES = ['single', 'sidebar', 'header-band', 'tabular'];
const COLUMN_VALUES = ['main', 'sidebar', 'header', 'full'];
const VARIANT_VALUES = ['list', 'timeline', 'table', 'tags', 'chips', 'grid'];
const CONTACT_LAYOUT_VALUES = [
  'icon-row',
  'icon-stack',
  'icon-line',
  'dotted',
  'labelled-box',
  'inline-labels',
  'inline',
];
const LINK_MODE_VALUES = ['row', 'box', 'inline', 'none'];
/**
 * The `props.layout` vocabulary is a union of the three section types that use
 * the field: basics (`stack | split`), work and education (their own layouts).
 * The validator checks each section's value against its own list; the tool
 * schema cannot express that conditionality, so it advertises the union and the
 * per-key requirements live in the description.
 */
const SECTION_LAYOUT_VALUES = [
  'stack',
  'split',
  'role-company-block',
  'role-date-then-company',
  'inline-role-company',
  'degree-field-block',
  'inline-degree-field',
  'stacked',
];
const PERSONAL_FIELD_VALUES = [
  'dob',
  'nationality',
  'maritalStatus',
  'visaStatus',
  'fatherName',
  'gender',
];

export const UPDATE_RESUME_TOOL: NeutralTool = {
  name: 'update_resume',
  description:
    'Updates the structured resume with new or corrected information provided by the user. Call this tool whenever the user provides details about their contact info, work experience, education, skills, projects, certifications, or languages.',
  parameters: {
    type: 'object',
    properties: {
      patch: {
        type: 'object',
        description: 'A JSON patch representing the updated resume details.',
        properties: {
          basics: {
            type: 'object',
            properties: {
              fullName: { type: 'string' },
              email: { type: 'string' },
              phone: { type: 'string' },
              location: { type: 'string' },
              summary: { type: 'string', description: 'A brief, compelling professional summary.' },
              links: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'e.g., LinkedIn, GitHub, Portfolio' },
                    url: { type: 'string' },
                  },
                },
              },
              photo: {
                type: 'string',
                description: 'A photo data URI or path. Only set when the selected country convention expects a photo (e.g. DE, FR, IN, JP, AE).',
              },
            },
          },
          personal: {
            type: 'object',
            description: 'Country-specific personal details. Only populate fields the user provides — never invent them.',
            properties: {
              dob: { type: 'string', description: 'Date of birth, e.g. 1990-05-14' },
              nationality: { type: 'string' },
              maritalStatus: { type: 'string' },
              visaStatus: { type: 'string', description: 'e.g. Work visa, Permanent resident, Citizen' },
              fatherName: { type: 'string' },
              gender: { type: 'string' },
            },
          },
          work: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                company: { type: 'string' },
                role: { type: 'string' },
                start: { type: 'string', description: "Start date, e.g., 'Jan 2021' or '2021'" },
                end: { type: 'string', description: "End date, e.g., 'Present' or 'Dec 2023'" },
                highlights: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Key achievements or responsibilities in this role.',
                },
              },
            },
          },
          education: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                school: { type: 'string' },
                degree: { type: 'string' },
                field: { type: 'string' },
                start: { type: 'string' },
                end: { type: 'string' },
              },
            },
          },
          skills: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                category: { type: 'string', description: "e.g., 'Languages', 'Frameworks', 'Design Tools'" },
                items: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
            },
          },
          projects: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                link: { type: 'string' },
              },
            },
          },
          certifications: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                issuer: { type: 'string' },
                date: { type: 'string' },
              },
            },
          },
          languages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                proficiency: { type: 'string', description: "e.g., 'Native', 'Fluent', 'Intermediate'" },
              },
            },
          },
          signature: {
            type: 'object',
            description: 'Signature block. Used by conventions that require one (Germany\'s Lebenslauf).',
            properties: {
              place: { type: 'string' },
              date: { type: 'string' },
              signed: { type: 'boolean' },
            },
          },
        },
      },
    },
    required: ['patch'],
  },
};

export const UPDATE_COVER_LETTER_TOOL: NeutralTool = {
  name: 'update_cover_letter',
  description:
    'Updates or drafts the cover letter. Call this tool when the user requests a cover letter, specifies target companies/roles, or wants to edit sections of the cover letter.',
  parameters: {
    type: 'object',
    properties: {
      patch: {
        type: 'object',
        description: 'The cover letter details.',
        properties: {
          recipient: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Contact person name, if known' },
              company: { type: 'string', description: 'Company name' },
              role: { type: 'string', description: 'Target job title/role' },
            },
          },
          intro: { type: 'string', description: 'The opening paragraph stating interest in the role.' },
          body: { type: 'string', description: 'The main paragraph(s) aligning candidate achievements to the role.' },
          closing: { type: 'string', description: 'The concluding call to action and sign-off.' },
          tone: { type: 'string', description: 'e.g., professional, warm, concise' },
        },
      },
    },
    required: ['patch'],
  },
};

// ---------------------------------------------------------------------------
// create_template (M11 Stage B — PRD §5.5(a), §9, §10)
// ---------------------------------------------------------------------------

/**
 * The per-section `props` bag.
 *
 * The validator enforces a *different subset* of these fields for each enabled
 * section key (`basics` needs `nameClass` + `headline` + `contacts`, `work`
 * needs `layout` + `listClass` + `rowClass`, and so on). Standard JSON Schema has
 * no portable conditional-required, and the Gemini converter whitelists only
 * `description/type/properties/items/required/enum/nullable/format`, so the
 * conditional cannot be expressed structurally. The bag therefore advertises
 * the whole vocabulary as optional and spells the per-key requirements out in
 * the description; the repair pass catches what the model still misses.
 */
const PROPERTIES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description:
    'Per-section output options. REQUIRED whenever the section is enabled. ' +
    'Required fields per section key: ' +
    'basics → containerClass, nameClass, nameFallback, headline{enabled}, contacts{layout, rowClass, linkMode}; ' +
    'summary → className; ' +
    'work → layout, listClass, rowClass; ' +
    'education → layout, listClass; ' +
    'skills → listClass (itemsMode optional: inline|chips); ' +
    'projects → listClass; ' +
    'certifications → listClass, variant (full|compact); ' +
    'languages → listClass, variant (full|compact|stacked|inline); ' +
    'personal → (optional) fields array; ' +
    'signature → (no required fields).',
  properties: {
    // --- shared / heading -------------------------------------------------
    headingClass: { type: 'string', description: 'Per-section heading class override; defaults to tokens.headingClass.' },
    containerClass: { type: 'string', description: 'Wrapper class for the section.' },
    className: { type: 'string', description: 'summary only — the summary paragraph class.' },
    // --- basics -----------------------------------------------------------
    nameClass: { type: 'string', description: 'basics — the full-name class (required there); projects — the project-name class.' },
    nameFallback: { type: 'string', description: 'basics only — text shown when the resume has no full name.' },
    layout: {
      type: 'string',
      enum: SECTION_LAYOUT_VALUES,
      description:
        'basics (stack|split), work (role-company-block|role-date-then-company|inline-role-company), ' +
        'education (degree-field-block|inline-degree-field|stacked).',
    },
    badge: {
      type: 'object',
      description: 'basics only — an optional status pill above the name.',
      properties: { text: { type: 'string' }, className: { type: 'string' } },
    },
    headline: {
      type: 'object',
      description: 'basics only — the headline line under the name.',
      properties: {
        enabled: { type: 'boolean' },
        className: { type: 'string' },
        prefix: { type: 'string' },
        fallback: { type: 'string' },
      },
      required: ['enabled'],
    },
    photo: {
      type: 'object',
      description: 'basics only — optional header photo styling. Only rendered when the resume has a photo and the country convention allows one.',
      properties: { className: { type: 'string' }, enabled: { type: 'boolean' } },
    },
    contacts: {
      type: 'object',
      description: 'basics only — how the contact entries render.',
      properties: {
        layout: { type: 'string', enum: CONTACT_LAYOUT_VALUES },
        rowClass: { type: 'string' },
        itemClass: { type: 'string' },
        iconClass: { type: 'string' },
        bulletPrefix: { type: 'string' },
        bulletSkipFirst: { type: 'boolean' },
        labelPrefixes: {
          type: 'object',
          properties: { email: { type: 'string' }, phone: { type: 'string' }, location: { type: 'string' } },
        },
        truncateEmail: { type: 'boolean' },
        linksRowClass: { type: 'string' },
        linkMode: { type: 'string', enum: LINK_MODE_VALUES },
        linkClass: { type: 'string' },
        linkIcon: { type: 'boolean' },
        linkIconClass: { type: 'string' },
        linkPrefix: { type: 'string' },
        linkSuffix: { type: 'string' },
        linkFallback: { type: 'string' },
      },
      required: ['layout', 'rowClass', 'linkMode'],
    },
    // --- list-style sections ---------------------------------------------
    listClass: { type: 'string', description: 'The section list wrapper class (work, education, skills, projects, certifications, languages).' },
    itemClass: { type: 'string', description: 'One list item class.' },
    rowClass: { type: 'string', description: 'work — the title/date row class.' },
    // work
    roleClass: { type: 'string' },
    roleTag: { type: 'string', enum: ['h3', 'span'] },
    inlineSeparator: { type: 'string' },
    companyClass: { type: 'string' },
    companyTag: { type: 'string', enum: ['p', 'div'] },
    dateClass: { type: 'string' },
    dateSeparator: { type: 'string' },
    endFallback: { type: 'string' },
    highlightsClass: { type: 'string' },
    highlightItemClass: { type: 'string' },
    highlightPrefix: { type: 'string' },
    markerClass: { type: 'string' },
    // education
    degreeClass: { type: 'string' },
    degreeTag: { type: 'string', enum: ['h3', 'span', 'div'] },
    degreeFieldSeparator: { type: 'string' },
    degreeFieldSuffix: { type: 'string' },
    fieldClass: { type: 'string' },
    fieldTag: { type: 'string', enum: ['p', 'div'] },
    includeField: { type: 'boolean' },
    schoolClass: { type: 'string' },
    schoolTag: { type: 'string', enum: ['p', 'div'] },
    dateTag: { type: 'string', enum: ['span', 'p', 'div'] },
    // skills
    categoryClass: { type: 'string' },
    categoryPrefix: { type: 'string' },
    categorySuffix: { type: 'string' },
    itemsPrefix: { type: 'string' },
    itemsClass: { type: 'string' },
    itemsMode: { type: 'string', enum: ['inline', 'chips'] },
    itemsWrapClass: { type: 'string' },
    chipClass: { type: 'string' },
    // projects
    nameTag: { type: 'string', enum: ['h3', 'span'] },
    linkClass: { type: 'string' },
    linkLabel: { type: 'string' },
    descriptionClass: { type: 'string' },
    // certifications + languages
    variant: {
      type: 'string',
      enum: ['full', 'compact', 'stacked', 'inline'],
      description: 'certifications (full|compact) or languages (full|compact|stacked|inline).',
    },
    primaryClass: { type: 'string' },
    secondaryClass: { type: 'string' },
    // personal
    fields: {
      type: 'array',
      description: 'personal only — the ordered subset of personal fields to render.',
      items: { type: 'string', enum: PERSONAL_FIELD_VALUES },
    },
    separator: { type: 'string' },
    labelClass: { type: 'string' },
    valueClass: { type: 'string' },
    // signature
    placeClass: { type: 'string' },
    lineClass: { type: 'string' },
    lineLabel: { type: 'string' },
  },
};

/**
 * `create_template` — PRD §9's `create_template(schema: TemplateSchema) -> { ok, template_id }`.
 *
 * The document shape matches `src/templates/schema.ts` field-for-field. Every
 * `enum` below is a value `validateTemplateSchema` accepts; the enums the
 * validator does **not** enforce (tag names, class strings) are free strings.
 */
export const CREATE_TEMPLATE_TOOL: NeutralTool = {
  name: 'create_template',
  description:
    'Creates and saves a brand-new resume template from a complete TemplateSchema document, when the user asks for a new design or layout. Supply the whole document in one call: it is validated before saving and an incomplete document is rejected (never rendered).',
  parameters: {
    type: 'object',
    properties: {
      schema: {
        type: 'object',
        description: 'A complete TemplateSchema document (PRD §10).',
        properties: {
          id: { type: 'string', description: 'Unique template id, e.g. "navy-two-column".' },
          name: { type: 'string', description: 'User-facing template name.' },
          version: { type: 'number', description: 'Document version; start at 1.' },
          origin: {
            type: 'string',
            enum: ORIGIN_VALUES,
            description: 'Use "generated" for a chat-created design.',
          },
          layout: { type: 'string', enum: LAYOUT_VALUES, description: 'The top-level document layout.' },
          page: {
            type: 'object',
            properties: {
              size: { type: 'string', enum: PAGE_SIZE_VALUES },
              margins: { type: 'string', description: "CSS length applied to the sheet, e.g. '40px'." },
              targetPages: { type: 'number', description: 'Target page count, e.g. 1.' },
            },
            required: ['size', 'margins', 'targetPages'],
          },
          tokens: {
            type: 'object',
            properties: {
              fonts: {
                type: 'object',
                properties: { heading: { type: 'string' }, body: { type: 'string' } },
                required: ['heading', 'body'],
              },
              scale: { type: 'number' },
              lineHeight: { type: 'number' },
              radius: { type: 'number' },
              colors: {
                type: 'object',
                description: 'Palette keys, not rendered values — the class bundles carry the concrete colours.',
                properties: {
                  heading: { type: 'string' },
                  body: { type: 'string' },
                  muted: { type: 'string' },
                  accent: { type: 'string' },
                  rule: { type: 'string' },
                  background: { type: 'string' },
                },
                required: ['heading', 'body', 'muted', 'accent', 'rule', 'background'],
              },
              spacing: {
                type: 'object',
                properties: { page: { type: 'number' }, section: { type: 'number' }, item: { type: 'number' } },
                required: ['page', 'section', 'item'],
              },
              borders: {
                type: 'object',
                properties: { ruleWidth: { type: 'number' }, ruleStyle: { type: 'string' } },
                required: ['ruleWidth', 'ruleStyle'],
              },
              rootClass: { type: 'string', description: 'The sheet root class bundle (font, padding, background, leading).' },
              bodyClass: { type: 'string', description: 'The wrapper that stacks the body sections.' },
              groupClass: { type: 'string', description: 'The wrapper for sections sharing a group.' },
              headingClass: { type: 'string', description: 'Default section-heading class.' },
              splitClass: { type: 'string', description: 'The wrapper holding the main + sidebar columns.' },
              splitMainClass: { type: 'string' },
              splitSidebarClass: { type: 'string' },
            },
            required: [
              'fonts',
              'scale',
              'lineHeight',
              'radius',
              'colors',
              'spacing',
              'borders',
              'rootClass',
              'bodyClass',
              'groupClass',
              'headingClass',
            ],
          },
          sidebar: {
            type: 'object',
            description: 'Required when any section uses column "sidebar".',
            properties: {
              widthPct: { type: 'number' },
              background: { type: 'string' },
              position: { type: 'string', enum: ['left', 'right'] },
              containerClass: { type: 'string' },
              innerClass: { type: 'string' },
              footerText: { type: 'string' },
              footerClass: { type: 'string' },
            },
            required: ['widthPct', 'background'],
          },
          sections: {
            type: 'array',
            description:
              'Non-empty, ordered list of sections. Each section key may appear at most once. ' +
              'Every enabled section needs its props bag — see props for the per-key required fields.',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', enum: SECTION_KEY_VALUES },
                label: { type: 'string', description: 'The rendered heading, e.g. "Work Experience".' },
                enabled: { type: 'boolean' },
                order: { type: 'number', description: 'Ascending render order within its column.' },
                column: { type: 'string', enum: COLUMN_VALUES, description: '"header" is the name/contacts region; "full" spans a split body.' },
                variant: { type: 'string', enum: VARIANT_VALUES },
                group: { type: 'string', description: 'Sections sharing a group render together in one wrapper.' },
                props: PROPERTIES_SCHEMA,
              },
              required: ['key', 'label', 'enabled', 'order', 'column', 'variant'],
            },
          },
        },
        required: ['id', 'name', 'version', 'origin', 'page', 'tokens', 'layout', 'sections'],
      },
    },
    required: ['schema'],
  },
};

export const RESUME_TOOLS: NeutralTool[] = [
  UPDATE_RESUME_TOOL,
  UPDATE_COVER_LETTER_TOOL,
  CREATE_TEMPLATE_TOOL,
];

// ---------------------------------------------------------------------------
// Per-adapter converters
// ---------------------------------------------------------------------------

export function toOpenAITools(tools: NeutralTool[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function toAnthropicTools(tools: NeutralTool[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

const GEMINI_SCHEMA_KEYS = ['description', 'type', 'properties', 'items', 'required', 'enum', 'nullable', 'format'];

/**
 * Recursive converter to Gemini's `Schema` proto shape: uppercase `type`
 * values, only whitelisted keys (Gemini rejects `additionalProperties`).
 */
export function toGeminiSchema(node: unknown): any {
  if (Array.isArray(node)) return node.map((n) => toGeminiSchema(n));
  if (node && typeof node === 'object') {
    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(src)) {
      if (!GEMINI_SCHEMA_KEYS.includes(key)) continue;
      if (key === 'type' && typeof value === 'string') {
        out.type = value.toUpperCase();
        continue;
      }
      if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
        const props: Record<string, unknown> = {};
        for (const [propKey, propValue] of Object.entries(value as Record<string, unknown>)) {
          props[propKey] = toGeminiSchema(propValue);
        }
        out.properties = props;
        continue;
      }
      if (key === 'items') {
        out.items = toGeminiSchema(value);
        continue;
      }
      out[key] = value;
    }
    return out;
  }
  return node;
}

export function toGeminiTools(tools: NeutralTool[]) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: toGeminiSchema(t.parameters),
      })),
    },
  ];
}

// ---------------------------------------------------------------------------
// Patch validators (used by the repair pass)
// ---------------------------------------------------------------------------

const RESUME_KEYS = ['basics', 'personal', 'work', 'education', 'skills', 'projects', 'certifications', 'languages', 'signature'];
const RESUME_ARRAY_KEYS = ['work', 'education', 'skills', 'projects', 'certifications', 'languages'];
// M10 — object-valued (shallow-merged) sections. A non-object here would be
// spread into the resume, so reject it early.
const RESUME_OBJECT_KEYS = ['basics', 'personal', 'signature'];
const COVER_LETTER_KEYS = ['recipient', 'intro', 'body', 'closing', 'tone'];
const COVER_LETTER_STRING_KEYS = ['intro', 'body', 'closing', 'tone'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateResumePatch(patch: unknown): string | null {
  if (!isPlainObject(patch)) return 'The "patch" argument must be a JSON object.';
  for (const key of Object.keys(patch)) {
    if (!RESUME_KEYS.includes(key)) {
      return `Unknown field "${key}" in the resume patch. Allowed fields: ${RESUME_KEYS.join(', ')}.`;
    }
  }
  for (const key of RESUME_OBJECT_KEYS) {
    if (patch[key] !== undefined && !isPlainObject(patch[key])) {
      return `The "${key}" field must be an object.`;
    }
  }
  for (const key of RESUME_ARRAY_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) return `The "${key}" field must be an array.`;
    for (let i = 0; i < value.length; i++) {
      if (!isPlainObject(value[i])) return `Entry ${i} of "${key}" must be an object.`;
    }
  }
  return null;
}

export function validateCoverLetterPatch(patch: unknown): string | null {
  if (!isPlainObject(patch)) return 'The "patch" argument must be a JSON object.';
  for (const key of Object.keys(patch)) {
    if (!COVER_LETTER_KEYS.includes(key)) {
      return `Unknown field "${key}" in the cover letter patch. Allowed fields: ${COVER_LETTER_KEYS.join(', ')}.`;
    }
  }
  if (patch.recipient !== undefined && !isPlainObject(patch.recipient)) {
    return 'The "recipient" field must be an object.';
  }
  for (const key of COVER_LETTER_STRING_KEYS) {
    const value = patch[key];
    if (value !== undefined && typeof value !== 'string') return `The "${key}" field must be a string.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// create_template argument validation (M11 Stage B)
// ---------------------------------------------------------------------------

type TemplateSchemaValidation = ReturnType<typeof validateTemplateSchema>;

/**
 * Narrow a `validateTemplateSchema` result.
 *
 * `tsconfig.json` has no `strict` flag, so `strictNullChecks` is off and this
 * project's TypeScript does NOT narrow a union on a boolean discriminant
 * (GOTCHA #52). A user-defined type guard narrows in both directions and under
 * both compiler settings.
 */
function isTemplateSchemaValid(
  result: TemplateSchemaValidation,
): result is { ok: true; schema: TemplateSchema } {
  return result.ok === true;
}

/**
 * The validator's errors for a candidate schema, or `[]` when the document is
 * valid. Exposed so tests can assert that the tool path uses the SAME validator
 * as `/api/templates` without repeating the narrowing dance.
 */
export function createTemplateSchemaErrors(value: unknown): string[] {
  const result = validateTemplateSchema(value);
  return isTemplateSchemaValid(result) ? [] : result.errors;
}

/** Reported errors are capped so one bad document cannot flood the repair turn. */
const MAX_REPORTED_TEMPLATE_ERRORS = 12;

/**
 * A single readable sentence for the model. The full validator error list (up
 * to a cap) is included so the repair pass can act on it.
 */
export function formatTemplateSchemaErrors(errors: string[]): string {
  const shown = errors.slice(0, MAX_REPORTED_TEMPLATE_ERRORS);
  const omitted = errors.length - shown.length;
  const plural = errors.length === 1 ? '' : 's';
  const suffix = omitted > 0 ? ` (+${omitted} more)` : '';
  return `The "schema" argument is invalid (${errors.length} error${plural}): ${shown.join('; ')}${suffix}`;
}

/** The candidate schema inside a `create_template` tool-call argument object. */
function templateSchemaArgument(args: unknown): unknown {
  if (isPlainObject(args) && Object.prototype.hasOwnProperty.call(args, 'schema')) {
    return (args as { schema?: unknown }).schema;
  }
  return undefined;
}

/**
 * Validate a `create_template` call's arguments.
 *
 * Returns `null` when the document is a valid `TemplateSchema`, otherwise a
 * single readable message built from `validateTemplateSchema`'s errors. Used by
 * the chat loop exactly like `validateResumePatch` / `validateCoverLetterPatch`,
 * so a malformed call gets the same single repair pass before it is rejected.
 */
export function validateCreateTemplateArgs(args: unknown): string | null {
  if (!isPlainObject(args) || !Object.prototype.hasOwnProperty.call(args, 'schema')) {
    return 'The "schema" argument is required and must be a complete TemplateSchema object.';
  }
  const errors = createTemplateSchemaErrors(templateSchemaArgument(args));
  if (errors.length === 0) return null;
  return formatTemplateSchemaErrors(errors);
}

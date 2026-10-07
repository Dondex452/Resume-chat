/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * M10 — the ten country presets as DATA (PRD §5.4, §5.4.1, §10).
 *
 * A preset is pure **overrides** layered on top of any `TemplateSchema`: page
 * size, which sections are enabled, their order and their labels. There is no
 * per-country branch anywhere in the renderer — `applyCountryPreset` folds a
 * preset into a schema and the one generic renderer draws the result.
 *
 * Two deliberate limits, recorded rather than faked:
 *   - `dateFormat` is declared (PRD §10) but not applied to rendered dates in
 *     M10 Stage B; it would mean reformatting every work/education date string.
 *   - Japan's Rirekisho is a JIS fixed-grid form. `layout: 'tabular'` is
 *     declared in the schema but unimplemented, so JP gets the personal/photo/
 *     signature blocks with the *default* layout — it is not the real grid.
 */

import type {
  BasicsProps,
  PersonalFieldKey,
  PersonalProps,
  SectionKey,
  SectionSpec,
  TemplatePage,
  TemplateSchema,
} from './schema';
import type { ResumeJSON, ResumeSignature } from '../types';
import {
  createPersonalSection,
  createSignatureSection,
  PERSONAL_SECTION_ORDER,
  SIGNATURE_SECTION_ORDER,
} from './sections';

/**
 * What a market expects on the person: the six `resume_json.personal` fields,
 * plus `photo` (carried by `basics`) and `signature` (its own section).
 */
export type CountryPersonalField = PersonalFieldKey | 'photo' | 'signature';

export interface CountrySectionOverrides {
  enabled?: Partial<Record<SectionKey, boolean>>;
  order?: Partial<Record<SectionKey, number>>;
  /** Localised section headings (PRD §5.4). */
  labels?: Partial<Record<SectionKey, string>>;
}

export interface CountryRules {
  maxPages: number;
  photoExpected: boolean;
  signatureRequired: boolean;
  /** Declared per PRD §10; see the file header for its M10 Stage B status. */
  dateFormat: string;
}

export interface CountryPreset {
  /** ISO 3166-1 alpha-2. */
  code: string;
  name: string;
  documentName: string;
  page: Partial<TemplatePage>;
  personalFields: CountryPersonalField[];
  sections: CountrySectionOverrides;
  rules: CountryRules;
}

const PERSONAL_DATA_FIELDS: PersonalFieldKey[] = [
  'dob',
  'nationality',
  'maritalStatus',
  'visaStatus',
  'fatherName',
  'gender',
];

function isPersonalDataField(field: CountryPersonalField): field is PersonalFieldKey {
  return (PERSONAL_DATA_FIELDS as string[]).includes(field);
}

/**
 * A full main-column order that leads with the personal block. German, Indian,
 * Gulf and Japanese conventions all open with the applicant's particulars, so
 * those presets reorder the main column rather than leaving the block at the
 * template's tail (PRD §10 `sections.order`).
 */
const PERSONAL_FIRST_ORDER: Partial<Record<SectionKey, number>> = {
  personal: 1,
  work: 2,
  education: 3,
  skills: 4,
  projects: 5,
  certifications: 6,
  languages: 7,
};

/**
 * PRD §5.4.1, transcribed. Labels are exactly the ones the spec lists; where it
 * lists none, the template's own English label is left untouched.
 */
export const COUNTRY_PRESETS: CountryPreset[] = [
  {
    code: 'US',
    name: 'United States',
    documentName: 'Resume',
    // §11: US and CA export to Letter.
    page: { size: 'Letter', targetPages: 1 },
    personalFields: [],
    sections: {
      enabled: { personal: false, signature: false },
      labels: { work: 'Work Experience', education: 'Education' },
    },
    rules: { maxPages: 1, photoExpected: false, signatureRequired: false, dateFormat: 'MM/YYYY' },
  },
  {
    code: 'CA',
    name: 'Canada',
    documentName: 'Resume',
    page: { size: 'Letter', targetPages: 2 },
    personalFields: [],
    sections: {
      enabled: { personal: false, signature: false },
      labels: { work: 'Work Experience', education: 'Education' },
    },
    rules: { maxPages: 2, photoExpected: false, signatureRequired: false, dateFormat: 'MM/YYYY' },
  },
  {
    code: 'UK',
    name: 'United Kingdom',
    documentName: 'CV',
    page: { size: 'A4', targetPages: 2 },
    personalFields: [],
    sections: {
      enabled: { personal: false, signature: false },
      // "Personal statement block" (§5.4.1): the summary gains a heading where
      // it sits in the header; where a design already makes it a body section
      // the label styles it there.
      labels: {
        summary: 'Personal Statement',
        work: 'Work Experience',
        education: 'Education',
      },
    },
    rules: { maxPages: 2, photoExpected: false, signatureRequired: false, dateFormat: 'DD/MM/YYYY' },
  },
  {
    code: 'DE',
    name: 'Germany',
    documentName: 'Lebenslauf',
    page: { size: 'A4', targetPages: 2 },
    personalFields: ['dob', 'photo', 'signature'],
    sections: {
      enabled: { personal: true, signature: true },
      order: PERSONAL_FIRST_ORDER,
      labels: { work: 'Berufserfahrung', education: 'Ausbildung' },
    },
    rules: { maxPages: 2, photoExpected: true, signatureRequired: true, dateFormat: 'DD.MM.YYYY' },
  },
  {
    code: 'FR',
    name: 'France',
    documentName: 'CV',
    page: { size: 'A4', targetPages: 1 },
    personalFields: ['photo'],
    sections: {
      enabled: { personal: false, signature: false },
      labels: { work: 'Expérience professionnelle', education: 'Formation' },
    },
    rules: { maxPages: 1, photoExpected: true, signatureRequired: false, dateFormat: 'DD/MM/YYYY' },
  },
  {
    code: 'NL',
    name: 'Netherlands',
    documentName: 'CV',
    page: { size: 'A4', targetPages: 2 },
    personalFields: [],
    sections: { enabled: { personal: false, signature: false } },
    rules: { maxPages: 2, photoExpected: false, signatureRequired: false, dateFormat: 'DD-MM-YYYY' },
  },
  {
    code: 'IN',
    name: 'India',
    documentName: 'CV',
    page: { size: 'A4', targetPages: 2 },
    personalFields: ['dob', 'maritalStatus', 'nationality', 'fatherName', 'photo'],
    sections: { enabled: { personal: true, signature: false }, order: PERSONAL_FIRST_ORDER },
    rules: { maxPages: 2, photoExpected: true, signatureRequired: false, dateFormat: 'DD/MM/YYYY' },
  },
  {
    code: 'JP',
    name: 'Japan',
    documentName: 'Rirekisho',
    page: { size: 'A4', targetPages: 2 },
    // The real form adds a 職務経歴書 and a seal box; see the file header.
    personalFields: ['dob', 'photo', 'signature'],
    sections: { enabled: { personal: true, signature: true }, order: PERSONAL_FIRST_ORDER },
    rules: { maxPages: 2, photoExpected: true, signatureRequired: true, dateFormat: 'YYYY/MM' },
  },
  {
    code: 'AU',
    name: 'Australia',
    documentName: 'Resume',
    page: { size: 'A4', targetPages: 2 },
    personalFields: [],
    sections: {
      enabled: { personal: false, signature: false },
      labels: { summary: 'Career Objective' },
    },
    rules: { maxPages: 3, photoExpected: false, signatureRequired: false, dateFormat: 'DD/MM/YYYY' },
  },
  {
    code: 'AE',
    name: 'UAE / Gulf',
    documentName: 'CV',
    page: { size: 'A4', targetPages: 2 },
    personalFields: ['nationality', 'visaStatus', 'maritalStatus', 'photo'],
    sections: { enabled: { personal: true, signature: false }, order: PERSONAL_FIRST_ORDER },
    rules: { maxPages: 2, photoExpected: true, signatureRequired: false, dateFormat: 'DD/MM/YYYY' },
  },
];

/** Resolve a stored `country_code`. Unknown or empty codes resolve to none. */
export function getCountryPreset(code: string | null | undefined): CountryPreset | undefined {
  if (!code) return undefined;
  const normalized = code.trim().toUpperCase();
  if (!normalized) return undefined;
  return COUNTRY_PRESETS.find((preset) => preset.code === normalized);
}

/**
 * Fold a preset into a schema. **Pure**: the input schema is never mutated, so
 * `BUILTIN_TEMPLATE_SCHEMAS` stays shared, pristine module data.
 *
 * With no preset the schema is returned untouched, which is what keeps the
 * no-country render byte-for-byte identical to pre-M10 output.
 */
export function applyCountryPreset(
  schema: TemplateSchema,
  preset: CountryPreset | null | undefined
): TemplateSchema {
  if (!preset) return schema;

  const enabledOverrides = preset.sections.enabled ?? {};
  const orderOverrides = preset.sections.order ?? {};
  const labelOverrides = preset.sections.labels ?? {};
  const personalFields = preset.personalFields.filter(isPersonalDataField);

  const inherited = new Set(schema.sections.map((section) => section.key));
  const photoExpected = preset.personalFields.includes('photo');
  const sections: SectionSpec[] = schema.sections.map((section): SectionSpec => {
    const enabled = enabledOverrides[section.key] ?? section.enabled;
    const order = orderOverrides[section.key] ?? section.order;
    const label = labelOverrides[section.key] ?? section.label;

    if (section.key === 'basics') {
      // A stored photo is suppressed for markets that do not use one.
      const props = section.props as BasicsProps;
      return {
        ...section,
        enabled,
        order,
        label,
        props: { ...props, photo: { ...(props.photo ?? {}), enabled: photoExpected } }
      };
    }

    if (section.key === 'personal') {
      const props = section.props as PersonalProps | undefined;
      return {
        ...section,
        enabled,
        order,
        label,
        props:
          personalFields.length > 0 ? { ...(props ?? {}), fields: personalFields } : props
      };
    }

    return { ...section, enabled, order, label };
  });

  // Defensive: a generated/cloned schema may not ship the M10 blocks.
  if (enabledOverrides.personal === true && !inherited.has('personal')) {
    sections.push({
      ...createPersonalSection(PERSONAL_SECTION_ORDER, { fields: personalFields }),
      enabled: true
    } as SectionSpec);
  }
  if (enabledOverrides.signature === true && !inherited.has('signature')) {
    sections.push({
      ...createSignatureSection(SIGNATURE_SECTION_ORDER),
      enabled: true
    } as SectionSpec);
  }

  return {
    ...schema,
    page: { ...schema.page, ...preset.page },
    sections,
  };
}

export type ConformanceWarningCode = 'max-pages' | 'photo' | 'signature';

export interface ConformanceWarning {
  code: ConformanceWarningCode;
  text: string;
}

function hasSignatureData(signature: ResumeSignature | undefined): boolean {
  if (!signature) return false;
  const place = typeof signature.place === 'string' && signature.place.trim().length > 0;
  const date = typeof signature.date === 'string' && signature.date.trim().length > 0;
  const signed = typeof signature.signed === 'boolean';
  return place || date || signed;
}

/**
 * PRD §5.4 conformance notices. A preset **advises, it does not police**: these
 * are warnings, never blockers, and each one only fires when its condition is
 * actually true.
 *
 * `pageCount` is a measurement of the rendered sheet; when it is `null`
 * (nothing rendered yet) no page-count claim is made.
 */
export function getConformanceWarnings(params: {
  preset: CountryPreset;
  data: ResumeJSON;
  pageCount?: number | null;
}): ConformanceWarning[] {
  const { preset, data, pageCount } = params;
  const warnings: ConformanceWarning[] = [];
  const doc = preset.documentName;

  if (pageCount != null && pageCount > preset.rules.maxPages) {
    warnings.push({
      code: 'max-pages',
      text: `This ${doc} runs to ${pageCount} pages; the ${preset.name} convention is ${preset.rules.maxPages}.`,
    });
  }
  if (preset.rules.photoExpected && !data.basics?.photo) {
    warnings.push({ code: 'photo', text: `A photo is customary on a ${preset.name} ${doc}.` });
  }
  if (preset.rules.signatureRequired && !hasSignatureData(data.signature)) {
    warnings.push({
      code: 'signature',
      text: `A ${preset.name} ${doc} conventionally carries a place, date and signature line.`,
    });
  }
  return warnings;
}

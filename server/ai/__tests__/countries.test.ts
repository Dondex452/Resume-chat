/**
 * M10 Stage B — the country-preset engine and the new personal/signature blocks.
 *
 * These tests exercise real module data (the ten built-ins) and the one generic
 * renderer, so they prove the two properties Stage B promises:
 *   1. `applyCountryPreset` is pure and never mutates shared template data.
 *   2. Absent personal data renders nothing — no heading, no empty rows, no
 *      photo — for every design and every preset that expects those fields.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  BUILTIN_TEMPLATE_SCHEMAS,
  BUILTIN_TEMPLATE_SCHEMA_LIST,
} from '../../../src/templates/builtin';
import { validateTemplateSchema } from '../../../src/templates/schema';
import {
  applyCountryPreset,
  COUNTRY_PRESETS,
  getConformanceWarnings,
  getCountryPreset,
} from '../../../src/templates/countries';
import SchemaResumeRenderer from '../../../src/templates/render';
import type { ResumeJSON } from '../../../src/types';

const PLAIN_RESUME: ResumeJSON = {
  basics: {
    fullName: 'Amara Okafor',
    email: 'amara@example.com',
    phone: '+44 20 7946 0812',
    location: 'Manchester, UK',
    summary: 'Product engineer.',
    links: [{ label: 'GitHub', url: 'https://example.com' }],
  },
  work: [{ company: 'Northwind', role: 'Staff Engineer', start: '2022', end: 'Present', highlights: ['Shipped things.'] }],
  education: [{ school: 'Manchester', degree: 'BSc', field: 'Computer Science', start: '2013', end: '2016' }],
  skills: [{ category: 'Languages', items: ['TypeScript'] }],
  projects: [{ name: 'Ledgerbench', description: 'A ledger.', link: 'https://example.com' }],
  certifications: [{ name: 'AWS', issuer: 'Amazon', date: '2023' }],
  languages: [{ name: 'English', proficiency: 'Native' }],
};

const PERSONAL_RESUME: ResumeJSON = {
  ...PLAIN_RESUME,
  basics: { ...PLAIN_RESUME.basics, photo: 'data:image/png;base64,AAAA' },
  personal: {
    dob: '1990-05-14',
    nationality: 'German',
    maritalStatus: 'Single',
    visaStatus: 'Citizen',
    fatherName: 'Chidi Okafor',
    gender: 'Female',
  },
  signature: { place: 'Berlin', date: '2026-09-20', signed: true },
};

const PRESETS_THAT_ENABLE_PERSONAL = COUNTRY_PRESETS.filter(
  (preset) => preset.sections.enabled?.personal === true
);

test('country presets: ten unique ISO codes with the spec page sizes', () => {
  assert.equal(COUNTRY_PRESETS.length, 10);
  const codes = COUNTRY_PRESETS.map((preset) => preset.code);
  assert.equal(new Set(codes).size, 10);
  for (const preset of COUNTRY_PRESETS) {
    const expectedSize = preset.code === 'US' || preset.code === 'CA' ? 'Letter' : 'A4';
    assert.equal(preset.page.size, expectedSize, `${preset.code} page size`);
  }
});

test('country presets: §5.4.1 section labels are transcribed', () => {
  assert.equal(getCountryPreset('de')?.sections.labels?.work, 'Berufserfahrung');
  assert.equal(getCountryPreset('de')?.sections.labels?.education, 'Ausbildung');
  assert.equal(getCountryPreset('fr')?.sections.labels?.work, 'Expérience professionnelle');
  assert.equal(getCountryPreset('fr')?.sections.labels?.education, 'Formation');
  assert.equal(getCountryPreset('au')?.sections.labels?.summary, 'Career Objective');
  assert.equal(getCountryPreset('uk')?.sections.labels?.summary, 'Personal Statement');
  assert.equal(getCountryPreset('ca')?.sections.labels?.work, 'Work Experience');
  assert.equal(getCountryPreset('ca')?.sections.labels?.education, 'Education');
});

test('country presets: getCountryPreset tolerates empty, unknown, and lower case', () => {
  assert.equal(getCountryPreset(''), undefined);
  assert.equal(getCountryPreset(null), undefined);
  assert.equal(getCountryPreset(undefined), undefined);
  assert.equal(getCountryPreset('ZZ'), undefined);
  assert.equal(getCountryPreset(' de ')?.documentName, 'Lebenslauf');
});

test('every built-in carries the M10 blocks disabled, and still validates', () => {
  for (const schema of BUILTIN_TEMPLATE_SCHEMA_LIST) {
    const personal = schema.sections.find((section) => section.key === 'personal');
    const signature = schema.sections.find((section) => section.key === 'signature');
    assert.ok(personal, `${schema.id} has a personal section`);
    assert.ok(signature, `${schema.id} has a signature section`);
    assert.equal(personal?.enabled, false, `${schema.id} personal disabled`);
    assert.equal(signature?.enabled, false, `${schema.id} signature disabled`);
    const validation = validateTemplateSchema(schema);
    assert.equal(validation.ok, true, `${schema.id} validates: ${JSON.stringify(validation)}`);
  }
});

test('applyCountryPreset is pure: it never mutates shared module data', () => {
  const before = JSON.stringify(BUILTIN_TEMPLATE_SCHEMAS);
  for (const preset of COUNTRY_PRESETS) {
    for (const schema of BUILTIN_TEMPLATE_SCHEMA_LIST) {
      applyCountryPreset(schema, preset);
    }
  }
  assert.equal(JSON.stringify(BUILTIN_TEMPLATE_SCHEMAS), before);
});

test('applyCountryPreset: no preset returns the same schema untouched', () => {
  const schema = BUILTIN_TEMPLATE_SCHEMAS.minimal;
  assert.equal(applyCountryPreset(schema, null), schema);
  assert.equal(applyCountryPreset(schema, undefined), schema);
});

test('applyCountryPreset: page size, enables, labels and personal fields', () => {
  const base = BUILTIN_TEMPLATE_SCHEMAS.minimal;
  const de = getCountryPreset('DE')!;
  const effective = applyCountryPreset(base, de);

  assert.notEqual(effective, base);
  assert.equal(effective.page.size, 'A4');

  const personal = effective.sections.find((section) => section.key === 'personal');
  const signature = effective.sections.find((section) => section.key === 'signature');
  assert.ok(personal && signature, 'personal and signature sections exist');
  assert.equal(personal.enabled, true);
  assert.equal(signature.enabled, true);
  // `photo` and `signature` are not personal *data* fields.
  assert.deepEqual((personal.props as { fields?: string[] }).fields, ['dob']);

  assert.equal(effective.sections.find((s) => s.key === 'work')?.label, 'Berufserfahrung');
  assert.equal(effective.sections.find((s) => s.key === 'education')?.label, 'Ausbildung');
  // DE leads with the personal block (sections.order override).
  assert.ok(
    personal.order < (effective.sections.find((s) => s.key === 'work')?.order ?? 0),
    'personal renders before work for DE'
  );

  const us = applyCountryPreset(base, getCountryPreset('US')!);
  assert.equal(us.page.size, 'Letter');
  assert.equal(us.sections.find((s) => s.key === 'personal')?.enabled, false);
  assert.equal(us.sections.find((s) => s.key === 'signature')?.enabled, false);
});

test('absent personal data renders no personal or signature output, for every design', () => {
  for (const schema of BUILTIN_TEMPLATE_SCHEMA_LIST) {
    for (const preset of [null, ...PRESETS_THAT_ENABLE_PERSONAL]) {
      const effective = applyCountryPreset(schema, preset);
      const html = renderToStaticMarkup(SchemaResumeRenderer({ schema: effective, data: PLAIN_RESUME }));
      assert.ok(
        !html.includes('Personal Details'),
        `${schema.id}/${preset?.code ?? 'none'}: no personal heading`
      );
      assert.ok(
        !html.includes('Date of birth') && !html.includes('Father&#x27;s name'),
        `${schema.id}/${preset?.code ?? 'none'}: no personal rows`
      );
      assert.ok(
        !html.includes('Signature'),
        `${schema.id}/${preset?.code ?? 'none'}: no signature block`
      );
      assert.ok(!html.includes('<img'), `${schema.id}/${preset?.code ?? 'none'}: no photo`);
    }
  }
});

test('present personal data renders its fields, photo and signature line', () => {
  const schema = BUILTIN_TEMPLATE_SCHEMAS.minimal;
  const effective = applyCountryPreset(schema, getCountryPreset('DE')!);
  const html = renderToStaticMarkup(SchemaResumeRenderer({ schema: effective, data: PERSONAL_RESUME }));
  assert.ok(html.includes('Personal Details'), 'personal heading');
  assert.ok(html.includes('Date of birth'), 'dob row');
  assert.ok(html.includes('1990-05-14'), 'dob value');
  assert.ok(!html.includes('Nationality'), 'only preset fields render (dob)');
  assert.ok(html.includes('<img'), 'photo renders when present');
  assert.ok(html.includes('Berlin'), 'signature place');
  assert.ok(html.includes('Signature'), 'signature line caption');
});

test('a market that does not use a photo suppresses a stored one', () => {
  const schema = BUILTIN_TEMPLATE_SCHEMAS.minimal;
  const render = (code: string) =>
    renderToStaticMarkup(
      SchemaResumeRenderer({
        schema: applyCountryPreset(schema, getCountryPreset(code)!),
        data: PERSONAL_RESUME,
      })
    );

  assert.ok(render('DE').includes('<img'), 'DE keeps the photo');
  assert.ok(render('FR').includes('<img'), 'FR keeps the photo');
  assert.ok(!render('US').includes('<img'), 'US suppresses the photo');
  assert.ok(!render('AU').includes('<img'), 'AU suppresses the photo');
  assert.ok(!render('UK').includes('<img'), 'UK suppresses the photo');
});

test('conformance warnings fire only when the condition is true', () => {
  const us = getCountryPreset('US')!;
  const de = getCountryPreset('DE')!;

  assert.deepEqual(
    getConformanceWarnings({ preset: us, data: PLAIN_RESUME, pageCount: 1 }),
    []
  );
  const overPage = getConformanceWarnings({ preset: us, data: PLAIN_RESUME, pageCount: 2 });
  assert.equal(overPage.length, 1);
  assert.equal(overPage[0].code, 'max-pages');
  assert.match(overPage[0].text, /1/);
  assert.match(overPage[0].text, /2/);

  // An unmeasured page count makes no claim.
  assert.deepEqual(getConformanceWarnings({ preset: us, data: PLAIN_RESUME, pageCount: null }), []);

  const deWarnings = getConformanceWarnings({ preset: de, data: PLAIN_RESUME, pageCount: null });
  const codes = deWarnings.map((warning) => warning.code).sort();
  assert.deepEqual(codes, ['photo', 'signature']);

  assert.deepEqual(
    getConformanceWarnings({ preset: de, data: PERSONAL_RESUME, pageCount: null }),
    []
  );
});

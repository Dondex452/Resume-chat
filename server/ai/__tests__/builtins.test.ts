/**
 * Shipped-template hygiene (PRD §10, Decision #29).
 *
 * The M9 port moved all ten designs from hardcoded JSX into `TemplateSchema`
 * data, and its acceptance gate was **SHA256-identity** against the pre-port
 * baselines. That gate is why `creative` faithfully reproduced v1's static
 * `AI-Crafted CV Profile` caption instead of dropping it — the port was told to
 * change nothing, and it changed nothing.
 *
 * The caption is gone (user directive 2026-09-23). These tests keep it gone:
 * a shipped template must not print chrome the user did not author, cannot
 * delete, and which no country preset localises.
 *
 * The `SidebarSpec.footerText` / `footerClass` *capability* deliberately stays
 * in the schema — a chat-generated template (§5.5) may legitimately set a
 * caption the user asked for. What is forbidden is a **built-in** shipping one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  BUILTIN_TEMPLATE_SCHEMAS,
  BUILTIN_TEMPLATE_SCHEMA_LIST,
} from '../../../src/templates/builtin';
import SchemaResumeRenderer from '../../../src/templates/render';
import type { ResumeJSON } from '../../../src/types';

const RESUME: ResumeJSON = {
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

test('no built-in template ships a sidebar footer caption', () => {
  for (const schema of BUILTIN_TEMPLATE_SCHEMA_LIST) {
    assert.equal(
      schema.sidebar?.footerText,
      undefined,
      `${schema.id} must not pin a static caption to its sidebar`
    );
  }
});

test('no built-in renders the removed caption, and the sidebar design still renders', () => {
  for (const schema of BUILTIN_TEMPLATE_SCHEMA_LIST) {
    const html = renderToStaticMarkup(SchemaResumeRenderer({ schema, data: RESUME }));
    assert.ok(
      !/crafted/i.test(html),
      `${schema.id} renders no "crafted" chrome`
    );
    assert.ok(html.includes('Amara Okafor'), `${schema.id} still renders the resume`);
  }

  // `creative` is the template the caption was removed from — prove the sidebar
  // design itself is intact (it kept the resume content, not just dropped a row).
  const creative = renderToStaticMarkup(
    SchemaResumeRenderer({ schema: BUILTIN_TEMPLATE_SCHEMAS.creative, data: RESUME })
  );
  assert.ok(creative.includes('Northwind'), 'creative still renders work history');
  assert.ok(creative.includes('Ledgerbench'), 'creative still renders projects');
});

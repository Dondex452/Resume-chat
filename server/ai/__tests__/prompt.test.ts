/**
 * M14 — `buildSystemInstruction` (PRD §9.1, §9.7, §8).
 *
 * The prompt builder was extracted from the route handler precisely so these
 * properties can be pinned without a model call or an HTTP server:
 *   - a selected country preset reaches the prompt (document name, personal
 *     fields, photo, signature, target page count);
 *   - no country selected says so and claims no preset;
 *   - the v2 fields (`personal`, `signature`, `basics.photo`) are always
 *     documented, because the model was previously never told they exist;
 *   - an uploaded CV with an empty resume carries the acknowledge-and-populate
 *     instruction, and a populated resume does not.
 *
 * Assertions are on stable substrings, never on the whole prompt, so wording can
 * be improved without breaking the suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemInstruction } from '../../prompt';

const EMPTY_RESUME = '{}';
const POPULATED_RESUME = JSON.stringify({
  basics: { fullName: 'Ada Lovelace' },
  work: [{ company: 'Northwind', role: 'Engineer' }],
});

const UPLOAD_MARKER = 'Uploaded CV — do this on your next reply';

// ---------------------------------------------------------------------------
// Country context (PRD §9.1)
// ---------------------------------------------------------------------------

test('prompt: with no country selected it says so and claims no preset', () => {
  const prompt = buildSystemInstruction({ resume_json: EMPTY_RESUME });

  assert.match(prompt, /No country convention is selected/);
  assert.ok(!prompt.includes('Lebenslauf'), 'DE preset must not leak in');
  assert.ok(!prompt.includes('Rirekisho'), 'JP preset must not leak in');
  assert.ok(!prompt.includes('Berufserfahrung'), 'DE headings must not leak in');
});

test('prompt: an unknown country code behaves like no country', () => {
  const prompt = buildSystemInstruction({ resume_json: EMPTY_RESUME, country_code: 'ZZ' });
  assert.match(prompt, /No country convention is selected/);
  assert.ok(!prompt.includes('Lebenslauf'));
});

test('prompt: DE carries Lebenslauf, 2 pages, photo and signature expectations', () => {
  const prompt = buildSystemInstruction({ resume_json: EMPTY_RESUME, country_code: 'DE' });

  assert.ok(prompt.includes('Lebenslauf'), 'the local document name must be named');
  assert.ok(prompt.includes('Germany'));
  assert.match(prompt, /2 pages/);
  assert.ok(prompt.includes('Photo: expected'));
  assert.ok(prompt.includes('Signature line: expected'));
  assert.ok(prompt.includes('date of birth'), 'the DE personal field must be described');
  assert.ok(prompt.includes('`personal.dob`'), 'the destination JSON path must be stated');
  assert.ok(!prompt.includes('No country convention is selected'));
});

test('prompt: US carries 1 page and an explicit no-photo convention', () => {
  const prompt = buildSystemInstruction({ resume_json: EMPTY_RESUME, country_code: 'US' });

  assert.ok(prompt.includes('United States'));
  assert.match(prompt, /1 page\b/);
  assert.ok(prompt.includes('Photo: not used'));
  assert.ok(prompt.includes('Signature line: not required'));
  assert.ok(prompt.includes('do not add a photo'));
  assert.ok(!prompt.includes('Lebenslauf'));
});

test('prompt: JP carries Rirekisho plus photo and signature expectations', () => {
  const prompt = buildSystemInstruction({ resume_json: EMPTY_RESUME, country_code: 'JP' });

  assert.ok(prompt.includes('Rirekisho'));
  assert.ok(prompt.includes('Japan'));
  assert.match(prompt, /2 pages/);
  assert.ok(prompt.includes('Photo: expected'));
  assert.ok(prompt.includes('Signature line: expected'));
});

test('prompt: country_code is case-insensitive and trimmed', () => {
  const prompt = buildSystemInstruction({ resume_json: EMPTY_RESUME, country_code: ' de ' });
  assert.ok(prompt.includes('Lebenslauf'));
});

// ---------------------------------------------------------------------------
// The v2 fields (PRD §8) — always documented
// ---------------------------------------------------------------------------

test('prompt: personal, signature and basics.photo are always documented', () => {
  const prompts = [
    buildSystemInstruction({ resume_json: EMPTY_RESUME }),
    buildSystemInstruction({ resume_json: EMPTY_RESUME, country_code: 'DE' }),
    buildSystemInstruction({ resume_json: EMPTY_RESUME, country_code: 'US' }),
    buildSystemInstruction({ resume_json: EMPTY_RESUME, country_code: 'JP' }),
  ];

  for (const prompt of prompts) {
    assert.ok(prompt.includes('`personal`'), 'the personal block must be documented');
    assert.ok(prompt.includes('`signature`'), 'the signature block must be documented');
    assert.ok(prompt.includes('`basics.photo`'), 'basics.photo must be documented');
    assert.match(prompt, /never invent/i);
  }
});

test('prompt: the original interview guidelines and tool instructions are preserved', () => {
  const prompt = buildSystemInstruction({ resume_json: EMPTY_RESUME });

  assert.ok(prompt.includes('**Your Guidelines**'));
  assert.ok(prompt.includes('Ask 1 or 2 targeted questions at a time'));
  assert.ok(prompt.includes("call the 'update_resume' tool immediately"));
  assert.ok(prompt.includes("use the 'update_cover_letter' tool immediately"));
  assert.ok(prompt.includes("call the 'create_template' tool with a COMPLETE TemplateSchema document"));
});

test('prompt: it interpolates the stored resume, cover letter and job text', () => {
  const prompt = buildSystemInstruction({
    resume_json: POPULATED_RESUME,
    cover_letter_json: '{"tone":"warm"}',
    job_text: 'JOB-XYZ-DESCRIPTION',
  });

  assert.ok(prompt.includes(POPULATED_RESUME));
  assert.ok(prompt.includes('{"tone":"warm"}'));
  assert.ok(prompt.includes('JOB-XYZ-DESCRIPTION'));
  assert.ok(prompt.includes('None uploaded.'));
  assert.ok(prompt.includes('Current Resume State:'));
  assert.ok(prompt.includes('Target Job Details:'));
});

// ---------------------------------------------------------------------------
// Uploaded CV, first turn (PRD §9.7)
// ---------------------------------------------------------------------------

test('prompt: an uploaded CV with an empty resume carries the acknowledge-and-populate instruction', () => {
  const prompt = buildSystemInstruction({ resume_json: EMPTY_RESUME, source_text: 'OLD CV TEXT' });

  assert.ok(prompt.includes(UPLOAD_MARKER));
  assert.match(prompt, /acknowledge that you have read the uploaded CV/i);
  assert.match(prompt, /Call the 'update_resume' tool to populate/);
  assert.ok(prompt.includes('OLD CV TEXT'), 'the source text itself must still be interpolated');
  assert.match(prompt, /genuine gaps/i);
  assert.match(prompt, /does NOT pre-fill/);
});

test('prompt: an uploaded CV over an already-populated resume does not carry the upload instruction', () => {
  const prompt = buildSystemInstruction({ resume_json: POPULATED_RESUME, source_text: 'OLD CV TEXT' });

  assert.ok(!prompt.includes(UPLOAD_MARKER));
  assert.ok(prompt.includes('OLD CV TEXT'), 'source text stays available for gap-filling');
});

test('prompt: a malformed stored resume_json is treated as empty, not as a crash', () => {
  const prompt = buildSystemInstruction({ resume_json: '{not valid json', source_text: 'OLD CV' });
  assert.ok(prompt.includes(UPLOAD_MARKER));
});

test('prompt: the uploaded-CV and country blocks coexist', () => {
  const prompt = buildSystemInstruction({
    resume_json: EMPTY_RESUME,
    source_text: 'OLD CV',
    country_code: 'DE',
  });

  assert.ok(prompt.includes(UPLOAD_MARKER));
  assert.ok(prompt.includes('Lebenslauf'));
  assert.ok(prompt.includes('`signature`'));
});

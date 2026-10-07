import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UPDATE_RESUME_TOOL,
  UPDATE_COVER_LETTER_TOOL,
  validateResumePatch,
  validateCoverLetterPatch,
  toOpenAITools,
  toAnthropicTools,
  toGeminiTools,
  toGeminiSchema,
} from '../schema';

test('validators accept valid resume and cover-letter patches', () => {
  assert.equal(
    validateResumePatch({ basics: { fullName: 'Ada' }, work: [{ company: 'X', highlights: ['a'] }] }),
    null,
  );
  assert.equal(validateCoverLetterPatch({ recipient: { company: 'X' }, intro: 'hi', tone: 'warm' }), null);
});

test('validators reject non-object, wrong-typed, and unknown-key patches', () => {
  assert.match(validateResumePatch(null)!, /JSON object/);
  assert.match(validateResumePatch([])!, /JSON object/);
  assert.match(validateResumePatch({ nope: 1 })!, /Unknown field "nope"/);
  assert.match(validateResumePatch({ work: 'x' })!, /must be an array/);
  assert.match(validateResumePatch({ work: ['x'] })!, /Entry 0/);
  assert.match(validateResumePatch({ basics: 'x' })!, /must be an object/);

  assert.match(validateCoverLetterPatch({ intro: 42 })!, /must be a string/);
  assert.match(validateCoverLetterPatch({ recipient: 'x' })!, /must be an object/);
  assert.match(validateCoverLetterPatch({ foo: true })!, /Unknown field "foo"/);
});

test('validators are permissive about extra keys inside array items', () => {
  assert.equal(validateResumePatch({ work: [{ company: 'X', anyExtra: true }] }), null);
  assert.equal(validateCoverLetterPatch({ recipient: { name: 'A', extra: 1 } }), null);
});

test('validators accept the M10 personal / signature / photo fields', () => {
  assert.equal(validateResumePatch({ personal: { dob: '1990-05-14', nationality: 'German' } }), null);
  assert.equal(validateResumePatch({ signature: { place: 'Berlin', signed: true } }), null);
  assert.equal(validateResumePatch({ basics: { photo: 'data:image/png;base64,AAAA' } }), null);
  assert.match(validateResumePatch({ personal: 'x' })!, /must be an object/);
  assert.match(validateResumePatch({ signature: 5 })!, /must be an object/);
  assert.match(validateResumePatch({ basics: 'x' })!, /must be an object/);
});

test('resume tool declares the M10 patch fields', () => {
  const patchProps: any = (UPDATE_RESUME_TOOL.parameters.properties as any).patch.properties;
  assert.ok(patchProps.personal, 'update_resume must declare personal');
  assert.ok(patchProps.signature, 'update_resume must declare signature');
  assert.ok(patchProps.basics.properties.photo, 'basics must declare photo');
  assert.ok(patchProps.personal.properties.dob);
  assert.ok(patchProps.signature.properties.place);
});

test('tool definitions carry the original names and required patch', () => {
  assert.equal(UPDATE_RESUME_TOOL.name, 'update_resume');
  assert.equal(UPDATE_COVER_LETTER_TOOL.name, 'update_cover_letter');
  assert.deepEqual(UPDATE_RESUME_TOOL.parameters.required, ['patch']);
  assert.deepEqual(UPDATE_COVER_LETTER_TOOL.parameters.required, ['patch']);
});

test('toOpenAITools wraps in function declarations', () => {
  const tools = toOpenAITools([UPDATE_RESUME_TOOL]);
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].function.name, 'update_resume');
  assert.equal(tools[0].function.parameters.type, 'object');
});

test('toAnthropicTools uses input_schema', () => {
  const tools = toAnthropicTools([UPDATE_COVER_LETTER_TOOL]);
  assert.equal(tools[0].name, 'update_cover_letter');
  assert.equal(tools[0].input_schema.type, 'object');
});

test('toGeminiSchema uppercases types and drops additionalProperties', () => {
  const converted = toGeminiSchema({
    type: 'object',
    description: 'd',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', description: 'b' },
      list: { type: 'array', items: { type: 'string' } },
    },
    required: ['ok'],
    enum: ['a', 'b'],
  });
  assert.equal(converted.type, 'OBJECT');
  assert.equal(converted.properties.ok.type, 'BOOLEAN');
  assert.equal(converted.properties.list.type, 'ARRAY');
  assert.equal(converted.properties.list.items.type, 'STRING');
  assert.deepEqual(converted.required, ['ok']);
  assert.deepEqual(converted.enum, ['a', 'b']);
  assert.ok(!('additionalProperties' in converted));
});

test('toGeminiTools produces one declaration group with converted parameters', () => {
  const tools = toGeminiTools([UPDATE_RESUME_TOOL]);
  assert.equal(tools.length, 1);
  const declaration = tools[0].functionDeclarations[0];
  assert.equal(declaration.name, 'update_resume');
  assert.equal(declaration.parameters.type, 'OBJECT');
  assert.equal(declaration.parameters.properties.patch.type, 'OBJECT');
  assert.equal(declaration.parameters.properties.patch.properties.basics.type, 'OBJECT');
});

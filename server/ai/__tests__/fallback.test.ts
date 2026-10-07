import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFallbackToolBlocks,
  extractFencedJsonValues,
  stripFallbackBlocks,
  FALLBACK_ADDENDUM,
} from '../index';

test('fallback: parses a single fenced json block', () => {
  const text = 'Sure thing!\n```json\n{"tool":"update_resume","patch":{"basics":{"fullName":"Ada"}}}\n```\nDone.';
  const blocks = parseFallbackToolBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].tool, 'update_resume');
  assert.deepEqual(blocks[0].patch, { basics: { fullName: 'Ada' } });
});

test('fallback: tolerates a fence without a language tag', () => {
  const text = '```\n{"tool":"update_cover_letter","patch":{"intro":"hi"}}\n```';
  const blocks = parseFallbackToolBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].tool, 'update_cover_letter');
});

test('fallback: accepts a bare whole-response JSON object', () => {
  const text = '{"tool":"update_resume","patch":{"basics":{"fullName":"Grace"}}}';
  const blocks = parseFallbackToolBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].patch.basics.fullName, 'Grace');
});

test('fallback: malformed blocks are ignored, not thrown', () => {
  const text = '```json\n{not valid json}\n```\nAlso:\n```json\n{"notTool":true}\n```';
  const blocks = parseFallbackToolBlocks(text);
  assert.equal(blocks.length, 0);
});

test('fallback: multiple blocks are parsed in order', () => {
  const text = [
    '```json',
    '{"tool":"update_resume","patch":{"basics":{"fullName":"A"}}}',
    '```',
    'middle prose',
    '```json',
    '{"tool":"update_cover_letter","patch":{"intro":"Hi"}}',
    '```',
  ].join('\n');
  const blocks = parseFallbackToolBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].tool, 'update_resume');
  assert.equal(blocks[1].tool, 'update_cover_letter');
});

test('fallback: strips blocks from prose', () => {
  const text = 'Here you go.\n```json\n{"tool":"update_resume","patch":{}}\n```\nAll set.';
  assert.equal(stripFallbackBlocks(text), 'Here you go.\n\nAll set.');
  assert.equal(stripFallbackBlocks('{"tool":"update_resume","patch":{}}'), '');
});

test('fallback: extractFencedJsonValues accepts any JSON object (capability probe)', () => {
  assert.equal(extractFencedJsonValues('```json\n{"ok":true}\n```').length, 1);
  assert.equal(extractFencedJsonValues('{"ok":true}').length, 1);
  assert.equal(extractFencedJsonValues('no json here').length, 0);
});

test('fallback addendum documents both tools', () => {
  assert.match(FALLBACK_ADDENDUM, /update_resume/);
  assert.match(FALLBACK_ADDENDUM, /update_cover_letter/);
});

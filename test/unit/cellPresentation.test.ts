import assert from 'node:assert/strict';
import test from 'node:test';
import { needsCellDetail } from '../../src/webview/cellPresentation.js';

test('offers details only for long or multi-line cell values', () => {
  assert.equal(needsCellDetail(null), false);
  assert.equal(needsCellDetail('short value'), false);
  assert.equal(needsCellDetail('x'.repeat(64)), false);
  assert.equal(needsCellDetail('x'.repeat(65)), true);
  assert.equal(needsCellDetail('first\nsecond\nthird'), true);
});

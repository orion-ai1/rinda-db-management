import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSensitiveText } from '../../src/security/redaction.js';

test('redacts explicit secrets and common password forms', () => {
  const text = redactSensitiveText(
    'connect mysql://root:s3cret@localhost failed; password=s3cret',
    ['s3cret']
  );
  assert.equal(text.includes('s3cret'), false);
  assert.match(text, /\[REDACTED\]/);
});

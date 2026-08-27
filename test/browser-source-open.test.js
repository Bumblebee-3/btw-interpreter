const assert = require('assert');
const { extractIndexedSourceUrl } = require('../plugins/browser');

const response = [
  'Related sources (newest first):',
  '1. Instagram post/reel about shared update https://example.com/one',
  '2. Twitter post about shared update https://example.com/two',
  '5. YouTube video on shared update https://example.com/five'
].join('\n');

assert.strictEqual(extractIndexedSourceUrl('open 1', response), 'https://example.com/one');
assert.strictEqual(extractIndexedSourceUrl('open 2', response), 'https://example.com/two');
assert.strictEqual(extractIndexedSourceUrl('open 5', response), 'https://example.com/five');
assert.strictEqual(extractIndexedSourceUrl('open first', response), 'https://example.com/one');

console.log('browser source open tests passed');

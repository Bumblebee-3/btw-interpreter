const assert = require('assert');
const { selectRelevantLinkSources } = require('../plugins/whatsapp');

const bucket = [
  { url: 'https://example.com/old', title: 'old', summary: 'old', sender: 'A', timestamp: 1000 },
  { url: 'https://example.com/new', title: 'new', summary: 'new', sender: 'B', timestamp: 2000 }
];

assert.deepStrictEqual(selectRelevantLinkSources(bucket, 100, 60, 6), []);
assert.deepStrictEqual(selectRelevantLinkSources(bucket, 2000, 60, 6).map(item => item.url), ['https://example.com/new']);

console.log('whatsapp link source tests passed');

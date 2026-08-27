const assert = require('assert');
const { shouldRewriteQuery } = require('../src/interpreter/queryRewrite');

const history = [{ userQuery: 'summarize messages from krishna', toolName: 'followup:whatsapp' }];

assert.strictEqual(shouldRewriteQuery('2', history, null, { lastToolName: 'followup:whatsapp' }), false);
assert.strictEqual(shouldRewriteQuery('option 2', history, null, { lastToolName: 'followup:whatsapp' }), false);
assert.strictEqual(shouldRewriteQuery('first', history, null, { lastToolName: 'followup:whatsapp' }), false);
assert.strictEqual(shouldRewriteQuery('what about that', history, null, { lastToolName: 'followup:whatsapp' }), true);

console.log('query rewrite tests passed');

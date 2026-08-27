const assert = require('assert');
const { extractGenericSendIntent } = require('../src/interpreter/workflowHandler');

assert.deepStrictEqual(extractGenericSendIntent('send a message to dhiren telling him that i got whatsapp working on it :)'), {
  recipient: 'dhiren',
  message: 'i got whatsapp working on it :)'
});

assert.strictEqual(extractGenericSendIntent('tell me about the weather'), null);
assert.strictEqual(extractGenericSendIntent('send a message to dhiren'), null);

console.log('workflow send intent tests passed');

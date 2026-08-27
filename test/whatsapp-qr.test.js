const assert = require('assert');
const { shouldDisplayQrUpdate } = require('../plugins/whatsapp');

assert.strictEqual(shouldDisplayQrUpdate('qr-1', 'connecting', 'closed', ''), true);
assert.strictEqual(shouldDisplayQrUpdate('qr-2', 'connecting', 'closed', 'qr-1'), true);
assert.strictEqual(shouldDisplayQrUpdate('qr-1', 'connecting', 'closed', 'qr-1'), false);
assert.strictEqual(shouldDisplayQrUpdate('qr-3', 'open', 'open', ''), false);
assert.strictEqual(shouldDisplayQrUpdate('qr-4', 'close', 'closed', ''), false);
assert.strictEqual(shouldDisplayQrUpdate('qr-5', 'connecting', 'close', ''), false);

console.log('whatsapp qr tests passed');

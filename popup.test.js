const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const en = require('./_locales/en/messages.json');
const getMessage = key => en[key].message;

// Loads popup.js without a page: its panel code waits for DOMContentLoaded,
// which never fires here, so only the top-level helpers are defined.
function popupHelpers() {
    const context = vm.createContext({ document: { addEventListener() {} }, chrome: {}, console });
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8'), context);
    return context;
}

test('a failure the service worker reports is shown word for word, even when it mentions the API', () => {
    const { analysisErrorMessage } = popupHelpers();
    const response = { success: false, error: en.prepaidCreditsDepleted.message };

    assert.equal(analysisErrorMessage(new Error(response.error), response, getMessage), en.prepaidCreditsDepleted.message);
});

test('an unexpected error with no message from the service worker gets the generic failure message', () => {
    const { analysisErrorMessage } = popupHelpers();
    const lostConnection = new Error('Could not establish connection. Receiving end does not exist.');

    assert.equal(analysisErrorMessage(lostConnection, undefined, getMessage), en.analysisFailed.message);
});

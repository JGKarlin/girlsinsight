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

// ---------------------------------------------------------------- error card

const ja = require('./_locales/ja/messages.json');
const strictMessages = messages => key => {
    assert.ok(messages[key], `missing message ${key}`);
    return messages[key].message;
};
const plain = value => JSON.parse(JSON.stringify(value)); // objects from the vm realm

test('every error card has a title, an explanation, steps and button labels in English and Japanese', () => {
    const context = popupHelpers();
    const kinds = plain(vm.runInContext('Object.keys(ERROR_CARD_ACTIONS)', context));
    assert.deepEqual(kinds.sort(), ['busy', 'creditsDepleted', 'keyRejected', 'noKey', 'noModel', 'other', 'pageUnreadable', 'rateLimited']);
    for (const [locale, messages] of [['en', en], ['ja', ja]]) {
        for (const kind of kinds) {
            const card = plain(context.errorCardContent(kind, '', strictMessages(messages)));
            assert.ok(card.title && card.why && card.intro, `${locale} ${kind}`);
            assert.ok(card.steps.length >= 2, `${locale} ${kind} has steps`);
            assert.ok(card.actions.length >= 1 && card.actions.every(action => action.label), `${locale} ${kind} buttons`);
        }
    }
});

test('the used-up credits card explains the free route and offers the API Keys page and Settings', () => {
    const card = plain(popupHelpers().errorCardContent('creditsDepleted', en.prepaidCreditsDepleted.message, getMessage));

    assert.equal(card.title, en.errorTitle_creditsDepleted.message);
    assert.equal(card.intro, en.errorIntroFree.message);
    assert.deepEqual(card.actions.map(action => action.action), ['openApiKeysPage', 'openSettings']);
});

test('a busy Gemini offers Try again; an unreadable page offers Reload page', () => {
    const { errorCardContent } = popupHelpers();
    assert.deepEqual(plain(errorCardContent('busy', '', getMessage)).actions.map(a => a.action), ['tryAgain']);
    assert.deepEqual(plain(errorCardContent('pageUnreadable', '', getMessage)).actions.map(a => a.action), ['reloadPage']);
});

test('any other failure is explained in the service worker\'s own words, and an unknown kind is treated the same', () => {
    const { errorCardContent } = popupHelpers();
    const message = 'The analysis was cut off before it finished.';
    for (const kind of ['other', 'somethingNew', undefined]) {
        const card = plain(errorCardContent(kind, message, getMessage));
        assert.equal(card.title, en.errorTitle_other.message);
        assert.equal(card.why, message);
        assert.deepEqual(card.actions.map(action => action.action), ['tryAgain']);
    }
});

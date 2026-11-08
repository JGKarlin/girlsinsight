// Runs the real content.js against a small fake GirlsChannel page: only the
// DOM calls the page reader makes are faked, plus chrome.runtime messaging.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = __dirname;

function element({ text = '', attrs = {}, href, children = {} } = {}) {
    const node = {
        textContent: text,
        innerText: text,
        href,
        getAttribute: name => (name in attrs ? attrs[name] : null),
        querySelector: selector => [].concat(children[selector] || [])[0] || null,
        querySelectorAll: selector => [].concat(children[selector] || []),
        cloneNode: () => node,
        remove() {},
    };
    return node;
}

function commentElement(number, text, { plus = 0, minus = 0, replyPath = null } = {}) {
    const replyLink = replyPath
        ? element({ text: '1件の返信', attrs: { href: replyPath }, href: `https://girlschannel.net${replyPath}` })
        : null;
    return element({
        children: {
            '.info': element({ text: `${number}. 匿名` }),
            '.icon-rate-wrap-plus p': element({ text: String(plus) }),
            '.icon-rate-wrap-minus p': element({ text: `-${minus}` }),
            '.body': element({ text }),
            'a[href]': replyLink ? [replyLink] : [],
        },
    });
}

// Loads content.js on a one-page topic and returns what it sends.
function loadContentScript(comments, replyPages = {}) {
    const sent = []; // messages, in order, including fetchPage requests
    let onMessage = null;
    const page = element({
        children: {
            '.comment-item': comments,
            h1: element({ text: 'Test topic' }),
        },
    });
    page.title = 'Test topic';
    const chrome = {
        runtime: {
            lastError: undefined,
            onMessage: { addListener: listener => { onMessage = listener; } },
            sendMessage: (message, callback) => {
                sent.push(message);
                if (message.action === 'fetchPage') {
                    callback({ success: true, html: message.url });
                }
            },
        },
        storage: { local: { set: async () => {}, remove: async () => {} } },
    };
    class DOMParser {
        parseFromString(html) {
            return element({ children: { 'li.comment-item': replyPages[html] || [] } });
        }
    }
    const context = vm.createContext({
        chrome,
        document: page,
        window: { location: { href: 'https://girlschannel.net/topics/1/' } },
        DOMParser,
        URL,
        console: { log() {}, warn() {}, error() {}, info() {} },
        setTimeout: (callback, _ms, ...args) => setTimeout(callback, 0, ...args),
        Date,
    });
    context.globalThis = context;
    for (const file of ['girlschannel-parsing.js', 'content.js']) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
    }
    const start = options => onMessage({ action: 'startPhasedExtraction', analysisId: 'a1', options }, {}, () => {});
    return { sent, start };
}

async function until(condition) {
    const deadline = Date.now() + 2000;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('timed out waiting');
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

test('with replies on, the page reader sends the main comments before it fetches any reply page', async () => {
    const replyUrl = 'https://girlschannel.net/comment/1/2/';
    const { sent, start } = loadContentScript(
        [commentElement(1, 'Topic post'), commentElement(2, 'Has a reply', { plus: 5, replyPath: '/comment/1/2/' })],
        { [replyUrl]: [commentElement(2, 'Has a reply'), commentElement(1, 'The reply')] },
    );
    start({ scrapeReplies: true });
    await until(() => sent.some(m => m.action === 'allCommentsReady'));

    const actions = sent.map(m => m.action);
    const mainIndex = actions.indexOf('mainCommentsReady');
    const replyFetchIndex = sent.findIndex(m => m.action === 'fetchPage' && m.url === replyUrl);
    assert.ok(mainIndex >= 0, `no mainCommentsReady in ${JSON.stringify(actions)}`);
    assert.ok(replyFetchIndex > mainIndex, 'the main comments were sent only after the reply pages');
    const main = sent[mainIndex];
    assert.equal(main.analysisId, 'a1');
    assert.deepEqual([...main.data.data.comments].map(c => c.text), ['Topic post', 'Has a reply']);
    const all = sent.find(m => m.action === 'allCommentsReady');
    assert.deepEqual([...all.data.data.comments].map(c => c.text), ['Topic post', 'Has a reply', 'The reply']);
});

test('with replies off, the page reader sends the comments only once', async () => {
    const { sent, start } = loadContentScript([commentElement(1, 'Topic post'), commentElement(2, 'A comment')]);
    start({ scrapeReplies: false });
    await until(() => sent.some(m => m.action === 'allCommentsReady'));
    assert.ok(!sent.some(m => m.action === 'mainCommentsReady'));
});

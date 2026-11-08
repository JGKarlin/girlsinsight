// Loads the real background.js service worker in a Node vm context.
// Only the parts that cannot run outside Chrome are faked: the chrome.* APIs
// and network fetches (locale files are served from disk; Gemini is scripted
// per test). Timers run with zero delay so retry back-off and the post-summary
// pause do not slow the suite down.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function chromeEvent() {
    const listeners = [];
    return {
        listeners,
        addListener(listener) { listeners.push(listener); },
        removeListener(listener) {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
        },
    };
}

function storageArea(initial = {}) {
    const data = { ...initial };
    return {
        data,
        async get(keys) {
            if (keys == null) return { ...data };
            const list = typeof keys === 'string' ? [keys]
                : Array.isArray(keys) ? keys : Object.keys(keys);
            const result = {};
            for (const key of list) if (key in data) result[key] = data[key];
            return result;
        },
        async set(items) { Object.assign(data, items); },
        async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
    };
}

function jsonResponse(status, body) {
    const text = JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: String(status),
        json: async () => JSON.parse(text),
        text: async () => text,
    };
}

function geminiText(text) {
    return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP' }],
    });
}

/**
 * @param {object} options
 * @param {object} [options.sync]   initial chrome.storage.sync contents
 * @param {(request: {model: string, prompt: string}) => object} [options.gemini]
 *        returns a fetch-style response for each generateContent call
 */
async function loadBackground({ sync = {}, gemini = () => geminiText('ok') } = {}) {
    const runtimeMessages = [];
    const geminiRequests = [];
    const fastTimeout = (callback, _ms, ...args) => setTimeout(callback, 0, ...args);

    const chrome = {
        storage: { sync: storageArea(sync), local: storageArea() },
        runtime: {
            getURL: relativePath => relativePath,
            onMessage: chromeEvent(),
            onInstalled: chromeEvent(),
            onStartup: chromeEvent(),
            sendMessage: async message => { runtimeMessages.push(message); },
            getPlatformInfo: async () => ({ os: 'mac' }),
            lastError: undefined,
        },
        action: { onClicked: chromeEvent(), setPopup: async () => {} },
        sidePanel: {
            open: async () => {},
            setPanelBehavior: async () => {},
            setOptions: async () => {},
        },
        contextMenus: {
            removeAll: async () => {},
            create: (_props, callback) => { if (callback) callback(); },
            onClicked: chromeEvent(),
        },
        tabs: {
            onUpdated: chromeEvent(),
            onRemoved: chromeEvent(),
            query: async () => [],
            sendMessage: async () => ({ success: true }),
        },
    };

    async function fakeFetch(url, init = {}) {
        if (url.startsWith('_locales/')) {
            return jsonResponse(200, JSON.parse(fs.readFileSync(path.join(ROOT, url), 'utf8')));
        }
        if (/\/v1beta\/models\?key=/.test(url)) {
            return jsonResponse(200, { models: [] });
        }
        const match = url.match(/\/v1beta\/models\/([^:]+):generateContent/);
        if (match) {
            const body = JSON.parse(init.body);
            const request = { model: match[1], prompt: body.contents[0].parts[0].text };
            geminiRequests.push(request);
            return gemini(request);
        }
        throw new Error(`Unexpected fetch in test: ${url}`);
    }

    const silent = { log() {}, warn() {}, error() {}, info() {} };
    const context = vm.createContext({
        chrome,
        console: silent,
        fetch: fakeFetch,
        setTimeout: fastTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        crypto: globalThis.crypto,
        URL,
        AbortController,
    });
    context.globalThis = context;
    context.importScripts = (...files) => {
        for (const file of files) {
            if (file.includes('xlsx')) continue; // Excel export is not under test here
            vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
        }
    };

    vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context, {
        filename: 'background.js',
    });
    // background.js creates its own instance on load. Tests drive a second
    // instance directly; chrome.runtime.sendMessage only records messages, so
    // the two never talk to each other.
    const background = vm.runInContext('new GirlsinSightBackground()', context);
    await new Promise(resolve => setTimeout(resolve, 0)); // let initialize() settle

    return { background, chrome, runtimeMessages, geminiRequests };
}

/**
 * Runs startFullAnalysis end to end, with chrome.tabs.sendMessage standing in
 * for the content script: it answers startPhasedExtraction by delivering the
 * opening post and then the given comments through the real message handler.
 */
async function runFullAnalysis(harness, { comments, settings }) {
    const { background, chrome } = harness;
    const tabId = 7;
    chrome.tabs.sendMessage = async (targetTab, message) => {
        if (message.action !== 'startPhasedExtraction') return { success: true };
        const sender = { tab: { id: targetTab } };
        setTimeout(() => {
            background.handleMessage({
                action: 'initialDataReady',
                analysisId: message.analysisId,
                data: {
                    success: true,
                    data: {
                        topicData: { title: 'Test topic', url: 'https://girlschannel.net/topics/1/' },
                        firstPageComments: [comments[0]],
                    },
                },
            }, sender, () => {});
            background.handleMessage({
                action: 'allCommentsReady',
                analysisId: message.analysisId,
                data: { success: true, data: { comments, activityStats: { score: 1 } } },
            }, sender, () => {});
        }, 0);
        return { success: true };
    };

    const result = await background.startFullAnalysis({
        tabId,
        analysisId: 'test-run',
        settings: { geminiApiKey: 'test-key', language: 'en', commentsToDisplay: 5, ...settings },
        articleAccessGranted: false,
    });
    const statsMessage = harness.runtimeMessages.find(
        message => message.action === 'partialResults' && message.type === 'stats'
    );
    return { result, stats: statsMessage && statsMessage.data.stats };
}

/** Splits the sentiment prompt into the comment texts sent in each list. */
function sentimentSample(prompt, { separator = /\n|\\n/ } = {}) {
    const between = (start, end) => prompt.split(start)[1].split(end)[0];
    const parse = block => block.split(separator)
        .map(line => line.replace(/ \(Up: \d+, Down: \d+\)$/, '').trim())
        .filter(Boolean);
    return {
        top: parse(between('Top-voted comments:\n', '\n\nBottom-voted comments:')),
        bottom: parse(between('Bottom-voted comments:\n', '\n\nAt the end')),
    };
}

function comment(number, text, plus, minus, extra = {}) {
    return { number, text, plus, minus, date: '2026-11-01T00:00:00.000Z', urls: [], ...extra };
}

module.exports = {
    geminiText,
    jsonResponse,
    loadBackground,
    runFullAnalysis,
    sentimentSample,
    comment,
};

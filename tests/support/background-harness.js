// Loads the real background.js service worker in a Node vm context.
// Only the parts that cannot run outside Chrome are faked: the chrome.* APIs
// and network fetches (locale files are served from disk; Gemini is scripted
// per test). Timers run with zero delay so retry back-off and the post-summary
// pause do not slow the suite down; requested delays are recorded instead.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');

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

function storageArea(initial = {}, { quotaBytes = Infinity } = {}) {
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
        async set(items) {
            const next = { ...data, ...items };
            if (JSON.stringify(next).length > quotaBytes) {
                throw new Error('QUOTA_BYTES quota exceeded');
            }
            Object.assign(data, items);
        },
        async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
    };
}

// A ReadableStream body in Server-Sent Events form, as streamGenerateContent
// sends it (`data: {json}` events separated by blank lines).
function sseBody(chunks) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\r\n\r\n`));
            }
            controller.close();
        },
    });
}

function jsonResponse(status, body) {
    const text = JSON.stringify(body);
    const ok = status >= 200 && status < 300;
    return {
        ok,
        status,
        statusText: String(status),
        json: async () => JSON.parse(text),
        text: async () => text,
        // A successful reply also works for a streaming request, as one event.
        body: ok ? sseBody([body]) : null,
    };
}

function geminiText(text, finishReason = 'STOP') {
    return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason }],
    });
}

/** A streamed reply: each string is one SSE event; the last carries finishReason. */
function geminiStream(pieces, finishReason = 'STOP') {
    const chunks = pieces.map((text, index) => ({
        candidates: [{
            content: { parts: [{ text }], role: 'model' },
            ...(index === pieces.length - 1 ? { finishReason } : {}),
        }],
    }));
    return { ok: true, status: 200, statusText: '200', body: sseBody(chunks), text: async () => '', json: async () => chunks[0] };
}

/**
 * A streamed reply built from raw candidate chunks, e.g.
 * { parts: [{ text, thought: true }] } for one of Gemini's thinking notes.
 */
function geminiStreamChunks(chunks) {
    const events = chunks.map(({ parts, finishReason }) => ({
        candidates: [{ content: { parts, role: 'model' }, ...(finishReason ? { finishReason } : {}) }],
    }));
    return { ok: true, status: 200, statusText: '200', body: sseBody(events), text: async () => '', json: async () => events[0] };
}

/** A streamed reply that sends `pieces` and then goes quiet without finishing. */
function stalledStream(pieces) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
        start(controller) {
            for (const text of pieces) {
                const chunk = { candidates: [{ content: { parts: [{ text }], role: 'model' } }] };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\r\n\r\n`));
            }
        },
    });
    return { ok: true, status: 200, statusText: '200', body, text: async () => '', json: async () => ({}) };
}

const DEFAULT_MODELS = [
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent', 'countTokens'] },
];

/**
 * @param {object} options
 * @param {object} [options.sync]   initial chrome.storage.sync contents
 * @param {object} [options.local]  initial chrome.storage.local contents
 * @param {number} [options.localQuota] byte limit for chrome.storage.local
 * @param {Array}  [options.models] models returned by GET /v1beta/models
 * @param {() => object} [options.modelsReply] replaces the whole GET /v1beta/models reply
 * @param {(request) => object} [options.gemini]
 *        returns a fetch-style response for each generate call
 * @param {number[]} [options.heldTimerDelays] timers of these lengths are
 *        recorded but never fire. By default those are the 90 s wait for
 *        the first words and the 30 s silence limit, so a test can hold back
 *        a Gemini reply without it counting as Gemini going quiet; tests of
 *        the limits themselves pass their own list.
 */
async function loadBackground({
    sync = {},
    local = {},
    localQuota = Infinity,
    models = DEFAULT_MODELS,
    modelsReply = null,
    gemini = () => geminiText('ok'),
    heldTimerDelays = [30_000, 90_000],
} = {}) {
    const runtimeMessages = [];
    const geminiRequests = [];
    const modelListRequests = [];
    const timerDelays = [];
    const fastTimeout = (callback, ms, ...args) => {
        timerDelays.push(ms);
        if (heldTimerDelays.includes(ms)) return { held: ms };
        return setTimeout(callback, 0, ...args);
    };

    const chrome = {
        storage: { sync: storageArea(sync), local: storageArea(local, { quotaBytes: localQuota }) },
        runtime: {
            getURL: relativePath => relativePath,
            onMessage: chromeEvent(),
            onInstalled: chromeEvent(),
            onStartup: chromeEvent(),
            onConnect: chromeEvent(),
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
        if (/\/v1beta\/models(\?|$)/.test(url)) {
            modelListRequests.push({ url, headers: init.headers || {} });
            return modelsReply ? modelsReply() : jsonResponse(200, { models });
        }
        const match = url.match(/\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)/);
        if (match) {
            const body = JSON.parse(init.body);
            const request = {
                model: match[1],
                streaming: match[2] === 'streamGenerateContent',
                prompt: body.contents[0].parts[0].text,
                body,
                url,
                headers: init.headers || {},
                signal: init.signal,
            };
            geminiRequests.push(request);
            return gemini(request);
        }
        throw new Error(`Unexpected fetch in test: ${url}`);
    }

    // console.log calls are recorded (verbose logging is gated by DEBUG_MODE);
    // warnings and errors are silenced.
    const consoleLogs = [];
    const silent = { log: (...args) => consoleLogs.push(args), warn() {}, error() {}, info() {} };
    const context = vm.createContext({
        chrome,
        console: silent,
        fetch: fakeFetch,
        setTimeout: fastTimeout,
        clearTimeout,
        // The keep-alive interval must not hold the test process open if a
        // test leaves an analysis running.
        setInterval: (...args) => { const timer = setInterval(...args); timer.unref(); return timer; },
        clearInterval,
        crypto: globalThis.crypto,
        URL,
        AbortController,
        TextDecoder,
        Date,
    });
    context.globalThis = context;
    context.importScripts = (...files) => {
        for (const file of files) {
            if (file.includes('xlsx')) continue; // Excel workbook writing is not under test here
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

    const tabMessages = []; // messages sent to the content script by runFullAnalysis
    return { background, chrome, runtimeMessages, tabMessages, geminiRequests, modelListRequests, timerDelays, consoleLogs };
}

/**
 * Runs startFullAnalysis end to end, with chrome.tabs.sendMessage standing in
 * for the content script: it answers startPhasedExtraction by delivering the
 * opening post and then the given comments through the real message handler.
 * With `mainComments`, the main comments are delivered first (as the page
 * reader does when reply pages still have to be fetched), and the full list
 * follows once `allCommentsGate` resolves.
 */
async function runFullAnalysis(harness, { comments, settings, analysisId = 'test-run', mainComments = null, allCommentsGate = null }) {
    const { background, chrome } = harness;
    const tabId = 7;
    chrome.tabs.sendMessage = async (targetTab, message) => {
        harness.tabMessages.push(message);
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
            if (mainComments) {
                background.handleMessage({
                    action: 'mainCommentsReady',
                    analysisId: message.analysisId,
                    data: { success: true, data: { comments: mainComments } },
                }, sender, () => {});
            }
            Promise.resolve(allCommentsGate).then(() => background.handleMessage({
                action: 'allCommentsReady',
                analysisId: message.analysisId,
                data: { success: true, data: { comments, activityStats: { score: 1 } } },
            }, sender, () => {}));
        }, 0);
        return { success: true };
    };

    const result = await background.startFullAnalysis({
        tabId,
        analysisId,
        settings: { geminiApiKey: 'test-key', language: 'en', commentsToDisplay: 5, ...settings },
        articleAccessGranted: false,
    });
    const partial = type => harness.runtimeMessages.filter(
        message => message.action === 'partialResults' && message.type === type
    );
    const statsMessage = partial('stats')[0];
    const sentimentMessage = partial('sentiment')[0];
    return {
        result,
        stats: statsMessage && statsMessage.data.stats,
        sentiment: sentimentMessage && sentimentMessage.data.sentiment,
        drafts: partial('sentimentDraft').map(message => message.data.text),
    };
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
    chromeEvent,
    comment,
    geminiStream,
    geminiStreamChunks,
    geminiText,
    jsonResponse,
    loadBackground,
    runFullAnalysis,
    sentimentSample,
    stalledStream,
};

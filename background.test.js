const test = require('node:test');
const assert = require('node:assert/strict');

const {
    comment,
    geminiStream,
    geminiText,
    jsonResponse,
    loadBackground,
    runFullAnalysis,
    sentimentSample,
} = require('./test-support/background-harness.js');
const en = require('./_locales/en/messages.json');

// 5 heavily upvoted, 5 heavily downvoted and 30 low-engagement comments.
function polarizedTopic() {
    const comments = [];
    for (let i = 1; i <= 5; i++) comments.push(comment(i, `LOVED-${i}`, 900 - i * 10, 20));
    for (let i = 1; i <= 5; i++) comments.push(comment(5 + i, `HATED-${i}`, 30, 800 - i * 10));
    for (let i = 1; i <= 30; i++) comments.push(comment(10 + i, `quiet-${i}`, i % 4, i % 3));
    return comments;
}

function topicOfSize(count) {
    return Array.from({ length: count }, (_, i) => comment(i + 1, `c${i + 1}`, i, count - i));
}

const isSentimentRequest = request => request.prompt.includes('Top-voted comments:');

function sentimentPrompt(harness) {
    const request = harness.geminiRequests.find(isSentimentRequest);
    assert.ok(request, 'a sentiment request was sent');
    return request.prompt;
}

// Answers the summary with plain text and the essay with `essay(request)`.
function scriptedGemini(essay) {
    return request => (isSentimentRequest(request) ? essay(request) : geminiText('A summary.'));
}

const manual10 = { autoCommentCalculation: false, commentsToAnalyze: 10 };

// ---------------------------------------------------------------- sampling

test('the sentiment sample sends the most upvoted comments as top-voted and the most downvoted as bottom-voted', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

    const sample = sentimentSample(sentimentPrompt(harness));
    assert.deepEqual([...sample.top].sort(), ['LOVED-1', 'LOVED-2', 'LOVED-3', 'LOVED-4', 'LOVED-5']);
    assert.deepEqual([...sample.bottom].sort(), ['HATED-1', 'HATED-2', 'HATED-3', 'HATED-4', 'HATED-5']);
});

test('each sampled comment is on its own line in the sentiment prompt', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

    const sample = sentimentSample(sentimentPrompt(harness), { separator: '\n' });
    assert.equal(sample.top.length, 5);
    assert.equal(sample.bottom.length, 5);
});

test('auto comment calculation sets how many comments are sent and reported', async () => {
    // 300 comments: (0.03 × 300 + 20) × 2 = 58, split 29 + 29.
    const harness = await loadBackground({ sync: { language: 'en', commentsToAnalyze: 30 } });
    const { stats } = await runFullAnalysis(harness, {
        comments: topicOfSize(300),
        settings: { autoCommentCalculation: true, commentsToAnalyze: 30 },
    });

    const sample = sentimentSample(sentimentPrompt(harness));
    assert.equal(sample.top.length, 29);
    assert.equal(sample.bottom.length, 29);
    assert.equal(stats.commentsAnalyzed, 58);
});

test('replies do not change the sample size, which is based on main comments', async () => {
    const main = topicOfSize(300);
    const replies = main.map(parent => comment(`${parent.number}.1`, `reply to ${parent.number}`, 1, 1, {
        isSubComment: true,
        parentNumber: parent.number,
    }));
    const harness = await loadBackground({ sync: { language: 'en' } });
    const { stats } = await runFullAnalysis(harness, {
        comments: [...main, ...replies],
        settings: { autoCommentCalculation: true, scrapeReplies: true },
    });

    const sample = sentimentSample(sentimentPrompt(harness));
    assert.equal(sample.top.length + sample.bottom.length, 58);
    assert.equal(stats.commentsAnalyzed, 58);
});

test('a requested sample larger than the topic sends each comment once', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    await runFullAnalysis(harness, {
        comments: topicOfSize(150),
        settings: { autoCommentCalculation: false, commentsToAnalyze: 1000 },
    });

    const { top, bottom } = sentimentSample(sentimentPrompt(harness));
    const sent = [...top, ...bottom];
    assert.equal(sent.length, 150);
    assert.equal(new Set(sent).size, 150);
});

test('a topic with a single comment sends that comment once', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    await runFullAnalysis(harness, {
        comments: [comment(1, 'only-comment', 4, 1)],
        settings: { autoCommentCalculation: true },
    });

    const { top, bottom } = sentimentSample(sentimentPrompt(harness));
    assert.deepEqual(top, ['only-comment']);
    assert.deepEqual(bottom, []);
});

// ---------------------------------------------------------------- export

test('the Excel comment sheet lists replies in order under their parent', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    const shuffled = [36, '35.10', '35.2', 35, '35.1', '35.100'].map(number => comment(number, `n${number}`, 1, 1));

    const rows = harness.background.createCommentsSheetData(harness.background.sortCommentsForExport(shuffled));
    // Array.from copies out of the vm realm so deepEqual compares values only.
    assert.deepEqual(Array.from(rows.slice(1), row => row[0]), [35, '35.1', '35.2', '35.10', '35.100', 36]);
});

test('comments without a date show "-" in the Excel sheets instead of 1970', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    const undated = comment(4, 'no date here', 2, 1, { date: null });

    const commentRows = harness.background.createCommentsSheetData([undated]);
    assert.equal(commentRows[1][1], '-');

    const report = harness.background.createExcelData({
        title: 'T', url: 'u', summary: 's',
        sentiment: { label: 'neutral', score: 5, details: 'd' },
        stats: {}, topComments: [undated], bottomComments: [],
    });
    const topRow = report.find(row => row[0] === 'no date here');
    assert.equal(topRow[3], '-');
});

test('a sentiment result without a score shows "-" for label and score in the report', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    const report = harness.background.createExcelData({
        title: 'T', url: 'u', summary: 's',
        sentiment: { label: null, score: null, details: 'unfinished' },
        stats: {}, topComments: [], bottomComments: [],
    });

    const labelRow = report.find(row => row[0] === en.overallScoreLabel.message);
    const scoreRow = report.find(row => row[0] === en.scoreLabel.message);
    assert.equal(labelRow[1], '-');
    assert.equal(scoreRow[1], '-');
});

// ---------------------------------------------------------------- settings

test('extension and browser updates keep the user\'s settings', async () => {
    const saved = { language: 'en', commentsToAnalyze: 200, scrapeReplies: true };
    const harness = await loadBackground({ sync: saved });

    for (const reason of ['update', 'chrome_update']) {
        harness.chrome.runtime.onInstalled.listeners.forEach(listener => listener({ reason }));
    }
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(harness.chrome.storage.sync.data, saved);
});

test('an API key saved by an older version moves from synced to local storage', async () => {
    const harness = await loadBackground({ sync: { language: 'en', geminiApiKey: 'old-key' } });

    assert.equal(harness.chrome.storage.local.data.geminiApiKey, 'old-key');
    assert.equal('geminiApiKey' in harness.chrome.storage.sync.data, false);
    assert.equal(harness.background.settings.geminiApiKey, 'old-key');
});

test('the API key is read from local storage', async () => {
    const harness = await loadBackground({ sync: { language: 'en' }, local: { geminiApiKey: 'device-key' } });
    assert.equal(harness.background.settings.geminiApiKey, 'device-key');
});

test('manual mode without a saved number uses the same default of 30 as a fresh install', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    assert.equal(harness.background.getCommentsToAnalyzeCount(300, { autoCommentCalculation: false }), 30);
});

test('a fresh install stores the default settings', async () => {
    const harness = await loadBackground();
    harness.chrome.runtime.onInstalled.listeners.forEach(listener => listener({ reason: 'install' }));
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(harness.chrome.storage.sync.data, {
        language: 'ja',
        commentsToAnalyze: 30,
        scrapeReplies: false,
    });
});

// ---------------------------------------------------------------- Gemini requests

test('Gemini requests follow the gemini-3.8-flash contract and keep the key out of the URL', async () => {
    // From the Gemini API reference and the official @google/genai SDK:
    // thinking is set with generationConfig.thinkingConfig.thinkingLevel,
    // `store` sits at the top level of the body, and the key can be sent in
    // the x-goog-api-key header.
    const harness = await loadBackground({ sync: { language: 'en' } });
    await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

    assert.equal(harness.geminiRequests.length, 2, 'one summary and one sentiment request');
    for (const { model, body, url, headers } of harness.geminiRequests) {
        assert.equal(model, 'gemini-3.8-flash');
        assert.doesNotMatch(url, /[?&]key=/);
        assert.equal(headers['x-goog-api-key'], 'test-key');
        assert.equal(body.store, false);
        assert.deepEqual(
            body.safetySettings.map(s => `${s.category}:${s.threshold}`).sort(),
            ['HARM_CATEGORY_DANGEROUS_CONTENT:OFF', 'HARM_CATEGORY_HARASSMENT:OFF',
                'HARM_CATEGORY_HATE_SPEECH:OFF', 'HARM_CATEGORY_SEXUALLY_EXPLICIT:OFF']
        );
        const config = body.generationConfig;
        for (const removed of ['temperature', 'topP', 'topK', 'candidateCount']) {
            assert.equal(config[removed], undefined, `${removed} is not sent`);
        }
        assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(config.thinkingConfig.thinkingLevel));
        assert.equal(config.thinkingConfig.thinkingBudget, undefined);
        assert.ok(config.maxOutputTokens > 0 && config.maxOutputTokens <= 65536);
    }
    for (const { url, headers } of harness.modelListRequests) {
        assert.doesNotMatch(url, /[?&]key=/);
        assert.equal(headers['x-goog-api-key'], 'test-key');
    }
});

test('the reply text joins every answer part and leaves out thought parts', async () => {
    const reply = () => jsonResponse(200, {
        candidates: [{
            content: {
                role: 'model',
                parts: [
                    { text: 'Planning the answer…', thought: true },
                    { text: 'Hello, ', thoughtSignature: 'c2lnbmF0dXJl' },
                    { text: 'world.' },
                ],
            },
            finishReason: 'STOP',
        }],
    });
    const harness = await loadBackground({ sync: { language: 'en', geminiApiKey: 'k' }, gemini: reply });

    const text = await harness.background.callGeminiAPI('prompt');
    assert.equal(text, 'Hello, world.');
    // A call with no options still leaves room for thinking.
    assert.ok(harness.geminiRequests[0].body.generationConfig.thinkingConfig.thinkingLevel);
});

test('the sentiment essay is streamed to the panel as it is written', async () => {
    const pieces = ['The community ', 'is largely ', 'supportive.\n\nSentiment: positive\nScore: 8'];
    const harness = await loadBackground({
        sync: { language: 'en' },
        gemini: scriptedGemini(() => geminiStream(pieces)),
    });
    const { sentiment, drafts } = await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

    assert.ok(harness.geminiRequests.find(isSentimentRequest).streaming, 'essay uses streamGenerateContent');
    assert.ok(drafts.length >= 1, 'at least one draft reached the panel');
    assert.equal(drafts[drafts.length - 1], pieces.join(''));
    assert.equal(sentiment.score, 8);
    assert.equal(sentiment.details, 'The community is largely supportive.');
});

// ---------------------------------------------------------------- Gemini errors

const errorBody = (code, status, message, details = []) => ({ error: { code, status, message, details } });

const invalidKey = () => jsonResponse(400, errorBody(400, 'INVALID_ARGUMENT',
    'API key not valid. Please pass a valid API key.',
    [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }]));
// What Gemini answers when the key's project uses Prepay billing and the
// balance is $0. Such a project is blocked; it does not fall back to the free tier.
const creditsDepleted = () => jsonResponse(402, errorBody(402, 'RESOURCE_EXHAUSTED',
    'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.'));

test('an invalid API key fails at once with the localized invalid-key message', async () => {
    const harness = await loadBackground({ sync: { language: 'en', geminiApiKey: 'bad' }, gemini: invalidKey });

    await assert.rejects(harness.background.callGeminiAPI('prompt'), { message: en.apiKeyInvalid.message });
    assert.equal(harness.geminiRequests.length, 1);
});

test('a temporary server error is retried until Gemini answers', async () => {
    let calls = 0;
    const flaky = () => (++calls < 3
        ? jsonResponse(500, errorBody(500, 'INTERNAL', 'Internal error'))
        : geminiText('recovered'));
    const harness = await loadBackground({ sync: { language: 'en', geminiApiKey: 'k' }, gemini: flaky });

    assert.equal(await harness.background.callGeminiAPI('prompt'), 'recovered');
    assert.equal(harness.geminiRequests.length, 3);
});

test('a rate limit is retried after the delay Gemini asks for', async () => {
    let calls = 0;
    const limited = () => (++calls === 1
        ? jsonResponse(429, errorBody(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded',
            [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' }]))
        : geminiText('after the wait'));
    const harness = await loadBackground({ sync: { language: 'en', geminiApiKey: 'k' }, gemini: limited });

    assert.equal(await harness.background.callGeminiAPI('prompt'), 'after the wait');
    assert.equal(harness.geminiRequests.length, 2);
    assert.ok(harness.timerDelays.includes(2000), 'waited the 2 s Gemini asked for');
});

test('a rate limit that asks for a long wait fails at once with the rate-limit message', async () => {
    const limited = () => jsonResponse(429, errorBody(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded',
        [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '120s' }]));
    const harness = await loadBackground({ sync: { language: 'en', geminiApiKey: 'k' }, gemini: limited });

    await assert.rejects(harness.background.callGeminiAPI('prompt'), { message: en.rateLimited.message });
    assert.equal(harness.geminiRequests.length, 1);
});

test('depleted prepaid credits (402) fail at once with a message that points to the free tier', async () => {
    const harness = await loadBackground({ sync: { language: 'en', geminiApiKey: 'k' }, gemini: creditsDepleted });

    await assert.rejects(harness.background.callGeminiAPI('prompt'), { message: en.prepaidCreditsDepleted.message });
    assert.equal(harness.geminiRequests.length, 1);
});

for (const [name, reply, messageKey, errorKind] of [
    ['depleted prepaid credits', creditsDepleted, 'prepaidCreditsDepleted', 'creditsDepleted'],
    ['a rejected API key', invalidKey, 'apiKeyInvalid', 'keyRejected'],
]) {
    test(`${name} at the summary request ends the run with the matching card`, async () => {
        const harness = await loadBackground({ sync: { language: 'en' }, gemini: reply });
        const { result } = await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

        assert.equal(result.success, false);
        assert.ok(!harness.runtimeMessages.some(message => message.action === 'analysisComplete'));
        const failure = harness.runtimeMessages.find(message => message.action === 'analysisFailed');
        assert.equal(failure && failure.error, en[messageKey].message);
        assert.equal(failure.errorKind, errorKind, 'the panel is told which error card to show');
        assert.ok(harness.tabMessages.some(message => message.action === 'abortExtraction'),
            'the content script was told to stop reading pages');
    });
}

test('credits that run out at the sentiment request are named in the sentiment result', async () => {
    const harness = await loadBackground({ sync: { language: 'en' }, gemini: scriptedGemini(creditsDepleted) });
    const { sentiment } = await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

    assert.equal(sentiment.score, null);
    assert.equal(sentiment.details, en.prepaidCreditsDepleted.message);
    assert.equal(sentiment.errorKind, 'creditsDepleted');
});

// What Gemini answers when it sheds free-tier traffic under heavy demand.
const overloaded = () => jsonResponse(503, errorBody(503, 'UNAVAILABLE',
    'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.'));
// A request Gemini never answers; it ends only when the request is aborted.
const neverAnswers = request => new Promise((_, reject) => request.signal.addEventListener('abort', () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    reject(error);
}));

test('a summary request Gemini never answers is given up after 60 s and sent to the fallback model', async () => {
    const harness = await loadBackground({
        sync: { language: 'en' },
        gemini: request => (request.model === 'gemini-3.8-flash' ? neverAnswers(request) : scriptedGemini(() => geminiText('An essay.\nSentiment: Positive\nScore: 7'))(request)),
    });
    const outcome = await Promise.race([
        runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 }),
        new Promise(resolve => setTimeout(() => resolve('still stuck'), 2000)),
    ]);

    assert.notEqual(outcome, 'still stuck', 'the run never moved past the summary request');
    assert.equal(outcome.result.success, true);
    assert.ok(harness.timerDelays.includes(60_000), 'the summary request had a 60 s time limit');
    const summary = harness.runtimeMessages.find(m => m.action === 'partialResults' && m.type === 'summary');
    assert.equal(summary.data.summary, 'A summary.');
});

test('the essay waits up to 3 minutes for Gemini to start, since its deep thinking comes first', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });
    assert.ok(harness.timerDelays.includes(180_000));
});

test('when the main model is too busy the next try uses the fallback model and the run finishes', async () => {
    const harness = await loadBackground({
        sync: { language: 'en' },
        gemini: request => (request.model === 'gemini-3.8-flash' ? overloaded() : scriptedGemini(() => geminiText('An essay.\nSentiment: Positive\nScore: 7'))(request)),
    });
    const { result, sentiment } = await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

    assert.equal(result.success, true);
    assert.equal(sentiment.score, 7);
    assert.ok(harness.geminiRequests.some(r => r.model === 'gemini-3.6-flash'), 'the fallback model was used');
});

const progressTexts = harness => harness.runtimeMessages.filter(m => m.action === 'analysisProgress').map(m => m.message);

test('while Gemini is busy the panel names the busy model, the model it tries next and the try number', async () => {
    const harness = await loadBackground({
        sync: { language: 'en' },
        gemini: request => (request.model === 'gemini-3.8-flash' ? overloaded() : geminiText('A summary.')),
    });
    await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

    assert.ok(progressTexts(harness).includes('Gemini 3.8 Flash is busy. Trying again with Gemini 3.6 Flash (try 2 of 3)…'),
        JSON.stringify(progressTexts(harness)));
});

test('when no other model is left, the busy message says which try comes next', async () => {
    const harness = await loadBackground({
        sync: { language: 'en' },
        models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }],
        gemini: overloaded,
    });
    await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

    assert.ok(progressTexts(harness).includes('Gemini 3.8 Flash is busy. Trying again (try 3 of 3)…'),
        JSON.stringify(progressTexts(harness)));
});

test('a busy spell that does not clear is reported as Gemini being busy', async () => {
    const harness = await loadBackground({ sync: { language: 'en' }, gemini: overloaded });
    const { sentiment } = await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

    assert.equal(sentiment.score, null);
    assert.equal(sentiment.details, en.geminiBusy.message);
    assert.equal(sentiment.errorKind, 'busy');
});

for (const [name, reply] of [
    ['a missing model (404)', () => jsonResponse(404, errorBody(404, 'NOT_FOUND', 'models/x is not found'))],
    ['a blocked prompt', () => jsonResponse(200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })],
    ['a reply stopped by the safety filter', () => geminiText('', 'SAFETY')],
    ['an empty reply cut off at the token limit', () => jsonResponse(200, {
        candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }],
    })],
]) {
    test(`${name} is not retried`, async () => {
        const harness = await loadBackground({ sync: { language: 'en', geminiApiKey: 'k' }, gemini: reply });
        await assert.rejects(harness.background.callGeminiAPI('prompt'));
        assert.equal(harness.geminiRequests.length, 1);
    });
}

test('a reply cut off at the token limit is not returned as a complete answer', async () => {
    const harness = await loadBackground({
        sync: { language: 'en', geminiApiKey: 'k' },
        gemini: () => geminiText('Half an ess', 'MAX_TOKENS'),
    });
    await assert.rejects(harness.background.callGeminiAPI('prompt'), error => error.code === 'MAX_TOKENS');
});

test('a cut-off essay is retried once with less thinking', async () => {
    const harness = await loadBackground({
        sync: { language: 'en' },
        gemini: scriptedGemini(request => (request.body.generationConfig.thinkingConfig.thinkingLevel === 'HIGH'
            ? geminiStream(['Cut off mid-sen'], 'MAX_TOKENS')
            : geminiStream(['A finished essay.\nSentiment: negative\nScore: 2']))),
    });
    const { sentiment } = await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

    const levels = harness.geminiRequests.filter(isSentimentRequest)
        .map(request => request.body.generationConfig.thinkingConfig.thinkingLevel);
    assert.deepEqual(levels, ['HIGH', 'MEDIUM']);
    assert.equal(sentiment.score, 2);
    assert.equal(sentiment.label, 'negative');
});

test('an essay that is still cut off shows no score and says it is incomplete', async () => {
    const harness = await loadBackground({
        sync: { language: 'en' },
        gemini: scriptedGemini(() => geminiStream(['Cut off mid-sen'], 'MAX_TOKENS')),
    });
    const { sentiment } = await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

    assert.equal(sentiment.score, null);
    assert.equal(sentiment.label, null);
    assert.equal(sentiment.details, en.sentimentIncomplete.message);
});

// ---------------------------------------------------------------- model availability

test('when the key cannot use gemini-3.8-flash the newest available Flash model is used', async () => {
    const harness = await loadBackground({
        sync: { language: 'en' },
        models: [
            { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.7-flash-preview', supportedGenerationMethods: ['generateContent'] },
        ],
    });
    await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

    assert.deepEqual([...new Set(harness.geminiRequests.map(r => r.model))], ['gemini-3.6-flash']);
});

test('a key with no usable model stops before extraction with a clear message', async () => {
    const harness = await loadBackground({
        sync: { language: 'en' },
        models: [{ name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] }],
    });
    const { result } = await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

    assert.equal(result.success, false);
    assert.equal(harness.geminiRequests.length, 0);
    const failure = harness.runtimeMessages.find(message => message.action === 'analysisFailed');
    assert.equal(failure.error, en.modelUnavailable.message);
    assert.equal(failure.errorKind, 'noModel');
});

test('the Verify button reports a key that has no usable model', async () => {
    const harness = await loadBackground({
        sync: { language: 'en' },
        models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }],
    });
    const response = await new Promise(resolve => harness.background.handleMessage(
        { action: 'validateApiKey', apiKey: 'k' }, {}, resolve
    ));
    assert.equal(response.success, false);
    assert.equal(response.error, en.modelUnavailable.message);
});

// ---------------------------------------------------------------- run speed and status

// Waits (up to 2 s) until condition() holds; the tests below fail instead of hanging.
async function until(condition) {
    const deadline = Date.now() + 2000;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('timed out waiting');
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

const progressAfter = (harness, text) => {
    const all = harness.runtimeMessages.filter(m => m.action === 'analysisProgress').map(m => m.message);
    return all.slice(all.indexOf(text) + 1);
};

test('the essay starts as soon as the comments are read, without waiting for the summary', async () => {
    let summaryAnswered = false;
    let essaySentWhileSummaryPending = false;
    let releaseSummary = null;
    const harness = await loadBackground({
        sync: { language: 'en' },
        gemini: request => {
            if (isSentimentRequest(request)) {
                essaySentWhileSummaryPending = !summaryAnswered;
                if (releaseSummary) releaseSummary();
                return geminiText('An essay.\nSentiment: Positive\nScore: 7');
            }
            // The summary (article reading plus Gemini) is still running.
            return new Promise(resolve => { releaseSummary = () => { summaryAnswered = true; resolve(geminiText('A summary.')); }; });
        },
    });
    const outcome = await Promise.race([
        runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 }),
        new Promise(resolve => setTimeout(() => resolve('waiting for the summary'), 2000)),
    ]);

    assert.notEqual(outcome, 'waiting for the summary', 'the essay waited for the summary');
    assert.ok(essaySentWhileSummaryPending);
    assert.equal(outcome.result.success, true);
    assert.equal(harness.runtimeMessages.find(m => m.action === 'partialResults' && m.type === 'summary').data.summary, 'A summary.');
});

test('while the essay is being written the status line says so, even after the summary arrives', async () => {
    let releaseEssay = null;
    const harness = await loadBackground({
        sync: { language: 'en' },
        gemini: request => (isSentimentRequest(request)
            ? new Promise(resolve => { releaseEssay = () => resolve(geminiText('An essay.\nSentiment: Positive\nScore: 7')); })
            : geminiText('A summary.')),
    });
    const run = runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });
    await until(() => releaseEssay && harness.runtimeMessages.some(m => m.action === 'partialResults' && m.type === 'summary'));
    await new Promise(resolve => setTimeout(resolve, 0));
    const whileWriting = progressAfter(harness, en.progressSummaryReceived.message);
    releaseEssay();
    await run;

    assert.equal(whileWriting.at(-1), en.progressSendingSentimentRequest.message, JSON.stringify(whileWriting));
});

test('while the summary and the essay are both running, the status line names both', async () => {
    let releaseSummary = null;
    let releaseEssay = null;
    const harness = await loadBackground({
        sync: { language: 'en' },
        gemini: request => new Promise(resolve => {
            const answer = () => resolve(isSentimentRequest(request)
                ? geminiText('An essay.\nSentiment: Positive\nScore: 7')
                : geminiText('A summary.'));
            if (isSentimentRequest(request)) releaseEssay = answer;
            else releaseSummary = answer;
        }),
    });
    const run = runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });
    await until(() => releaseSummary && releaseEssay);
    const status = harness.runtimeMessages.filter(m => m.action === 'analysisProgress').at(-1).message;
    releaseSummary();
    releaseEssay();
    await run;

    assert.equal(status, en.progressSummaryAndSentiment && en.progressSummaryAndSentiment.message);
    assert.equal(status, 'Processing the summary and sentiment analysis...');
});

test('when the essay is done first, the status line says the summary is still on its way', async () => {
    let releaseSummary = null;
    const harness = await loadBackground({
        sync: { language: 'en' },
        gemini: request => (isSentimentRequest(request)
            ? geminiText('An essay.\nSentiment: Positive\nScore: 7')
            : new Promise(resolve => { releaseSummary = () => resolve(geminiText('A summary.')); })),
    });
    const run = runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });
    await until(() => harness.runtimeMessages.some(m => m.action === 'partialResults' && m.type === 'sentiment'));
    const status = harness.runtimeMessages.filter(m => m.action === 'analysisProgress').at(-1).message;
    releaseSummary();
    await run;

    assert.equal(status, en.progressSendingSummaryRequest.message);
});

test('the summary uses low thinking and the essay the deepest', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

    const level = request => request.body.generationConfig.thinkingConfig.thinkingLevel;
    assert.equal(level(harness.geminiRequests.find(r => !isSentimentRequest(r))), 'LOW');
    assert.equal(level(harness.geminiRequests.find(isSentimentRequest)), 'HIGH');
});

test('the page reader no longer says "Extraction complete. Analyzing..." while Gemini is still working', () => {
    const contentScript = require('node:fs').readFileSync(require('node:path').join(__dirname, 'content.js'), 'utf8');
    assert.ok(!contentScript.includes('progressExtractionComplete'));
});

// ---------------------------------------------------------------- summary streaming

test('the summary is streamed to the panel as it is written', async () => {
    const harness = await loadBackground({
        sync: { language: 'en' },
        gemini: request => (isSentimentRequest(request)
            ? geminiText('An essay.\nSentiment: Positive\nScore: 7')
            : geminiStream(['Perfume member ', 'Nocchi announced ', 'her marriage.'])),
    });
    await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

    const summaryRequest = harness.geminiRequests.find(r => !isSentimentRequest(r));
    assert.equal(summaryRequest.streaming, true);
    const drafts = harness.runtimeMessages.filter(m => m.action === 'partialResults' && m.type === 'summaryDraft').map(m => m.data.text);
    assert.ok(drafts.length >= 1, 'drafts were sent');
    assert.equal(drafts.at(-1), 'Perfume member Nocchi announced her marriage.');
    const summary = harness.runtimeMessages.find(m => m.action === 'partialResults' && m.type === 'summary').data.summary;
    assert.equal(summary, 'Perfume member Nocchi announced her marriage.');
});

// ---------------------------------------------------------------- summary prompts

for (const [name, articleText] of [
    ['an article summary', 'The agency announced the marriage on its website. '.repeat(20)],
    ['a summary of the opening post', null],
]) {
    test(`${name} is asked for as one continuous summary, without sections, headings or labels`, async () => {
        const harness = await loadBackground({ sync: { language: 'en', geminiApiKey: 'k' }, gemini: () => geminiText('A summary.') });
        await harness.background.generateSummary(
            { title: 'Test topic' },
            [comment(1, 'Opening post text', 10, 1)],
            articleText
        );
        const { prompt } = harness.geminiRequests[0];

        assert.match(prompt, /one continuous summary/i);
        assert.match(prompt, /sections/i);
        assert.match(prompt, /headings/i);
        assert.match(prompt, /"Meaning:"/);
    });
}

// ---------------------------------------------------------------- error cards

const failureOf = harness => harness.runtimeMessages.find(message => message.action === 'analysisFailed');

test('a run without an API key tells the panel to show the "no key" card', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    await runFullAnalysis(harness, { comments: polarizedTopic(), settings: { ...manual10, geminiApiKey: '' } });
    assert.equal(failureOf(harness).errorKind, 'noKey');
});

for (const [name, reply, errorKind, messageKey] of [
    ['rejects the key', invalidKey, 'keyRejected', 'apiKeyInvalid'],
    ['finds the prepaid credits used up', creditsDepleted, 'creditsDepleted', 'prepaidCreditsDepleted'],
]) {
    test(`a key check that ${name} stops before extraction with the matching card`, async () => {
        const harness = await loadBackground({ sync: { language: 'en' }, modelsReply: reply });
        const { result } = await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

        assert.equal(result.success, false);
        assert.equal(failureOf(harness).errorKind, errorKind);
        assert.equal(failureOf(harness).error, en[messageKey].message);
    });
}

test('a topic page that cannot be read gives the "reload the page" card', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    harness.background.awaitWithSignal = () => Promise.reject(new Error('Failed to extract initial topic data.'));
    await harness.background.startFullAnalysis({
        tabId: 7, analysisId: 'unreadable', articleAccessGranted: false,
        settings: { geminiApiKey: 'k', language: 'en', commentsToDisplay: 5, ...manual10 },
    });
    assert.equal(failureOf(harness).errorKind, 'pageUnreadable');
});

test('a rate limit that does not clear marks the sentiment result as rate limited', async () => {
    const limited = () => jsonResponse(429, errorBody(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded',
        [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '120s' }]));
    const harness = await loadBackground({ sync: { language: 'en' }, gemini: scriptedGemini(limited) });
    const { sentiment } = await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });
    assert.equal(sentiment.errorKind, 'rateLimited');
});

// ---------------------------------------------------------------- panel lifetime

test('closing the side panel cancels the running analysis', async () => {
    const { chromeEvent } = require('./test-support/background-harness.js');
    const port = { name: 'analysis:test-run', onDisconnect: chromeEvent() };
    const harness = await loadBackground({
        sync: { language: 'en' },
        gemini: scriptedGemini(request => {
            // The user closes the panel while the essay is being written.
            setTimeout(() => port.onDisconnect.listeners.forEach(listener => listener(port)), 0);
            return new Promise((_, reject) => request.signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            }));
        }),
    });
    harness.chrome.runtime.onConnect.listeners.forEach(listener => listener(port));

    const outcome = await Promise.race([
        runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 }),
        new Promise(resolve => setTimeout(() => resolve('still running'), 2000)),
    ]);

    assert.notEqual(outcome, 'still running', 'the analysis was not cancelled');
    assert.equal(outcome.result.cancelled, true);
    assert.ok(harness.runtimeMessages.some(message => message.action === 'analysisCancelled'));
});

test('a normal run writes nothing to the console log', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });
    assert.equal(harness.consoleLogs.length, 0, JSON.stringify(harness.consoleLogs.slice(0, 3)).slice(0, 300));
});

// ---------------------------------------------------------------- saved analyses

test('a finished analysis is saved for its topic', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

    const [saved] = harness.chrome.storage.local.data.savedAnalyses;
    assert.equal(saved.url, 'https://girlschannel.net/topics/1/');
    assert.equal(saved.analysis.title, 'Test topic');
    assert.ok(saved.analysis.sentiment, 'sentiment result is saved');
    assert.equal(saved.analysis.allComments.length, 40, 'comments are saved for the Excel export');
    assert.equal(saved.analysis.settings.commentsToDisplay, 5);
});

test('the API key never appears in messages to the panel or in saved analyses', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    await runFullAnalysis(harness, { comments: polarizedTopic(), settings: manual10 });

    assert.doesNotMatch(JSON.stringify(harness.runtimeMessages), /test-key/);
    assert.doesNotMatch(JSON.stringify(harness.chrome.storage.local.data.savedAnalyses), /test-key/);
});

test('saved analyses keep the five most recent topics, newest first, one per topic', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    const analysisFor = id => ({ url: `https://girlschannel.net/topics/${id}/`, title: `topic ${id}` });
    for (const id of [1, 2, 3, 4, 5, 6, 3]) await harness.background.saveAnalysis(analysisFor(id));

    const urls = Array.from(harness.chrome.storage.local.data.savedAnalyses, entry => entry.url.match(/topics\/(\d+)/)[1]);
    assert.deepEqual(urls, ['3', '6', '5', '4', '2']);
});

test('when local storage is full the oldest saved analyses make room for the new one', async () => {
    const big = id => ({ url: `https://girlschannel.net/topics/${id}/`, title: 'x'.repeat(4000) });
    // Room for two analyses of this size, not three.
    const harness = await loadBackground({ sync: { language: 'en' }, localQuota: 9000 });
    for (const id of [1, 2, 3]) await harness.background.saveAnalysis(big(id));

    const urls = Array.from(harness.chrome.storage.local.data.savedAnalyses, entry => entry.url.match(/topics\/(\d+)/)[1]);
    assert.deepEqual(urls, ['3', '2']);
});

// ---------------------------------------------------------------- sentiment parsing

test('a score of 0 is kept as 0 and labeled negative', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    const result = harness.background.parseSentimentResponse('A grim thread.\n\nSentiment: negative\nScore: 0');
    assert.equal(result.score, 0);
    assert.equal(result.label, 'negative');
});

test('only the closing verdict lines are removed from the essay and used for the score', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    // The essay's last paragraph uses the same words mid-sentence, right
    // above the closing verdict lines.
    const lastParagraph = 'In the end the overall sentiment: mixed, with what one user called a score: 9 for honesty.';
    const essay = [
        'First paragraph.',
        lastParagraph,
        '',
        '**Sentiment:** negative',
        '**Score:** 2/10',
    ].join('\n');

    const result = harness.background.parseSentimentResponse(essay);
    assert.equal(result.score, 2);
    assert.equal(result.label, 'negative');
    assert.equal(result.details, `First paragraph.\n${lastParagraph}`);
});

test('an essay without a verdict gets no score instead of a made-up neutral 5', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    const result = harness.background.parseSentimentResponse('An essay that never gives a verdict.');
    assert.equal(result.score, null);
    assert.equal(result.label, null);
    assert.equal(result.details, 'An essay that never gives a verdict.');
});

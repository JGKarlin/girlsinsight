const test = require('node:test');
const assert = require('node:assert/strict');

const {
    comment,
    geminiText,
    jsonResponse,
    loadBackground,
    runFullAnalysis,
    sentimentSample,
} = require('./test-support/background-harness.js');

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

function sentimentPrompt(harness) {
    const request = harness.geminiRequests.find(r => r.prompt.includes('Top-voted comments:'));
    assert.ok(request, 'a sentiment request was sent');
    return request.prompt;
}

test('the sentiment sample sends the most upvoted comments as top-voted and the most downvoted as bottom-voted', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    await runFullAnalysis(harness, {
        comments: polarizedTopic(),
        settings: { autoCommentCalculation: false, commentsToAnalyze: 10 },
    });

    const sample = sentimentSample(sentimentPrompt(harness));
    assert.deepEqual([...sample.top].sort(), ['LOVED-1', 'LOVED-2', 'LOVED-3', 'LOVED-4', 'LOVED-5']);
    assert.deepEqual([...sample.bottom].sort(), ['HATED-1', 'HATED-2', 'HATED-3', 'HATED-4', 'HATED-5']);
});

test('each sampled comment is on its own line in the sentiment prompt', async () => {
    const harness = await loadBackground({ sync: { language: 'en' } });
    await runFullAnalysis(harness, {
        comments: polarizedTopic(),
        settings: { autoCommentCalculation: false, commentsToAnalyze: 10 },
    });

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

test('extension and browser updates keep the user\'s settings', async () => {
    const saved = { language: 'en', commentsToAnalyze: 200, scrapeReplies: true, geminiApiKey: 'k' };
    const harness = await loadBackground({ sync: saved });

    for (const reason of ['update', 'chrome_update']) {
        harness.chrome.runtime.onInstalled.listeners.forEach(listener => listener({ reason }));
    }
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(harness.chrome.storage.sync.data, saved);
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

test('an invalid API key fails at once with the localized invalid-key message', async () => {
    // Gemini's real response body for a bad key.
    const invalidKey = () => jsonResponse(400, {
        error: {
            code: 400,
            message: 'API key not valid. Please pass a valid API key.',
            status: 'INVALID_ARGUMENT',
            details: [{
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'API_KEY_INVALID',
                domain: 'googleapis.com',
            }],
        },
    });
    const harness = await loadBackground({ sync: { language: 'en', geminiApiKey: 'bad' }, gemini: invalidKey });

    await assert.rejects(
        harness.background.callGeminiAPI('prompt', 'gemini-2.5-flash', {}, 3),
        { message: 'API key is invalid or network error' }
    );
    assert.equal(harness.geminiRequests.length, 1);
});

test('Gemini requests use gemini-3.8-flash, only fields it accepts, and opt out of request storage', async () => {
    // Contract from the Gemini API reference and the official @google/genai SDK:
    // sampling parameters are ignored on 3.6+ models, thinking is set with
    // generationConfig.thinkingConfig.thinkingLevel, and `store` sits at the
    // top level of the request body.
    const harness = await loadBackground({ sync: { language: 'en' } });
    await runFullAnalysis(harness, {
        comments: polarizedTopic(),
        settings: { autoCommentCalculation: false, commentsToAnalyze: 10 },
    });

    assert.equal(harness.geminiRequests.length, 2, 'one summary and one sentiment request');
    for (const { model, body } of harness.geminiRequests) {
        assert.equal(model, 'gemini-3.8-flash');
        assert.equal(body.store, false);
        assert.equal(body.safetySettings, undefined);
        const config = body.generationConfig;
        for (const removed of ['temperature', 'topP', 'topK', 'candidateCount']) {
            assert.equal(config[removed], undefined, `${removed} is not sent`);
        }
        assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(config.thinkingConfig.thinkingLevel));
        assert.equal(config.thinkingConfig.thinkingBudget, undefined);
        assert.ok(config.maxOutputTokens > 0 && config.maxOutputTokens <= 65536);
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
});

test('a temporary server error is retried until Gemini answers', async () => {
    let calls = 0;
    const flaky = () => (++calls < 3
        ? jsonResponse(500, { error: { code: 500, message: 'Internal error', status: 'INTERNAL' } })
        : geminiText('recovered'));
    const harness = await loadBackground({ sync: { language: 'en', geminiApiKey: 'k' }, gemini: flaky });

    const text = await harness.background.callGeminiAPI('prompt', 'gemini-2.5-flash', {}, 3);
    assert.equal(text, 'recovered');
    assert.equal(harness.geminiRequests.length, 3);
});

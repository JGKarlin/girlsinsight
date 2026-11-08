const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ArticlePipeline,
    articleAccessOrigins,
    buildArticleExcerpt,
    collectArticleCandidates,
    createSourceReference,
} = require('./article-pipeline.js');

test('article access is requested only for the linked sites plus the Wayback Machine', () => {
    const origins = articleAccessOrigins([
        'https://news.yahoo.co.jp/articles/abc?utm_source=x',
        'https://news.yahoo.co.jp/pickup/1',
        'http://example.com/story',
        'https://girlschannel.net/topics/1/',
        'https://img.example/picture.jpg',
    ]);
    assert.deepEqual(origins, [
        'https://news.yahoo.co.jp/*',
        'http://example.com/*',
        'https://web.archive.org/*',
        'https://archive.org/*',
    ]);
});

test('no article access is requested when the opening post links nowhere readable', () => {
    assert.deepEqual(articleAccessOrigins([]), []);
    assert.deepEqual(articleAccessOrigins(['https://girlschannel.net/topics/1/', 'https://img.example/a.png']), []);
    assert.deepEqual(articleAccessOrigins(undefined), []);
});

function successfulPage(overrides = {}) {
    return {
        status: 'success',
        finalUrl: 'https://news.example/story',
        canonicalUrl: 'https://news.example/story',
        title: 'Example story',
        byline: 'Reporter',
        publishedTime: '2026-08-08T00:00:00Z',
        text: 'A'.repeat(800),
        excerpt: 'Example excerpt',
        nextUrl: null,
        partial: false,
        ...overrides,
    };
}

test('successful rendered article never contacts the archive', async () => {
    let archiveCalls = 0;
    let closeCalls = 0;
    const pipeline = new ArticlePipeline({
        openSession: async () => ({
            load: async () => successfulPage(),
            close: async () => { closeCalls += 1; },
        }),
        findArchive: async () => {
            archiveCalls += 1;
            return 'https://web.archive.org/web/20260101/https://news.example/story';
        },
    });

    const result = await pipeline.retrieve(['https://news.example/story']);

    assert.equal(result.status, 'success');
    assert.equal(result.source.kind, 'live');
    assert.equal(archiveCalls, 0);
    assert.equal(closeCalls, 1);
});

test('archive is attempted only after a confirmed dead result', async () => {
    const loaded = [];
    const pipeline = new ArticlePipeline({
        openSession: async () => ({
            load: async (url) => {
                loaded.push(url);
                if (url.startsWith('https://web.archive.org/')) {
                    return successfulPage({ finalUrl: url, canonicalUrl: url });
                }
                return { status: 'dead', finalUrl: url, text: '' };
            },
            close: async () => {},
        }),
        findArchive: async () =>
            'https://web.archive.org/web/20260101/https://news.example/dead',
    });

    const result = await pipeline.retrieve(['https://news.example/dead']);

    assert.equal(result.status, 'success');
    assert.equal(result.source.kind, 'archive');
    assert.equal(result.source.href, 'https://news.example/dead');
    assert.equal(
        result.source.archiveHref,
        'https://web.archive.org/web/20260101/https://news.example/dead'
    );
    assert.deepEqual(loaded, [
        'https://news.example/dead',
        'https://web.archive.org/web/20260101/https://news.example/dead',
    ]);
});

test('all live candidates are tried before any confirmed-dead candidate uses the archive', async () => {
    let archiveCalls = 0;
    const pipeline = new ArticlePipeline({
        openSession: async () => ({
            load: async (url) => {
                if (url.includes('/dead')) {
                    return { status: 'dead', finalUrl: url, text: '' };
                }
                return successfulPage({ finalUrl: url, canonicalUrl: url });
            },
            close: async () => {},
        }),
        findArchive: async () => {
            archiveCalls += 1;
            return 'https://web.archive.org/web/20260101/https://news.example/dead';
        },
    });

    const result = await pipeline.retrieve([
        'https://news.example/dead',
        'https://second.example/live',
    ]);

    assert.equal(result.status, 'success');
    assert.equal(result.source.kind, 'live');
    assert.equal(result.source.href, 'https://second.example/live');
    assert.equal(archiveCalls, 0);
});

test('blocked or unauthorized live pages are not mislabeled as dead archives', async () => {
    for (const status of ['blocked', 'permissionDenied', 'timeout', 'notArticle']) {
        let archiveCalls = 0;
        const pipeline = new ArticlePipeline({
            openSession: async () => ({
                load: async () => ({ status, finalUrl: 'https://news.example/story', text: '' }),
                close: async () => {},
            }),
            findArchive: async () => {
                archiveCalls += 1;
                return null;
            },
        });

        const result = await pipeline.retrieve(['https://news.example/story']);
        assert.equal(result.status, status);
        assert.equal(archiveCalls, 0);
    }
});

test('pagination reuses one session and deduplicates repeated paragraphs', async () => {
    let openCalls = 0;
    let closeCalls = 0;
    const loaded = [];
    const repeated = 'Repeated publication boilerplate paragraph '.repeat(5).trim();
    const first = 'First-page reporting paragraph '.repeat(20).trim();
    const second = 'Second-page conclusion paragraph '.repeat(20).trim();
    const pipeline = new ArticlePipeline({
        openSession: async () => {
            openCalls += 1;
            return {
                load: async (url) => {
                    loaded.push(url);
                    if (url.endsWith('/2')) {
                        return successfulPage({
                            finalUrl: url,
                            canonicalUrl: 'https://news.example/story',
                            text: `${repeated}\n\n${second}`,
                        });
                    }
                    return successfulPage({
                        text: `${repeated}\n\n${first}`,
                        nextUrl: 'https://news.example/story/2',
                    });
                },
                close: async () => { closeCalls += 1; },
            };
        },
        findArchive: async () => null,
        targetCharacters: 20_000,
    });

    const result = await pipeline.retrieve(['https://news.example/story']);

    assert.equal(openCalls, 1);
    assert.equal(closeCalls, 1);
    assert.deepEqual(loaded, [
        'https://news.example/story',
        'https://news.example/story/2',
    ]);
    assert.equal(result.text.match(/Repeated publication boilerplate paragraph/g).length, 5);
    assert.match(result.text, /First-page reporting/);
    assert.match(result.text, /Second-page conclusion/);
});

test('pagination refuses a rel-next link that resolves to a different article', async () => {
    const pipeline = new ArticlePipeline({
        openSession: async () => ({
            load: async (url) => {
                if (url.endsWith('/different-story')) {
                    return successfulPage({
                        finalUrl: url,
                        canonicalUrl: url,
                        title: 'A completely different report',
                        text: 'Different-story text must never be appended. '.repeat(20),
                    });
                }
                return successfulPage({
                    finalUrl: url,
                    canonicalUrl: url,
                    title: 'Original investigation',
                    text: 'Original reporting. '.repeat(20),
                    nextUrl: 'https://news.example/different-story',
                });
            },
            close: async () => {},
        }),
        findArchive: async () => null,
        targetCharacters: 20_000,
    });

    const result = await pipeline.retrieve(['https://news.example/story']);

    assert.equal(result.status, 'success');
    assert.match(result.text, /Original reporting/);
    assert.doesNotMatch(result.text, /Different-story text/);
});

test('candidate collection keeps unique external HTTP links and removes tracking', () => {
    const result = collectArticleCandidates([
        'https://news.example/story?utm_source=girlschannel#comments',
        'https://news.example/story',
        'https://girlschannel.net/res/12345/',
        'javascript:alert(1)',
        'https://cdn.example/photo.jpg',
        'http://second.example/report?fbclid=tracking',
        'https://third.example/japanese）。',
    ]);

    assert.deepEqual(result, [
        'https://news.example/story',
        'http://second.example/report',
        'https://third.example/japanese',
    ]);
});

test('excerpt preserves the conclusion instead of keeping only the leading characters', () => {
    const text = [
        'Lead paragraph '.repeat(50),
        'Middle paragraph '.repeat(50),
        'Conclusion that must survive. '.repeat(20),
    ].join('\n\n');

    const excerpt = buildArticleExcerpt(text, 1_200);

    assert.ok(excerpt.length <= 1_200);
    assert.match(excerpt, /^Lead paragraph/);
    assert.match(excerpt, /Conclusion that must survive/);
});

test('source reference keeps link targets separate from provenance labels', () => {
    assert.deepEqual(
        createSourceReference({
            originalUrl: 'https://news.example/story',
            resolvedUrl: 'https://web.archive.org/web/20260101/https://news.example/story',
            kind: 'archive',
        }),
        {
            href: 'https://news.example/story',
            label: 'https://news.example/story',
            kind: 'archive',
            archiveHref: 'https://web.archive.org/web/20260101/https://news.example/story',
        }
    );
});

test('cancellation closes the active session and suppresses late results', async () => {
    const controller = new AbortController();
    let closeCalls = 0;
    let markLoadStarted;
    const loadStarted = new Promise((resolve) => { markLoadStarted = resolve; });
    const pipeline = new ArticlePipeline({
        openSession: async () => ({
            load: async () => {
                markLoadStarted();
                return new Promise(() => {});
            },
            close: async () => { closeCalls += 1; },
        }),
        findArchive: async () => null,
    });

    const pending = pipeline.retrieve(
        ['https://news.example/story'],
        { signal: controller.signal }
    );
    await loadStarted;
    controller.abort();

    const result = await Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(
            () => reject(new Error('cancellation did not settle')),
            100
        )),
    ]);
    assert.equal(result.status, 'cancelled');
    assert.equal(closeCalls, 1);
});

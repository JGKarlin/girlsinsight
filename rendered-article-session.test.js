const test = require('node:test');
const assert = require('node:assert/strict');

const {
    RenderedArticleSession,
    probeHttpStatus,
} = require('./rendered-article-session.js');

function chromeEvent() {
    const listeners = new Set();
    return {
        addListener(listener) { listeners.add(listener); },
        removeListener(listener) { listeners.delete(listener); },
        emit(...args) { listeners.forEach(listener => listener(...args)); },
        get size() { return listeners.size; },
    };
}

function makeChrome({
    completeNavigation = true,
    denyScripting = false,
    statusCode = 200,
    extractionStatus = 'success',
} = {}) {
    const onUpdated = chromeEvent();
    const onRemoved = chromeEvent();
    const onHeadersReceived = chromeEvent();
    const calls = {
        create: 0,
        update: [],
        remove: 0,
        readability: 0,
        stability: 0,
        extraction: 0,
    };

    const chromeApi = {
        tabs: {
            onUpdated,
            onRemoved,
            async create() {
                calls.create += 1;
                return { id: 41, status: 'complete', url: 'about:blank' };
            },
            async update(tabId, { url }) {
                calls.update.push(url);
                if (completeNavigation) {
                    queueMicrotask(() => {
                        onHeadersReceived.emit({ tabId, type: 'main_frame', statusCode, url });
                        onUpdated.emit(tabId, { status: 'complete' }, {
                            id: tabId,
                            status: 'complete',
                            url,
                        });
                    });
                }
                return { id: tabId, status: 'loading', url };
            },
            async remove() { calls.remove += 1; },
        },
        scripting: {
            async executeScript(options) {
                if (denyScripting) throw new Error('Cannot access contents of url');
                if (options.files) {
                    calls.readability += 1;
                    return [];
                }
                if (options.func.name === 'extractRenderedArticlePage') {
                    calls.extraction += 1;
                    return [{ result: {
                        status: extractionStatus,
                        finalUrl: calls.update.at(-1),
                        text: extractionStatus === 'success'
                            ? 'Rendered article text '.repeat(20)
                            : '',
                        nextUrl: null,
                    } }];
                }
                calls.stability += 1;
                return [{ result: { readyState: 'complete', textLength: 1_000 } }];
            },
        },
        webRequest: {
            onHeadersReceived,
        },
    };

    return {
        chromeApi,
        calls,
        onUpdated,
        onRemoved,
        onHeadersReceived,
        statusProbe: async () => statusCode,
    };
}

test('one rendered session reuses its tab and removes navigation listeners', async () => {
    const fake = makeChrome();
    const session = await RenderedArticleSession.open({
        chromeApi: fake.chromeApi,
        statusProbe: fake.statusProbe,
        stabilityTimeoutMs: 2_000,
    });

    const first = await session.load('https://news.example/story');
    const second = await session.load('https://news.example/story/2');
    await session.close();
    await session.close();

    assert.equal(first.status, 'success');
    assert.equal(second.status, 'success');
    assert.equal(fake.calls.create, 1);
    assert.deepEqual(fake.calls.update, [
        'https://news.example/story',
        'https://news.example/story/2',
    ]);
    assert.equal(fake.calls.readability, 2);
    assert.equal(fake.calls.extraction, 2);
    assert.equal(fake.calls.remove, 1);
    assert.equal(fake.onUpdated.size, 0);
    assert.equal(fake.onRemoved.size, 0);
    assert.equal(fake.onHeadersReceived.size, 0);
});

test('aborting navigation settles immediately and cleans every listener', async () => {
    const fake = makeChrome({ completeNavigation: false });
    const controller = new AbortController();
    const session = await RenderedArticleSession.open({
        chromeApi: fake.chromeApi,
        statusProbe: fake.statusProbe,
        loadTimeoutMs: 30_000,
    });

    const pending = session.load('https://news.example/slow', { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();

    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(fake.onUpdated.size, 0);
    assert.equal(fake.onRemoved.size, 0);
    assert.equal(fake.onHeadersReceived.size, 0);
    await session.close();
    assert.equal(fake.calls.remove, 1);
});

test('missing optional host access is a typed non-archive failure', async () => {
    const fake = makeChrome({ denyScripting: true });
    const session = await RenderedArticleSession.open({
        chromeApi: fake.chromeApi,
        statusProbe: fake.statusProbe,
    });

    const result = await session.load('https://news.example/story');
    await session.close();

    assert.equal(result.status, 'permissionDenied');
    assert.equal(fake.calls.remove, 1);
});

test('an authoritative main-frame 404 is classified dead without DOM heuristics', async () => {
    const fake = makeChrome({ statusCode: 404, extractionStatus: 'notArticle' });
    const session = await RenderedArticleSession.open({
        chromeApi: fake.chromeApi,
        statusProbe: fake.statusProbe,
    });

    const result = await session.load('https://news.example/missing');
    await session.close();

    assert.equal(result.status, 'dead');
    assert.ok(fake.calls.stability > 0);
    assert.equal(fake.calls.readability, 1);
    assert.equal(fake.onHeadersReceived.size, 0);
});

test('a successfully rendered article wins over an anonymous HEAD 404', async () => {
    const fake = makeChrome({ statusCode: 404, extractionStatus: 'success' });
    const session = await RenderedArticleSession.open({
        chromeApi: fake.chromeApi,
        statusProbe: fake.statusProbe,
    });

    const result = await session.load('https://news.example/authenticated');
    await session.close();

    assert.equal(result.status, 'success');
    assert.match(result.text, /Rendered article text/);
});

test('a successful rendered article does not wait for a stalled status probe', async () => {
    const fake = makeChrome({ extractionStatus: 'success' });
    const session = await RenderedArticleSession.open({
        chromeApi: fake.chromeApi,
        statusProbe: async () => new Promise(() => {}),
    });

    const result = await Promise.race([
        session.load('https://news.example/fast-render'),
        new Promise((_, reject) => setTimeout(
            () => reject(new Error('successful render waited for status probe')),
            1_500
        )),
    ]);
    await session.close();

    assert.equal(result.status, 'success');
});

test('status probing is anonymous, status-only, and does not read a response body', async () => {
    let requestOptions;
    const status = await probeHttpStatus('https://news.example/missing', {
        fetchImpl: async (_url, options) => {
            requestOptions = options;
            return { status: 410 };
        },
    });

    assert.equal(status, 410);
    assert.equal(requestOptions.method, 'HEAD');
    assert.equal(requestOptions.credentials, 'omit');
});

test('cancelling while the tab is being created removes the late tab', async () => {
    const controller = new AbortController();
    let resolveCreate;
    let removedTabId = null;
    const chromeApi = {
        tabs: {
            create: async () => new Promise(resolve => { resolveCreate = resolve; }),
            remove: async tabId => { removedTabId = tabId; },
        },
    };

    const pending = RenderedArticleSession.open({ chromeApi, signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    resolveCreate({ id: 73 });

    await assert.rejects(pending, { name: 'AbortError' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(removedTabId, 73);
});

// ---------------------------------------------------------------- slow, busy news pages

test('a page that never reports "loaded" is still read once its text is there', async () => {
    // Ad-heavy pages in a hidden tab can take far longer than the time limit to
    // finish loading every ad and video, though the article text is already there.
    const fake = makeChrome({ completeNavigation: false });
    const session = await RenderedArticleSession.open({
        chromeApi: fake.chromeApi,
        statusProbe: fake.statusProbe,
        loadTimeoutMs: 20,
        stabilityTimeoutMs: 50,
    });

    const result = await session.load('https://www.oricon.co.jp/news/2491485/full/');
    await session.close();

    assert.equal(result.status, 'success');
    assert.equal(fake.calls.extraction, 1);
});

test('a page that never loads and has no article text still reports a timeout', async () => {
    const fake = makeChrome({ completeNavigation: false, extractionStatus: 'notArticle' });
    const session = await RenderedArticleSession.open({
        chromeApi: fake.chromeApi,
        statusProbe: fake.statusProbe,
        loadTimeoutMs: 20,
        stabilityTimeoutMs: 50,
    });

    const result = await session.load('https://news.example/slow');
    await session.close();

    assert.equal(result.status, 'timeout');
});

// Runs the real extractRenderedArticlePage against a minimal page: Readability
// returns `readabilityText`, and the page has one <article> holding `articleText`.
function extractFrom({ readabilityText, articleText }) {
    const vm = require('node:vm');
    const { extractRenderedArticlePage } = require('./rendered-article-session.js');
    const element = text => ({
        innerText: text,
        textContent: text,
        cloneNode() { return { ...element(text), querySelectorAll: () => [] }; },
        querySelectorAll: () => [],
    });
    const document = {
        title: 'Perfume・のっち、結婚を発表',
        body: { innerText: `${readabilityText}\n${articleText}` },
        cloneNode: () => ({}),
        querySelector: () => null,
        querySelectorAll: selector => (/^(?:article|main article)\b|^article,/.test(selector) ? [element(articleText)] : []),
    };
    class Readability {
        parse() { return { textContent: readabilityText, title: document.title }; }
    }
    const context = vm.createContext({
        document,
        Readability,
        location: { href: 'https://www.oricon.co.jp/news/2491485/full/', origin: 'https://www.oricon.co.jp' },
        URL,
    });
    return JSON.parse(JSON.stringify(vm.runInContext(`(${extractRenderedArticlePage.toString()})()`, context)));
}

const STORY = [
    'Perfume・のっち（38）が8日、所属事務所の公式サイトを通じ、結婚を発表した。',
    'お相手は俳優の渋谷謙人（38）。',
    '事務所の公式サイトでは、温かい支援への感謝とともに結婚を報告した。',
    '「日頃より応援してくださっている皆さまにおかれましては、温かく見守り応援していただけますと幸いです」と呼びかけた。',
    'のっちは1988年9月20日生まれ、広島県出身。',
    '渋谷は1988年4月23日生まれ、神奈川県出身。8歳で子役として活動を始めた。',
].join('\n');
const MENU_AND_ADS = [
    'トップ', '芸能', '音楽', 'ドラマ&映画', 'アニメ&ゲーム', '動画配信サービス', 'スポーツ', '社会・経済',
    'グルメ', 'ビューティ', 'ライフ', 'ランキング', '推し活', '新着トレンド', 'ホーム（オリコンニュース）', '芸能 TOP',
    '営業/ブランドセールス/インターネット/Webサービス・ASP 年収500万円～1,000万円 正社員 / 東京都',
    '事務サポート 未経験歓迎 完休2日/残業月3h/賞与初年度3回/書類選考なし/転勤なし 月給22万1,440円～30万円',
    '業務推進メンバー/インターネット/Webサービス・ASP 年収350万円～600万円 正社員 / 東京都',
    '続きはこちら', 'sponsored by 求人ボックス',
].join('\n');

test('when Readability returns a site menu and ads instead of the story, the article element is used', () => {
    const page = extractFrom({ readabilityText: MENU_AND_ADS, articleText: `${STORY}\n関連写真\nあなたにおすすめの記事` });

    assert.equal(page.status, 'success');
    assert.ok(page.text.includes('結婚を発表した'), page.text.slice(0, 200));
    assert.ok(!page.text.includes('ドラマ&映画'), 'the site menu was not used');
});

test('a Readability result that holds the story is kept, even when the page element has more around it', () => {
    const page = extractFrom({ readabilityText: STORY, articleText: `${STORY}\n${MENU_AND_ADS}` });

    assert.equal(page.extractionMethod, 'readability');
    assert.ok(!page.text.includes('求人ボックス'));
});

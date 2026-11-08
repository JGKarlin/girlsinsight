(function installRenderedArticleSession(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GirlsinSightRenderedArticle = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeRenderedArticleSession() {
    function abortError() {
        const error = new Error('Rendered article loading was cancelled');
        error.name = 'AbortError';
        return error;
    }

    function timeoutError(message) {
        const error = new Error(message);
        error.name = 'TimeoutError';
        return error;
    }

    function raceWithSignal(operation, signal) {
        const promise = Promise.resolve(operation);
        if (!signal) return promise;
        if (signal.aborted) return Promise.reject(abortError());

        return new Promise((resolve, reject) => {
            const handleAbort = () => {
                signal.removeEventListener('abort', handleAbort);
                reject(abortError());
            };
            signal.addEventListener('abort', handleAbort, { once: true });
            promise.then(
                (value) => {
                    signal.removeEventListener('abort', handleAbort);
                    resolve(value);
                },
                (error) => {
                    signal.removeEventListener('abort', handleAbort);
                    reject(error);
                }
            );
        });
    }

    // A status-only, anonymous probe distinguishes authoritative 404/410
    // responses from CORS, timeout, paywall, and rendering failures. It never
    // gates a successfully parsed live article.
    async function probeHttpStatus(url, { signal, fetchImpl = globalThis.fetch, timeoutMs = 2_500 } = {}) {
        if (signal && signal.aborted) throw abortError();
        if (typeof fetchImpl !== 'function') return null;

        const controller = new AbortController();
        let parentAborted = false;
        const handleAbort = () => {
            parentAborted = true;
            controller.abort();
        };
        if (signal) signal.addEventListener('abort', handleAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetchImpl(url, {
                method: 'HEAD',
                cache: 'no-store',
                credentials: 'omit',
                redirect: 'follow',
                signal: controller.signal,
            });
            return response.status;
        } catch (_) {
            if (parentAborted || (signal && signal.aborted)) throw abortError();
            return null;
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', handleAbort);
        }
    }

    // How often to check whether the article tab's new page is readable.
    const READABLE_CHECK_MS = 250;

    // Serialized by chrome.scripting: the article tab's current page and how
    // far it has loaded.
    function readDocumentState() {
        return { url: document.URL, readyState: document.readyState };
    }

    // This function is serialized by chrome.scripting and must remain self-contained.
    function extractRenderedArticlePage() {
        const fullText = (document.body && document.body.innerText || '').trim();
        const diagnosticText = `${document.title || ''}\n${fullText.slice(0, 2500)}`;
        const deadPatterns = [
            /(?:^|\n)\s*(?:404|410)(?:\s|:|-)*(?:not found|gone|error)?\s*(?:\n|$)/im,
            /page\s+(?:was\s+)?not\s+found/i,
            /this\s+(?:page|article)\s+(?:has been|was)\s+(?:deleted|removed)/i,
            /ページが見つかりません/,
            /お探しのページは(?:見つかりません|削除されました)/,
            /記事(?:は|が)?削除されました/,
        ];
        const suspectedDead = deadPatterns.some((pattern) => pattern.test(diagnosticText));

        const blockedPatterns = [
            /access denied/i,
            /verify (?:that )?you are human/i,
            /checking (?:if the site connection is secure|your browser)/i,
            /captcha/i,
            /コンテンツブロック機能/,
            /広告ブロック機能/,
            /ロボットではないことを確認/,
        ];
        const paywallPatterns = [
            /subscribe to (?:continue|read)/i,
            /sign in to (?:continue|read)/i,
            /会員限定/,
            /有料会員/,
            /続きを読むには(?:会員登録|ログイン)/,
        ];
        const isBlocked = blockedPatterns.some((pattern) => pattern.test(diagnosticText));
        const hasPaywall = paywallPatterns.some((pattern) => pattern.test(fullText.slice(0, 12_000)));

        function normalizedText(value) {
            return String(value || '')
                .replace(/\r/g, '')
                .split(/\n+/)
                .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
                .filter(Boolean)
                .join('\n\n')
                .trim();
        }

        // Sentence endings in a text. A site menu or a block of ads has almost
        // none; a news story has many.
        function sentenceCount(value) {
            return (String(value || '').match(/[。！？]|[.!?](?=\s|$)/g) || []).length;
        }

        function jsonLdArticleBody() {
            const bodies = [];
            function visit(value) {
                if (!value) return;
                if (Array.isArray(value)) {
                    value.forEach(visit);
                    return;
                }
                if (typeof value !== 'object') return;
                if (typeof value.articleBody === 'string') bodies.push(value.articleBody);
                Object.values(value).forEach(visit);
            }

            for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
                try {
                    visit(JSON.parse(script.textContent));
                } catch (_) {
                    // Invalid page metadata should not prevent DOM extraction.
                }
            }
            return bodies.sort((left, right) => right.length - left.length)[0] || '';
        }

        function longestVisibleArticleText() {
            const selectors = [
                'article',
                'main article',
                '[role="main"]',
                'main',
                '.article-body',
                '.article__body',
                '.article-content',
                '.entry-content',
                '.story-body',
                '.post-content',
            ];
            let longest = '';
            for (const element of document.querySelectorAll(selectors.join(','))) {
                const clone = element.cloneNode(true);
                clone.querySelectorAll(
                    'nav,aside,footer,form,button,script,style,noscript,[aria-hidden="true"],.advertisement,.related,.recommend'
                ).forEach((node) => node.remove());
                const text = normalizedText(clone.innerText || clone.textContent);
                if (text.length > longest.length) longest = text;
            }
            return longest;
        }

        function nextPageUrl() {
            const explicit = document.querySelector('link[rel~="next"], a[rel~="next"]');
            const links = explicit ? [explicit] : Array.from(document.querySelectorAll(
                'nav a[href], .pagination a[href], .pager a[href], .article-pager a[href], main a[href], article a[href]'
            ));
            for (const link of links) {
                const label = `${link.textContent || ''} ${link.getAttribute('aria-label') || ''}`.trim();
                const href = link.href;
                if (!href) continue;
                if (!explicit && !/(?:次のページ|次ページ|続きを読む|続き|next\s*page|^[>→›»]+$)/i.test(label)) {
                    continue;
                }
                if (/(?:次の記事|関連記事|おすすめ|ランキング|related|recommend|ranking|popular)/i.test(label + href)) {
                    continue;
                }
                try {
                    const next = new URL(href, location.href);
                    if (next.origin !== location.origin || next.href === location.href) continue;
                    next.hash = '';
                    return next.href;
                } catch (_) {
                    // Ignore malformed publisher links.
                }
            }
            return null;
        }

        let parsed = null;
        try {
            if (typeof Readability === 'function') {
                parsed = new Readability(document.cloneNode(true), {
                    charThreshold: 160,
                    maxElemsToParse: 50_000,
                }).parse();
            }
        } catch (_) {
            parsed = null;
        }

        const jsonLdText = normalizedText(jsonLdArticleBody());
        const fallbackText = longestVisibleArticleText();
        const readabilityText = normalizedText(parsed && parsed.textContent);
        // Readability's scoring intentionally removes navigation, comments, and
        // recommendations. Only use broader DOM fallbacks if it could not parse,
        // or if what it picked has far fewer sentences than the page's article
        // element: on some busy pages it picks the site menu and ads instead.
        const readabilityMissedStory = Boolean(readabilityText) &&
            sentenceCount(fallbackText) >= 3 &&
            sentenceCount(readabilityText) * 3 < sentenceCount(fallbackText);
        const storyText = readabilityMissedStory ? '' : readabilityText;
        let text = storyText || jsonLdText || fallbackText;
        const extractionMethod = storyText
            ? 'readability'
            : (jsonLdText ? 'jsonLd' : 'fallback');

        if (isBlocked && !readabilityText && !jsonLdText) {
            return {
                status: 'blocked',
                finalUrl: location.href,
                text: '',
            };
        }

        if (text.length < 180) {
            return {
                status: 'notArticle',
                finalUrl: location.href,
                text: '',
                suspectedDead,
            };
        }

        const transferBudget = 40_000;
        if (text.length > transferBudget) {
            const separator = '\n\n[…]\n\n';
            const head = Math.floor((transferBudget - separator.length) * 0.7);
            const tail = transferBudget - separator.length - head;
            text = `${text.slice(0, head)}${separator}${text.slice(-tail)}`;
        }

        const canonical = document.querySelector('link[rel="canonical"]');
        const published = document.querySelector(
            'meta[property="article:published_time"], meta[name="date"], time[datetime]'
        );
        const byline = document.querySelector(
            'meta[name="author"], meta[property="article:author"], [rel="author"]'
        );

        return {
            status: 'success',
            finalUrl: location.href,
            canonicalUrl: canonical && canonical.href || location.href,
            title: parsed && parsed.title || document.title || '',
            byline: parsed && parsed.byline || byline && (byline.content || byline.textContent) || '',
            publishedTime: parsed && parsed.publishedTime || published && (published.content || published.dateTime) || '',
            excerpt: parsed && parsed.excerpt || document.querySelector('meta[name="description"]')?.content || '',
            text,
            extractionMethod,
            nextUrl: nextPageUrl(),
            partial: hasPaywall,
            suspectedDead,
        };
    }

    class RenderedArticleSession {
        static async open({
            chromeApi,
            signal,
            statusProbe = probeHttpStatus,
            loadTimeoutMs = 15_000,
            stabilityTimeoutMs = 8_000,
        } = {}) {
            const api = chromeApi || chrome;
            if (signal && signal.aborted) throw abortError();
            const creatingTab = api.tabs.create({ url: 'about:blank', active: false });
            let tab;
            try {
                tab = await raceWithSignal(creatingTab, signal);
            } catch (error) {
                if (error && error.name === 'AbortError') {
                    creatingTab.then(lateTab => api.tabs.remove(lateTab.id)).catch(() => {});
                }
                throw error;
            }
            return new RenderedArticleSession({
                chromeApi: api,
                tabId: tab.id,
                statusProbe,
                loadTimeoutMs,
                stabilityTimeoutMs,
            });
        }

        constructor({ chromeApi, tabId, statusProbe, loadTimeoutMs, stabilityTimeoutMs }) {
            this.chrome = chromeApi;
            this.tabId = tabId;
            this.statusProbe = statusProbe;
            this.loadTimeoutMs = loadTimeoutMs;
            this.stabilityTimeoutMs = stabilityTimeoutMs;
            this.closed = false;
        }

        async load(url, { signal } = {}) {
            if (this.closed) return { status: 'error', finalUrl: url, text: '' };
            const probeController = new AbortController();
            const forwardAbort = () => probeController.abort();
            if (signal) signal.addEventListener('abort', forwardAbort, { once: true });
            const statusPromise = Promise.resolve()
                .then(() => this.statusProbe(url, { signal: probeController.signal }))
                .catch(() => null);
            try {
                // Busy pages in a hidden tab can take far longer than the time
                // limit to finish loading every ad, though the article is already
                // on the page. Read what is there; report a timeout only if that
                // finds no article.
                let navigationTimedOut = false;
                try {
                    await this.navigate(url, signal);
                } catch (error) {
                    if (!error || error.name !== 'TimeoutError') throw error;
                    navigationTimedOut = true;
                }
                await this.waitForDomStability(signal);
                await raceWithSignal(this.chrome.scripting.executeScript({
                    target: { tabId: this.tabId },
                    files: ['lib/Readability.js'],
                }), signal);
                const results = await raceWithSignal(this.chrome.scripting.executeScript({
                    target: { tabId: this.tabId },
                    func: extractRenderedArticlePage,
                }), signal);
                const page = results && results[0] && results[0].result || {
                    status: 'notArticle',
                    finalUrl: url,
                    text: '',
                };
                if (page.status === 'success') return page;
                if (navigationTimedOut) return { status: 'timeout', finalUrl: url, text: '' };

                const statusCode = await raceWithSignal(statusPromise, signal);
                if (page.status !== 'success' &&
                    (statusCode === 404 || statusCode === 410) &&
                    (page.status === 'notArticle' || page.suspectedDead)) {
                    return { status: 'dead', finalUrl: page.finalUrl || url, text: '' };
                }
                return page;
            } catch (error) {
                if (error && error.name === 'AbortError') throw error;
                const message = String(error && error.message || error || '');
                if (error && error.name === 'TimeoutError') {
                    return { status: 'timeout', finalUrl: url, text: '' };
                }
                if (/cannot access|permission|extensions gallery|chrome:\/\//i.test(message)) {
                    return { status: 'permissionDenied', finalUrl: url, text: '' };
                }
                return { status: 'error', finalUrl: url, text: '', error: message };
            } finally {
                probeController.abort();
                if (signal) signal.removeEventListener('abort', forwardAbort);
            }
        }

        // Resolves when the new page is readable: its HTML is parsed (it may
        // still be loading ads and images) or Chrome reports it loaded,
        // whichever comes first. The story is usually on the page long before
        // every ad has loaded. The tab's previous page (the blank start page or
        // the last article page) never counts.
        navigate(url, signal) {
            if (signal && signal.aborted) return Promise.reject(abortError());
            const previousUrl = this.documentUrl || 'about:blank';
            return new Promise((resolve, reject) => {
                let settled = false;
                const finish = (error, tab) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    this.chrome.tabs.onUpdated.removeListener(handleUpdated);
                    this.chrome.tabs.onRemoved.removeListener(handleRemoved);
                    if (signal) signal.removeEventListener('abort', handleAbort);
                    if (error) {
                        reject(error);
                    } else {
                        this.documentUrl = (tab && tab.url) || url;
                        resolve(tab);
                    }
                };
                const checkReadable = async () => {
                    while (!settled) {
                        await new Promise(next => setTimeout(next, READABLE_CHECK_MS));
                        if (settled) return;
                        try {
                            const results = await this.chrome.scripting.executeScript({
                                target: { tabId: this.tabId },
                                func: readDocumentState,
                            });
                            const state = results && results[0] && results[0].result;
                            if (state && state.readyState !== 'loading' && state.url &&
                                state.url !== 'about:blank' && state.url !== previousUrl) {
                                finish(null, { id: this.tabId, url: state.url });
                            }
                        } catch (_) {
                            // Between pages, or a page this extension may not read;
                            // Chrome's own "loaded" signal or the time limit applies.
                        }
                    }
                };
                const handleUpdated = (tabId, changeInfo, tab) => {
                    if (tabId === this.tabId && changeInfo.status === 'complete') finish(null, tab);
                };
                const handleRemoved = (tabId) => {
                    if (tabId === this.tabId) finish(new Error('Article tab was closed'));
                };
                const handleAbort = () => finish(abortError());
                const timer = setTimeout(
                    () => finish(timeoutError('Article tab load timed out')),
                    this.loadTimeoutMs
                );

                this.chrome.tabs.onUpdated.addListener(handleUpdated);
                this.chrome.tabs.onRemoved.addListener(handleRemoved);
                if (signal) signal.addEventListener('abort', handleAbort, { once: true });

                this.chrome.tabs.update(this.tabId, { url, muted: true }).then((tab) => {
                    if (tab.status === 'complete') finish(null, tab);
                }).catch((error) => finish(error));
                checkReadable();
            });
        }

        async waitForDomStability(signal) {
            const startedAt = Date.now();
            const minimumQuietWindowMs = 750;
            let previousLength = -1;
            let stableSamples = 0;

            while (Date.now() - startedAt < this.stabilityTimeoutMs) {
                const results = await raceWithSignal(this.chrome.scripting.executeScript({
                    target: { tabId: this.tabId },
                    func: () => ({
                        readyState: document.readyState,
                        textLength: (document.body && document.body.innerText || '').length,
                    }),
                }), signal);
                const sample = results && results[0] && results[0].result;
                // "interactive" counts too: a slow page that never finished
                // loading every ad is read once its text stops changing.
                if (sample && sample.readyState !== 'loading' && sample.textLength === previousLength) {
                    stableSamples += 1;
                    if (stableSamples >= 2 && Date.now() - startedAt >= minimumQuietWindowMs) return;
                } else {
                    stableSamples = 0;
                }
                previousLength = sample ? sample.textLength : -1;
                await this.delay(250, signal);
            }
        }

        delay(milliseconds, signal) {
            if (signal && signal.aborted) return Promise.reject(abortError());
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    if (signal) signal.removeEventListener('abort', handleAbort);
                    resolve();
                }, milliseconds);
                const handleAbort = () => {
                    clearTimeout(timer);
                    signal.removeEventListener('abort', handleAbort);
                    reject(abortError());
                };
                if (signal) signal.addEventListener('abort', handleAbort, { once: true });
            });
        }

        async close() {
            if (this.closed) return;
            this.closed = true;
            try {
                await this.chrome.tabs.remove(this.tabId);
            } catch (_) {
                // The user may have already closed the temporary tab.
            }
        }
    }

    return {
        RenderedArticleSession,
        extractRenderedArticlePage,
        probeHttpStatus,
    };
}));

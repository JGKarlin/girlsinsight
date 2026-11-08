(function installArticlePipeline(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GirlsinSightArticlePipeline = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeArticlePipeline() {
    const TRACKING_PARAMETERS = new Set([
        'fbclid',
        'gclid',
        'igshid',
        'mc_cid',
        'mc_eid',
        'ref',
        'referrer',
    ]);
    const NON_ARTICLE_EXTENSIONS = /\.(?:avif|bmp|css|gif|ico|jpe?g|js|json|m4a|mov|mp3|mp4|pdf|png|svg|webm|webp|xml|zip)$/i;

    function abortError() {
        const error = new Error('Article retrieval was cancelled');
        error.name = 'AbortError';
        return error;
    }

    function isAbortError(error) {
        return error && error.name === 'AbortError';
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

    function stringsFrom(value) {
        if (Array.isArray(value)) return value.flatMap(stringsFrom);
        if (value && typeof value === 'object') {
            return stringsFrom(value.href || value.url || '');
        }
        if (typeof value !== 'string') return [];

        const matches = value.match(/https?:\/\/[^\s<>"']+/gi);
        return matches || [];
    }

    function cleanCandidate(rawValue) {
        const withoutTrailingPunctuation = rawValue.replace(/[),.;!?\]}〉》」』】、。！？）]+$/g, '');
        let candidate;
        try {
            candidate = new URL(withoutTrailingPunctuation);
        } catch (_) {
            return null;
        }

        if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') return null;

        const hostname = candidate.hostname.toLowerCase();
        if (hostname === 'girlschannel.net' || hostname.endsWith('.girlschannel.net')) return null;
        if (NON_ARTICLE_EXTENSIONS.test(candidate.pathname)) return null;

        candidate.hash = '';
        for (const key of Array.from(candidate.searchParams.keys())) {
            if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMETERS.has(key.toLowerCase())) {
                candidate.searchParams.delete(key);
            }
        }

        return candidate.toString();
    }

    function collectArticleCandidates(rawCandidates) {
        const candidates = [];
        const seen = new Set();

        for (const value of stringsFrom(rawCandidates)) {
            const candidate = cleanCandidate(value);
            if (!candidate || seen.has(candidate)) continue;
            seen.add(candidate);
            candidates.push(candidate);
        }

        return candidates;
    }

    function createSourceReference({ originalUrl, resolvedUrl, kind = 'live' }) {
        const reference = {
            href: originalUrl,
            label: originalUrl,
            kind,
        };
        if (kind === 'archive') reference.archiveHref = resolvedUrl;
        return reference;
    }

    function buildArticleExcerpt(text, maxCharacters = 15_000) {
        const normalized = String(text || '').trim();
        const budget = Math.max(0, Number(maxCharacters) || 0);
        if (!budget || !normalized) return '';
        if (normalized.length <= budget) return normalized;

        const divider = '\n\n[…]\n\n';
        if (budget <= divider.length + 2) return normalized.slice(0, budget);

        const available = budget - divider.length;
        const leadingBudget = Math.ceil(available * 0.68);
        const trailingBudget = available - leadingBudget;
        let leading = normalized.slice(0, leadingBudget);
        let trailing = normalized.slice(normalized.length - trailingBudget);

        const leadingBoundary = Math.max(leading.lastIndexOf('\n\n'), leading.lastIndexOf('. '));
        if (leadingBoundary > leadingBudget * 0.7) leading = leading.slice(0, leadingBoundary + 1);

        const trailingParagraph = trailing.indexOf('\n\n');
        const trailingSentence = trailing.indexOf('. ');
        const trailingBoundary = [trailingParagraph, trailingSentence]
            .filter((index) => index >= 0)
            .sort((left, right) => left - right)[0];
        if (trailingBoundary !== undefined && trailingBoundary < trailingBudget * 0.3) {
            trailing = trailing.slice(trailingBoundary + (trailingBoundary === trailingParagraph ? 2 : 2));
        }

        const excerpt = `${leading.trimEnd()}${divider}${trailing.trimStart()}`;
        return excerpt.length <= budget ? excerpt : excerpt.slice(0, budget);
    }

    function paragraphKey(paragraph) {
        return paragraph.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    }

    function appendUniqueParagraphs(parts, seen, text) {
        const paragraphs = String(text || '')
            .split(/\n\s*\n+/)
            .map((paragraph) => paragraph.replace(/[ \t]+/g, ' ').trim())
            .filter(Boolean);

        for (const paragraph of paragraphs) {
            const key = paragraphKey(paragraph);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            parts.push(paragraph);
        }
    }

    function safeNextUrl(currentUrl, nextUrl) {
        if (!nextUrl) return null;
        try {
            const current = new URL(currentUrl);
            const next = new URL(nextUrl, current);
            if (!['http:', 'https:'].includes(next.protocol)) return null;
            if (next.origin !== current.origin) return null;
            next.hash = '';
            return next.toString();
        } catch (_) {
            return null;
        }
    }

    function normalizedArticleTitle(title) {
        return String(title || '')
            .toLowerCase()
            .replace(/[（(]\s*(?:page|p\.?|ページ)?\s*\d+(?:\s*[/／]\s*\d+)?\s*[)）]\s*$/i, '')
            .replace(/(?:\s|[-–—|])+?(?:page|p\.?|ページ)\s*\d+(?:\s*[/／]\s*\d+)?\s*$/i, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function canonicalIdentity(value) {
        if (!value) return null;
        try {
            const url = new URL(value);
            url.hash = '';
            for (const key of Array.from(url.searchParams.keys())) {
                if (/^(?:page|p|pg|pageno|page_num)$/i.test(key)) url.searchParams.delete(key);
            }
            return url.toString();
        } catch (_) {
            return null;
        }
    }

    function isSameArticlePage(firstPage, page, firstUrl, pageUrl) {
        const firstCanonical = canonicalIdentity(firstPage.canonicalUrl);
        const pageCanonical = canonicalIdentity(page.canonicalUrl);
        if (firstCanonical && pageCanonical && firstCanonical === pageCanonical) return true;

        const firstTitle = normalizedArticleTitle(firstPage.title);
        const pageTitle = normalizedArticleTitle(page.title);
        if (firstTitle.length < 8 || pageTitle.length < 8) return false;
        const shorter = firstTitle.length <= pageTitle.length ? firstTitle : pageTitle;
        const longer = firstTitle.length > pageTitle.length ? firstTitle : pageTitle;
        const titlesMatch = firstTitle === pageTitle ||
            (longer.includes(shorter) && shorter.length / longer.length >= 0.8);
        if (!titlesMatch) return false;

        try {
            return new URL(firstUrl).origin === new URL(page.finalUrl || pageUrl).origin;
        } catch (_) {
            return false;
        }
    }

    function pageFailureFromError(error) {
        if (isAbortError(error)) throw error;
        const message = String(error && error.message || error || '').toLowerCase();
        if (error && error.name === 'TimeoutError') return { status: 'timeout', text: '' };
        if (message.includes('permission') || message.includes('cannot access')) {
            return { status: 'permissionDenied', text: '' };
        }
        return { status: 'error', text: '', error: String(error && error.message || error) };
    }

    class ArticlePipeline {
        constructor({
            openSession,
            findArchive,
            maxPages = 10,
            targetCharacters = 15_000,
        }) {
            if (typeof openSession !== 'function') throw new TypeError('openSession is required');
            if (typeof findArchive !== 'function') throw new TypeError('findArchive is required');
            this.openSession = openSession;
            this.findArchive = findArchive;
            this.maxPages = Math.max(1, maxPages);
            this.targetCharacters = Math.max(1, targetCharacters);
        }

        async retrieve(rawCandidates, { signal } = {}) {
            const candidates = collectArticleCandidates(rawCandidates);
            if (!candidates.length) return { status: 'notArticle', text: '' };
            if (signal && signal.aborted) return { status: 'cancelled', text: '' };

            let session = null;
            let openingSession = null;
            try {
                openingSession = Promise.resolve().then(() => this.openSession({ signal }));
                session = await raceWithSignal(openingSession, signal);

                const failures = [];
                const deadCandidates = [];

                for (const candidate of candidates) {
                    const result = await this.loadArticle(session, candidate, { signal });
                    if (result.status === 'success') {
                        return this.successResult(result, candidate, candidate, 'live');
                    }
                    failures.push(result);
                    if (result.status === 'dead') deadCandidates.push(candidate);
                }

                for (const candidate of deadCandidates) {
                    let archiveUrl = null;
                    try {
                        archiveUrl = await raceWithSignal(
                            this.findArchive(candidate, { signal }),
                            signal
                        );
                    } catch (error) {
                        if (isAbortError(error)) throw error;
                    }
                    if (!archiveUrl) continue;

                    const archived = await this.loadArticle(session, archiveUrl, { signal });
                    if (archived.status === 'success') {
                        return this.successResult(archived, candidate, archiveUrl, 'archive');
                    }
                }

                return failures[0] || { status: 'notArticle', text: '' };
            } catch (error) {
                if (isAbortError(error) || (signal && signal.aborted)) {
                    if (!session && openingSession) {
                        openingSession.then((lateSession) => lateSession.close()).catch(() => {});
                    }
                    return { status: 'cancelled', text: '' };
                }
                return pageFailureFromError(error);
            } finally {
                if (session) {
                    try {
                        await session.close();
                    } catch (_) {
                        // Closing a temporary tab is best effort and must not hide a valid result.
                    }
                }
            }
        }

        async loadArticle(session, initialUrl, { signal } = {}) {
            const parts = [];
            const seenParagraphs = new Set();
            const visitedUrls = new Set();
            let url = initialUrl;
            let firstPage = null;
            let lastPage = null;

            for (let pageNumber = 0; pageNumber < this.maxPages && url; pageNumber += 1) {
                if (visitedUrls.has(url)) break;
                visitedUrls.add(url);

                let page;
                try {
                    page = await raceWithSignal(session.load(url, { signal }), signal);
                } catch (error) {
                    page = pageFailureFromError(error);
                }

                if (!page || page.status !== 'success') {
                    if (parts.length) break;
                    return page || { status: 'error', text: '' };
                }

                if (firstPage && !isSameArticlePage(firstPage, page, initialUrl, url)) break;
                if (!firstPage) firstPage = page;
                lastPage = page;
                appendUniqueParagraphs(parts, seenParagraphs, page.text);

                const accumulatedLength = parts.reduce(
                    (total, paragraph) => total + paragraph.length + 2,
                    0
                );
                if (accumulatedLength >= this.targetCharacters) break;

                const next = safeNextUrl(page.finalUrl || url, page.nextUrl);
                if (!next || visitedUrls.has(next)) break;
                url = next;
            }

            const text = parts.join('\n\n').trim();
            if (!firstPage || !text) return { status: 'notArticle', text: '' };

            return {
                ...firstPage,
                status: 'success',
                finalUrl: (lastPage && lastPage.finalUrl) || firstPage.finalUrl || initialUrl,
                text,
            };
        }

        successResult(page, originalUrl, resolvedUrl, kind) {
            return {
                ...page,
                status: 'success',
                text: buildArticleExcerpt(page.text, this.targetCharacters),
                source: createSourceReference({ originalUrl, resolvedUrl, kind }),
            };
        }
    }

    return {
        ArticlePipeline,
        buildArticleExcerpt,
        collectArticleCandidates,
        createSourceReference,
        isSameArticlePage,
    };
}));

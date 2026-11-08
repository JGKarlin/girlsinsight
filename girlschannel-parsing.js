// Pure helpers for reading GirlsChannel pages. Loaded by the content script,
// by the service worker (importScripts) and by Node tests.
(function installGirlsChannelParsing(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GirlsinSightParsing = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeGirlsChannelParsing() {
    const JST_OFFSET_HOURS = 9;

    // GirlsChannel shows times in Japan Standard Time (UTC+9, no daylight
    // saving). Build the instant from UTC so the browser's own time zone
    // cannot shift it.
    function jst(year, month, day, hour, minute, second = 0) {
        return new Date(Date.UTC(
            Number(year), Number(month) - 1, Number(day),
            Number(hour) - JST_OFFSET_HOURS, Number(minute), Number(second)
        ));
    }

    function parseGirlsChannelDate(text) {
        const value = String(text || '').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
        if (!value) return null;
        const patterns = [
            /(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/, // 2026/11/08 01:11:22
            /(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/, // 2026.11.08 01:11
            /(\d{4})年(\d{2})月(\d{2})日 (\d{2}):(\d{2})(?::(\d{2}))?/, // 2026年11月08日 01:11
        ];
        for (const pattern of patterns) {
            const parts = value.match(pattern);
            if (parts) return jst(parts[1], parts[2], parts[3], parts[4], parts[5], parts[6] || 0);
        }
        return null;
    }

    // Topic pages are /topics/<id>/ (page 1) and /topics/<id>/<n>/ (page n).
    function topicPageInfo(url) {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (_) {
            return null;
        }
        if (parsed.hostname !== 'girlschannel.net') return null;
        const match = parsed.pathname.match(/^\/topics\/(\d+)\/(?:(\d+)\/?)?$/);
        if (!match) return null;
        return {
            topicId: match[1],
            page: match[2] ? Number(match[2]) : 1,
            firstPageUrl: `${parsed.origin}/topics/${match[1]}/`,
        };
    }

    // Main comments are numbers (35); replies are "parent.n" strings ("35.10").
    function commentNumberParts(number) {
        const [main, reply] = String(number).split('.');
        return [Number(main) || 0, reply === undefined ? 0 : Number(reply) || 0];
    }

    function compareCommentNumbers(a, b) {
        const [mainA, replyA] = commentNumberParts(a);
        const [mainB, replyB] = commentNumberParts(b);
        return mainA - mainB || replyA - replyB;
    }

    return {
        compareCommentNumbers,
        parseGirlsChannelDate,
        topicPageInfo,
    };
}));

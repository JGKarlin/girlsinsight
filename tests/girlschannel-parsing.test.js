const test = require('node:test');
const assert = require('node:assert/strict');

const {
    GIRLSCHANNEL_HOME_URL,
    compareCommentNumbers,
    parseGirlsChannelDate,
    topicPageInfo,
} = require('../girlschannel-parsing.js');

test('the "Go to GirlsChannel" link opens the site the extension recognizes', () => {
    // www.girlschannel.net no longer answers, and the extension only treats
    // girlschannel.net as GirlsChannel, so the link must use that host.
    assert.equal(typeof GIRLSCHANNEL_HOME_URL, 'string');
    assert.ok(topicPageInfo(new URL('topics/1/', GIRLSCHANNEL_HOME_URL).href),
        'topic pages under the home link are recognized as GirlsChannel');
});

test('GirlsChannel times are read as Japan time whatever the browser time zone', () => {
    // 2026/11/08 01:11 in Japan (UTC+9) is 2026-11-07 16:11 UTC.
    assert.equal(parseGirlsChannelDate('2026/11/08(日) 01:11:22').toISOString(), '2026-11-07T16:11:22.000Z');
    assert.equal(parseGirlsChannelDate('2026/11/08 01:11').toISOString(), '2026-11-07T16:11:00.000Z');
    assert.equal(parseGirlsChannelDate('2026.11.08 01:11').toISOString(), '2026-11-07T16:11:00.000Z');
    assert.equal(parseGirlsChannelDate('2026年11月08日 01:11').toISOString(), '2026-11-07T16:11:00.000Z');
});

test('an unreadable date gives null instead of a guess', () => {
    assert.equal(parseGirlsChannelDate(''), null);
    assert.equal(parseGirlsChannelDate('昨日'), null);
    assert.equal(parseGirlsChannelDate(null), null);
});

test('topic pages after the first resolve to the topic\'s first page', () => {
    assert.deepEqual(topicPageInfo('https://girlschannel.net/topics/6330813/'), {
        topicId: '6330813', page: 1, firstPageUrl: 'https://girlschannel.net/topics/6330813/',
    });
    assert.deepEqual(topicPageInfo('https://girlschannel.net/topics/6330813/7/'), {
        topicId: '6330813', page: 7, firstPageUrl: 'https://girlschannel.net/topics/6330813/',
    });
    assert.deepEqual(topicPageInfo('https://girlschannel.net/topics/6330813/2/#comment-501'), {
        topicId: '6330813', page: 2, firstPageUrl: 'https://girlschannel.net/topics/6330813/',
    });
});

test('pages that are not topics are not treated as topics', () => {
    assert.equal(topicPageInfo('https://girlschannel.net/'), null);
    assert.equal(topicPageInfo('https://girlschannel.net/topics/search/?q=abc'), null);
    assert.equal(topicPageInfo('https://example.com/topics/123/'), null);
});

test('comments sort by number with replies in reply order under their parent', () => {
    const numbers = [36, '35.10', '35.2', 35, '35.1', '35.100', 2, '2.1'];
    assert.deepEqual([...numbers].sort(compareCommentNumbers), [2, '2.1', 35, '35.1', '35.2', '35.10', '35.100', 36]);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Renders components with the bundled production React to element trees.
// The components tested here use no hooks, so they can be called directly
// without a DOM.
function loadComponents() {
    const context = vm.createContext({ console });
    context.self = context; // React's UMD wrapper attaches to `self` outside CommonJS
    for (const file of ['lib/react.production.min.js', 'popup-react.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
    }
    return {
        CommentItem: vm.runInContext('CommentItem', context),
        SentimentSection: vm.runInContext('SentimentSection', context),
        SummarySection: vm.runInContext('SummarySection', context),
    };
}

function findAll(node, predicate, found = []) {
    if (Array.isArray(node)) {
        node.forEach(child => findAll(child, predicate, found));
    } else if (node && typeof node === 'object' && node.props) {
        if (predicate(node)) found.push(node);
        findAll(node.props.children, predicate, found);
    }
    return found;
}

function textOf(node) {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    return node && node.props ? textOf(node.props.children) : '';
}

const { CommentItem, SentimentSection, SummarySection } = loadComponents();
const render = (text, extra = {}) => CommentItem({
    comment: { text, plus: 3, minus: 1, date: '2026-11-01T00:00:00.000Z', number: 2, ...extra },
});
const i18n = key => `«${key}»`;
const byClass = (tree, name) => findAll(tree, node => String(node.props.className || '').split(' ').includes(name));

test('an image-only comment is shown as its image', () => {
    // content.js stores an image-only comment as the image's data-src URL.
    const url = 'https://up.gc-img.net/post_img/2026/11/yThk2UZakM5MMq5_sMQVy_408.jpeg';
    const images = findAll(render(url), node => node.type === 'img');

    assert.equal(images.length, 1);
    assert.equal(images[0].props.src, url);
});

test('a comment that only mentions a link stays text', () => {
    const tree = render('ニュースはこちら https://news.example/article');

    assert.equal(findAll(tree, node => node.type === 'img').length, 0);
    assert.match(textOf(tree), /ニュースはこちら https:\/\/news\.example\/article/);
});

test('a comment that is a link to a page, not an image, stays text', () => {
    const tree = render('https://news.example/article');

    assert.equal(findAll(tree, node => node.type === 'img').length, 0);
});

test('a comment without a date shows no date instead of 1970', () => {
    const tree = render('undated comment', { date: null });

    assert.doesNotMatch(textOf(tree), /1970/);
});

test('a sentiment score of 0 is shown as 0 with its label', () => {
    const tree = SentimentSection({
        sentiment: { score: 0, label: 'negative', details: 'grim' }, loading: false, i18n,
    });

    assert.equal(textOf(byClass(tree, 'score-value')), '0');
    assert.equal(textOf(byClass(tree, 'sentiment-label')), '«sentimentNegative»');
});

test('a sentiment result without a score shows "-" and no label', () => {
    const tree = SentimentSection({
        sentiment: { score: null, label: null, details: 'cut off' }, loading: false, i18n,
    });

    assert.equal(textOf(byClass(tree, 'score-value')), '-');
    assert.equal(textOf(byClass(tree, 'sentiment-label')), '');
});

test('the essay draft is shown while the sentiment analysis is still running', () => {
    const tree = SentimentSection({ sentiment: null, draft: 'The community is lar', loading: true, i18n });

    assert.match(textOf(byClass(tree, 'sentiment-details')), /The community is lar/);
    assert.equal(byClass(tree, 'skeleton-line').length, 0);
    assert.equal(textOf(byClass(tree, 'score-value')), '?');
});

// ---------------------------------------------------------------- Gemini's Markdown

const ofType = (tree, type) => findAll(tree, node => node.type === type);
const summaryTree = summary => SummarySection({ summary, source: null, sourceDetails: null, loading: false, i18n });
const essayTree = details => SentimentSection({ sentiment: { label: 'positive', score: 7, details }, loading: false, i18n });

test('the summary shows Markdown italics and bold as real italics and bold', () => {
    const tree = summaryTree('He starred in the drama *Docchi ga Docchi!* and the **NHK Taiga** drama _Toshiie to Matsu_.');

    assert.deepEqual(ofType(tree, 'em').map(textOf), ['Docchi ga Docchi!', 'Toshiie to Matsu']);
    assert.deepEqual(ofType(tree, 'strong').map(textOf), ['NHK Taiga']);
    assert.ok(!textOf(tree).includes('*'), textOf(tree));
});

test('headings, bullet lists and numbered lists in the essay are shown as such', () => {
    const tree = essayTree(['## Main themes', '- Support for the couple', '- Surprise at the news', '',
        '1. First reason', '2. Second reason', '', 'A closing paragraph with *emphasis*.'].join('\n'));

    assert.deepEqual(byClass(tree, 'md-heading').map(textOf), ['Main themes']);
    assert.deepEqual(ofType(tree, 'ul').flatMap(list => ofType(list, 'li')).map(textOf), ['Support for the couple', 'Surprise at the news']);
    assert.deepEqual(ofType(tree, 'ol').flatMap(list => ofType(list, 'li')).map(textOf), ['First reason', 'Second reason']);
    assert.deepEqual(ofType(tree, 'em').map(textOf), ['emphasis']);
});

test('the essay streamed so far shows its formatting too', () => {
    const tree = SentimentSection({ sentiment: null, draft: 'An *early* draft', loading: true, i18n });
    assert.deepEqual(ofType(tree, 'em').map(textOf), ['early']);
});

test('HTML in a reply is shown as text, never as markup', () => {
    const tree = summaryTree('<img src=x onerror=alert(1)> and *safe*');

    assert.equal(ofType(tree, 'img').length, 0);
    assert.ok(textOf(tree).includes('<img src=x onerror=alert(1)>'));
});

test('asterisks and underscores that are not Markdown stay as written', () => {
    const text = '3 * 4 = 12, snake_case_name and 5*6';
    const tree = summaryTree(text);

    assert.equal(ofType(tree, 'em').length, 0);
    assert.equal(textOf(byClass(tree, 'summary-content')), text);
});

test('the summary streamed so far is shown, with its formatting, instead of the loading lines', () => {
    const tree = SummarySection({ summary: null, draft: 'An *early* summary', source: null, sourceDetails: null, loading: true, i18n });

    assert.deepEqual(ofType(tree, 'em').map(textOf), ['early']);
    assert.equal(byClass(tree, 'loading-skeleton').length, 0);
});

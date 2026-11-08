const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Renders CommentItem with the bundled production React to an element tree.
// CommentItem uses no hooks, so it can be called directly without a DOM.
function loadCommentItem() {
    const context = vm.createContext({ console });
    context.self = context; // React's UMD wrapper attaches to `self` outside CommonJS
    for (const file of ['lib/react.production.min.js', 'popup-react.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file });
    }
    return vm.runInContext('CommentItem', context);
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

const CommentItem = loadCommentItem();
const render = text => CommentItem({
    comment: { text, plus: 3, minus: 1, date: '2026-11-01T00:00:00.000Z', number: 2 },
});

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

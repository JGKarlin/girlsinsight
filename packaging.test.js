const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));

// Every file the extension loads at run time.
function filesTheExtensionLoads() {
    const files = new Set([
        'manifest.json',
        manifest.background.service_worker,
        manifest.side_panel.default_path,
        ...manifest.content_scripts.flatMap(script => script.js),
        ...Object.values(manifest.icons),
        `_locales/${manifest.default_locale}/messages.json`,
        '_locales/en/messages.json',
        'lib/Readability.js', // injected into article tabs by rendered-article-session.js
    ]);
    const popupHtml = fs.readFileSync(path.join(__dirname, manifest.side_panel.default_path), 'utf8');
    for (const [, src] of popupHtml.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^":]+)"/g)) files.add(src);
    const background = fs.readFileSync(path.join(__dirname, manifest.background.service_worker), 'utf8');
    for (const [, args] of background.matchAll(/importScripts\(([^)]*)\)/g)) {
        for (const [, file] of args.matchAll(/'([^']+)'/g)) files.add(file);
    }
    return [...files];
}

test('the Web Store package contains every file the extension loads and no tests', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'girlsinsight-package-'));
    execFileSync('sh', [path.join(__dirname, 'scripts', 'package.sh')], { env: { ...process.env, OUT_DIR: outDir } });

    const zipPath = path.join(outDir, `girlsinsight-${manifest.version}.zip`);
    const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).split('\n').filter(Boolean);

    for (const file of filesTheExtensionLoads()) {
        assert.ok(entries.includes(file), `package is missing ${file}`);
    }
    assert.deepEqual(entries.filter(entry => /\.test\.js$|^test-support\/|^scripts\/|^\.github\//.test(entry)), []);
});

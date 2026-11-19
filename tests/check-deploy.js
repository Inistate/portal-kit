// Checks kit/dev/deploy.js (/portal deploy) and the folder rules in kit/dev/check.js: a copy of the kit's menu sample
// with its own files beside index.html, offered to the Publish dialog as Settings › Portals reads it (the pack
// contract). This script plays the web app's part;
// nothing reaches Inistate or S3.
//
//   PLAYWRIGHT_CORE=<path to playwright-core> node dev/kit/check-deploy.js
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const PORT = 8796;
const KIT = path.join(__dirname, '..', 'kit');
const SAMPLE = path.join(KIT, 'samples', 'leave-overview');
const APP = 'https://gneysoftware.apps.inistate.com';   // the sample's server is internal
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-deploy-'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// A portal folder as /portal try leaves it, with the page's own files beside it, the kit's files, and clutter.
function makeFolder(name, edit) {
  const dir = path.join(TEMP, name);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  ['index.html', 'portal.json'].forEach(f => fs.copyFileSync(path.join(SAMPLE, f), path.join(dir, f)));
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace('</head>', '<link rel="stylesheet" href="assets/app.css">\n</head>');
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.writeFileSync(path.join(dir, 'assets', 'app.css'), '.brand { background: url(logo.svg) no-repeat; }\n');
  fs.writeFileSync(path.join(dir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'what this page is for\n');
  fs.mkdirSync(path.join(dir, 'design'));
  fs.writeFileSync(path.join(dir, 'design', 'Main.dc.html'), '<p>design</p>');
  fs.mkdirSync(path.join(dir, 'shots'));
  fs.writeFileSync(path.join(dir, 'shots', 'ready-360.png'), 'not a page file');
  fs.writeFileSync(path.join(dir, '.hidden.txt'), 'secret');
  fs.writeFileSync(path.join(dir, 'Thumbs.db'), 'clutter');
  if (edit) edit(dir);
  return dir;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail && !ok ? '   [' + String(detail).slice(0, 400) + ']' : ''));
}
function request(method, pathname, headers, body) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers: Object.assign({ Host: 'localhost:' + PORT }, headers || {}) }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', e => resolve({ status: 0, error: e.message, headers: {}, body: Buffer.alloc(0) }));
    if (body) req.write(body);
    req.end();
  });
}
const node = (script, args) => spawnSync(process.execPath, [path.join(KIT, 'dev', script)].concat(args), { encoding: 'utf8', env: process.env });
const out = r => (r.stdout || '') + (r.stderr || '');

(async () => {
  let child = null;
  try {
    // ---------------------------------------------------------------- the checks take a folder
    const dir = makeFolder('leave-overview');
    const checked = node('check.js', [dir, '--deploy', '--port=8797']);
    check('check: a page with its own files beside it passes, for publishing', checked.status === 0 && /ready to publish/.test(out(checked)), out(checked).split('\n').filter(l => /^FAIL/.test(l)).join(' | '));
    check('check: it says what goes up and what stays', /goes up: 4 files.*stays on this PC: \.hidden\.txt, design\/, portal\.json, shots\/, Thumbs\.db/.test(out(checked)), (/goes up:.*/.exec(out(checked)) || [])[0]);

    const exe = makeFolder('with-exe', d => fs.writeFileSync(path.join(d, 'setup.exe'), 'MZ'));
    const refused = node('check.js', [exe, '--port=8797']);
    check('check: a file type Inistate does not take fails the checks', refused.status !== 0 && /FAIL  files: the folder is what Inistate takes.*setup\.exe/.test(out(refused)), out(refused).split('\n').filter(l => /^FAIL/.test(l)).join(' | '));

    const missing = makeFolder('missing-file', d => {
      const p = path.join(d, 'index.html');
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('</head>', '<script src="assets/gone.js"></script>\n<script src="https://cdn.example.com/x.js"></script>\n</head>'));
      fs.writeFileSync(path.join(d, 'assets', 'app.js'), 'localStorage.setItem("x", 1);\n');
    });
    const loose = node('check.js', [missing, '--port=8797']);
    const fails = out(loose).split('\n').filter(l => /^FAIL/.test(l)).join('\n');
    check('check: a file the page names but the folder lacks fails', /FAIL  files: every file the page loads is in its folder.*assets\/gone\.js/.test(fails), fails);
    check('check: a script by address still fails', /FAIL  rule: nothing from third parties.*cdn\.example\.com/.test(fails), fails);
    check('check: the page\'s own files are read by the page rules too (localStorage in assets/app.js)', /FAIL  rule: sessionStorage only.*in assets\/app\.js/.test(fails), fails);

    const notSelf = makeFolder('no-self', d => {
      const p = path.join(d, 'index.html');
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace("style-src 'self' 'unsafe-inline'", "style-src 'unsafe-inline'").replace("default-src 'none'", "default-src 'self'"));
    });
    const policy = out(node('check.js', [notSelf, '--port=8797']));
    check('check: \'self\' anywhere but scripts, styles, images and fonts fails', /FAIL  rule: default-src 'none'/.test(policy) && /FAIL  rule: nothing else may be loaded.*default-src 'self'/.test(policy), policy.split('\n').filter(l => /^FAIL/.test(l)).join(' | '));
    check('check: own files need \'self\' in the policy', /FAIL  files: the policy lets the page's own files load.*style-src/.test(policy), policy.split('\n').filter(l => /^FAIL/.test(l)).join(' | '));

    const notReady = node('deploy.js', [exe, '--port=' + PORT]);
    check('deploy: refuses while a check fails, and offers nothing', notReady.status === 1 && /Not ready to publish/.test(out(notReady)) && !/settings\/portals\?publish/.test(out(notReady)), out(notReady).slice(-300));

    // ---------------------------------------------------------------- /portal deploy, as the Publish dialog reads it
    child = spawn(process.execPath, [path.join(KIT, 'dev', 'deploy.js'), dir, '--port=' + PORT], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let printed = '';
    child.stdout.on('data', d => { printed += d; });
    child.stderr.on('data', d => { printed += d; });
    const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
    for (let i = 0; i < 300 && !/Ctrl\+C stops it/.test(printed); i++) await new Promise(r => setTimeout(r, 100));
    const link = (new RegExp(APP.replace(/[.]/g, '\\.') + '/#/settings/portals\\?publish=1&ws=136&port=' + PORT + '#n=([A-Za-z0-9_-]+)').exec(printed) || []);
    const nonce = link[1] || '';
    check('deploy: prints the Publish link for portal.json\'s server and workspace, the nonce in the inner fragment', !!nonce && /^[A-Za-z0-9_-]{16,128}$/.test(nonce), printed.slice(0, 800));
    check('deploy: says what goes up, and as what', /Goes up: 4 files/.test(printed) && /a new portal, or the next version of the one named "leave-overview"/.test(printed), printed.slice(0, 600));

    const ok = { Origin: APP, 'X-Publish-Nonce': nonce };
    check('loopback: any Host but localhost:<port> is refused (421)', (await request('GET', '/__publish/pack.json', Object.assign({}, ok, { Host: '127.0.0.1:' + PORT }))).status === 421);
    const otherOrigin = await request('GET', '/__publish/pack.json', Object.assign({}, ok, { Origin: 'https://evil.example' }));
    check('loopback: another origin is refused, with no CORS answer', otherOrigin.status === 403 && !otherOrigin.headers['access-control-allow-origin']);
    const preflight = await request('OPTIONS', '/__publish/pack.json', { Origin: APP, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-publish-nonce', 'Access-Control-Request-Private-Network': 'true' });
    check('loopback: the preflight answers the app origin, the nonce header and Private Network Access',
      preflight.status === 204 && preflight.headers['access-control-allow-origin'] === APP && /X-Publish-Nonce/i.test(preflight.headers['access-control-allow-headers'] || '')
      && preflight.headers['access-control-allow-private-network'] === 'true', JSON.stringify(preflight.headers));
    check('loopback: no nonce, no pack (403)', (await request('GET', '/__publish/pack.json', { Origin: APP })).status === 403);
    check('loopback: a wrong nonce, no pack (403)', (await request('GET', '/__publish/pack.json', { Origin: APP, 'X-Publish-Nonce': nonce.slice(0, -1) + (nonce.slice(-1) === 'A' ? 'B' : 'A') })).status === 403);

    const packAnswer = await request('GET', '/__publish/pack.json', ok);
    let pack = {};
    try { pack = JSON.parse(packAnswer.body.toString('utf8')); } catch (e) { pack = {}; }
    check('pack: answered to the app origin', packAnswer.status === 200 && packAnswer.headers['access-control-allow-origin'] === APP && packAnswer.headers['cache-control'] === 'no-store');
    check('pack: the portal.json values the dialog fills in', pack.slug === 'leave-overview' && pack.name === 'Leave overview' && pack.icon === 'calendar' && pack.visibleTo === 'Workspace admins'
      && JSON.stringify(pack.platforms) === '["web","app"]' && !('portalId' in pack), JSON.stringify(Object.assign({}, pack, { files: undefined })));
    const listed = (pack.files || []).map(f => f.path);
    check('pack: the page\'s files, and never portal.json, design/, shots/, hidden files or clutter', JSON.stringify(listed) === JSON.stringify(['assets/app.css', 'assets/logo.svg', 'index.html', 'notes.txt']), JSON.stringify(listed));
    check('pack: each file\'s size and lower-case SHA-256', (pack.files || []).every(f => {
      const bytes = fs.readFileSync(path.join(dir, ...f.path.split('/')));
      return f.size === bytes.length && f.sha256 === sha(bytes) && /^[0-9a-f]{64}$/.test(f.sha256);
    }));
    check('pack: the checks that passed', pack.checks && pack.checks.passed > 40 && Array.isArray(pack.checks.failed) && pack.checks.failed.length === 0, JSON.stringify(pack.checks));

    const css = await request('GET', '/__publish/files/assets/app.css', ok);
    check('files: a file\'s bytes, with its type', css.status === 200 && css.body.equals(fs.readFileSync(path.join(dir, 'assets', 'app.css'))) && /^text\/css/.test(css.headers['content-type']), css.status + ' ' + css.headers['content-type']);
    check('files: a path segment is URI-decoded', (await request('GET', '/__publish/files/' + encodeURIComponent('assets') + '/' + encodeURIComponent('logo.svg'), ok)).status === 200);
    check('files: nothing outside the pack (portal.json, design/, ../)', (await request('GET', '/__publish/files/portal.json', ok)).status === 404
      && (await request('GET', '/__publish/files/design/Main.dc.html', ok)).status === 404 && (await request('GET', '/__publish/files/..%2Fportal.json', ok)).status === 404);
    check('files: no nonce, no file (403)', (await request('GET', '/__publish/files/index.html', { Origin: APP })).status === 403);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'changed after the list was made\n');
    const changed = await request('GET', '/__publish/files/notes.txt', ok);
    check('files: a file changed since the pack was made is refused (409), not sent', changed.status === 409 && /file_changed/.test(changed.body.toString('utf8')), changed.status);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'what this page is for\n');
    check('files: … and sent again once it is back as listed', (await request('GET', '/__publish/files/notes.txt', ok)).status === 200);

    const doneHeaders = Object.assign({ 'Content-Type': 'application/json' }, ok);
    check('done: an address that is not https is refused (400)', (await request('POST', '/__publish/done', doneHeaders, JSON.stringify({ portalId: 'p1', version: 1, url: 'http://x.example/' }))).status === 400);
    check('done: no nonce, no done (403)', (await request('POST', '/__publish/done', { Origin: APP, 'Content-Type': 'application/json' }, JSON.stringify({ portalId: 'p1', version: 1, url: 'https://x.example/' }))).status === 403);
    // an address nothing answers: the live-copy check says it could not check, at once
    const published = 'https://localhost:1/leave-overview/v1/index.html';
    const done = await request('POST', '/__publish/done', doneHeaders, JSON.stringify({ portalId: '6731aa0000000000000000c1', version: 1, url: published }));
    check('done: answered', done.status === 200, done.status);
    const code = await Promise.race([exited, new Promise(r => setTimeout(() => r('still running'), 20000))]);
    check('done: the kit stops', code === 0, code + ' ' + printed.slice(-400));
    child = null;
    check('done: it says what was published, and that the live copy could not be checked', /Published: Leave overview is v1 at https:\/\/localhost:1\/leave-overview\/v1\/index\.html/.test(printed) && /Live copy: could not be checked/.test(printed), printed.slice(-600));
    const written = fs.readFileSync(path.join(dir, 'portal.json'), 'utf8');
    const spec = JSON.parse(written);
    check('done: portal.json records the portal, the version and the address', spec.portalId === '6731aa0000000000000000c1' && spec.version === 1 && spec.url === published, written.slice(-200));
    check('done: portal.json keeps its shape (a short list stays on one line)', /"platforms": \["web", "app"\]/.test(written) && JSON.stringify(Object.keys(spec).slice(0, 3)) === '["slug","name","icon"]', written.slice(0, 300));
    check('loopback: stopped after done', (await request('GET', '/__publish/pack.json', ok)).status === 0);

    // ---------------------------------------------------------------- after a publish
    const again = node('serve.js', [dir, '--publish', '--undo']);
    check('undo: serve.js --publish is deploy.js; --undo prints the portal\'s Versions link', again.status === 0 && out(again).includes(APP + '/#/settings/portals?versions=6731aa0000000000000000c1&ws=136'), out(again));
    const hand = node('handover.js', [dir]);
    check('handover: a published page goes by /portal deploy, not the S3 command', hand.status === 1 && /published with \/portal deploy \(v1/.test(out(hand)) && !/aws s3 cp/.test(out(hand)), out(hand));
    const handOwn = node('handover.js', [makeFolder('own-files')]);
    check('handover: a page with its own files is not hand-hosted', handOwn.status === 1 && /A hand-hosted page is one file/.test(out(handOwn)), out(handOwn));
    const links = require(path.join(KIT, 'dev', 'links'));
    check('links: a published page\'s address is the one the publish answered', links.portalAddress(spec) === published && links.portalAddress({ slug: 'x' }) === 'https://e.inistate.com/p/x/index.html');
  } catch (error) {
    check('the run completed', false, error.stack || error.message);
  } finally {
    if (child) child.kill();
    fs.rmSync(TEMP, { recursive: true, force: true });
  }
  const failed = results.filter(r => !r.ok).length;
  console.log('\n' + (results.length - failed) + ' of ' + results.length + ' passed');
  process.exit(failed ? 1 : 0);
})();

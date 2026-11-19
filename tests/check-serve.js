// Checks kit/dev/serve.js: a copy of the kit's menu sample, served from a temporary folder, as /portal try serves a
// page. Nothing reaches Inistate (the page is opened without a launch).
//
//   PLAYWRIGHT_CORE=<path to playwright-core> node dev/kit/check-serve.js
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('../kit/dev/playwright');

const PORT = 8795;
const SAMPLE = path.join(__dirname, '..', 'kit', 'samples', 'leave-overview');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-serve-'));
['index.html', 'portal.json'].forEach(name => fs.copyFileSync(path.join(SAMPLE, name), path.join(DIR, name)));
fs.mkdirSync(path.join(DIR, 'shots'));
fs.writeFileSync(path.join(DIR, 'shots', 'x.png'), 'not served');
fs.mkdirSync(path.join(DIR, 'design'));
fs.writeFileSync(path.join(DIR, 'design', 'Main.dc.html'), 'not served');
fs.mkdirSync(path.join(DIR, 'assets'));
fs.writeFileSync(path.join(DIR, 'assets', 'app.css'), 'body { margin: 0; }');
const FILE = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail && !ok ? '   [' + detail + ']' : ''));
}
function get(pathname, host) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET', headers: { Host: host || 'localhost:' + PORT } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', e => resolve({ status: 0, error: e.message }));
    req.end();
  });
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'kit', 'dev', 'serve.js'), DIR, '--port=' + PORT], { stdio: ['ignore', 'pipe', 'pipe'] });
  let printed = '';
  child.stdout.on('data', d => { printed += d; });
  child.stderr.on('data', d => { printed += d; });
  let browser;
  try {
    for (let i = 0; i < 50 && !/Ctrl\+C/.test(printed); i++) await new Promise(r => setTimeout(r, 100));
    check('serve: starts and says where', /http:\/\/localhost:8795\//.test(printed), printed);
    check('serve: prints the debug link for portal.json\'s server and workspace', printed.includes('https://gneysoftware.apps.inistate.com/#/portal/debug?ws=136&port=8795'), printed);

    const page = await get('/');
    check('serve: / is the page', page.status === 200 && /<meta name="inistate-portal" content="1">/.test(page.body));
    check('serve: no-store and no Referer', page.headers['cache-control'] === 'no-store' && page.headers['referrer-policy'] === 'no-referrer', JSON.stringify(page.headers));
    check('serve: live reload is added after the SDK, in the served copy', page.body.indexOf('new EventSource("/__reload")') > page.body.indexOf('<!-- inistate-portal-sdk:end -->'));
    check('serve: the SDK is still the first script', page.body.indexOf('<script') === page.body.indexOf('<!-- inistate-portal-sdk:begin') + page.body.slice(page.body.indexOf('<!-- inistate-portal-sdk:begin')).indexOf('<script'));
    check('serve: connect-src gains this server only', /connect-src 'self' https:\/\/api\.inistate\.com https:\/\/app02\.apps\.inistate\.com https:\/\/gneysoftware\.apps\.inistate\.com https:\/\/test\.apps\.inistate\.com;/.test(page.body));
    check('serve: the file on disk is untouched', fs.readFileSync(path.join(DIR, 'index.html'), 'utf8') === FILE && !FILE.includes('__reload'));
    check('serve: 127.0.0.1 is answered too', (await get('/', '127.0.0.1:' + PORT)).status === 200);
    check('serve: any other name is refused (421)', (await get('/', 'evil.example:' + PORT)).status === 421);
    check('serve: portal.json is not served', (await get('/portal.json')).status === 404);
    check('serve: shots are not served', (await get('/shots/x.png')).status === 404);
    check('serve: the design is not served', (await get('/design/Main.dc.html')).status === 404);
    const css = await get('/assets/app.css');
    check('serve: the page\'s own files are, with their type', css.status === 200 && /^text\/css/.test(css.headers['content-type']), css.status + ' ' + css.headers['content-type']);
    check('serve: nothing outside the folder', (await get('/..%2F..%2Fwindows/win.ini')).status === 404 && (await get('/../package.json')).status === 404);
    const listening = await new Promise(resolve => {
      const req = http.request({ host: os.hostname(), port: PORT, path: '/', headers: { Host: 'localhost:' + PORT }, timeout: 1500 }, res => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
    check('serve: listens on 127.0.0.1 only (not on this PC\'s name)', listening === false || os.hostname().toLowerCase() === 'localhost');

    browser = await chromium.launch({ channel: 'chrome' });
    const tab = await (await browser.newContext()).newPage();
    await tab.goto('http://localhost:' + PORT + '/');
    await tab.waitForFunction(() => document.body.getAttribute('data-state') === 'outside');
    await new Promise(r => setTimeout(r, 300));
    const reloaded = tab.waitForEvent('load', { timeout: 5000 }).then(() => true, () => false);
    fs.writeFileSync(path.join(DIR, 'index.html'), FILE.replace("title: 'Leave overview',", "title: 'Leave overview (edited)',"));
    check('live reload: an edit reloads the page', await reloaded);
    check('live reload: the page shows the edit', (await tab.title()) === 'Leave overview (edited)', await tab.title());
  } catch (error) {
    check('the run completed', false, error.stack || error.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  const failed = results.filter(r => !r.ok).length;
  console.log('\n' + (results.length - failed) + ' of ' + results.length + ' passed');
  process.exit(failed ? 1 : 0);
})();

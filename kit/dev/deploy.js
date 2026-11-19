// /portal deploy: publishes a portal folder to the workspace's own host through Inistate's Publish dialog
// It holds no Inistate credential and
// uploads nothing itself: the workspace admin's own browser reads the folder from this PC, puts each file to storage
// with the links Inistate signs, and a person presses Publish.
//
//   node deploy.js <slug | folder> [--port=<1024-65535>]     publish this folder (a new portal, or its next version)
//   node deploy.js <slug | folder> --undo                    the portal's versions, to Restore an older one
//
// 1. The checks again, with --deploy (check.js). Nothing is offered while one fails.
// 2. The pack: every file that goes up, with its size and SHA-256 (folder.js: portal.json, design\, shots\ and hidden
//    files stay here).
// 3. The Publish link: <app>/#/settings/portals?publish=1&ws=<workspace>&port=<port>#n=<nonce>. Settings › Portals
//    reads the pack from http://localhost:<port>/__publish/ and shows "New portal" or "Update … v1 → v2".
// 4. When Publish lands, the page tells this PC the portal, version and address: they are written to portal.json, the
//    live copy is compared with this index.html, and an activity page's Open with link is printed.
//
// The loopback server (the pack contract):
// - listens on 127.0.0.1 and answers only Host localhost:<port>, and only the portal.json server's app origin (CORS,
//   with the Private Network Access preflight). Every request but a preflight carries X-Publish-Nonce, or gets 403.
// - GET /__publish/pack.json, GET /__publish/files/<path> (each segment URI-encoded; a file changed since the pack
//   was built gets 409), POST /__publish/done { portalId, version, url }.
// - stops after done, or after 15 minutes.
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const links = require('./links');
const folder = require('./folder');

const MINUTES = 15;
const PACK = '/__publish/pack.json', FILES = '/__publish/files/', DONE = '/__publish/done';
const NONCE_HEADER = 'x-publish-nonce';

const args = process.argv.slice(2);
const arg = name => { const found = args.find(a => a.startsWith('--' + name + '=')); return found ? found.slice(name.length + 3) : null; };
const target = args.find(a => !a.startsWith('--'));
if (!target) { console.error('Usage: node deploy.js <slug | folder> [--port=<1024-65535>] [--undo]'); process.exit(2); }
const ROOT = process.env.PORTALS_ROOT || 'D:\\portals';
const DIR = path.resolve(fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.join(ROOT, target));
const SPEC_FILE = path.join(DIR, 'portal.json');
if (!fs.existsSync(path.join(DIR, 'index.html'))) { console.error('No index.html in ' + DIR); process.exit(2); }
let spec;
try { spec = JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8')); } catch (e) { console.error('No readable portal.json in ' + DIR + ': ' + e.message); process.exit(2); }
let app;
try { app = links.server(spec).app; } catch (e) { console.error(e.message); process.exit(2); }

// --undo: the portal's versions in Settings › Portals; a person presses Restore there.
if (args.includes('--undo')) {
  if (!spec.portalId) { console.error('portal.json has no portalId: this page has not been published with /portal deploy yet.'); process.exit(1); }
  console.log([
    'Versions of ' + spec.name + ' (now v' + (spec.version || '?') + '). Open this link signed in to ' + app + ' as an admin of workspace ' + spec.workspace + ':',
    '  ' + links.versionsLink(spec),
    'It opens Settings › Portals › Versions for this portal. Restore on an older version moves the portal back to it;',
    'nothing changes until Restore is pressed and confirmed. Run /portal deploy again later to publish a new version.'
  ].join('\n'));
  process.exit(0);
}

const PORT = arg('port') === null ? 0 : Number(arg('port'));
if (PORT !== 0 && !(Number.isInteger(PORT) && PORT >= 1024 && PORT <= 65535)) { console.error('The port must be 1024–65535.'); process.exit(2); }

// 1. the checks
const run = spawnSync(process.execPath, [path.join(__dirname, 'check.js'), DIR, '--deploy'], { encoding: 'utf8', env: process.env });
const output = (run.stdout || '') + (run.stderr || '');
const counted = /(\d+) of (\d+) passed/.exec(output);
if (run.status !== 0 || !counted) {
  process.stdout.write(output);
  console.log('\nNot ready to publish: ' + (counted ? counted[0] : 'the checks did not finish') + '. Fix what failed above, then run /portal deploy again.');
  process.exit(1);
}

// 2. the pack
const { files, skipped } = folder.folderFiles(DIR);
const problem = folder.listProblem(files);
if (problem) { console.log('Not ready to publish: ' + folder.problemText(problem)); process.exit(1); }
files.forEach(f => { f.sha256 = folder.sha256(fs.readFileSync(f.abs)); });
const byPath = new Map(files.map(f => [f.path, f]));
const pack = {
  slug: spec.slug,
  name: spec.name,
  icon: spec.icon,
  visibleTo: spec.visibleTo,
  platforms: spec.platforms,
  files: files.map(f => ({ path: f.path, size: f.size, sha256: f.sha256 })),
  checks: { passed: Number(counted[1]), failed: [] }
};
if (spec.portalId) pack.portalId = spec.portalId;
const total = files.reduce((sum, f) => sum + f.size, 0);

// 3. the loopback server
const NONCE = crypto.randomBytes(24).toString('base64url');
const ORIGIN = new URL(app).origin;
const sockets = new Set();
const served = new Set();
let readPack = false, finished = false, port = 0;

const base = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const cors = { 'Access-Control-Allow-Origin': ORIGIN, Vary: 'Origin' };
function answer(res, status, body, extra) {
  const json = body !== undefined && !Buffer.isBuffer(body);
  const payload = body === undefined ? undefined : json ? Buffer.from(JSON.stringify(body)) : body;
  res.writeHead(status, Object.assign({}, base, json ? { 'Content-Type': 'application/json; charset=utf-8' } : {}, extra || {}));
  res.end(payload);
}
function nonceMatches(value) {
  const given = Buffer.from(String(value || '')), mine = Buffer.from(NONCE);
  return given.length === mine.length && crypto.timingSafeEqual(given, mine);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (String(req.headers.host || '').toLowerCase() !== 'localhost:' + port) return answer(res, 421, { error: 'wrong_host', message: 'Only http://localhost:' + port + ' answers.' });
  if (req.headers.origin !== ORIGIN) return answer(res, 403, { error: 'wrong_origin', message: 'Only ' + ORIGIN + ' may read this folder.' });
  if (finished) return answer(res, 410, { error: 'finished' }, cors);
  if (req.method === 'OPTIONS') {
    const method = String(req.headers['access-control-request-method'] || '');
    if (!['GET', 'POST'].includes(method)) return answer(res, 405, undefined, cors);
    const extra = Object.assign({}, cors, {
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'X-Publish-Nonce, Content-Type',
      'Access-Control-Max-Age': '600'
    });
    if (String(req.headers['access-control-request-private-network'] || '') === 'true') extra['Access-Control-Allow-Private-Network'] = 'true';
    return answer(res, 204, undefined, extra);
  }
  if (!nonceMatches(req.headers[NONCE_HEADER])) return answer(res, 403, { error: 'nonce_required', message: 'This publish link is not the one this PC printed.' }, cors);
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'GET' && pathname === PACK) {
    if (!readPack) { readPack = true; console.log('Inistate read the file list (' + files.length + ' files).'); }
    return answer(res, 200, pack, cors);
  }
  if (req.method === 'GET' && pathname.startsWith(FILES)) {
    let wanted;
    try { wanted = pathname.slice(FILES.length).split('/').map(decodeURIComponent).join('/'); } catch (e) { wanted = null; }
    const f = wanted && byPath.get(wanted);
    if (!f) return answer(res, 404, { error: 'not_in_pack' }, cors);
    const bytes = fs.readFileSync(f.abs);
    if (folder.sha256(bytes) !== f.sha256) {
      console.log('Changed since the file list was made: ' + f.path + '. Run /portal deploy again.');
      return answer(res, 409, { error: 'file_changed', path: f.path, message: f.path + ' changed on this PC after the file list was made. Run /portal deploy again.' }, cors);
    }
    served.add(f.path);
    if (served.size === files.length) console.log('Sent every file (' + files.length + ', ' + folder.sizeText(total) + ') to the browser.');
    return answer(res, 200, bytes, Object.assign({ 'Content-Type': folder.typeOf(f.path), 'Content-Length': bytes.length }, cors));
  }
  if (req.method === 'POST' && pathname === DONE) {
    let result;
    try { result = JSON.parse(await readBody(req, 16 * 1024)); } catch (e) { return answer(res, 400, { error: 'invalid_body' }, cors); }
    const portalId = typeof result.portalId === 'string' ? result.portalId.trim() : '';
    const version = Number(result.version);
    let url = '';
    try { url = new URL(String(result.url)).protocol === 'https:' ? String(result.url) : ''; } catch (e) { url = ''; }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(portalId) || !Number.isInteger(version) || version < 1 || !url) return answer(res, 400, { error: 'invalid_result' }, cors);
    answer(res, 200, { ok: true }, cors);
    return finish({ portalId, version, url });
  }
  return answer(res, 404, { error: 'not_found' }, cors);
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });

function stop() {
  server.close();
  sockets.forEach(s => s.destroy());
  clearTimeout(timer);
}

// portal.json keeps its shape: the publish's portal, version and address are set in place (or added at the end), and
// a short list of names stays on one line.
function writeSpec(result) {
  const next = Object.assign({}, spec, result);
  const text = JSON.stringify(next, null, 2).replace(/\[\n\s+((?:"[^"\n]*"|-?\d+(?:\.\d+)?|true|false|null)(?:,\n\s+(?:"[^"\n]*"|-?\d+(?:\.\d+)?|true|false|null))*)\n\s*\]/g,
    (whole, inner) => '[' + inner.split(/,\n\s+/).join(', ') + ']');
  fs.writeFileSync(SPEC_FILE, text + '\n');
  return next;
}

// The live copy at the address the publish answered: this very index.html, another one, or not there (yet).
function liveCopy(address) {
  const mine = byPath.get(folder.INDEX).sha256;
  return new Promise(resolve => {
    const request = https.get(address, { headers: { 'Cache-Control': 'no-cache' }, timeout: 15000 }, response => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => {
        if (response.statusCode !== 200) return resolve({ state: 'missing', status: response.statusCode });
        resolve({ state: folder.sha256(Buffer.concat(chunks)) === mine ? 'same' : 'different' });
      });
    });
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', error => resolve({ state: 'unknown', reason: error.message }));
  });
}

async function finish(result) {
  finished = true;
  stop();
  const next = writeSpec(result);
  console.log('\nPublished: ' + next.name + ' is v' + result.version + ' at ' + result.url);
  console.log('portal.json now records portalId ' + result.portalId + ', version ' + result.version + ' and that address.');
  let live = await liveCopy(result.url);
  for (let i = 0; i < 12 && live.state === 'missing'; i++) {
    await new Promise(r => setTimeout(r, 5000));
    live = await liveCopy(result.url);
  }
  console.log('Live copy: ' + {
    same: 'the address serves this index.html.',
    different: 'the address serves ANOTHER index.html than this folder\'s. Check that the folder did not change, then run /portal deploy again.',
    missing: 'the address still answers ' + live.status + ' after a minute. Members may not see it yet: check the workspace\'s host is set up.',
    unknown: 'could not be checked (' + live.reason + ').'
  }[live.state]);
  if (next.kind === 'activity' || next.activity) {
    const a = next.activity;
    console.log([
      '',
      'Then the module\'s designer sets the activity to open the page (Studio; Open with is for Inistate staff while it is in alpha):',
      '  ' + links.openWithLink(next),
      '  It opens module "' + a.module + '" → activity "' + (a.activity || a.activityId) + '" with Open with: Portal page → "' + next.name + '".',
      '  Check it and press Save. A portal set as Open with keeps working across new versions: it is chosen by portal, not by address.'
    ].join('\n'));
  }
  console.log('\nUndo: /portal deploy --undo opens this portal\'s versions, where an older one can be restored.');
  process.exit(live.state === 'different' ? 1 : 0);
}

const timer = setTimeout(() => {
  if (finished) return;
  finished = true;
  stop();
  console.log('\nStopped: nothing was published within ' + MINUTES + ' minutes, and the folder is no longer offered. Run /portal deploy again to publish.');
  process.exit(3);
}, MINUTES * 60 * 1000);

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Port ' + PORT + ' is in use. Pick another with --port=…, or leave it out.' : String(error));
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  port = server.address().port;
  const update = spec.portalId ? 'the next version of portal ' + spec.portalId + (spec.version ? ' (now v' + spec.version + ')' : '') : 'a new portal, or the next version of the one named "' + spec.slug + '"';
  console.log([
    'Publish: ' + spec.name + '  (checks: ' + counted[0] + ')',
    'Goes up: ' + files.length + ' file' + (files.length === 1 ? '' : 's') + ', ' + folder.sizeText(total) + (skipped.length ? '   (stays on this PC: ' + skipped.map(s => s.path).join(', ') + ')' : ''),
    'As: ' + update + ', in workspace ' + spec.workspace + ' on ' + links.server(spec).label + '.',
    '',
    'Open this link signed in to ' + app + ' as an admin of workspace ' + spec.workspace + ':',
    '  ' + links.publishLink(spec, port, NONCE),
    'It opens Settings › Portals › Publish with these files. Inistate shows the address and the version; nothing is',
    'published until Publish is pressed. If the browser asks whether ' + ORIGIN + ' may reach this PC, allow it.',
    '',
    'This PC offers the folder to that page only, at http://localhost:' + port + ', for ' + MINUTES + ' minutes. Ctrl+C stops it.'
  ].join('\n'));
});

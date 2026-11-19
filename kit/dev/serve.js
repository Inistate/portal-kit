// Serves one portal page from this PC for a live try, reloading it on every edit.
//
//   node serve.js <slug | folder> [--port=5173] [--entry=<entry id>]
//   node serve.js <slug | folder> --publish [--port=…]       the same as node deploy.js (/portal deploy)
//
// <slug> is a folder under D:\portals (PORTALS_ROOT changes that); a folder path also works. The port defaults to
// portal.json's. Open the debug link it prints: Inistate asks the workspace admin to Allow, then sends their own
// session to http://localhost:<port>/, where this server answers.
//
// - Listens on 127.0.0.1 only, and answers only a Host of localhost:<port> or 127.0.0.1:<port>, so no other name
//   (a LAN address, a rebinding domain) reaches the page.
// - Serves only the files that go up with the page (folder.js: never portal.json, design\, shots\ or hidden files),
//   only GET and HEAD. Every answer is no-store, with no Referer.
// - Live reload: the copy of index.html it serves (never the file) gets a short script after the SDK that listens on
//   /__reload, and a connect-src for this server alone. A change to any file in the folder reloads the page; the
//   session survives the reload (it is kept in this tab's sessionStorage). The file on disk is what the checks and
//   the hand-over see.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const links = require('./links');
const folder = require('./folder');

const args = process.argv.slice(2);
// serve.js --publish is /portal deploy: the folder is offered to Inistate's Publish dialog instead (deploy.js).
if (args.includes('--publish')) {
  const run = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'deploy.js')].concat(args.filter(a => a !== '--publish')), { stdio: 'inherit' });
  process.exit(run.status === null ? 1 : run.status);
}
const arg = name => { const found = args.find(a => a.startsWith('--' + name + '=')); return found ? found.slice(name.length + 3) : null; };
const target = args.find(a => !a.startsWith('--'));
if (!target) { console.error('Usage: node serve.js <slug | folder> [--port=5173] [--entry=<entry id>]'); process.exit(2); }
const ROOT = process.env.PORTALS_ROOT || 'D:\\portals';
const DIR = path.resolve(fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.join(ROOT, target));
if (!fs.existsSync(path.join(DIR, 'index.html'))) { console.error('No index.html in ' + DIR); process.exit(2); }
let spec = null;
try { spec = JSON.parse(fs.readFileSync(path.join(DIR, 'portal.json'), 'utf8')); } catch (e) { spec = null; }
const PORT = Number(arg('port') || (spec && spec.port) || 5173);
if (!(PORT >= 1024 && PORT <= 65535)) { console.error('The port must be 1024–65535 (a debug grant takes no other).'); process.exit(2); }
const HOSTS = ['localhost:' + PORT, '127.0.0.1:' + PORT];

const RELOAD = '<script>/* /portal serve: live reload, in the served copy only (never in the files that are published) */\n'
  + '(function () { var source = new EventSource("/__reload"); source.onmessage = function () { location.reload(); }; })();</script>\n';
const SDK_END = '<!-- inistate-portal-sdk:end -->\n';

function served(html) {
  if (!html.includes(SDK_END)) return { html, reload: false };
  return {
    html: html.replace(SDK_END, SDK_END + RELOAD).replace(/connect-src /, "connect-src 'self' "),
    reload: true
  };
}

const clients = new Set();
const headers = extra => Object.assign({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }, extra || {});

const server = http.createServer((req, res) => {
  if (!HOSTS.includes(String(req.headers.host || '').toLowerCase())) { res.writeHead(421, headers()); return res.end('Open this page at http://localhost:' + PORT + '/'); }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers({ Allow: 'GET, HEAD' })); return res.end(); }
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/__reload') {
    res.writeHead(200, headers({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }));
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(DIR, relative);
  const inside = file.startsWith(DIR + path.sep);
  const own = inside ? path.relative(DIR, file).split(path.sep).join('/') : '';
  const stays = !own || !!folder.leftOut(own) || !!folder.pathError(own);
  if (!inside || stays || !fs.existsSync(file) || !fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) { res.writeHead(404, headers()); return res.end('Not found'); }
  const type = folder.typeOf(own);
  let body = fs.readFileSync(file);
  if (relative === 'index.html') body = Buffer.from(served(body.toString('utf8')).html, 'utf8');
  res.writeHead(200, headers({ 'Content-Type': type, 'Content-Length': body.length }));
  res.end(req.method === 'HEAD' ? undefined : body);
});

let pending = null;
fs.watch(DIR, { recursive: true }, (event, name) => {
  if (name && /^(shots[\\/]|\.)/i.test(String(name))) return;
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    clients.forEach(res => res.write('data: reload\n\n'));
    console.log('changed: ' + (name || '?') + (clients.size ? ' (reloading ' + clients.size + ' tab' + (clients.size > 1 ? 's' : '') + ')' : ''));
  }, 150);
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Port ' + PORT + ' is in use. Pick another with --port=…, and open the debug link for that port.' : String(error));
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  console.log('Serving ' + DIR + ' at http://localhost:' + PORT + '/ (this PC only, no-store, no Referer)');
  console.log(served(html).reload ? 'Live reload is on: every edit reloads the page, and its session stays.' : 'Live reload is off: the page has no inistate-portal-sdk markers.');
  if (spec) {
    try {
      console.log('\nDebug link (' + links.server(spec).label + ', workspace ' + spec.workspace + '):\n  ' + links.debugLink(spec, PORT, arg('entry')));
      if (spec.kind === 'menu' && spec.activity) {
        console.log('As "' + (spec.activity.activity || spec.activity.activityId) + '" opens it:\n  ' + links.debugLink(spec, PORT, arg('entry'), true));
      }
      if (spec.activity && spec.activity.onEntry && !arg('entry')) console.log('  This activity runs on an entry: add --entry=<entry id> (the raw id, not the address\'s encoded ?id=) for the entry to try it on.');
      console.log('Submits are real: they write entries and run automations in that workspace.');
    } catch (e) { console.log('\n' + e.message); }
  }
  console.log('\nCtrl+C stops it.');
});

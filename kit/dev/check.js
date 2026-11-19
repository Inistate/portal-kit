// Checks a portal page before it is tried live or handed over, on made-up data only. Nothing reaches Inistate.
//
//   node check.js <slug | folder> [--port=8790] [--handover | --deploy]
//
// <slug> is a folder under D:\portals (PORTALS_ROOT changes that); a folder path also works. It holds index.html (the
// page), the page's own files beside it if it has any (styles, scripts, images, fonts), and portal.json (what the page
// reads and submits, by name; written by /portal try). portal.json, design\, shots\ and hidden files never go up.
// --handover adds what registering needs; --deploy adds that, and what publishing to the workspace's host needs.
//
// The page is served on http://localhost:<port>/, as a debug launch opens it, and launched the way Inistate launches
// it: a single-use code after the #, swapped at Inistate's API address. That address is answered inside the browser
// by a mock built from portal.json (made-up rows and forms), so the page runs unchanged and no call leaves this PC.
// Any request to any other address fails the run.
//
// What it checks:
//   the rules     marker, no-referrer, the content policy (Inistate's four API addresses only; 'self' only for
//                 scripts, styles, images and fonts), the SDK unchanged and first, no outside loads, sessionStorage
//                 only, safe-area aware, no debug code paths, in the page and in its own files
//   the files     what Inistate takes (types, paths, 200 files, 100 MB), and every
//                 file the page names is in the folder
//   the screens   outside, loading -> ready, empty, no access, ended ("Open again from Inistate"), saving -> saved,
//                 refused; screenshots at 360 px and 1280 px in <folder>/shots/ (never uploaded)
//   behaviour     no request outside Inistate, no localStorage, no timer under 60 s that repeats, no refresh more
//                 often than once a minute (ten minutes are run on a fake clock), 360 px without sideways scrolling,
//                 the submit through /api/activity/form, /api/fileupload and /api/activity/ with the session's
//                 activity and entry, and done() closing the page (web) or telling the app (app)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('./playwright');
const links = require('./links');
const folder = require('./folder');

const KIT = path.join(__dirname, '..');
const SDK = fs.readFileSync(path.join(KIT, 'sdk', 'portal-v1.js'), 'utf8');
const args = process.argv.slice(2);
const arg = name => { const found = args.find(a => a.startsWith('--' + name + '=')); return found ? found.slice(name.length + 3) : null; };
const target = args.find(a => !a.startsWith('--'));
if (!target) { console.error('Usage: node check.js <slug | folder> [--port=8790] [--handover | --deploy]'); process.exit(2); }
const ROOT = process.env.PORTALS_ROOT || 'D:\\portals';
const DIR = fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.resolve(target) : path.join(ROOT, target);
const DEPLOY = args.includes('--deploy');
const HANDOVER = DEPLOY || args.includes('--handover');
const PORT = Number(arg('port')) || 8790;
const ORIGIN = 'http://localhost:' + PORT;
const API = 'https://api.inistate.com';
const APP = 'https://app.inistate.com';
const CSP_HOSTS = ['https://api.inistate.com', 'https://app02.apps.inistate.com', 'https://gneysoftware.apps.inistate.com', 'https://test.apps.inistate.com'];
const WORKSPACE = '1001';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail && !ok ? '   [' + String(detail).slice(0, 300) + ']' : ''));
  return !!ok;
}

if (!fs.existsSync(path.join(DIR, 'index.html'))) { console.error('No index.html in ' + DIR); process.exit(2); }
const HTML = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
let SPEC = null;
try { SPEC = JSON.parse(fs.readFileSync(path.join(DIR, 'portal.json'), 'utf8')); } catch (e) { SPEC = null; }

// ---------------------------------------------------------------- 1. the rules, read from the file
const SDK_BLOCK = /<!-- inistate-portal-sdk:begin[^\n]*-->\n<script>\n([\s\S]*?)<\/script>\n<!-- inistate-portal-sdk:end -->/.exec(HTML);
// the page's own code and markup: everything but the SDK, which says "localStorage" in its own rules
const OWN = SDK_BLOCK ? HTML.replace(SDK_BLOCK[0], '') : HTML;
// the folder as it goes up: index.html and the page's own files; the kit's files stay here
const FOLDER = folder.folderFiles(DIR);
const SERVED = new Map(FOLDER.files.map(f => [f.path, f]));
const ASSETS = FOLDER.files.filter(f => f.path !== folder.INDEX);
// the page's own code in its files, read by the same rules as the page
const CODE = ASSETS.filter(f => /\.(js|mjs|css|html)$/i.test(f.path)).map(f => ({ path: f.path, text: fs.readFileSync(f.abs, 'utf8') }));
const SELF_OK = ['script-src', 'style-src', 'img-src', 'font-src'];

// What a page or file loads, by the address it names: { what, ref, from }. Links a member follows (<a href>) are not
// loads, and are left alone.
function loadsOf(text, from, kind) {
  const found = [];
  const add = (what, ref) => found.push({ what, ref: String(ref).trim(), from });
  if (kind === 'html') {
    (text.match(/<(script|link|img|source|video|audio|track|image|use|input)\b[^>]*>/gi) || []).forEach(tag => {
      const name = /^<(\w+)/.exec(tag)[1].toLowerCase();
      const attr = /\s(src|href|srcset|poster|xlink:href)\s*=\s*(["'])([\s\S]*?)\2/gi;
      let m;
      while ((m = attr.exec(tag))) {
        if (m[1].toLowerCase() === 'srcset') m[3].split(',').forEach(s => add('a <' + name + ' srcset>', s.trim().split(/\s+/)[0]));
        else add('a <' + name + ' ' + m[1].toLowerCase() + '>', m[3]);
      }
    });
  }
  if (kind === 'html' || kind === 'css') {
    let m;
    const url = /url\(\s*(["']?)([^"')]*)\1\s*\)/gi;
    while ((m = url.exec(text))) add('a CSS url()', m[2]);
    const imp = /@import\s+(?:url\(\s*)?(["'])([^"']+)\1/gi;
    while ((m = imp.exec(text))) add('a CSS @import', m[2]);
  }
  if (kind === 'html' || kind === 'js') {
    let m;
    const dynamic = /\bimport\s*\(\s*(["'`])([^"'`]+)\1/g;
    while ((m = dynamic.exec(text))) add('a module import', m[2]);
    const fromAddress = /\bfrom\s*(["'])((?:[a-z][a-z0-9+.-]*:|\/\/)[^"']*)\1/gi;
    while ((m = fromAddress.exec(text))) add('a module import', m[2]);
  }
  return found;
}

// Each load: nothing from an address or outside the folder, and every file named is in the folder.
function loadProblems() {
  const loads = loadsOf(OWN, folder.INDEX, 'html').concat(...CODE.map(c => loadsOf(c.text, c.path, /\.html$/i.test(c.path) ? 'html' : /\.css$/i.test(c.path) ? 'css' : 'js')));
  const outside = [], missing = [];
  loads.forEach(l => {
    if (!l.ref || l.ref.charAt(0) === '#' || /^(data|blob):/i.test(l.ref)) return;
    const at = l.from === folder.INDEX ? '' : ' in ' + l.from;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(l.ref)) return outside.push(l.what + ' to an address' + at + ' (' + l.ref.slice(0, 80) + ')');
    if (l.ref.charAt(0) === '/') return outside.push(l.what + ' outside the page\'s folder' + at + ' (' + l.ref + ')');
    let ref = l.ref.replace(/[?#].*$/, '');
    try { ref = decodeURIComponent(ref); } catch (e) { /* kept as written */ }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(l.from), ref));
    if (resolved === '..' || resolved.startsWith('../')) return outside.push(l.what + ' outside the page\'s folder' + at + ' (' + l.ref + ')');
    if (!SERVED.has(resolved)) missing.push(resolved + (at ? ' (named' + at + ')' : ''));
  });
  return { outside: [...new Set(outside)], missing: [...new Set(missing)] };
}

function rules() {
  check('portal.json: present and readable', !!SPEC);
  const spec = SPEC || {};
  check('portal.json: a slug (lower-case letters, digits and hyphens)', /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(String(spec.slug || '')), spec.slug);
  if (DEPLOY) check('deploy: the slug is 2 to 40 characters, the folder name on the workspace\'s host', folder.isSlug(spec.slug), spec.slug);
  check('portal.json: a name and a kind (menu or activity)', !!spec.name && ['menu', 'activity'].includes(spec.kind), spec.kind);
  check('portal.json: the server is production, internal or test', ['production', 'internal', 'test'].includes(spec.server), spec.server);
  // A menu page may name an activity too: the Portals menu opens it, and so does that activity (one page, one address).
  if (spec.kind === 'activity' || spec.activity) {
    const a = spec.activity || {};
    check('portal.json: an activity page names its module and activity ids', Number.isInteger(Number(a.moduleId)) && !!a.activityId && !!a.module, JSON.stringify(a));
    check('portal.json: an activity page describes the activity\'s form', (spec.submits || []).some(s => s.module === a.module), 'submits[] has no form for ' + a.module);
  }
  check('portal.json: names only, no rows', !JSON.stringify(spec).match(/"(rows|list|data|values|entries)"\s*:/), 'portal.json carries rows');
  if (HANDOVER) {
    check('hand-over: portal.json has the Add portal values (icon, visibleTo, platforms)', !!spec.icon && !!spec.visibleTo && Array.isArray(spec.platforms) && spec.platforms.length > 0
      && spec.platforms.every(p => p === 'web' || p === 'app'), JSON.stringify({ icon: spec.icon, visibleTo: spec.visibleTo, platforms: spec.platforms }));
    // what the Add portal dialog offers, so its setup link fills it in as written
    check('hand-over: the icon is one Settings › Portals offers', links.PORTAL_ICONS.includes(spec.icon), 'one of: ' + links.PORTAL_ICONS.join(', '));
    check('hand-over: visibleTo is "Everyone" or "Workspace admins"', !!links.visibility(spec), JSON.stringify(spec.visibleTo));
  }

  check('rule: the portal marker', HTML.includes('<meta name="inistate-portal" content="1">'));
  check('rule: no Referer (<meta name="referrer" content="no-referrer">)', HTML.includes('<meta name="referrer" content="no-referrer">'));
  const cspMatch = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(HTML);
  check('rule: a content policy', !!cspMatch);
  const csp = {};
  if (cspMatch) cspMatch[1].split(';').map(s => s.trim()).filter(Boolean).forEach(d => { const [name, ...sources] = d.split(/\s+/); csp[name] = sources; });
  check('rule: default-src \'none\'', JSON.stringify(csp['default-src']) === '["\'none\'"]', JSON.stringify(csp['default-src']));
  const connect = (csp['connect-src'] || []).slice().sort();
  check('rule: connect-src names Inistate\'s four API addresses (the SDK\'s API_HOSTS), and only them', JSON.stringify(connect) === JSON.stringify(CSP_HOSTS.slice().sort()), connect.join(' '));
  const loose = Object.keys(csp).filter(d => d !== 'connect-src').flatMap(d => csp[d]
    .filter(s => !["'none'", "'unsafe-inline'", 'data:', 'blob:'].includes(s) && !(s === "'self'" && SELF_OK.includes(d))).map(s => d + ' ' + s));
  check('rule: nothing else may be loaded from any address (\'self\' only for scripts, styles, images and fonts)', !loose.length, loose.join(', '));
  if (ASSETS.length) {
    check('files: the policy lets the page\'s own files load (\'self\' in script-src, style-src, img-src and font-src)',
      SELF_OK.every(d => (csp[d] || []).includes("'self'")), SELF_OK.filter(d => !(csp[d] || []).includes("'self'")).join(', ') + ' without \'self\'');
  }
  check('rule: base-uri and form-action are \'none\'', JSON.stringify(csp['base-uri']) === '["\'none\'"]' && JSON.stringify(csp['form-action']) === '["\'none\'"]');
  check('rule: the content policy comes before any script', !!cspMatch && HTML.indexOf(cspMatch[0]) < HTML.indexOf('<script'));
  check('rule: the SDK sits between its markers', !!SDK_BLOCK);
  check('rule: the SDK is the kit\'s copy, unchanged', !!SDK_BLOCK && SDK_BLOCK[1] === SDK, SDK_BLOCK ? 'differs from kit/sdk/portal-v1.js' : '');
  check('rule: the SDK is the first script', !!SDK_BLOCK && HTML.indexOf('<script') === HTML.indexOf(SDK_BLOCK[0]) + SDK_BLOCK[0].indexOf('<script'));
  check('rule: one layout from 360 px (width=device-width, viewport-fit=cover)', /<meta name="viewport" content="[^"]*width=device-width[^"]*viewport-fit=cover[^"]*">/.test(HTML));
  check('rule: safe-area aware (env(safe-area-inset-…))', /env\(safe-area-inset-(top|bottom)/.test(OWN));
  check('rule: starts on the loading screen (<body data-state="loading">)', /<body[^>]*data-state="loading"/.test(OWN));
  // the page and its own files, each by the same rules
  const sources = [{ path: folder.INDEX, text: OWN }].concat(CODE);
  const where = (list, test) => sources.flatMap(s => list.filter(([re]) => test(re, s.text)).map(([, what]) => what + (s.path === folder.INDEX ? '' : ' in ' + s.path)));
  const loads = loadProblems();
  const frames = where([[/<iframe|<object|<embed/i, 'a frame or object']], (re, text) => re.test(text));
  check('rule: nothing from third parties (no fonts, scripts, styles or images by address)', !loads.outside.length && !frames.length, loads.outside.concat(frames).join(', '));
  check('files: every file the page loads is in its folder', !loads.missing.length, 'not in the folder: ' + loads.missing.join(', '));
  const storage = where(['localStorage', 'indexedDB', 'document.cookie', 'caches.open', 'openDatabase'].map(w => [w, w]), (word, text) => text.includes(word));
  check('rule: sessionStorage only (no localStorage, IndexedDB, cookies or caches)', !storage.length, storage.join(', '));
  const debug = where([[/localhost|127\.0\.0\.1/, 'a local address'], [/apiHosts|appHosts/, 'start() options'], [/portal\/debug/, 'the debug route'],
    [/InistatePortal\.start\(\s*[^)\s]/, 'InistatePortal.start() with options'], [/[?&#](?:token|plc|prt)=/i, 'a token in an address']], (re, text) => re.test(text));
  check('rule: no debug code paths (the same files are uploaded)', !debug.length, debug.join(', '));
  // (an activity page's own form needs no name in the page: the session's context names its module)
  const ownForm = form => !!spec.activity && form.module === spec.activity.module;
  const named = (spec.reads || []).concat((spec.submits || []).filter(form => !ownForm(form))).flatMap(r => [r.module, r.listing].filter(Boolean));
  const missing = named.filter(name => !OWN.includes(name));
  check('portal.json and the page name the same modules and listings', !missing.length, 'not in the page: ' + missing.join(', '));
  check('rule: index.html under 2 MB', Buffer.byteLength(HTML) < 2 * 1024 * 1024, Math.round(Buffer.byteLength(HTML) / 1024) + ' KB');
  const problem = folder.listProblem(FOLDER.files);
  check('files: the folder is what Inistate takes (types, paths, at most ' + folder.MAX_FILES + ' files and 100 MB)', !problem, problem && folder.problemText(problem));
  const total = FOLDER.files.reduce((sum, f) => sum + f.size, 0);
  console.log('      goes up: ' + FOLDER.files.length + ' file' + (FOLDER.files.length === 1 ? '' : 's') + ', ' + folder.sizeText(total)
    + (FOLDER.skipped.length ? '; stays on this PC: ' + FOLDER.skipped.map(s => s.path).join(', ') : ''));
}

// ---------------------------------------------------------------- 2. the mock, made up from portal.json
// Field keys are not the display names, as on a real module; ids and values are made up.
const modules = {};
function moduleOf(name) {
  if (!modules[name]) modules[name] = { name, id: String(9101 + Object.keys(modules).length), fields: {}, listings: {} };
  return modules[name];
}
function buildModules() {
  const spec = SPEC || {};
  if (spec.activity && spec.activity.module) moduleOf(spec.activity.module).id = String(spec.activity.moduleId);
  (spec.reads || []).forEach(read => {
    const m = moduleOf(read.module);
    Object.assign(m.fields, read.fields || {});
    if (read.listing) m.listings[read.listing.toLowerCase()] = Object.keys(read.fields || {});
  });
  (spec.submits || []).forEach(form => {
    const m = moduleOf(form.module);
    Object.assign(m.fields, form.fields || {});
    m.required = (m.required || []).concat(form.required || []);
  });
  Object.values(modules).forEach(m => {
    m.keys = {};
    Object.keys(m.fields).forEach((name, i) => { m.keys[name] = 'k' + i + '_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12); });
  });
}
const TYPE_CODE = { text: 1, number: 2, currency: 3, date: 4, datetime: 5, selection: 6, checkbox: 7, boolean: 7, member: 8, file: 9, image: 10, table: 12 };
function madeUp(type, name, i) {
  switch (String(type || 'text').toLowerCase()) {
    case 'date': case 'datetime': return '2026-10-' + String(10 + (i % 18)).padStart(2, '0') + 'T00:00:00Z';
    case 'number': return i + 1;
    case 'currency': case 'decimal': return Math.round((120 + 37.5 * i) * 100) / 100;
    case 'checkbox': case 'boolean': return i % 2 === 0;
    case 'file': case 'image': return { path: '/s/check/' + i + '/sample.pdf', name: 'sample-' + (i + 1) + '.pdf', size: 1200 + i };
    case 'table': return [];
    case 'selection': return ['Low', 'Normal', 'High'][i % 3];
    default: return 'Sample ' + name.toLowerCase() + ' ' + (i + 1);
  }
}

function makeMock(scenario) {
  const log = [];   // every call the page made to Inistate, in order
  const codes = new Map(), refresh = new Map();
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  function session(grant) {
    const s = codes.get(grant) || refresh.get(grant);
    const prt = 'prt_' + Math.random().toString(36).slice(2).padEnd(43, 'x').slice(0, 43);
    refresh.set(prt, s);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const answer = {
      access_token: b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ nameid: 'check-' + s.persona, unique_name: 'check.' + s.persona + '@example.com', 'mock:persona': s.persona, exp, 'inistate:portal': s.portalId }) + '.check',
      token_type: 'bearer', expires_in: 3600, refresh_token: prt,
      portal_id: s.portalId, workspace_id: WORKSPACE, session_expires_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString()
    };
    if (s.context) answer.portal_context = JSON.stringify(s.context);
    return answer;
  }
  function launchCode(extra) {
    const c = 'plc_' + Math.random().toString(36).slice(2).padEnd(43, 'y').slice(0, 43);
    codes.set(c, Object.assign({ persona: scenario.persona || 'member', portalId: scenario.portalId || 'p-check', context: scenario.context || null }, extra || {}));
    return c;
  }
  function persona(headers) {
    try { return JSON.parse(Buffer.from(String((/^Bearer (\S+)/.exec(headers.authorization || '') || [])[1]).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))['mock:persona']; } catch (e) { return null; }
  }
  const json = (status, body) => ({ status, body });
  const designOf = m => ({ rows: Object.keys(m.fields).map((name, i) => ({ items: [{ id: 'id' + i, fieldName: m.keys[name], displayName: name, type: TYPE_CODE[String(m.fields[name]).toLowerCase()] || 1,
    fields: String(m.fields[name]).toLowerCase() === 'table' ? [] : undefined }] })) });
  function rowsOf(m, fields, count) {
    return Array.from({ length: count }, (x, i) => {
      const data = {};
      fields.forEach(name => { data[name] = madeUp(m.fields[name], name, i); });
      return { entryId: 700100 + i, documentId: 'CHK' + String(i + 1).padStart(4, '0'), state: ['Open', 'Pending', 'Done'][i % 3], data };
    });
  }
  function handle(method, pathname, headers, raw) {
    const route = method + ' ' + pathname.toLowerCase().replace(/\/$/, '');
    if (route === 'POST /token') {
      const grant = new URLSearchParams(raw.toString('utf8')).get('refresh_token') || '';
      log.push({ route, grant: grant.slice(0, 4) });
      if (codes.has(grant)) { const a = session(grant); codes.delete(grant); return json(200, a); }
      if (refresh.has(grant)) { const a = session(grant); refresh.delete(grant); return json(200, a); }
      return json(400, { error: 'invalid_grant' });
    }
    const who = persona(headers);
    let body = {};
    if (/json/.test(headers['content-type'] || '')) { try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch (e) { body = {}; } }
    const entry = { route, body, wsId: headers.wsid || '', auth: /^Bearer \S+/.test(headers.authorization || '') };
    log.push(entry);
    if (!who) return json(401, { message: 'Authorization has been denied for this request.' });
    if (scenario.mode === 'ended') return json(401, { error: 'portal_session_ended', message: 'The portal session has ended.' });
    if (/^GET \/api\/workspace\/\d+$/.test(route)) {
      return json(200, { id: Number(WORKSPACE), name: 'Check workspace', roles: who === 'admin' ? ['Workspace Admin'] : ['Member'],
        menus: [{ id: 'g1', type: 'group', name: 'Made up', children: Object.values(modules).map(m => ({ id: m.id, module: m.id, name: m.name, currentWorkspace: true, menus: [] })) }] });
    }
    if (scenario.mode === 'forbidden') return json(403, { error: 'Forbidden', message: 'You do not have access to this module.' });
    if (route === 'POST /v1/list') {
      const m = modules[body.module] || Object.values(modules).find(x => x.id === String(body.module));
      if (!m) return json(404, { error: 'Not found', message: "Module '" + body.module + "' not found" });
      if (Number(body.pageSize) > 500) entry.problem = 'pageSize ' + body.pageSize + ' is over 500';
      const listing = String(body.listing || '').toLowerCase();
      if (!listing && who !== 'admin' && Object.keys(m.listings).length) return json(403, { error: 'Forbidden', message: "The 'Everything' view is restricted. Query one of your accessible listings instead." });
      if (listing && !m.listings[listing]) return json(403, { error: 'Forbidden', message: "Listing '" + body.listing + "' not found or not accessible." });
      const columns = listing ? m.listings[listing] : Object.keys(m.fields);
      const unknown = (body.fields || []).filter(f => !m.fields[f] && !['state', 'date'].includes(f));
      if (unknown.length) return json(400, { error: 'Bad request', message: "Unknown field '" + unknown[0] + "' in " + m.name + '.' });
      const fields = (body.fields || columns).filter(f => columns.includes(f));   // a listing gives only its own columns
      const total = scenario.mode === 'empty' ? 0 : 7, size = Math.min(Number(body.pageSize) || 50, 500), page = Number(body.currentPage) || 0;
      const all = rowsOf(m, fields, total);
      return json(200, { module: m.name, listing: body.listing, page, pageSize: size, totalItems: total, hasMore: (page + 1) * size < total, list: all.slice(page * size, page * size + size) });
    }
    if (route === 'POST /api/activity/form') {
      const m = Object.values(modules).find(x => x.id === String(body.moduleId));
      if (!m) return json(400, { message: 'Module ' + body.moduleId + ' is not found.' });
      // the entry is in none of the person's listings: only a workspace admin reads it, as the Everything view
      if (scenario.mode === 'outside-listing' && body.entryId) {
        if (body.listingId !== 'everything') return json(400, { message: 'Unauthorized to access this entry' });
        if (who !== 'admin') return json(400, { message: 'Listing: Everything not accessible' });
      }
      // as the server before the 2026-11 entryId fix: the entry's values come back only when it is named as locusId
      // (entryId alone answered none, and a submit echoing them cleared the activity's read-only fields)
      const values = {};
      if (body.locusId) Object.keys(m.fields).forEach((name, i) => { values[m.keys[name]] = madeUp(m.fields[name], name, i); });
      return json(200, { header: { moduleId: m.id }, classificationForm: { design: designOf(m), needSync: false, default: values } });
    }
    if (route === 'POST /api/fileupload') {
      const head = raw.slice(0, 8192).toString('latin1');
      const part = name => (new RegExp('name="' + name + '"\\r\\n\\r\\n([^\\r]*)').exec(head) || [])[1];
      entry.body = { vectorId: part('vectorId'), fieldName: part('fieldName'), fieldId: part('fieldId'), filename: (/filename="([^"]+)"/.exec(head) || [])[1] };
      const name = entry.body.filename || 'upload.bin';
      return json(200, { filename: name, mimeType: 'application/octet-stream', size: raw.length, url: '/s/check1234/' + name, type: 's3' });
    }
    if (route === 'POST /api/activity') {
      if (scenario.mode === 'refuse') return json(422, { error: 'Validation failed', message: 'One or more fields failed validation.', details: [{ field: 'k0', message: 'Made-up refusal: this is not allowed in the entry\'s state.' }] });
      const id = (body.entryIds || [])[0];
      return { status: 200, body: { entryId: id || 700999, entryIds: [id || 700999], moduleId: body.moduleId, activityId: body.activityId }, delay: 600 };
    }
    entry.problem = 'a call the kit does not expect: ' + route;
    return json(404, { message: 'No such route in the check: ' + route });
  }
  return { log, launchCode, handle };
}

// ---------------------------------------------------------------- 3. the browser
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, ORIGIN).pathname;
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
  // the page, and only the files that go up with it: the kit's files are never served
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) { res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, headers)); return res.end(HTML); }
  let relative = '';
  try { relative = decodeURIComponent(pathname).replace(/^\/+/, ''); } catch (e) { relative = ''; }
  const own = req.method === 'GET' ? SERVED.get(relative) : null;
  if (own) { res.writeHead(200, Object.assign({ 'Content-Type': folder.typeOf(own.path) }, headers)); return res.end(fs.readFileSync(own.abs)); }
  if (pathname === '/favicon.ico') { res.writeHead(204, headers); return res.end(); }
  res.writeHead(404, headers); res.end();
});

// recorded in every document before the page's own scripts: states, policy refusals, storage, timers
const WATCH = () => {
  window.__states = [];
  window.__csp = [];
  window.__local = [];
  window.__timers = [];
  document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
  new MutationObserver(() => {
    const state = document.body && document.body.getAttribute('data-state');
    if (state && window.__states[window.__states.length - 1] !== state) window.__states.push(state);
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-state'], childList: true });
  ['getItem', 'setItem', 'removeItem', 'clear', 'key'].forEach(name => {
    const original = Storage.prototype[name];
    Storage.prototype[name] = function () { try { if (this === window.localStorage) window.__local.push(name); } catch (e) { /* closed */ } return original.apply(this, arguments); };
  });
  const source = fn => { try { return String(fn).slice(0, 160); } catch (e) { return '?'; } };
  const setT = window.setTimeout, setI = window.setInterval;
  window.setTimeout = function (fn, delay) { window.__timers.push({ kind: 'timeout', delay: Number(delay) || 0, fn: source(fn) }); return setT.apply(this, arguments); };
  window.setInterval = function (fn, delay) { window.__timers.push({ kind: 'interval', delay: Number(delay) || 0, fn: source(fn) }); return setI.apply(this, arguments); };
};
const BRIDGE = () => { window.__host = []; window.InistatePortalHost = { postMessage: m => window.__host.push(JSON.parse(m)) }; };

async function open(browser, scenario, options) {
  options = options || {};
  const mock = makeMock(scenario);
  const outside = [], requests = [];
  const context = await browser.newContext({ viewport: options.viewport || { width: 360, height: 780 }, deviceScaleFactor: 1 });
  if (options.clock) await context.clock.install();
  await context.addInitScript(WATCH);
  if (options.app) await context.addInitScript(BRIDGE);
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    requests.push(url.origin + url.pathname);
    if (url.origin === ORIGIN) return route.continue();
    if (url.origin === API) {
      const out = mock.handle(req.method(), url.pathname, req.headers(), req.postDataBuffer() || Buffer.alloc(0));
      if (out.delay) await new Promise(r => setTimeout(r, out.delay));
      return route.fulfill({ status: out.status, contentType: 'application/json; charset=utf-8', headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }, body: JSON.stringify(out.body) });
    }
    if (url.origin === APP && req.resourceType() === 'document') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Inistate</title>' });
    outside.push(req.method() + ' ' + req.url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  const launch = options.noLaunch ? '' : '#plc=' + encodeURIComponent(mock.launchCode()) + '&api=' + encodeURIComponent(API) + '&app=' + encodeURIComponent(APP) + '&host=' + (options.app ? 'app' : 'web');
  await page.goto(ORIGIN + '/' + launch);
  return { context, page, mock, outside, requests, errors };
}
const stateOf = page => page.evaluate(() => document.body.getAttribute('data-state'));
async function settle(page, states, timeout) {
  try { await page.waitForFunction(list => list.includes(document.body.getAttribute('data-state')), states, { timeout: timeout || 8000 }); } catch (e) { /* reported by the caller */ }
  return stateOf(page);
}
const visibleText = page => page.evaluate(() => document.body.innerText);
function shotDir() { const dir = path.join(DIR, 'shots'); fs.mkdirSync(dir, { recursive: true }); return dir; }
async function shot(page, name) { const file = path.join(shotDir(), name + '.png'); await page.screenshot({ path: file, fullPage: true }); return file; }
async function noSidewaysScroll(page) { return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1); }

async function fill(page) {
  const filled = [];
  for (const handle of await page.$$('[data-field]')) {
    const info = await handle.evaluate(n => ({ tag: n.tagName.toLowerCase(), type: (n.type || '').toLowerCase(), name: n.getAttribute('data-field') }));
    if (info.tag === 'select') {
      const value = await handle.evaluate(n => { const o = Array.from(n.options).find(x => x.value); return o ? o.value : ''; });
      if (value) await handle.selectOption(value);
    } else if (info.type === 'checkbox') await handle.check();
    else if (info.type === 'file') await handle.setInputFiles({ name: 'check-upload.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex') });
    else if (info.type === 'date') await handle.fill('2026-10-20');
    else if (info.type === 'number') await handle.fill('42');
    else if (info.type === 'email') await handle.fill('check@example.com');
    else await handle.fill('Made-up ' + info.name.toLowerCase());
    filled.push(info);
  }
  return filled;
}

// ---------------------------------------------------------------- 4. the run
(async () => {
  console.log('Checking ' + DIR + (HANDOVER ? ' for hand-over' : ''));
  rules();
  if (!SPEC) return finish();
  buildModules();
  const spec = SPEC;
  const isActivity = spec.kind === 'activity';
  // A menu page that an activity opens too: its menu checks run without a context (as the Portals menu opens it), its
  // submit checks with one (as the activity opens it).
  const opensFromActivity = isActivity || !!spec.activity;
  const context = opensFromActivity ? { moduleId: Number(spec.activity.moduleId), activityId: String(spec.activity.activityId), entryId: spec.activity.onEntry ? '700123' : null } : null;
  const hasReads = (spec.reads || []).length > 0;
  const hasForm = opensFromActivity || (spec.submits || []).length > 0;
  const base = { persona: 'member', context: isActivity ? context : null };
  const formBase = Object.assign({}, base, { context });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    // a. opened directly, with no launch: "Open again from Inistate", and no call is made
    let r = await open(browser, base, { noLaunch: true });
    check('outside: opened without a launch, the page says to open it from Inistate', await settle(r.page, ['outside']) === 'outside', await stateOf(r.page));
    check('outside: … and makes no call', r.mock.log.length === 0, r.mock.log.map(x => x.route).join(', '));
    await shot(r.page, 'outside-360');
    await r.context.close();

    // b. the page as a member sees it: loading, then ready; the layout at 360 and 1280; ten minutes on a fake clock
    r = await open(browser, base, { clock: true });
    let state = await settle(r.page, ['ready', 'empty', 'refused', 'no-access', 'ended', 'outside']);
    check('ready: a launch signs in and the page is ready', state === 'ready', state + ' ' + (await visibleText(r.page)).slice(0, 200));
    check('loading: the page showed loading first', (await r.page.evaluate(() => window.__states))[0] === 'loading', JSON.stringify(await r.page.evaluate(() => window.__states)));
    check('ready: no script errors', !r.errors.length, r.errors.join(' | '));
    if (isActivity) {
      const asked = r.mock.log.filter(x => x.route === 'POST /api/activity/form');
      check('activity: the form asked for is the session\'s activity, module and entry',
        asked.length > 0 && asked.every(x => String(x.body.moduleId) === String(context.moduleId) && x.body.activityId === context.activityId && String(x.body.entryId === null ? '' : x.body.entryId) === String(context.entryId || '')),
        JSON.stringify(asked.map(x => x.body)));
      check('activity: the form names the entry as locusId too, so its current values come back',
        asked.length > 0 && asked.every(x => !context.entryId || String(x.body.locusId) === String(context.entryId)),
        JSON.stringify(asked.map(x => x.body.locusId)));
    }
    if (hasReads) {
      const reads = r.mock.log.filter(x => x.route === 'POST /v1/list');
      check('reads: every read goes through /v1/list with the session\'s workspace', reads.length > 0 && reads.every(x => x.auth && x.wsId === WORKSPACE), JSON.stringify(reads.map(x => x.wsId)));
      check('reads: pageSize is at most 500', reads.every(x => !x.problem), reads.map(x => x.problem).filter(Boolean).join(', '));
    }
    await r.page.setViewportSize({ width: 360, height: 780 });
    check('360 px: no sideways scrolling', await noSidewaysScroll(r.page), await r.page.evaluate(() => document.documentElement.scrollWidth + ' px wide'));
    console.log('      ' + await shot(r.page, 'ready-360'));
    await r.page.setViewportSize({ width: 1280, height: 800 });
    check('1280 px: no sideways scrolling', await noSidewaysScroll(r.page), await r.page.evaluate(() => document.documentElement.scrollWidth + ' px wide'));
    console.log('      ' + await shot(r.page, 'ready-1280'));
    const callsBefore = r.mock.log.filter(x => x.route !== 'POST /token').length;
    await r.page.clock.runFor(10 * 60 * 1000);
    const callsDuring = r.mock.log.filter(x => x.route !== 'POST /token').length - callsBefore;
    check('timers: no refresh more often than once a minute (10 minutes run)', callsDuring <= 10, callsDuring + ' calls in 10 minutes');
    const timers = await r.page.evaluate(() => window.__timers);
    check('timers: the timer watch saw the SDK\'s own refresh timer', timers.some(x => x.kind === 'timeout'), JSON.stringify(timers.slice(0, 3)));
    const shortIntervals = timers.filter(x => x.kind === 'interval' && x.delay < 60000);
    check('timers: no setInterval under 60 s', !shortIntervals.length, shortIntervals.map(x => x.delay + ' ms: ' + x.fn).join(' | '));
    const repeats = {};
    timers.filter(x => x.kind === 'timeout' && x.delay < 60000).forEach(x => { repeats[x.fn] = (repeats[x.fn] || 0) + 1; });
    const polling = Object.keys(repeats).filter(fn => repeats[fn] >= 3);
    check('timers: no setTimeout under 60 s that repeats', !polling.length, polling.map(fn => repeats[fn] + 'x ' + fn).join(' | '));
    // the content policy is in force: a call to another address is refused by the browser before it is sent
    const blocked = await r.page.evaluate(() => fetch('https://example.org/probe').then(() => 'sent', () => 'blocked'));
    check('policy: a call to any other address is refused by the page\'s own policy', blocked === 'blocked' && !r.outside.some(u => /example\.org/.test(u)), blocked);
    await r.page.evaluate(() => { window.__csp = window.__csp.filter(v => !/example\.org/.test(v)); });
    check('policy: nothing else was refused (the page tried to load nothing outside)', !(await r.page.evaluate(() => window.__csp)).length, (await r.page.evaluate(() => window.__csp)).join(' | '));
    check('requests: none outside Inistate\'s API and the page', !r.outside.length, r.outside.join(' | '));
    check('storage: localStorage is never touched', !(await r.page.evaluate(() => window.__local)).length && (await r.page.evaluate(() => localStorage.length)) === 0, (await r.page.evaluate(() => window.__local)).join(', '));
    check('storage: the session is kept in sessionStorage (this tab only)', !!(await r.page.evaluate(() => sessionStorage.getItem('inistate.portal.session'))));
    const unexpected = r.mock.log.filter(x => x.problem && !/pageSize/.test(x.problem));
    check('calls: only the calls a portal page makes', !unexpected.length, unexpected.map(x => x.problem).join(', '));
    await r.context.close();

    // c. a workspace admin: a read of the module whole (every field) where the page asks for one
    if ((spec.reads || []).some(x => x.whole)) {
      r = await open(browser, Object.assign({}, base, { persona: 'admin' }));
      state = await settle(r.page, ['ready', 'empty', 'refused', 'no-access', 'ended']);
      const whole = r.mock.log.filter(x => x.route === 'POST /v1/list' && !x.body.listing);
      check('admin: the module is read whole', state === 'ready' && whole.length > 0, state);
      await r.context.close();
      r = await open(browser, base);
      await settle(r.page, ['ready', 'empty', 'refused', 'no-access', 'ended']);
      const fellBack = r.mock.log.filter(x => x.route === 'POST /v1/list' && x.body.listing);
      check('member: refused the whole read, the page falls back to the listing', fellBack.length > 0 && await stateOf(r.page) === 'ready', await stateOf(r.page));
      await r.context.close();
    }

    // d. empty: no rows
    if (hasReads) {
      r = await open(browser, Object.assign({}, base, { mode: 'empty' }));
      check('empty: no rows shows the empty state', await settle(r.page, ['empty', 'ready', 'refused', 'no-access']) === 'empty', await stateOf(r.page));
      await shot(r.page, 'empty-360');
      await r.context.close();
    }

    // e. no access: every read or form is refused with 403
    r = await open(browser, Object.assign({}, base, { mode: 'forbidden' }));
    check('no access: a 403 shows the no-access screen', await settle(r.page, ['no-access', 'refused', 'ready', 'empty', 'ended']) === 'no-access', await stateOf(r.page));
    check('no access: the screen is shown', await r.page.isVisible('[data-screen="no-access"]'));
    await shot(r.page, 'no-access-360');
    await r.context.close();

    // f. ended: the session is over; "Open again from Inistate" goes back to Inistate
    r = await open(browser, Object.assign({}, base, { mode: 'ended' }));
    check('ended: an ended session shows the ended screen', await settle(r.page, ['ended', 'outside', 'refused', 'no-access', 'ready']) === 'ended', await stateOf(r.page));
    check('ended: it offers "Open again from Inistate"', /Open again from Inistate/i.test(await visibleText(r.page)));
    check('ended: the session is forgotten in this tab', (await r.page.evaluate(() => sessionStorage.getItem('inistate.portal.session'))) === null);
    await shot(r.page, 'ended-360');
    const reopen = await r.page.$('[data-screen="ended"] button, [data-screen="ended"] a');
    if (check('ended: the screen has a button to open it again', !!reopen)) {
      await Promise.all([r.page.waitForURL(u => u.origin === APP, { timeout: 5000 }).catch(() => null), reopen.click()]);
      check('ended: the button opens the portal again from Inistate', r.page.url().startsWith(APP + '/#/portal/'), r.page.url());
    }
    await r.context.close();

    // g. the submit, as the Inistate app's form does it, and what the page does after
    if (hasForm) {
      r = await open(browser, formBase);
      state = await settle(r.page, ['ready', 'empty']);
      const filled = await fill(r.page);
      check('submit: the form has fields to fill', filled.length > 0);
      check('submit: the page has its submit button ([data-action="submit"])', !!(await r.page.$('[data-action="submit"]')));
      const closed = r.page.waitForEvent('close', { timeout: 6000 }).then(() => true, () => false);
      await r.page.click('[data-action="submit"]');
      const after = opensFromActivity ? null : await settle(r.page, ['saved', 'refused', 'ended', 'no-access'], 8000);
      const wasClosed = opensFromActivity ? await closed : false;
      const states = wasClosed ? null : await r.page.evaluate(() => window.__states);
      const log = r.mock.log;
      const formAt = log.findIndex(x => x.route === 'POST /api/activity/form'), submitAt = log.findIndex(x => x.route === 'POST /api/activity');
      check('submit: the form is read first (/api/activity/form), then the activity submitted (/api/activity/)', formAt >= 0 && submitAt > formAt, log.map(x => x.route).join(', '));
      const sent = submitAt >= 0 ? log[submitAt].body : {};
      const m = opensFromActivity ? modules[spec.activity.module] : Object.values(modules).find(x => x.id === String(sent.moduleId));
      if (opensFromActivity) {
        check('submit: the session\'s activity and module', String(sent.moduleId) === String(context.moduleId) && sent.activityId === context.activityId, JSON.stringify({ moduleId: sent.moduleId, activityId: sent.activityId }));
        check('submit: on the session\'s entry', JSON.stringify(sent.entryIds) === JSON.stringify(context.entryId ? [context.entryId] : []), JSON.stringify(sent.entryIds));
      } else {
        const form = (spec.submits || [])[0] || {};
        check('submit: the module and activity portal.json names', !!m && m.name === form.module && sent.activityId === String(form.activityId || 'create'), JSON.stringify({ moduleId: sent.moduleId, activityId: sent.activityId }));
      }
      check('submit: moduleId is sent as a string, as the app sends it', typeof sent.moduleId === 'string');
      const keys = Object.keys(sent.payload || {}), known = m ? Object.values(m.keys) : [];
      check('submit: the payload is keyed by the form\'s field keys, not display names', keys.length > 0 && keys.every(k => known.includes(k)), keys.join(', '));
      // the server clears a form field a submit leaves out, read-only ones included: on an entry, every field the
      // page did not fill goes back with the value the form answered
      if ((sent.entryIds || []).length) check('submit: on an entry, the fields the page leaves alone keep their current values', known.every(k => keys.includes(k)), 'left out: ' + known.filter(k => !keys.includes(k)).join(', '));
      const fileFields = filled.filter(x => x.type === 'file');
      const uploads = log.filter(x => x.route === 'POST /api/fileupload');
      if (fileFields.length) {
        check('submit: each file goes through /api/fileupload first, for its field', uploads.length === fileFields.length && uploads.every(u => u.body.vectorId === String(sent.moduleId) && known.includes(u.body.fieldName) && /^id\d+$/.test(u.body.fieldId || '')) && log.indexOf(uploads[uploads.length - 1]) < submitAt,
          JSON.stringify(uploads.map(u => u.body)));
        check('submit: the uploaded file is the field\'s value', uploads.every(u => { const v = (sent.payload || {})[u.body.fieldName]; return v && v.path === '/s/check1234/check-upload.png' && v.name === 'check-upload.png'; }), JSON.stringify(sent.payload));
      }
      if (opensFromActivity) {
        const note = wasClosed ? null : await r.page.$('#inistate-portal-done');
        check('done (web): after the save the tab closes, or says it can be closed', wasClosed || !!note, wasClosed ? '' : JSON.stringify(states));
        if (!wasClosed) check('done (web): saving, then saved', states.includes('saving') && states.indexOf('saved') > states.indexOf('saving'), JSON.stringify(states));
      } else {
        check('saved: saving, then saved', after === 'saved' && states.includes('saving') && states.indexOf('saved') > states.indexOf('saving'), after + ' ' + JSON.stringify(states));
        await shot(r.page, 'saved-360');
      }
      check('submit: no request outside Inistate', !r.outside.length, r.outside.join(' | '));
      if (!wasClosed) await r.context.close(); else await r.context.close().catch(() => {});

      // refused: the server says no; the page says why, and nothing is closed
      r = await open(browser, Object.assign({}, formBase, { mode: 'refuse' }));
      await settle(r.page, ['ready', 'empty']);
      await fill(r.page);
      await r.page.click('[data-action="submit"]');
      check('refused: a refused submit shows the refused state', await settle(r.page, ['refused', 'saved', 'ended', 'no-access']) === 'refused', await stateOf(r.page));
      check('refused: it says why, in the server\'s words', /Made-up refusal/.test(await visibleText(r.page)), (await visibleText(r.page)).slice(0, 300));
      check('refused: the page stays open', !r.page.isClosed() && !(await r.page.$('#inistate-portal-done')));
      await shot(r.page, 'refused-360');
      await r.context.close();

      // in the app: done() tells the app, which closes the page
      if (opensFromActivity) {
        r = await open(browser, formBase, { app: true });
        await settle(r.page, ['ready', 'empty']);
        await fill(r.page);
        await r.page.click('[data-action="submit"]');
        await r.page.waitForFunction(() => window.__host && window.__host.length > 0, null, { timeout: 8000 }).catch(() => null);
        const sentToApp = await r.page.evaluate(() => window.__host);
        const expected = context.entryId || '700999';
        check('done (app): the app is told { type: "done", entryId }', JSON.stringify(sentToApp) === JSON.stringify([{ type: 'done', entryId: expected }]), JSON.stringify(sentToApp));
        await r.context.close();
      }

      // an entry outside every listing the person has: a workspace admin's form is read as the Everything view
      if (opensFromActivity && context.entryId) {
        r = await open(browser, Object.assign({}, formBase, { persona: 'admin', mode: 'outside-listing' }));
        state = await settle(r.page, ['ready', 'empty', 'refused', 'no-access']);
        const asked = r.mock.log.filter(x => x.route === 'POST /api/activity/form').map(x => x.body.listingId);
        check('outside the listings (admin): the form is read again as the Everything view', ['ready', 'empty'].includes(state) && asked.includes('everything') && (await r.page.$$('[data-field]')).length > 0, state + ' ' + JSON.stringify(asked));
        await r.context.close();
        r = await open(browser, Object.assign({}, formBase, { mode: 'outside-listing' }));
        state = await settle(r.page, ['refused', 'ready', 'empty', 'no-access']);
        check('outside the listings (member): the server\'s own reason is shown', /Unauthorized to access this entry/.test(await visibleText(r.page)), state + ' ' + (await visibleText(r.page)).slice(0, 200));
        await r.context.close();
      }
    }

    // h. opened by an activity page's link from the Portals menu, with no activity: it says so
    if (isActivity) {
      r = await open(browser, Object.assign({}, base, { context: null }));
      check('activity page without an activity: the page says to open it from the activity', await settle(r.page, ['outside', 'ready', 'refused']) === 'outside', await stateOf(r.page));
      await r.context.close();
    }
  } catch (error) {
    check('the run completed', false, error.stack || error.message);
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
  finish();
})().catch(error => { console.error(error); server.close(); process.exit(1); });

function finish() {
  const failed = results.filter(x => !x.ok).length;
  console.log('\n' + (results.length - failed) + ' of ' + results.length + ' passed' + (failed ? '' : DEPLOY ? ': ready to publish' : HANDOVER ? ': ready to hand over' : ': ready to try'));
  process.exit(failed ? 1 : 0);
}

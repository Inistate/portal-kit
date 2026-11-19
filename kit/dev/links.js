// The addresses a portal page needs, from its portal.json: the debug link, the address it is uploaded to, and the
// upload command; for a page /portal deploy publishes, the Publish and Versions links, and the address the publish
// answered.
'use strict';

const path = require('path');

// The Inistate servers a page can be tried on. The app address opens the debug card; the API address is the one the
// launch hands the page (both are on the SDK's built-in lists and in the page's content policy).
const SERVERS = {
  production: { app: 'https://app.inistate.com', api: 'https://api.inistate.com', label: 'production (app.inistate.com)' },
  internal: { app: 'https://gneysoftware.apps.inistate.com', api: 'https://gneysoftware.apps.inistate.com', label: 'internal (gneysoftware.apps.inistate.com)' },
  test: { app: 'https://test.apps.inistate.com', api: 'https://test.apps.inistate.com', label: 'test (test.apps.inistate.com)' }
};

function server(spec) {
  const found = SERVERS[spec && spec.server];
  if (!found) throw new Error('portal.json "server" must be production, internal or test (it is "' + (spec && spec.server) + '").');
  return found;
}

// https://<app>/#/portal/debug?ws=&port=[&module=&activity=&entry=]: the workspace admin's Allow card, then the page
// on http://localhost:<port> with their own session. An activity page also names the activity and, for a custom
// activity, the entry; the server binds them to the session (the page never reads them from its address). A menu page
// that an activity opens too has both links: viaActivity asks for the activity's.
function debugLink(spec, port, entryId, viaActivity) {
  const query = [['ws', spec.workspace], ['port', port]];
  if (spec.activity && (spec.kind === 'activity' || viaActivity)) {
    query.push(['module', spec.activity.moduleId], ['activity', spec.activity.activityId]);
    if (entryId) query.push(['entry', entryId]);
  }
  return server(spec).app + '/#/portal/debug?' + query.map(([k, v]) => k + '=' + encodeURIComponent(String(v))).join('&');
}

// A published page's address is the one Inistate answered at publish (the workspace's host, the live version), kept
// in portal.json by /portal deploy; a hand-hosted page's is e.inistate.com/p/<slug>/.
const isPublished = spec => !!(spec && spec.portalId && spec.version && /^https:\/\//.test(String(spec.url || '')));
const portalAddress = spec => (isPublished(spec) ? spec.url : 'https://e.inistate.com/p/' + spec.slug + '/index.html');

function uploadCommand(spec, dir) {
  return 'aws s3 cp "' + path.join(dir, 'index.html') + '" s3://e.inistate.com/p/' + spec.slug + '/index.html'
    + ' --content-type "text/html; charset=utf-8" --cache-control no-store';
}

// The icons Settings › Portals offers (the web app's PORTAL_ICONS in src/components/portals/portalNav.js; keep the two
// lists the same), and who can see a portal there.
const PORTAL_ICONS = ['window-maximize', 'chart-bar', 'chart-line', 'chart-pie', 'table', 'tasks', 'file-alt', 'clipboard',
  'calendar', 'users', 'shopping-bag', 'building', 'map-marked-alt', 'lightbulb'];
const VISIBLE_TO = { everyone: 'everyone', 'workspace admins': 'admins' };
const visibility = spec => VISIBLE_TO[String((spec && spec.visibleTo) || '').trim().toLowerCase()] || null;

const query = pairs => pairs.map(([k, v]) => k + '=' + encodeURIComponent(String(v))).join('&');

// The setup links: Settings › Portals › Add portal filled in, and Studio with the activity's Open with set to
// this portal. A person checks and saves each: nothing is saved from a link.
function addPortalLink(spec) {
  const platforms = spec.platforms || ['web', 'app'];
  return server(spec).app + '/#/settings/portals?' + query([['add', 1], ['ws', spec.workspace], ['name', spec.name],
    ['icon', spec.icon], ['url', portalAddress(spec)], ['visibleTo', visibility(spec) || 'everyone'],
    ['web', platforms.includes('web') ? 1 : 0], ['app', platforms.includes('app') ? 1 : 0]]);
}

function openWithLink(spec) {
  const a = spec.activity;
  if (!a) return null;
  const create = String(a.activityId) === 'create';
  return server(spec).app + '/#/studio?' + query([['id', a.moduleId], ['t', create ? 'standardActivity' : 'activity'],
    ['tid', a.activityId], ['openWith', portalAddress(spec)]]);
}

// /portal deploy: Settings › Portals opens Publish on the folder this PC serves on http://localhost:<port>. The nonce
// rides in the inner fragment, so it is never sent to any server; the page takes it out of the address at once.
function publishLink(spec, port, nonce) {
  return server(spec).app + '/#/settings/portals?' + query([['publish', 1], ['ws', spec.workspace], ['port', port]]) + '#n=' + nonce;
}

// /portal deploy --undo: the portal's versions, where a person presses Restore.
function versionsLink(spec) {
  return server(spec).app + '/#/settings/portals?' + query([['versions', spec.portalId], ['ws', spec.workspace]]);
}

module.exports = { SERVERS, server, debugLink, isPublished, portalAddress, uploadCommand, PORTAL_ICONS, visibility, addPortalLink, openWithLink, publishLink, versionsLink };

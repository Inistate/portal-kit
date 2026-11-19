// /portal handover: checks the page again, says whether the uploaded copy is this file, then prints what the person
// with upload rights needs and the two setup links: Add portal filled in, and Studio's Open with set to the
// portal. It uploads nothing and saves nothing: a person presses Save on each link. It is for a hand-hosted page
// (one file on e.inistate.com/p/<slug>/); a page with its own files, or one published before, goes by /portal deploy.
//
//   node handover.js <slug | folder>
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const links = require('./links');
const folder = require('./folder');

// The uploaded copy: not there yet (a missing S3 object answers 403), this very file, or another one.
function liveCopy(address, file) {
  const mine = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return new Promise(resolve => {
    const request = https.get(address, { headers: { 'Cache-Control': 'no-cache' }, timeout: 15000 }, response => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => {
        if (response.statusCode !== 200) return resolve({ state: 'missing', status: response.statusCode });
        const theirs = crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
        resolve({ state: theirs === mine ? 'same' : 'different' });
      });
    });
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', error => resolve({ state: 'unknown', reason: error.message }));
  });
}

const target = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!target) { console.error('Usage: node handover.js <slug | folder>'); process.exit(2); }
const ROOT = process.env.PORTALS_ROOT || 'D:\\portals';
const DIR = path.resolve(fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.join(ROOT, target));

// A page /portal deploy publishes is not hand-hosted, and a hand-hosted page is one file.
let early = null;
try { early = JSON.parse(fs.readFileSync(path.join(DIR, 'portal.json'), 'utf8')); } catch (e) { early = null; }
if (early && links.isPublished(early)) {
  console.log(early.name + ' is published with /portal deploy (v' + early.version + ' at ' + early.url + '). Run /portal deploy to publish a new version.');
  process.exit(1);
}
const ownFiles = fs.existsSync(DIR) ? folder.folderFiles(DIR).files.filter(f => f.path !== folder.INDEX).map(f => f.path) : [];
if (ownFiles.length) {
  console.log('This page has its own files beside index.html (' + ownFiles.slice(0, 5).join(', ') + (ownFiles.length > 5 ? ', …' : '') + '). A hand-hosted page is one file:'
    + ' publish this folder with /portal deploy instead.');
  process.exit(1);
}

// 1. the checks, as for a try, plus what registering needs
const run = spawnSync(process.execPath, [path.join(__dirname, 'check.js'), DIR, '--handover'], { encoding: 'utf8', env: process.env });
const output = (run.stdout || '') + (run.stderr || '');
const summary = (/(\d+) of (\d+) passed/.exec(output) || [])[0] || 'the checks did not finish';
if (run.status !== 0) {
  process.stdout.write(output);
  console.log('\nNot ready to hand over: ' + summary + '. Fix what failed above, then run /portal handover again.');
  process.exit(1);
}
const spec = JSON.parse(fs.readFileSync(path.join(DIR, 'portal.json'), 'utf8'));
const file = path.join(DIR, 'index.html');
const size = Math.round(fs.statSync(file).size / 1024);
const platforms = (spec.platforms || ['web', 'app']).map(p => (p === 'app' ? 'the mobile app' : p === 'web' ? 'the web' : p)).join(' and ');

const app = links.server(spec).app;

liveCopy(links.portalAddress(spec), file).then(live => {
  const uploaded = {
    same: 'uploaded: the copy at the address is this file.',
    different: 'the copy at the address is NOT this file: upload it again (step 2) before the setup links.',
    missing: 'not uploaded yet (the address answers ' + live.status + '): upload it first (step 2).',
    unknown: 'could not be checked (' + live.reason + '): make sure it is uploaded before the setup links.'
  }[live.state];
  const lines = [
    'Hand-over: ' + spec.name + '  (checks: ' + summary + ')',
    '',
    '1. The file',
    '   ' + file + '   (' + size + ' KB; the only file uploaded. portal.json and shots\\ stay here.)',
    '   Live copy: ' + uploaded,
    '',
    '2. For the person with S3 rights: upload it with exactly this command',
    '   ' + links.uploadCommand(spec, DIR),
    '',
    '3. Then a workspace admin adds it. Open this link signed in to ' + app + ' as an admin of workspace ' + spec.workspace + ':',
    '   ' + links.addPortalLink(spec),
    '   It opens Settings → Portals → Add portal filled in (or the portal already at this address, to edit):',
    '   Name "' + spec.name + '", icon ' + spec.icon + ', address ' + links.portalAddress(spec) + ', seen by ' + spec.visibleTo + ', on ' + platforms + '.',
    '   Check it and press Save. Inistate fetches the page once to find its portal marker, so add it after the upload.'
  ];
  if (spec.kind === 'activity' || spec.activity) {
    const a = spec.activity;
    lines.push('',
      '4. Then the module\'s designer sets the activity to open the page. Open this link (Studio; Open with is for Inistate',
      '   staff while it is in alpha):',
      '   ' + links.openWithLink(spec),
      '   It opens module "' + a.module + '" → activity "' + (a.activity || a.activityId) + '" with Open with: Portal page → "' + spec.name + '".',
      '   Check it and press Save. (Not together with Skip confirmation: choosing the portal clears it.)',
      '   Members get the page from their next click; the standard form opens instead in Run As, demo or guest,',
      '   for several entries at once, or where the portal is not shown to them.');
  }
  lines.push('', 'Nothing has been uploaded or saved. Copy ' + DIR + ' somewhere backed up: Phase 1 keeps pages on this PC only.');
  console.log(lines.join('\n'));
});

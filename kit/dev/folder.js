// A portal folder as Inistate takes it: the files
// that go up, the ones that stay on this PC, and the floor the server checks again. The same rules as the server
// (FETIAS PortalHosting, inistate-api Portals/PortalHosting) and the web app's Upload portal (portalUpload.js), with
// the same reason codes, so check.js says no before /portal deploy offers anything.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The types the server accepts, with the Content-Type it signs into each PUT (and the one check.js and serve.js answer).
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};
const MAX_FILES = 200;
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_PATH = 200;
const INDEX = 'index.html';

// A hosted portal's folder name: 2 to 40 lower-case letters, digits and hyphens, not starting or ending with a hyphen.
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;
const SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;
// The kit's working files, at the folder's top: never part of the page.
const KIT_FILES = ['portal.json'];
const KIT_FOLDERS = ['design', 'shots', 'node_modules'];
const CLUTTER = /^(\.ds_store|thumbs\.db|desktop\.ini)$/i;

const isSlug = value => SLUG.test(String(value || ''));
const extensionOf = p => { const dot = p.lastIndexOf('.'); return dot < 0 ? '' : p.slice(dot).toLowerCase(); };
const typeOf = p => TYPES[extensionOf(String(p || ''))] || null;

/** Null when the server would take this path; else its reason code. */
function pathError(p) {
  p = String(p || '');
  if (!p) return 'path_required';
  if (p.length > MAX_PATH) return 'path_too_long';
  if (p.includes('\\') || p.charAt(0) === '/') return 'path_not_allowed';
  if (p.split('/').some(s => !s || s === '.' || s === '..' || !SEGMENT.test(s))) return 'path_not_allowed';
  return typeOf(p) ? null : 'type_not_allowed';
}

/** Why a path (relative, with /) stays on this PC, or null when it goes up. */
function leftOut(p) {
  const segments = p.split('/');
  const name = segments[segments.length - 1];
  if (segments.length === 1 && KIT_FILES.includes(name.toLowerCase())) return 'kit';
  if (segments.length > 1 && KIT_FOLDERS.includes(segments[0].toLowerCase())) return 'kit';
  if (CLUTTER.test(name)) return 'clutter';
  if (segments.some(s => s.charAt(0) === '.')) return 'hidden';
  return null;
}

/**
 * The folder's files: { files: [{ path, size, abs }], skipped: [{ path, why }] }, paths relative with /, sorted.
 * A link (symbolic or junction) is never followed, so nothing outside the folder is offered.
 */
function folderFiles(dir) {
  const files = [], skipped = [];
  (function walk(abs, rel) {
    fs.readdirSync(abs, { withFileTypes: true }).forEach(item => {
      const p = rel ? rel + '/' + item.name : item.name;
      const full = path.join(abs, item.name);
      if (item.isSymbolicLink()) return skipped.push({ path: p, why: 'link' });
      if (item.isDirectory()) {
        const why = leftOut(p + '/x');
        if (why) return skipped.push({ path: p + '/', why });
        return walk(full, p);
      }
      if (!item.isFile()) return;
      const why = leftOut(p);
      if (why) return skipped.push({ path: p, why });
      files.push({ path: p, size: fs.statSync(full).size, abs: full });
    });
  })(dir, '');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, skipped };
}

/** The server's floor on the list: the first problem as { error, path? }, or null. */
function listProblem(files, limits) {
  const maxFiles = (limits && limits.maxFiles) || MAX_FILES;
  const maxBytes = (limits && limits.maxBytes) || MAX_BYTES;
  if (!files.length) return { error: 'files_required' };
  if (files.length > maxFiles) return { error: 'too_many_files' };
  const seen = new Set();
  let total = 0;
  for (const f of files) {
    const error = pathError(f.path);
    if (error) return { error, path: f.path };
    const key = f.path.toLowerCase();
    if (seen.has(key)) return { error: 'duplicate_path', path: f.path };
    seen.add(key);
    if (!(f.size > 0)) return { error: 'empty_file', path: f.path };
    total += f.size;
  }
  if (!seen.has(INDEX)) return { error: 'index_required', path: INDEX };
  if (total > maxBytes) return { error: 'too_large' };
  return null;
}

const PROBLEMS = {
  files_required: 'The folder has no files to publish',
  too_many_files: 'A portal can have at most ' + MAX_FILES + ' files',
  path_required: 'A file has no path',
  path_too_long: 'A path is longer than ' + MAX_PATH + ' characters',
  path_not_allowed: 'A path Inistate does not take: letters, digits and . _ ~ - only, no spaces, hidden names or ..',
  type_not_allowed: 'A type of file Inistate does not take (it takes ' + Object.keys(TYPES).join(' ') + ')',
  duplicate_path: 'Two files differ only by upper and lower case',
  empty_file: 'An empty file',
  index_required: 'The folder needs an index.html at its top',
  too_large: 'A portal can be at most 100 MB in all'
};
const problemText = p => (PROBLEMS[p.error] || p.error) + (p.path && p.error !== 'index_required' ? ': ' + p.path : '') + '.';

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const sizeText = bytes => (bytes < 1024 ? bytes + ' B' : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1024 / 1024).toFixed(1) + ' MB');

module.exports = { TYPES, MAX_FILES, MAX_BYTES, MAX_PATH, INDEX, isSlug, typeOf, pathError, leftOut, folderFiles, listProblem, problemText, sha256, sizeText };

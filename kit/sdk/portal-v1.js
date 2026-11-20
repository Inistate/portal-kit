/*! Inistate portal SDK v1.2 — docs/integration-portal-link-proposal.md §4.7, §3.8 of
 * docs/integration-portal-claude-design-proposal.md, and §3.3 and §4.3 of docs/integration-portal-dashboard-proposal.md
 * (Inistate SVN trunk).
 *
 * A portal page is a static page on https://e.inistate.com that members open from Inistate (web: a new tab;
 * mobile app: a full-screen web view; the workspace's Dashboard: a frame inside the web app). Inistate hands the page
 * a single-use launch code in the URL fragment; this file swaps it for the page's own, short-lived session and keeps
 * it for this tab only.
 *
 *   const s = await InistatePortal.start();          // null when the page was not opened from Inistate
 *   const res = await s.fetch('/v1/list', { method: 'POST', body: { module: 'Invoices' } });
 *   s.on('ended', reason => showOpenAgain());
 *   if (s.can.openInApp) s.openInApp('/list/812');   // a list or an entry, shown by Inistate itself
 *
 * The session: s.user { id, username }, s.workspace { id }, s.portal { id }, s.context, s.host ('web' | 'app' |
 * 'embed'), s.api, s.app, s.can { camera, download, print, newTab, openInApp }; s.fetch(path, options), s.headers(),
 * s.token(), s.refresh(), s.on('ended' | 'refreshed', fn), s.close(), s.relaunch(), s.done({ entryId }),
 * s.openExternal(url), s.openInApp(path), s.setHostClose(visible), s.end().
 *
 * v1.1:
 *  - s.context is { moduleId, activityId, entryId } when an activity opened the page (bound to the session by the
 *    server, never read from the address), or null for a launch from the Portals menu.
 *  - s.done({ entryId }) ends an activity page: the app closes it; the web closes the tab, or says it can be closed.
 *  - start() also works on a page served from this computer (http://localhost:<port>, http://127.0.0.1:<port>),
 *    which is where a workspace admin's debug launch sends their session. The API addresses accepted are the same.
 *
 * v1.2:
 *  - s.host is 'embed' when the Inistate web app shows the page in a frame of its own (a portal set as the
 *    workspace's Dashboard). The page draws no close of its own there, as in the app. close(), done(), relaunch()
 *    and an ended session never move the frame: they become messages to the app around it. s.can is the web's.
 *    Outside a frame, an 'embed' launch behaves as 'web'; a v1.1 page reads 'embed' as 'web'.
 *  - s.openInApp(path) opens an address of the Inistate app (what follows its '#': '/list/<module id>', an entry's
 *    own address): in a frame the app around it goes there, on the web a new tab opens it. s.can.openInApp is false
 *    in the mobile app, which does not take it yet. A path that is not '/…' is refused (false).
 *  - The messages, { source: 'inistate-portal', v: 1, type, … }: 'ready' (sdk) once start() has a session, or
 *    'failed' (reason) when it has none; then 'close', 'done' (entryId), 'relaunch', 'ended' (reason) when the
 *    session runs out, and 'navigate' (path).
 *
 * Rules this file keeps (do not loosen them in a page):
 *  - The fragment is read and removed from the address before any other script on the page runs (load this
 *    file first, inline, in <head>).
 *  - Only API and app addresses on the built-in lists are accepted; the page's own CSP connect-src is the
 *    second lock.
 *  - Tokens live in memory and in sessionStorage (this tab only), never in localStorage, cookies or URLs.
 *  - In a frame, messages go to the parent only, addressed to the launch's app address (on the built-in list),
 *    never to '*', and carry no token and nothing else of the session.
 *  - Paste this file into the page unchanged; a page never edits the copy it carries.
 */
(function (global) {
  'use strict';

  var VERSION = '1.2';
  var RECORD_VERSION = '1';          // the shape kept in sessionStorage: v1.1 added "context"; v1.2 may keep host 'embed'
  var STORAGE_KEY = 'inistate.portal.session';
  var DEBUG_PORTAL = 'debug';        // the portal id of a debug session (no portal record)
  var DONE_NOTE_ID = 'inistate-portal-done';
  var MESSAGE_SOURCE = 'inistate-portal';   // what every message to the app around a frame says it comes from
  var MESSAGE_VERSION = 1;
  var APP_PATH_MAX = 500;            // the longest address s.openInApp() takes
  var REFRESH_AT = 0.8;              // of the access token's remaining life
  var MIN_REFRESH_DELAY = 5000;
  var RETRY_DELAYS = [5000, 15000, 30000];

  var API_HOSTS = [
    'https://api.inistate.com',
    'https://app02.apps.inistate.com',
    'https://gneysoftware.apps.inistate.com',
    'https://test.apps.inistate.com'
  ];
  var APP_HOSTS = [
    'https://app.inistate.com',
    'https://app02.apps.inistate.com',
    'https://gneysoftware.apps.inistate.com',
    'https://test.apps.inistate.com'
  ];

  // ---- 1. capture and strip the launch fragment, at load time, before anything else runs ----
  var launch = null;
  (function capture() {
    try {
      var hash = global.location.hash || '';
      if (hash.indexOf('plc=') < 0) return;
      var params = {};
      hash.replace(/^#/, '').split('&').forEach(function (pair) {
        var eq = pair.indexOf('=');
        if (eq > 0) {
          try { params[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1)); } catch (e) { /* ignore a bad pair */ }
        }
      });
      if (params.plc) launch = { code: params.plc, api: params.api || '', app: params.app || '', host: params.host || 'web' };
    } catch (e) {
      launch = null;
    }
    try {
      global.history.replaceState(null, '', global.location.pathname + global.location.search);
    } catch (e) {
      // A frame may refuse replaceState; the code is single-use and short-lived either way.
      try { global.location.hash = ''; } catch (e2) { /* nothing more to do */ }
    }
  })();

  function origin(value) {
    try {
      var u = new URL(value);
      return u.protocol + '//' + u.host;
    } catch (e) {
      return null;
    }
  }

  function allowed(value, list) {
    var o = origin(value);
    return !!o && list.indexOf(o) >= 0 ? o : null;
  }

  function decodeJwt(token) {
    try {
      var part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (part.length % 4) part += '=';
      return JSON.parse(decodeURIComponent(Array.prototype.map.call(atob(part), function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join('')));
    } catch (e) {
      return null;
    }
  }

  function readStored() {
    try {
      var raw = global.sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeStored(record) {
    try {
      if (record) global.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record));
      else global.sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) { /* private mode: the session still lives in memory */ }
  }

  function timeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
  }

  function hostBridge(message) {
    try {
      if (global.InistatePortalHost && typeof global.InistatePortalHost.postMessage === 'function') {
        global.InistatePortalHost.postMessage(JSON.stringify(message));
        return true;
      }
    } catch (e) { /* not inside the app */ }
    return false;
  }

  // True when the page runs in a frame (the web app's Dashboard), not as a tab or a web view of its own.
  function framed() {
    try { return !!global.parent && global.parent !== global; } catch (e) { return false; }
  }

  // Where an 'embed' page's messages go: the launch's own app address (already on the built-in list), and only from
  // inside a frame. Anything else is no target, and the page then behaves as on the web.
  function embedTarget(host, app) {
    return host === 'embed' && app && framed() ? app : null;
  }

  // The one way out of a frame: a message to the Inistate app around it. It is addressed to that app's origin, never
  // '*', so the browser drops it if anything else holds the frame; it carries no token and nothing of the session.
  function parentBridge(target, message) {
    if (!target) return false;
    try {
      global.parent.postMessage(Object.assign({ source: MESSAGE_SOURCE, v: MESSAGE_VERSION }, message), target);
      return true;
    } catch (e) {
      return false;
    }
  }

  // An address of the Inistate app for s.openInApp(): what follows the app's '#', so '/…' and at most 500 characters,
  // with no '//' at the start and no backslash, white space or control character anywhere.
  function appPath(path) {
    return typeof path === 'string' && path.length <= APP_PATH_MAX && path.charAt(0) === '/' && path.charAt(1) !== '/'
      && !/[\s\\\u0000-\u001f\u007f-\u009f]/.test(path) ? path : null;
  }

  // After done() on the web, when the browser keeps the tab open: one note over the page, nothing more.
  function showDoneNote() {
    var doc = global.document;
    if (!doc || !doc.body || doc.getElementById(DONE_NOTE_ID)) return;
    var note = doc.createElement('div');
    note.id = DONE_NOTE_ID;
    note.setAttribute('role', 'status');
    note.textContent = api.doneNote || 'You can close this tab.';
    note.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;'
      + 'padding:24px;background:rgba(255,255,255,.97);color:#1f2933;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center';
    doc.body.appendChild(note);
  }

  // ---- 2. the token endpoint ----
  function tokenCall(api, grant) {
    return fetch(api + '/Token', {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(grant)
    }).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
        return { ok: res.ok, status: res.status, body: body };
      });
    });
  }

  // The activity that opened the page: the token answer's portal_context, a JSON string, on the launch and on every
  // refresh. Anything that is not a JSON object is no context.
  function contextFrom(raw) {
    try {
      var value = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (e) {
      return null;
    }
  }

  function recordFrom(answer, base) {
    var body = answer.body || {};
    var access = body.access_token;
    var claims = decodeJwt(access) || {};
    var exp = claims.exp ? claims.exp * 1000
      : (body.access_expires_at ? Date.parse(body.access_expires_at) : Date.now() + (Number(body.expires_in) || 3600) * 1000);
    return {
      v: RECORD_VERSION,
      api: base.api,
      app: base.app,
      host: base.host,
      portalId: body.portal_id || claims['inistate:portal'] || base.portalId || null,
      workspaceId: body.workspace_id || base.workspaceId || null,
      context: body.portal_context !== undefined ? contextFrom(body.portal_context) : (base.context || null),
      sessionEnd: body.session_expires_at ? Date.parse(body.session_expires_at) : (base.sessionEnd || null),
      access: access,
      refresh: body.refresh_token || null,
      exp: exp,
      user: {
        id: claims.nameid || claims.sub || (base.user && base.user.id) || null,
        username: claims.unique_name || claims.name || (base.user && base.user.username) || null
      }
    };
  }

  // ---- 3. the session ----
  function Session(record) {
    this._r = record;
    this._listeners = { ended: [], refreshed: [] };
    this._refreshing = null;
    this._timer = null;
    this._ended = false;
    this._announced = false;           // start() has handed the session to the page (an 'embed' page said 'ready')
    this._parent = embedTarget(record.host, record.app);   // the app around an 'embed' frame, or null
    this.host = record.host === 'app' ? 'app' : this._parent ? 'embed' : 'web';
    this.api = record.api;
    this.app = record.app;
    this.user = record.user;
    this.workspace = { id: record.workspaceId };
    this.portal = { id: record.portalId };
    this.context = record.context || null;
    this.can = this.host === 'app'
      ? { camera: false, download: false, print: false, newTab: false, openInApp: false }
      : { camera: !!(global.navigator && global.navigator.mediaDevices), download: true, print: true, newTab: true, openInApp: !!record.app };
    this._schedule();
  }

  // start() hands this session to the page: in a frame, the app around it hears that the page is ready (once).
  Session.prototype._announce = function () {
    if (this._announced) return;
    this._announced = true;
    parentBridge(this._parent, { type: 'ready', sdk: VERSION });
  };

  Session.prototype.on = function (event, fn) {
    if (this._listeners[event] && typeof fn === 'function') this._listeners[event].push(fn);
    return this;
  };

  Session.prototype._emit = function (event, detail) {
    (this._listeners[event] || []).forEach(function (fn) {
      try { fn(detail); } catch (e) { /* a listener's error is the page's own */ }
    });
  };

  Session.prototype._schedule = function () {
    var self = this;
    if (self._timer) clearTimeout(self._timer);
    if (self._ended || !self._r.refresh) return;
    var remaining = self._r.exp - Date.now();
    var delay = Math.max(MIN_REFRESH_DELAY, Math.floor(remaining * REFRESH_AT));
    self._timer = setTimeout(function () { self.refresh().catch(function () { /* reported through 'ended' */ }); }, delay);
  };

  /** Rotates the refresh token for a fresh access token. One refresh at a time. */
  Session.prototype.refresh = function () {
    var self = this;
    if (self._ended) return Promise.reject(new Error('ended'));
    if (self._refreshing) return self._refreshing;
    if (!self._r.refresh) {
      self._end('no_refresh_token');
      return Promise.reject(new Error('ended'));
    }

    var attempt = 0;
    function once() {
      return tokenCall(self._r.api, self._r.refresh).then(function (answer) {
        if (answer.ok && answer.body && answer.body.access_token) {
          self._r = recordFrom(answer, self._r);
          writeStored(self._r);
          self.user = self._r.user;
          self.context = self._r.context || null;
          self._schedule();
          self._emit('refreshed', { expiresAt: self._r.exp });
          return self._r.access;
        }
        // 400 invalid_grant: the session is over (12 h reached, ended by an admin or a sign-out, or reused).
        self._end('refresh_refused');
        throw new Error('ended');
      }, function (networkError) {
        if (attempt < RETRY_DELAYS.length) {
          var wait = RETRY_DELAYS[attempt++];
          return new Promise(function (resolve) { setTimeout(resolve, wait); }).then(once);
        }
        self._end('unreachable');
        throw networkError;
      });
    }

    self._refreshing = once().then(function (token) {
      self._refreshing = null;
      return token;
    }, function (error) {
      self._refreshing = null;
      throw error;
    });
    return self._refreshing;
  };

  /** A valid access token, refreshed first when it is about to run out. */
  Session.prototype.token = function () {
    if (this._ended) return Promise.reject(new Error('ended'));
    if (this._r.exp - Date.now() < 30000) return this.refresh();
    return Promise.resolve(this._r.access);
  };

  /** The headers every Inistate API call needs (for a page that builds its own request, e.g. an upload). */
  Session.prototype.headers = function () {
    var self = this;
    return self.token().then(function (token) {
      return { Authorization: 'Bearer ' + token, wsId: String(self._r.workspaceId), tz: timeZone() };
    });
  };

  /**
   * fetch() against the Inistate API: path is relative to the API base. A plain-object body is sent as JSON.
   * On a 401 the token is refreshed once and the call retried; an ended session fires 'ended'.
   */
  Session.prototype.fetch = function (path, options) {
    var self = this;
    options = options || {};
    var send = function (retried) {
      return self.headers().then(function (headers) {
        var init = {
          method: options.method || 'GET',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: Object.assign({}, headers, options.headers || {})
        };
        if (options.body !== undefined) {
          if (options.body !== null && typeof options.body === 'object' && !(options.body instanceof FormData)
            && !(options.body instanceof Blob) && !(options.body instanceof URLSearchParams)) {
            init.body = JSON.stringify(options.body);
            init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
          } else {
            init.body = options.body;
          }
        }
        return fetch(self._r.api + path, init);
      }).then(function (res) {
        if (res.status !== 401) return res;
        return res.clone().json().catch(function () { return null; }).then(function (body) {
          if (body && body.error === 'portal_session_ended') {
            self._end('session_ended');
            return res;
          }
          if (retried) return res;
          return self.refresh().then(function () { return send(true); }, function () { return res; });
        });
      });
    };
    return send(false);
  };

  /** Inside the app, hide (false) or show (true) the app's own close button when the page draws its own. */
  Session.prototype.setHostClose = function (visible) {
    if (this.host === 'app') hostBridge({ type: 'hostClose', visible: !!visible });
  };

  /**
   * Closes the portal: the tab on the web, the full-screen page in the app. In a frame the app around it is told
   * ({ type: 'close' }) and the frame stays where it is.
   */
  Session.prototype.close = function () {
    if (this.host === 'app' && hostBridge({ type: 'close' })) return;
    if (this.host === 'embed') {
      parentBridge(this._parent, { type: 'close' });
      return;
    }
    var app = this._r.app;
    try { global.close(); } catch (e) { /* not script-opened */ }
    setTimeout(function () { if (!global.closed && app) global.location.assign(app + '/#/'); }, 300);
  };

  /**
   * Opens the portal again from Inistate (a fresh launch, silent while the app is signed in). A page an activity
   * opened goes back through the same activity, and a debug session through the debug card, on this page's port.
   * In a frame the app around it launches the page again ({ type: 'relaunch' }); the frame itself never moves.
   */
  Session.prototype.relaunch = function () {
    if (this.host === 'app' && hostBridge({ type: 'relaunch' })) return;
    if (this.host === 'embed') {
      parentBridge(this._parent, { type: 'relaunch' });
      return;
    }
    var r = this._r, query = [];
    if (!r.app || !r.portalId) return;
    function add(name, value) { if (value !== undefined && value !== null && value !== '') query.push(name + '=' + encodeURIComponent(String(value))); }
    if (r.portalId === DEBUG_PORTAL || r.context) add('ws', r.workspaceId);
    if (r.portalId === DEBUG_PORTAL) add('port', global.location.port || (global.location.protocol === 'https:' ? '443' : '80'));
    if (r.context) {
      add('module', r.context.moduleId);
      add('activity', r.context.activityId);
      add('entry', r.context.entryId);
    }
    global.location.assign(r.app + '/#/portal/' + encodeURIComponent(r.portalId) + (query.length ? '?' + query.join('&') : ''));
  };

  /**
   * The page's work is done: an activity page calls this after its submit, with the entry it saved. In the app the
   * page then closes (the bridge carries { type: 'done', entryId }, a string or null); on the web the tab closes, and
   * where the browser keeps it open the page says it can be closed. In a frame the app around it is told
   * ({ type: 'done', entryId }), with no tab to close and no note. This tab forgets the session ('ended', 'done').
   */
  Session.prototype.done = function (result) {
    var entryId = result && result.entryId !== undefined && result.entryId !== null && result.entryId !== '' ? String(result.entryId) : null;
    if (this.host === 'app' && hostBridge({ type: 'done', entryId: entryId })) {
      this._end('done');
      return;
    }
    this._end('done');
    if (this.host === 'embed') {
      parentBridge(this._parent, { type: 'done', entryId: entryId });
      return;
    }
    try { global.close(); } catch (e) { /* not script-opened */ }
    setTimeout(function () { if (!global.closed) showDoneNote(); }, 300);
  };

  /** Opens an outside https link (the app sends it to the system browser; a frame opens a new tab, as the web). */
  Session.prototype.openExternal = function (url) {
    if (!/^https:\/\//i.test(String(url))) return;
    if (this.host === 'app' && hostBridge({ type: 'openExternal', url: String(url) })) return;
    global.open(String(url), '_blank', 'noopener');
  };

  /**
   * Opens an address of the Inistate app: path is what follows the app's '#', such as '/list/<module id>' or an
   * entry's own address. In a frame the app around it goes there ({ type: 'navigate', path }); on the web a new tab
   * opens it; the mobile app is told, but does not take it yet (s.can.openInApp is false there, so a page hides such
   * links). Answers true when it was handed on, false (doing nothing) for a path that is not '/…', is longer than 500
   * characters, starts with '//', or holds a backslash, white space or a control character.
   */
  Session.prototype.openInApp = function (path) {
    var to = appPath(path);
    if (!to) return false;
    if (this.host === 'app') return hostBridge({ type: 'navigate', path: to });
    if (this.host === 'embed') return parentBridge(this._parent, { type: 'navigate', path: to });
    if (!this._r.app) return false;
    global.open(this._r.app + '/#' + to, '_blank', 'noopener');
    return true;
  };

  /** Forgets this tab's session (the page's own sign-out). The server session runs out on its own. */
  Session.prototype.end = function () {
    this._end('page_ended');
  };

  Session.prototype._end = function (reason) {
    if (this._ended) return;
    this._ended = true;
    this._endReason = reason;
    if (this._timer) clearTimeout(this._timer);
    writeStored(null);
    this._emit('ended', reason);
    // In a frame the app around it hears that the session ran out (it may launch the page again): not after done(),
    // which says so itself, nor the page's own end(), nor before start() handed the session over (that is 'failed').
    if (this._announced && reason !== 'done' && reason !== 'page_ended') parentBridge(this._parent, { type: 'ended', reason: reason });
  };

  // ---- 4. start ----
  var current = null;

  function start(options) {
    options = options || {};
    if (current && !current._ended) return Promise.resolve(current);
    current = null;
    var apiHosts = API_HOSTS.concat(options.apiHosts || []);
    var appHosts = APP_HOSTS.concat(options.appHosts || []);
    api.lastError = null;

    // No session: the reason in lastError, and in a frame the app around it hears it too.
    function failed(reason, host, app) {
      api.lastError = reason;
      parentBridge(embedTarget(host, app), { type: 'failed', reason: reason });
      return null;
    }
    // A session, handed to the page: in a frame the app around it hears that the page is ready.
    function ready(session) {
      current = session;
      session._announce();
      return session;
    }

    if (launch) {
      var code = launch.code;
      var apiBase = allowed(launch.api, apiHosts);
      var appBase = allowed(launch.app, appHosts) || '';
      var host = launch.host === 'app' || launch.host === 'embed' ? launch.host : 'web';
      launch = null;
      if (!apiBase) return Promise.resolve(failed('api_not_allowed', host, appBase));
      return tokenCall(apiBase, code).then(function (answer) {
        if (!answer.ok || !answer.body || !answer.body.access_token) {
          return failed((answer.body && answer.body.error) || 'exchange_refused', host, appBase);
        }
        var record = recordFrom(answer, { api: apiBase, app: appBase, host: host });
        writeStored(record);
        return ready(new Session(record));
      }, function () {
        return failed('unreachable', host, appBase);
      });
    }

    var stored = readStored();
    var storedApp = stored ? allowed(stored.app, appHosts) || '' : '';
    if (stored && stored.v === RECORD_VERSION && allowed(stored.api, apiHosts)
      && (!stored.sessionEnd || stored.sessionEnd > Date.now())) {
      stored.app = storedApp;
      current = new Session(stored);
      var resumed = current;
      if (stored.exp - Date.now() < 30000) {
        return resumed.refresh().then(function () { return ready(resumed); }, function () {
          current = null;
          return failed(resumed._endReason === 'unreachable' ? 'unreachable' : 'invalid_grant', stored.host, storedApp);
        });
      }
      return Promise.resolve(ready(resumed));
    }

    writeStored(null);
    return Promise.resolve(failed('no_launch', stored && stored.host, storedApp));
  }

  var api = {
    version: VERSION,
    start: start,
    /**
     * Why start() resolved to null: no_launch | api_not_allowed | exchange_refused | invalid_grant | unreachable
     * (invalid_grant and unreachable also for this tab's session when it could not be refreshed). In a frame the app
     * around it hears the same, as { type: 'failed', reason }.
     */
    lastError: null,
    /** The note done() shows on the web when the tab stays open; a page may set it in the reader's language. */
    doneNote: 'You can close this tab.',
    /** True when this page load carried a launch code (before start() spends it). */
    get launching() { return !!launch; }
  };

  global.InistatePortal = api;
})(window);

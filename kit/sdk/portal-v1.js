/*! Inistate portal SDK v1.1 — docs/integration-portal-link-proposal.md §4.7, and §3.8 of
 * docs/integration-portal-claude-design-proposal.md (Inistate SVN trunk).
 *
 * A portal page is a static page on https://e.inistate.com that members open from Inistate (web: a new tab;
 * mobile app: a full-screen web view). Inistate hands the page a single-use launch code in the URL fragment;
 * this file swaps it for the page's own, short-lived session and keeps it for this tab only.
 *
 *   const s = await InistatePortal.start();          // null when the page was not opened from Inistate
 *   const res = await s.fetch('/v1/list', { method: 'POST', body: { module: 'Invoices' } });
 *   s.on('ended', reason => showOpenAgain());
 *
 * v1.1:
 *  - s.context is { moduleId, activityId, entryId } when an activity opened the page (bound to the session by the
 *    server, never read from the address), or null for a launch from the Portals menu.
 *  - s.done({ entryId }) ends an activity page: the app closes it; the web closes the tab, or says it can be closed.
 *  - start() also works on a page served from this computer (http://localhost:<port>, http://127.0.0.1:<port>),
 *    which is where a workspace admin's debug launch sends their session. The API addresses accepted are the same.
 *
 * Rules this file keeps (do not loosen them in a page):
 *  - The fragment is read and removed from the address before any other script on the page runs (load this
 *    file first, inline, in <head>).
 *  - Only API and app addresses on the built-in lists are accepted; the page's own CSP connect-src is the
 *    second lock.
 *  - Tokens live in memory and in sessionStorage (this tab only), never in localStorage, cookies or URLs.
 *  - Paste this file into the page unchanged; a page never edits the copy it carries.
 */
(function (global) {
  'use strict';

  var VERSION = '1.1';
  var RECORD_VERSION = '1';          // the shape kept in sessionStorage; v1.1 only adds "context" to it
  var STORAGE_KEY = 'inistate.portal.session';
  var DEBUG_PORTAL = 'debug';        // the portal id of a debug session (no portal record)
  var DONE_NOTE_ID = 'inistate-portal-done';
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
    this.host = record.host === 'app' ? 'app' : 'web';
    this.api = record.api;
    this.app = record.app;
    this.user = record.user;
    this.workspace = { id: record.workspaceId };
    this.portal = { id: record.portalId };
    this.context = record.context || null;
    this.can = this.host === 'app'
      ? { camera: false, download: false, print: false, newTab: false }
      : { camera: !!(global.navigator && global.navigator.mediaDevices), download: true, print: true, newTab: true };
    this._schedule();
  }

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

  /** Closes the portal: the tab on the web, the full-screen page in the app. */
  Session.prototype.close = function () {
    if (this.host === 'app' && hostBridge({ type: 'close' })) return;
    var app = this._r.app;
    try { global.close(); } catch (e) { /* not script-opened */ }
    setTimeout(function () { if (!global.closed && app) global.location.assign(app + '/#/'); }, 300);
  };

  /**
   * Opens the portal again from Inistate (a fresh launch, silent while the app is signed in). A page an activity
   * opened goes back through the same activity, and a debug session through the debug card, on this page's port.
   */
  Session.prototype.relaunch = function () {
    if (this.host === 'app' && hostBridge({ type: 'relaunch' })) return;
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
   * where the browser keeps it open the page says it can be closed. This tab forgets the session ('ended', 'done').
   */
  Session.prototype.done = function (result) {
    var entryId = result && result.entryId !== undefined && result.entryId !== null && result.entryId !== '' ? String(result.entryId) : null;
    if (this.host === 'app' && hostBridge({ type: 'done', entryId: entryId })) {
      this._end('done');
      return;
    }
    this._end('done');
    try { global.close(); } catch (e) { /* not script-opened */ }
    setTimeout(function () { if (!global.closed) showDoneNote(); }, 300);
  };

  /** Opens an outside https link (the app sends it to the system browser). */
  Session.prototype.openExternal = function (url) {
    if (!/^https:\/\//i.test(String(url))) return;
    if (this.host === 'app' && hostBridge({ type: 'openExternal', url: String(url) })) return;
    global.open(String(url), '_blank', 'noopener');
  };

  /** Forgets this tab's session (the page's own sign-out). The server session runs out on its own. */
  Session.prototype.end = function () {
    this._end('page_ended');
  };

  Session.prototype._end = function (reason) {
    if (this._ended) return;
    this._ended = true;
    if (this._timer) clearTimeout(this._timer);
    writeStored(null);
    this._emit('ended', reason);
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

    if (launch) {
      var code = launch.code;
      var apiBase = allowed(launch.api, apiHosts);
      var appBase = allowed(launch.app, appHosts) || '';
      var host = launch.host === 'app' ? 'app' : 'web';
      launch = null;
      if (!apiBase) {
        api.lastError = 'api_not_allowed';
        return Promise.resolve(null);
      }
      return tokenCall(apiBase, code).then(function (answer) {
        if (!answer.ok || !answer.body || !answer.body.access_token) {
          api.lastError = (answer.body && answer.body.error) || 'exchange_refused';
          return null;
        }
        var record = recordFrom(answer, { api: apiBase, app: appBase, host: host });
        writeStored(record);
        current = new Session(record);
        return current;
      }, function () {
        api.lastError = 'unreachable';
        return null;
      });
    }

    var stored = readStored();
    if (stored && stored.v === RECORD_VERSION && allowed(stored.api, apiHosts)
      && (!stored.sessionEnd || stored.sessionEnd > Date.now())) {
      current = new Session(stored);
      if (stored.exp - Date.now() < 30000) {
        return current.refresh().then(function () { return current; }, function () { current = null; return null; });
      }
      return Promise.resolve(current);
    }

    writeStored(null);
    api.lastError = 'no_launch';
    return Promise.resolve(null);
  }

  var api = {
    version: VERSION,
    start: start,
    /** Why start() resolved to null: no_launch | api_not_allowed | exchange_refused | invalid_grant | unreachable. */
    lastError: null,
    /** The note done() shows on the web when the tab stays open; a page may set it in the reader's language. */
    doneNote: 'You can close this tab.',
    /** True when this page load carried a launch code (before start() spends it). */
    get launching() { return !!launch; }
  };

  global.InistatePortal = api;
})(window);

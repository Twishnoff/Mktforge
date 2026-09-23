/* ==========================================================================
   Mktforge — module kit
   Small shared behaviours the tool modules use, so each one stays a thin
   port of its standalone app:

     accountEmail()                 the signed-in account's email ('' if none)
     accessProblem()                NO_ACCESS when that email can't be used
     accessError(status, message)   NO_ACCESS when a Worker refused the account
     NO_ACCESS                      the message shown in both cases
     seedCompanyUrl(input, memo)    My Company's URL as the default, once per sign-in
     attachPicker(input, pick)      drop-down of My Company values under a text field
     savedMaterials(cfg, opts, say) the account's Imported + Generated Materials for a
                                    Worker request, or null (see assets/js/research.js)
     perCompany(moduleId, opts)     one screen state per company (see below)
     hubspot(companyId?)            read-only HubSpot client for a company (see bottom)

   Everything here only reads My Company data (through MktforgeData) and
   only touches the elements a module passes in.
   ========================================================================== */

window.MktforgeKit = (() => {

  const NO_ACCESS = "Your account doesn't have access to this module. Request access from your administrator.";
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /* ---------- account email ---------- */

  function accountEmail() {
    const a = window.MktforgeAuth;
    const u = a && a.getUser && a.getUser();
    return (u && u.uid !== 'local-preview' && u.email) || '';
  }

  function accessProblem() {
    return EMAIL_RE.test(accountEmail()) ? null : NO_ACCESS;
  }

  /* The Workers answer an unknown or malformed email with 400/403 and a
     message about the email ("not recognized", "approved list", "valid email
     address"). 401/403 also covers a rejected sign-in token. */
  function accessError(status, message) {
    if (status === 401 || status === 403) return NO_ACCESS;
    if (/e-?mail|approved list|not recognized|access/i.test(String(message || ''))) return NO_ACCESS;
    return null;
  }

  /* ---------- Company URL default ----------
     `memo` is an object the module keeps in its own closure (it survives
     switching modules but not a sign-out, which reloads the page).
     The first time the module opens with a My Company URL available, that
     URL is filled in. After that the field is the person's: whatever they
     leave in it, edited or cleared, is what they come back to. */

  function seedCompanyUrl(input, memo) {
    if (!input || memo.seeded) return;
    const markTouched = () => { memo.seeded = true; };
    input.addEventListener('input', (e) => { if (e.isTrusted) markTouched(); });
    if (String(input.value || '').trim()) { markTouched(); return; }
    if (!window.MktforgeData) return;
    window.MktforgeData.getProfile().then((p) => {
      if (memo.seeded || !input.isConnected || !p.companyUrl) return;
      if (String(input.value || '').trim()) { markTouched(); return; }
      input.value = p.companyUrl;
      memo.seeded = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }).catch((err) => console.warn('[Mktforge] profile unavailable for Company URL', err));
  }

  /* ---------- picker ----------
     attachPicker(input, (profile) => profile.targetTitles)
     Focusing or clicking the field opens a list of the My Company values,
     narrowed as the person types. Clicking one fills the field; typing
     anything else is still fine. Arrow keys / Enter / Escape work too. */

  let seq = 0;

  function attachPicker(input, pick) {
    if (!input || input.dataset.picker) return;
    const host = input.parentElement;
    const id = `mf-picker-${++seq}`;
    input.dataset.picker = id;
    host.classList.add('mf-picker-host');

    const list = document.createElement('ul');
    list.className = 'mf-picker';
    list.id = id;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    host.appendChild(list);

    input.setAttribute('autocomplete', 'off');   // no browser history list on top
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', id);

    let all = [];
    let items = [];
    let active = -1;
    let open = false;

    const place = () => {
      list.style.top = `${input.offsetTop + input.offsetHeight + 4}px`;
      list.style.left = `${input.offsetLeft}px`;
      list.style.width = `${input.offsetWidth}px`;
    };

    const paint = () => {
      list.innerHTML = '';
      items.forEach((value, i) => {
        const li = document.createElement('li');
        li.id = `${id}-${i}`;
        li.className = `mf-picker__option${i === active ? ' is-active' : ''}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === active));
        li.dataset.index = String(i);
        li.textContent = value;
        list.appendChild(li);
      });
      const show = open && items.length > 0;
      if (show) place();
      list.hidden = !show;
      input.setAttribute('aria-expanded', String(show));
      if (show && active >= 0) input.setAttribute('aria-activedescendant', `${id}-${active}`);
      else input.removeAttribute('aria-activedescendant');
    };

    const filter = () => {
      const q = input.value.trim().toLowerCase();
      // An exact match (e.g. just picked) still shows everything, so the
      // list stays useful for switching to a different value.
      const exact = all.some((v) => v.toLowerCase() === q);
      items = !q || exact ? all.slice() : all.filter((v) => v.toLowerCase().includes(q));
      active = -1;
      paint();
    };

    const show = async () => {
      open = true;
      try {
        const profile = window.MktforgeData ? await window.MktforgeData.getProfile() : null;
        all = profile ? (pick(profile) || []).filter(Boolean) : [];
      } catch (err) {
        console.warn('[Mktforge] profile unavailable for suggestions', err);
        all = [];
      }
      if (!open || !input.isConnected) return;
      filter();
    };

    const hide = () => { open = false; active = -1; paint(); };

    const choose = (i) => {
      const value = items[i];
      if (value == null) return;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      hide();
      input.focus();
    };

    input.addEventListener('focus', show);
    input.addEventListener('click', () => { if (!open) show(); });
    input.addEventListener('input', () => { if (open) filter(); else show(); });
    input.addEventListener('blur', () => setTimeout(() => {
      if (document.activeElement !== input) hide();
    }, 0));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && (!open || list.hidden)) { e.preventDefault(); show(); return; }
      if (list.hidden) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault(); active = (active + 1) % items.length; paint();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); active = active <= 0 ? items.length - 1 : active - 1; paint();
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault(); choose(active);
      } else if (e.key === 'Escape') {
        e.preventDefault(); hide();
      }
    });
    // mousedown so the choice lands before the field loses focus
    list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('[data-index]');
      if (!li) return;
      e.preventDefault();
      choose(Number(li.dataset.index));
    });
  }

  /* ---------- saved materials ----------
     Only sent when the module's config says its Worker understands them
     (USE_SAVED_MATERIALS). Never blocks a run: if anything goes wrong the
     request goes out without them. */

  async function savedMaterials(cfg, { jobTitles = [], competitorUrl = '', data = null } = {}, say = () => {}) {
    if (!cfg || !cfg.USE_SAVED_MATERIALS || !window.MktforgeResearch) return null;
    let host = '';
    try {
      const v = String(competitorUrl || '').trim();
      if (v) host = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`).hostname.replace(/^www\./, '');
    } catch (e) { host = ''; }
    try {
      const { context, meta } = await window.MktforgeResearch.build(
        { jobTitles, competitorHost: host, data }, { onProgress: say });
      return meta.imported || meta.generated ? context : null;
    } catch (err) {
      console.warn('[Mktforge] continuing without saved materials', err);
      return null;
    }
  }

  /* ---------- one screen per company ----------
     const pc = MktforgeKit.perCompany('persona-builder', {
       create:   () => ({ form: {...}, persona: null, status: '', error: '', running: false }),
       held:     ['form'],               // typed-but-unsaved input, kept per tab
       snapshot: ['persona', 'status']   // what a cancelled run puts back
     });
     let state = pc.state;  pc.bind((st) => { state = st; });

     A run:
       const st = state;  const runId = pc.begin(st);   // st.controller.signal for fetch
       ... after every await:  if (!pc.live(st, runId)) return;
       ... finally:            if (!pc.end(st, runId)) return;

     Switching company cancels the old company's run: its request is aborted,
     its screen goes back to what it showed before the run, and it says
     "Run stopped when you switched companies. Run it again." A run cut off
     by a refresh, a closed tab or signing out shows, on return, the red
     light and "This run was interrupted. Run it again." */

  const STOPPED = 'Run stopped when you switched companies. Run it again.';
  const INTERRUPTED = 'This run was interrupted. Run it again.';
  const STALE_MS = 3 * 60 * 1000;     // a run flag not refreshed for this long is dead
  const BEAT_MS = 30 * 1000;
  const instances = [];
  const owned = new Set();            // run flags this tab is keeping alive

  /* A refresh or a closed tab aborts the run's request, and the run's own
     error handling fires on the way out. It must not tidy away the flag
     that says "this run was interrupted". */
  let leaving = false;
  window.addEventListener('beforeunload', () => {
    leaving = true;
    setTimeout(() => { leaving = false; }, 2000);   // only runs if the page stayed (unload cancelled)
  });
  window.addEventListener('pagehide', () => { leaving = true; });
  window.addEventListener('pageshow', () => { leaving = false; });   // back from the cache, or unload cancelled

  /* A flag written by this tab counts as interrupted only when this page
     load IS a refresh of that tab. A duplicated tab copies the tab id but
     arrives by navigation, so it waits for the flag to go stale instead. */
  const refreshed = (() => {
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      return !!nav && nav.type === 'reload';
    } catch (e) { return false; }
  })();

  function tabId() {
    try {
      let t = sessionStorage.getItem('mktforge.tab');
      if (!t) { t = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('mktforge.tab', t); }
      return t;
    } catch (e) { return 'notab'; }
  }
  function uid() {
    const a = window.MktforgeAuth;
    const u = a && a.getUser && a.getUser();
    return (u && u.uid) || 'anon';
  }
  const pack = (v) => (v instanceof Set ? { __set: [...v] } : v);
  const unpack = (v) => (v && typeof v === 'object' && Array.isArray(v.__set) ? new Set(v.__set) : v);
  const plain = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Set);

  setInterval(() => {
    owned.forEach((key) => {
      try {
        const f = JSON.parse(localStorage.getItem(key) || 'null');
        if (f && f.tab === tabId()) localStorage.setItem(key, JSON.stringify({ ...f, beat: Date.now() }));
        else owned.delete(key);
      } catch (e) { /* storage unavailable */ }
    });
  }, BEAT_MS);

  /* onLeave(st): for modules whose work doesn't fit one run at a time
     (several boxes, or Draft Answer rows) — called with the old company's
     state on every switch, to stop whatever it has going. Use flagOn/flagOff
     around each piece of work so a refresh mid-way is reported. */
  function perCompany(moduleId, { create, held = [], snapshot = [], onLeave = null }) {
    const states = new Map();
    const binders = [];
    let currentId = null;
    let current = null;
    let placeholder = null;

    const heldKey = (cid) => `mktforge.held.${cid}.${moduleId}`;
    const runKey = (cid) => `mktforge.run.${uid()}.${cid}.${moduleId}`;

    function saveHeld(st) {
      if (!st || !st._cid) return;
      const out = {};
      held.forEach((k) => { out[k] = pack(st[k]); });
      if (st.note) out.note = st.note;
      try { sessionStorage.setItem(heldKey(st._cid), JSON.stringify(out)); } catch (e) { /* full or blocked */ }
    }

    function load(cid) {
      if (states.has(cid)) return states.get(cid);
      const st = create();
      st._cid = cid;
      st._run = 0;
      st._flags = 0;
      try {
        const saved = JSON.parse(sessionStorage.getItem(heldKey(cid)) || 'null');
        if (saved) {
          held.forEach((k) => {
            if (saved[k] === undefined) return;
            const v = unpack(saved[k]);
            st[k] = plain(st[k]) && plain(v) ? { ...st[k], ...v } : v;
          });
          if (saved.note) st.note = saved.note;
        }
      } catch (e) { /* nothing held */ }
      try {
        const f = JSON.parse(localStorage.getItem(runKey(cid)) || 'null');
        if (f && ((refreshed && f.tab === tabId()) || Date.now() - (f.beat || 0) > STALE_MS)) {
          localStorage.removeItem(runKey(cid));
          st.error = INTERRUPTED;
          st._interrupted = true;
        }
      } catch (e) { /* no flag */ }
      states.set(cid, st);
      return st;
    }

    function clearFlag(cid) {
      try { localStorage.removeItem(runKey(cid)); } catch (e) { /* none */ }
      owned.delete(runKey(cid));
    }

    /* The "a run is going" flag is on while ANY work in this module is going
       for this company; it comes off when the last piece finishes. */
    function flagOn(st) {
      if (!st || !st._cid) return;
      st._flags = (st._flags || 0) + 1;
      if (st._flags > 1) return;
      try {
        localStorage.setItem(runKey(st._cid), JSON.stringify({ tab: tabId(), beat: Date.now() }));
        owned.add(runKey(st._cid));
      } catch (e) { /* storage unavailable: no interrupted notice */ }
    }
    function flagOff(st) {
      if (!st || !st._cid) return;
      st._flags = Math.max(0, (st._flags || 0) - 1);
      if (!st._flags && !leaving) clearFlag(st._cid);   // while unloading it stays: that's the notice
    }

    function cancel(st) {
      if (!st || !st.running) return;
      st._run += 1;                                   // any late answer is ignored
      if (st.controller) { try { st.controller.abort(); } catch (e) { /* already done */ } }
      st.controller = null;
      if (st.prev) Object.assign(st, st.prev);
      st.prev = null;
      st.running = false;
      st.error = '';
      st.note = STOPPED;
      st._flags = Math.max(0, (st._flags || 0) - 1);
      if (!st._flags) clearFlag(st._cid);
      saveHeld(st);                                    // so the note outlives a reload
    }

    document.addEventListener('mktforge:company-switched', (e) => {
      const { from, to } = e.detail || {};
      if (from && states.has(from)) {
        const old = states.get(from);
        cancel(old);
        if (onLeave) { try { onLeave(old); } catch (err) { console.error(err); } }
        if (!old._flags) clearFlag(from);
      }
      if (!to) return;
      currentId = to;
      current = load(to);
      binders.forEach((fn) => { try { fn(current); } catch (err) { console.error(err); } });
    });

    const api = {
      get state() {
        if (current) return current;
        if (!placeholder) { placeholder = create(); placeholder._run = 0; }
        return placeholder;
      },
      get companyId() { return currentId; },
      of(cid) { return cid ? load(cid) : null; },
      flagOn, flagOff,
      bind(fn) { binders.push(fn); if (current) fn(current); },
      /* Called with no argument from the module's typing handlers: the
         person has moved on, so a "Run stopped…" note is dropped too. */
      hold(st) {
        const t = st || current;
        if (!t) return;
        if (!st) t.note = '';
        saveHeld(t);
      },

      begin(st) {
        if (st.controller) { try { st.controller.abort(); } catch (e) { /* superseded */ } }
        st._run += 1;
        st.prev = {};
        snapshot.forEach((k) => { st.prev[k] = st[k]; });
        const again = !!st.controller;                  // superseding its own earlier run
        st.controller = new AbortController();
        st.note = '';
        st._interrupted = false;
        if (!again || !st.running) flagOn(st);
        if (st._cid) saveHeld(st);
        return st._run;
      },
      live(st, id) { return st._run === id; },
      end(st, id) {
        if (st._run !== id) return false;
        st.prev = null;
        st.controller = null;
        flagOff(st);          // (kept while the page unloads: that's the "interrupted" notice)
        return true;
      },

      // The shell has settled the company and cleared the lights: show red
      // for a run this company lost to a refresh or a closed tab.
      _ready() {
        if (current && current._interrupted) {
          current._interrupted = false;
          if (window.Mktforge) {
            window.Mktforge.reportActivity(moduleId, 'running');
            window.Mktforge.reportActivity(moduleId, 'error');
          }
        }
      }
    };
    instances.push(api);
    return api;
  }

  document.addEventListener('mktforge:company-ready', () => instances.forEach((i) => i._ready()));

  /* ---------- HubSpot (read-only) ----------
     One connection per Mktforge company, held by the hubspot-connect Worker.
     Every call sends the sign-in token and the company id; the Worker looks
     up that company's HubSpot token itself.

       const hs = MktforgeKit.hubspot();            // the active company
       await hs.status()      -> { connected, needsReconnect, portalId, portalDomain, scopes, connectedAt }
       await hs.connect({ returnTo })  sends the browser to HubSpot's approval screen
       await hs.disconnect()
       await hs.call('/api/…', body, { signal })   data endpoints, e.g. /api/read/contact-search

     Failures throw an Error whose .code is the Worker's error ('not_connected',
     'reconnect_needed', 'not_approved', …) and whose .message is safe to show. */

  class HubSpotError extends Error {
    constructor(message, code, status) { super(message); this.code = code; this.status = status; }
  }

  function hubspot(companyId) {
    const cfg = (window.MKTFORGE_CONFIG || {}).hubspot || {};
    const base = String(cfg.API_BASE_URL || '').replace(/\/+$/, '');
    const cid = () => companyId || (window.MktforgeData && window.MktforgeData.activeCompanyId) || null;

    async function request(method, path, { body, query, signal, keepalive } = {}) {
      if (!base) throw new HubSpotError('HubSpot isn’t set up for Mktforge yet.', 'not_configured', 0);
      const id = cid();
      if (!id) throw new HubSpotError('No company is selected.', 'bad_company', 0);
      const a = window.MktforgeAuth;
      const token = a && a.getIdToken ? await a.getIdToken() : null;
      if (!token) throw new HubSpotError('Sign in to use HubSpot.', 'unauthenticated', 401);

      const url = new URL(base + path);
      if (query) Object.entries({ companyId: id, ...query }).forEach(([k, v]) => url.searchParams.set(k, v));
      const init = { method, headers: { Authorization: `Bearer ${token}` }, signal, keepalive: !!keepalive };
      if (method !== 'GET') {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify({ companyId: id, ...(body || {}) });
      }

      let res;
      try { res = await fetch(url.toString(), init); } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        throw new HubSpotError('Couldn’t reach the HubSpot connection. Check your internet and try again.', 'network', 0);
      }
      let data = {};
      try { data = await res.json(); } catch (e) { /* empty body */ }
      if (!res.ok) {
        const msg = data.message
          || (res.status === 401 || res.status === 403 ? NO_ACCESS : 'Something went wrong with the HubSpot connection.');
        throw new HubSpotError(msg, data.error || `http_${res.status}`, res.status);
      }
      return data;
    }

    return {
      get companyId() { return cid(); },
      status: (opts) => request('GET', '/status', { query: {}, ...opts }),
      /* returnTo: the module to come back to after HubSpot's approval screen
         ('my-company' by default; the Worker only accepts modules it knows). */
      async connect({ returnTo } = {}) {
        const { url } = await request('POST', '/oauth/start', { body: returnTo ? { returnTo } : undefined });
        if (!url) throw new HubSpotError('HubSpot didn’t return an approval link.', 'no_url', 0);
        window.location.assign(url);
      },
      disconnect: (opts = {}) => request('POST', '/disconnect', opts),   // { keepalive } survives a page reload
      call: (path, body, opts = {}) => request('POST', path, { body, ...opts })
    };
  }

  return { NO_ACCESS, accountEmail, accessProblem, accessError, seedCompanyUrl, attachPicker, savedMaterials,
           perCompany, STOPPED, INTERRUPTED, hubspot, HubSpotError };
})();

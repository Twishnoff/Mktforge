/* ==========================================================================
   Mktforge — shell
   Owns the frame (nav, management bar, display field) and the module
   registry. It knows nothing about what any module does.

   MODULE CONTRACT
   ---------------
   A module is a folder under /modules that loads one script and calls:

     Mktforge.register({
       id:     'my-company',                        // unique; also the URL hash
       label:  'My Company',                        // nav button text
       icon:   'factory',                           // key in MktforgeIcons
       styles: 'modules/my-company/my-company.css', // optional, loaded on demand
       mount(container)   { ... },                // build your UI inside it
       unmount(container) { ... }                 // optional cleanup
     });

   Background-run lights (optional):
     Mktforge.reportActivity('module-id', 'running')   when a run starts
     Mktforge.reportActivity('module-id', 'idle')      when it finishes successfully
     Mktforge.reportActivity('module-id', 'error')     when it finishes with an error
   The shell shows a slow-blinking yellow dot next to a module that is running
   while you're somewhere else, and a solid green (or red, for an error) one
   once it has finished while you were away. All clear when you open that module.

   Rules that keep a future port to a framework cheap:
     - a module only ever touches the container element it is handed
     - a module never reads or writes the shell's DOM or globals
     - anything a module needs from the shell comes in through mount()
   ========================================================================== */

window.Mktforge = (() => {

  const modules = [];
  const scrollMemory = new Map();
  const activity = new Map();   // id -> { running, unseen, failed }
  let activeId = null;
  let booted = false;

  /* ---------- Registry ---------- */

  function register(mod) {
    if (!mod || !mod.id || typeof mod.mount !== 'function') {
      console.error('[Mktforge] register() needs at least { id, mount }', mod);
      return;
    }
    if (modules.some(m => m.id === mod.id)) {
      console.warn(`[Mktforge] a module with id "${mod.id}" is already registered`);
      return;
    }
    modules.push({ icon: 'grid', label: mod.id, ...mod, _stylesLoaded: false });
    if (booted) { renderNav(); route(); }   // allows lazy registration later
  }

  /* ---------- Lazy script loading ----------
     Lets a module pull in a heavy third-party library only when it is
     actually opened, instead of putting it in the initial page load.
     Uses a <script> tag rather than fetch/import so it also works when the
     project is opened straight off disk. */

  const scriptCache = new Map();

  function loadScript(src, opts = {}) {
    if (scriptCache.has(src)) return scriptCache.get(src);

    const { async = true, attrs = {} } = opts;

    const p = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      // Some third-party scripts refuse to initialize if the tag carries
      // async/defer — Cloudflare Turnstile is one — so this is opt-out.
      el.async = async;
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
      el.onload = () => resolve(src);
      el.onerror = () => {
        scriptCache.delete(src);
        reject(new Error(`[Mktforge] failed to load ${src}`));
      };
      document.head.appendChild(el);
    });

    scriptCache.set(src, p);
    return p;
  }

  /* ---------- Navigation bar ---------- */

  function renderNav() {
    const list = document.getElementById('nav-list');
    list.innerHTML = '';

    modules.forEach(mod => {
      const li = document.createElement('li');
      li.className = 'nav__item';

      const btn = document.createElement('button');
      btn.className = 'nav__button';
      btn.type = 'button';
      btn.dataset.moduleId = mod.id;
      btn.dataset.label = mod.label;          // used as the collapsed tooltip
      btn.innerHTML =
        `<span class="nav__icon">${window.MktforgeIcons[mod.icon] || window.MktforgeIcons.grid}</span>` +
        `<span class="nav__label">${mod.label}</span>` +
        `<span class="nav__status" aria-hidden="true"></span>` +
        `<span class="nav__status-text"></span>`;
      btn.addEventListener('click', () => { location.hash = `#/${mod.id}`; });

      li.appendChild(btn);
      list.appendChild(li);
    });

    markActive();
  }

  function markActive() {
    document.querySelectorAll('.nav__button').forEach(btn => {
      if (btn.dataset.moduleId === activeId) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    renderLights();
  }

  /* ---------- Background-run lights ----------
     Only ever shown next to a module you are NOT looking at:
       running                  -> blinking yellow
       finished OK, unseen      -> solid green (until you open it)
       finished with an error   -> solid red (until you open it)
     A run that starts and ends while you stay on the module shows nothing. */

  function reportActivity(id, status) {
    const a = activity.get(id) || { running: false, unseen: false, failed: false };
    if (status === 'running') {
      a.running = true;
      a.unseen = false;
      a.failed = false;
    } else if (a.running) {
      a.running = false;
      a.failed = status === 'error';
      a.unseen = id !== activeId;     // finished while you were elsewhere
    }
    activity.set(id, a);
    renderLights();
  }

  function renderLights() {
    document.querySelectorAll('.nav__button').forEach(btn => {
      const id = btn.dataset.moduleId;
      const mod = modules.find(m => m.id === id);
      const a = activity.get(id);
      let light = '';
      if (a && id !== activeId) {
        light = a.running ? 'running' : !a.unseen ? '' : a.failed ? 'error' : 'done';
      }
      const status = btn.querySelector('.nav__status');
      const text = btn.querySelector('.nav__status-text');
      if (!status) return;
      status.dataset.state = light;
      const words = {
        running: 'Running…',
        done:    'Finished — results ready',
        error:   'Stopped with an error'
      }[light] || '';
      text.textContent = words ? ` (${words})` : '';
      btn.dataset.label = mod ? (words ? `${mod.label} · ${words}` : mod.label) : btn.dataset.label;
    });
  }

  /* ---------- Nav minimize / restore ---------- */

  const NAV_KEY = 'mktforge.nav';

  function setNavCollapsed(collapsed) {
    document.body.dataset.nav = collapsed ? 'collapsed' : 'expanded';
    const btn = document.getElementById('nav-minimize');
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Minimize navigation');
    btn.title = collapsed ? 'Expand navigation' : 'Minimize navigation';
    try { localStorage.setItem(NAV_KEY, collapsed ? 'collapsed' : 'expanded'); } catch (e) {}
  }

  function initNavToggle() {
    let saved = 'expanded';
    try { saved = localStorage.getItem(NAV_KEY) || 'expanded'; } catch (e) {}
    setNavCollapsed(saved === 'collapsed');

    document.getElementById('nav-minimize').addEventListener('click', () => {
      setNavCollapsed(document.body.dataset.nav !== 'collapsed');
    });
  }

  /* ---------- Management bar: profile ---------- */

  function renderProfile() {
    // getUser() is null in the instant between signing out and the redirect,
    // so nothing here may assume there is an account.
    const user = window.MktforgeAuth.getUser();
    document.getElementById('profile-name').textContent =
      window.MktforgeAuth.getDisplayName() || '';

    const avatar = document.getElementById('profile-avatar');
    avatar.innerHTML = (user && user.avatar)
      ? `<img src="${user.avatar}" alt="">`
      : window.MktforgeIcons.user;
  }

  function initProfileMenu() {
    const button = document.getElementById('profile-button');
    const menu   = document.getElementById('profile-menu');

    const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
    const open  = () => { menu.hidden = false; button.setAttribute('aria-expanded', 'true'); };

    button.addEventListener('click', e => {
      e.stopPropagation();
      menu.hidden ? open() : close();
    });

    document.addEventListener('click', e => {
      if (!menu.hidden && !menu.contains(e.target)) close();
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !menu.hidden) { close(); button.focus(); }
    });

    document.getElementById('sign-out').addEventListener('click', async () => {
      close();
      try {
        await window.MktforgeAuth.signOut();     // ends the session, then
      } catch (err) {                            // sends them to the login page
        console.error(err);
        window.location.href = window.MktforgeAuth.config.loginPage;
      }
    });

    document.addEventListener('mktforge:user-changed', renderProfile);
  }

  /* ---------- Notices ----------
     Anything can raise a short message without touching the shell's DOM:
     document.dispatchEvent(new CustomEvent('mktforge:notify',
       { detail: { message, tone: 'info' | 'error' } })) */

  function initNotices() {
    const host = document.createElement('div');
    host.className = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);

    document.addEventListener('mktforge:notify', (e) => {
      const { message, tone } = e.detail || {};
      if (!message) return;
      const t = document.createElement('div');
      t.className = `toast${tone === 'error' ? ' toast--error' : ''}`;
      t.textContent = message;
      host.appendChild(t);
      requestAnimationFrame(() => t.classList.add('is-in'));
      setTimeout(() => {
        t.classList.remove('is-in');
        setTimeout(() => t.remove(), 300);
      }, tone === 'error' ? 7000 : 4000);
    });
  }

  /* ---------- Display field ---------- */

  function ensureStyles(mod) {
    if (!mod.styles || mod._stylesLoaded) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = mod.styles;
    link.dataset.module = mod.id;
    document.head.appendChild(link);
    mod._stylesLoaded = true;
  }

  function show(id) {
    if (id === activeId) return;

    const display = document.getElementById('display');
    const mount   = document.getElementById('display-mount');
    const next    = modules.find(m => m.id === id);
    if (!next) return;

    // tear down whatever is on screen
    const current = modules.find(m => m.id === activeId);
    if (current) {
      scrollMemory.set(current.id, display.scrollTop);
      if (typeof current.unmount === 'function') {
        try { current.unmount(mount); } catch (e) { console.error(`[Mktforge] ${current.id} unmount failed`, e); }
      }
    }
    mount.innerHTML = '';

    // bring up the new one
    ensureStyles(next);
    activeId = next.id;
    document.title = `${next.label} · Mktforge`;

    try {
      next.mount(mount);
    } catch (e) {
      console.error(`[Mktforge] ${next.id} mount failed`, e);
      mount.innerHTML = `<div style="padding:40px;font-family:var(--font-mono);color:#A8371F">
        Module "${next.id}" failed to load. See the console.</div>`;
    }

    display.scrollTop = scrollMemory.get(next.id) || 0;
    const seen = activity.get(next.id);
    if (seen) seen.unseen = false;      // opening the module counts as checking it
    markActive();
  }

  /* ---------- Routing ----------
     Hash routing on purpose: GitHub Pages serves static files, so a real
     path like /my-company would 404 on refresh or on a shared link. */

  function route() {
    const id = (location.hash || '').replace(/^#\/?/, '');
    const target = modules.find(m => m.id === id) || modules[0];
    if (!target) return;
    if (!id || id !== target.id) history.replaceState(null, '', `#/${target.id}`);
    show(target.id);
  }

  /* ---------- Boot ---------- */

  async function boot() {
    // Gate first: requireAuth() redirects to the login page when there is no
    // usable session, so nothing below runs for a signed-out visitor. This is
    // a convenience, NOT a security boundary — see the note in auth.js.
    const user = await window.MktforgeAuth.requireAuth();
    if (!user) return;                    // redirecting; don't paint the shell

    document.body.dataset.auth = 'ready';

    initNavToggle();
    initNotices();
    renderProfile();
    initProfileMenu();
    renderNav();
    window.addEventListener('hashchange', route);
    route();
    booted = true;

    if (!modules.length) {
      document.getElementById('display-mount').innerHTML =
        `<div style="padding:48px;color:#7A7565">No modules registered yet.</div>`;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    boot().catch((err) => {
      console.error('[Mktforge] boot failed', err);
      document.body.dataset.auth = 'ready';
      document.getElementById('display-mount').innerHTML =
        `<div style="padding:48px;color:#A8371F">Couldn't start the app — see the browser console.</div>`;
    });
  });

  return {
    register,
    loadScript,
    reportActivity,
    get modules() { return modules.slice(); },
    get activeId() { return activeId; },
    go(id) { location.hash = `#/${id}`; }
  };
})();

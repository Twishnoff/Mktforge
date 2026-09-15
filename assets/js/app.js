/* ==========================================================================
   Mktforge — shell
   Owns the frame (nav, management bar, display field) and the module
   registry. It knows nothing about what any module does.

   MODULE CONTRACT
   ---------------
   A module is a folder under /modules that loads one script and calls:

     Mktforge.register({
       id:     'module-1',                        // unique; also the URL hash
       label:  'Module 1',                        // nav button text
       icon:   'user',                            // key in MktforgeIcons
       styles: 'modules/module-1/module-1.css',   // optional, loaded on demand
       mount(container)   { ... },                // build your UI inside it
       unmount(container) { ... }                 // optional cleanup
     });

   Rules that keep a future port to a framework cheap:
     - a module only ever touches the container element it is handed
     - a module never reads or writes the shell's DOM or globals
     - anything a module needs from the shell comes in through mount()
   ========================================================================== */

window.Mktforge = (() => {

  const modules = [];
  const scrollMemory = new Map();
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
        `<span class="nav__label">${mod.label}</span>`;
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
    const user = window.MktforgeAuth.getUser();
    document.getElementById('profile-name').textContent = window.MktforgeAuth.getDisplayName();

    const avatar = document.getElementById('profile-avatar');
    avatar.innerHTML = user.avatar
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

    document.getElementById('sign-out').addEventListener('click', () => {
      close();
      window.MktforgeAuth.signOut();
    });

    document.addEventListener('mktforge:user-changed', renderProfile);
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
    markActive();
  }

  /* ---------- Routing ----------
     Hash routing on purpose: GitHub Pages serves static files, so a real
     path like /module-1 would 404 on refresh or on a shared link. */

  function route() {
    const id = (location.hash || '').replace(/^#\/?/, '');
    const target = modules.find(m => m.id === id) || modules[0];
    if (!target) return;
    if (!id || id !== target.id) history.replaceState(null, '', `#/${target.id}`);
    show(target.id);
  }

  /* ---------- Boot ---------- */

  function boot() {
    initNavToggle();
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

  document.addEventListener('DOMContentLoaded', boot);

  return {
    register,
    loadScript,
    get modules() { return modules.slice(); },
    get activeId() { return activeId; },
    go(id) { location.hash = `#/${id}`; }
  };
})();

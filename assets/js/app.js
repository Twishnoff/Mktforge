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
       hidden: false,                             // true = routable, but no nav button
       mount(container)   { ... },                // build your UI inside it
       unmount(container) { ... }                 // optional cleanup
     });

   A hidden module still has a #/id of its own and still mounts into the
   display field; it just isn't one of the things the nav offers. Manage
   Profile, reached from the management bar's account menu, is one.

   Background-run lights (optional):
     Mktforge.reportActivity('module-id', 'running')   when a run starts
     Mktforge.reportActivity('module-id', 'idle')      when it finishes successfully
     Mktforge.reportActivity('module-id', 'error')     when it finishes with an error
   The shell shows a slow-blinking yellow dot next to a module that is running,
   and a solid green (or red, for an error) one once it has finished — on the
   module you're looking at as well as the ones you aren't. A finished light
   clears when you open that module, or, if you're already on it, on your next
   click, key press or scroll. The browser tab carries the same light on its
   icon, summed over every module: yellow while anything is running, then green
   (red if something failed) until you've seen the results.

   Rules that keep a future port to a framework cheap:
     - a module only ever touches the container element it is handed
     - a module never reads or writes the shell's DOM or globals
     - anything a module needs from the shell comes in through mount()
   ========================================================================== */

window.Mktforge = (() => {

  const modules = [];
  const scrollMemory = new Map();   // id -> where you left off, for nav-bar returns
  let restoreScroll = false;        // set only by a nav-bar button click
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

    modules.filter(mod => !mod.hidden).forEach(mod => {
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
      btn.addEventListener('click', () => goTo(mod.id, { restore: true }));

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
     Shown next to every module, including the one you're looking at:
       running                  -> blinking yellow
       finished OK, unseen      -> solid green
       finished with an error   -> solid red
     A finished light means "there's a result here you haven't looked at". It
     clears when you open that module — or, when you're already on it, on your
     next click, key press or scroll, since by then you've seen it. */

  function reportActivity(id, status) {
    const a = activity.get(id) || { running: false, unseen: false, failed: false };
    if (status === 'running') {
      a.running = true;
      a.unseen = false;
      a.failed = false;
    } else if (a.running) {
      a.running = false;
      a.failed = status === 'error';
      a.unseen = true;                // wherever you are; see ackActive() below
    }
    activity.set(id, a);
    renderLights();
  }

  /* The finished light on the module you're on clears itself on your next
     click, key press or scroll — the same "seen it" signal that opening a
     module gives for a run that finished while you were elsewhere. The
     listeners only exist while there is such a light to clear. */

  const ACK_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
  let ackOn = false;

  function ackActive() {
    const a = activity.get(activeId);
    if (!a || !a.unseen) return;
    a.unseen = false;
    renderLights();                   // detaches these listeners again
  }

  function watchAck(on) {
    if (on === ackOn) return;
    ackOn = on;
    ACK_EVENTS.forEach(type => {
      if (on) window.addEventListener(type, ackActive, { passive: true, capture: true });
      else window.removeEventListener(type, ackActive, { capture: true });
    });
    // `scroll` doesn't bubble, so the display field needs its own listener.
    const display = document.getElementById('display');
    if (!display) return;
    if (on) display.addEventListener('scroll', ackActive, { passive: true });
    else display.removeEventListener('scroll', ackActive);
  }

  function renderLights() {
    document.querySelectorAll('.nav__button').forEach(btn => {
      const id = btn.dataset.moduleId;
      const mod = modules.find(m => m.id === id);
      const a = activity.get(id);
      let light = '';
      if (a) {
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
    const here = activity.get(activeId);
    watchAck(!!(here && here.unseen));
    renderTabLight();
  }

  /* ---------- Tab icon light ----------
     One light for the whole app, on the browser tab: yellow while any module
     is running, then green once everything has finished (red if a run failed),
     until every finished result has been seen.

     The mark's own green square becomes the status dot rather than carrying a
     little badge in the corner — a corner badge is barely readable at the 16px
     a tab actually gets, and a green badge on the green square especially so.
     Drawn as a data-URI SVG, so it needs no fetch and no canvas and works off
     disk too. Keep the squares in step with assets/img/favicon.svg. */

  const FAVICON_HREF = 'assets/img/favicon.svg';
  const TAB_COLORS = { running: '#E3A21A', done: '#2E9B57', error: '#C8412A' };
  let tabLight = null;

  function litFavicon(color) {
    const square = (x, y) => `<rect x="${x}" y="${y}" width="116" height="116" rx="12" fill="#20242B"/>`;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-30 -30 312 312">'
      + '<rect x="-30" y="-30" width="312" height="312" rx="48" fill="#F6F1E6"/>'
      + square(0, 0) + square(136, 0) + square(0, 136)
      + `<circle cx="194" cy="194" r="58" fill="${color}"/></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  function tabState() {
    let running = false;
    let unseen = false;
    let failed = false;
    activity.forEach(a => {
      if (a.running) running = true;
      if (a.unseen) { unseen = true; if (a.failed) failed = true; }
    });
    if (running) return 'running';        // anything still going wins
    return unseen ? (failed ? 'error' : 'done') : '';
  }

  function renderTabLight() {
    const light = tabState();
    if (light === tabLight) return;
    tabLight = light;
    // Replacing the element is the reliable way to get a tab icon to repaint.
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href = light ? litFavicon(TAB_COLORS[light]) : FAVICON_HREF;
    document.querySelectorAll('link[rel="icon"]').forEach(n => n.remove());
    document.head.appendChild(link);
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

  /* The picture someone uploaded on Manage Profile, once it has been read
     from the account. Held here so the circle can be repainted — on a save,
     or when the name changes — without going back to Firestore each time. */
  let avatarPhoto = '';

  function renderProfile() {
    // getUser() is null in the instant between signing out and the redirect,
    // so nothing here may assume there is an account.
    const user = window.MktforgeAuth.getUser();
    document.getElementById('profile-name').textContent =
      window.MktforgeAuth.getDisplayName() || '';

    const avatar = document.getElementById('profile-avatar');
    const src = avatarPhoto || (user && user.avatar) || '';
    avatar.innerHTML = src
      ? `<img src="${src}" alt="">`
      : window.MktforgeIcons.user;
  }

  /* Reads the stored picture once at boot, then keeps the circle in step with
     whatever Manage Profile saves. A failure here is not worth interrupting
     anyone over — the circle simply keeps the placeholder icon. */
  function initAvatar() {
    const Data = window.MktforgeData;
    if (!Data || typeof Data.getAvatar !== 'function') return;

    const paint = (photo) => { avatarPhoto = photo || ''; renderProfile(); };

    Data.getAvatar()
      .then(paint)
      .catch((err) => console.warn('[Mktforge] profile picture unavailable', err));

    Data.onAvatar(paint);
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

    document.getElementById('manage-profile').addEventListener('click', () => {
      close();
      goTo('account-profile');
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

    // A nav-bar button returns you to where you left off in that module;
    // every other way in (logo, Manage Profile, in-module links, typed or
    // shared URLs, back/forward) starts at the top.
    display.scrollTop = restoreScroll ? (scrollMemory.get(next.id) || 0) : 0;
    const seen = activity.get(next.id);
    if (seen) seen.unseen = false;      // opening the module counts as checking it
    markActive();
  }

  /* Go to a module from any button or link in the app.
     { restore: true } is for the nav-bar buttons only: they return you to
     where you last were in that module, and clicking the one you're already
     on leaves you where you are. Every other caller lands at the top — and
     since asking for the module you're already on changes nothing in the URL
     (so hashchange never fires), that case scrolls to the top here. */
  function goTo(id, { restore = false } = {}) {
    if (id === activeId) {
      if (!restore) document.getElementById('display').scrollTop = 0;
      return;
    }
    restoreScroll = restore;
    location.hash = `#/${id}`;
  }

  function initLogo() {
    const logo = document.querySelector('.nav__logo .logo');
    if (!logo) return;
    const id = (logo.getAttribute('href') || '').replace(/^#\/?/, '');
    logo.addEventListener('click', e => {
      if (!id) return;
      e.preventDefault();
      goTo(id);
    });
  }

  /* ---------- Routing ----------
     Hash routing on purpose: GitHub Pages serves static files, so a real
     path like /my-company would 404 on refresh or on a shared link. */

  function route() {
    const id = (location.hash || '').replace(/^#\/?/, '');
    // An unknown hash falls back to the first module someone can actually
    // navigate to, never to a hidden one like Manage Profile.
    const target = modules.find(m => m.id === id) || modules.find(m => !m.hidden) || modules[0];
    if (!target) return;
    if (!id || id !== target.id) history.replaceState(null, '', `#/${target.id}`);
    show(target.id);
    restoreScroll = false;     // one navigation only
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
    initAvatar();
    renderNav();
    initLogo();
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
    go(id) { goTo(id); }         // modules' links always land at the top
  };
})();

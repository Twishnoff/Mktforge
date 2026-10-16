/* ==========================================================================
   Mktforge — product analytics (PostHog)

   The event contract is docs/analytics-events.md. If an event is not in that
   file it does not get sent; add it there first.

     MktforgeAnalytics.capture(name, props, opts)  one event, common props added;
                                                   opts.beforeUnload sends it at once
     MktforgeAnalytics.identify(user)         called for you on sign-in
     MktforgeAnalytics.reset()                called for you on sign-out
     MktforgeAnalytics.signupSource()         where this browser first came from
     MktforgeAnalytics.runId()                a fresh id for one module run

   Loads posthog-js from PostHog's CDN. Calls made before it has loaded are
   queued and flushed, so modules can call capture() at any time. Autocapture,
   heatmaps and session replay are off: the app's inputs are the user's own
   company data. Pageviews are not captured in the app either; module_opened
   covers navigation.
   ========================================================================== */

window.MktforgeAnalytics = (() => {

  const cfg = (window.MKTFORGE_CONFIG && window.MKTFORGE_CONFIG.posthog) || {};
  const enabled = !!cfg.API_KEY && !cfg.API_KEY.startsWith('PASTE_');

  let ready = false;
  const queue = [];
  let identified = null;   // uid currently identified, so we only identify once per session

  /* ---------- load ---------- */

  function load() {
    if (!enabled) { console.info('[Mktforge] analytics off: no PostHog key in config.js'); return; }
    const assets = cfg.API_HOST.replace('.i.posthog.com', '-assets.i.posthog.com');
    const el = document.createElement('script');
    el.async = true;
    el.crossOrigin = 'anonymous';
    el.src = `${assets}/static/array.js`;
    el.onload = () => {
      window.posthog.init(cfg.API_KEY, {
        api_host: cfg.API_HOST,
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
        enable_heatmaps: false,
        capture_performance: { web_vitals: false },
        disable_surveys: true,
        persistence: 'localStorage+cookie'
      });
      ready = true;
      queue.splice(0).forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    };
    el.onerror = () => console.warn('[Mktforge] PostHog failed to load; events for this session are dropped');
    document.head.appendChild(el);
  }

  function when(fn) { ready ? fn() : queue.push(fn); }

  /* ---------- common properties ---------- */

  function common() {
    const props = {};
    const u = window.MktforgeAuth && window.MktforgeAuth.getUser && window.MktforgeAuth.getUser();
    if (u && u.uid) props.uid = u.uid;
    const d = window.MktforgeData;
    if (d && d.activeCompanyId) props.company_id = d.activeCompanyId;
    const k = window.MktforgeKit && window.MktforgeKit.byok && window.MktforgeKit.byok.current;
    if (k && k.plan) props.plan = k.plan;
    return props;
  }

  /* ---------- public ---------- */

  function capture(name, props = {}, opts = {}) {
    if (!enabled) return;
    // Before a redirect the batch would be lost; send_instantly + sendBeacon
    // hands it to the browser, which delivers it after the page is gone.
    const send = opts.beforeUnload ? { send_instantly: true, transport: 'sendBeacon' } : undefined;
    when(() => window.posthog.capture(name, { ...common(), ...props }, send));
  }

  /* signup_source (see docs/analytics-events.md): invite label, else the first
     UTM this browser saw, else the first referring domain, else direct.
     posthog-js keeps the first URL and referrer it saw in persistence
     ($initial_person_info: { u, r }), shared across subdomains by cookie. */
  function signupSource(inviteLabel) {
    if (inviteLabel) return String(inviteLabel);
    let url = location.href, ref = document.referrer;
    try {
      const info = ready && window.posthog.get_property('$initial_person_info');
      if (info && info.u) { url = info.u; ref = info.r || ''; }
    } catch (e) { /* persistence unavailable */ }
    try {
      const q = new URL(url).searchParams;
      const src = q.get('utm_source');
      if (src) return q.get('utm_campaign') ? `${src}/${q.get('utm_campaign')}` : src;
    } catch (e) { /* bad url */ }
    try {
      const host = ref && new URL(ref).hostname.replace(/^www\./, '');
      if (host && !/(^|\.)mktforge\.io$/.test(host)) return host;
    } catch (e) { /* bad referrer */ }
    return 'direct';
  }

  function runId() {
    return (crypto.randomUUID && crypto.randomUUID())
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function identify(user) {
    if (!enabled || !user || !user.uid || identified === user.uid) return;
    identified = user.uid;
    when(() => window.posthog.identify(user.uid, { email: user.email, uid: user.uid }));
  }

  function reset() {
    if (!enabled) return;
    identified = null;
    when(() => window.posthog.reset());
  }

  /* ---------- wiring ---------- */

  load();

  // auth.js dispatches this on every auth state change with publicUser() or null.
  document.addEventListener('mktforge:user-changed', (ev) => {
    const u = ev.detail;
    if (u && u.uid) identify(u); else if (identified) reset();
  });

  return { capture, identify, reset, signupSource, runId };
})();

/* ==========================================================================
   Marketing Opportunities — Mktforge module
   Ported from the standalone Syndication & Event Finder
   (github.com/Twishnoff/Syndication-And-Events-Finder). Same Cloudflare
   Worker, same request/response contract, same "All Results" table plus
   seven category boxes, same "already collected" guard and the same
   jsPDF + autoTable report. What changed:
     - the page's own header is gone; the shell provides the frame
     - every DOM lookup is scoped to the container the shell hands mount()
     - jsPDF, autoTable and the PDF builder load on the first PDF click
     - results, form values and an in-flight run survive navigating away

   Request:  POST { email, companyUrl, jobTitles: [..], industry, today }
   Response: { status, companyName,
               results: { events, meetups, newsletters, influencers,
                          publications, syndication, social }  // [{ name, url }]
               allResults: [{ name, url, channel }] }

   Track Channel
     Influencers, Publications, Other Syndication Platforms and Social Media
     and Blogs rows get a Track Channel button. It saves the row's CHANNEL —
     not the one page the row links to — to My Company's Tracked News and
     Media URLs, for whichever company is on screen; Market Tracker then
     reads that channel in depth on every refresh. The channel comes from the
     Market Tracker Worker (POST /api/channel: a video -> its YouTube
     channel, a Medium post -> its author, an article -> its blog index or
     publication), with MktforgeData.util.channelRule as the fallback when
     the Worker can't be reached. Once tracked, the button reads Stop
     Tracking and removes it again.
   ========================================================================== */

(function () {

  const JSPDF_SRC     = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  const AUTOTABLE_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/5.0.8/jspdf.plugin.autotable.min.js';
  const PDF_SRC       = 'modules/marketing-opportunities/opportunities-pdf.js';

  const MAX_ROWS = 15;   // per category box; All Results is uncapped

  // Box titles, the All Results "Channel" column and the PDF headings all
  // come from here so they always match.
  const CATEGORY_LABELS = {
    events: 'Events and Tradeshows',
    meetups: 'Smaller Group Events',
    newsletters: 'Newsletters',
    influencers: 'Influencers',
    publications: 'Publications',
    syndication: 'Other Syndication Platforms',
    social: 'Social Media and Blogs'
  };
  const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

  // The boxes whose rows are channels worth tracking.
  const TRACKABLE = new Set(['influencers', 'publications', 'syndication', 'social']);
  const TRACK_ADD = 'Track Channel';
  const TRACK_REMOVE = 'Stop Tracking';
  const CHANNEL_TIMEOUT_MS = 12000;

  // The two optional extra job titles are hidden for now. While hidden they
  // are always sent empty, even if an older session typed something in them.
  const SHOW_EXTRA_TITLES = false;

  const MARKUP = `
  <div class="mo">

    <header class="mo__head">
      <h1 class="mo__eyebrow">Marketing Opportunities</h1>
      <p class="mo__dek">Find events and other channels to reach the job titles you care about.</p>
    </header>

    <section class="mo__submit" aria-label="Search inputs">
      <form class="mo__form" data-el="form" autocomplete="off" novalidate>
        <div class="mo__row">
          <div class="mo__field">
            <label for="mo-url">Company URL</label>
            <input type="text" id="mo-url" data-el="companyUrl" placeholder="yourcompany.com">
          </div>
          <div class="mo__field">
            <label for="mo-title1">Job Title</label>
            <input type="text" id="mo-title1" data-el="jobTitle1" placeholder="e.g. Data Engineer">
          </div>
          <div class="mo__field">
            <label for="mo-industry">Industry <span class="mo__optional">(optional)</span></label>
            <input type="text" id="mo-industry" data-el="industry" placeholder="e.g. Oil and Gas">
          </div>
          <div class="mo__field mo__field--action">
            <button type="submit" class="mo__btn" data-el="submit" disabled>Find Opportunities</button>
          </div>
        </div>

        <!-- Two extra job titles, parked for now. Set SHOW_EXTRA_TITLES to
             true (top of this file) to bring them back as a second row. -->
        <div class="mo__row mo__row--extra" data-el="extraTitles" hidden>
          <div class="mo__field">
            <label for="mo-title2">Job Title <span class="mo__optional">(optional)</span></label>
            <input type="text" id="mo-title2" data-el="jobTitle2" placeholder="Optional">
          </div>
          <div class="mo__field">
            <label for="mo-title3">Job Title <span class="mo__optional">(optional)</span></label>
            <input type="text" id="mo-title3" data-el="jobTitle3" placeholder="Optional">
          </div>
        </div>
      </form>
      <p class="mo__hint" data-el="hint" aria-live="polite"></p>
      <p class="mo__error" data-el="error" role="alert" hidden></p>
    </section>

    <div class="mo__results is-idle" data-el="grid">

    <div class="mo__idle">
      <div class="mo__intro">
        <img class="mo__intro-img" src="modules/marketing-opportunities/marketing-opportunities-panda.jpg"
          alt="" width="640" height="550">
        <div class="mo__intro-copy">
          <p class="mo__intro-title">Let's get the word out!</p>
          <p class="mo__intro-text">Pick your target job title and we'll find the best places to
            reach out and find the buyers you're after.</p>
        </div>
      </div>
      <div class="mo__idle-loading">
        <!-- The forging clips are shared with Find My Customer. -->
        <div class="mo__forge-stage" aria-hidden="true">
          <video class="mo__forge" data-el="forge" muted loop playsinline preload="auto"
            width="660" height="540" aria-hidden="true">
            <source src="modules/find-my-customer/find-customer-forge.webm" type="video/webm">
            <source src="modules/find-my-customer/find-customer-forge.mp4" type="video/mp4">
          </video>
          <video class="mo__forge mo__forge--end" data-el="forgeEnd" muted playsinline preload="auto"
            width="660" height="540" aria-hidden="true">
            <source src="modules/find-my-customer/find-customer-forge-end.webm" type="video/webm">
            <source src="modules/find-my-customer/find-customer-forge-end.mp4" type="video/mp4">
          </video>
        </div>
        <p class="mo__status" data-el="status" aria-live="polite"></p>
      </div>
    </div>

    <section class="mo__box mo__box--all" aria-label="All results">
      <h2>All Results <span class="mo__count" data-el="count"></span></h2>
      <div class="mo__box-body is-placeholder" data-box="all">No Data Collected</div>
    </section>

    <section class="mo__grid" aria-label="Results by channel">
      ${CATEGORY_ORDER.map((key) => `
      <article class="mo__box${key === 'social' ? ' mo__box--last' : ''}"><h2>${CATEGORY_LABELS[key]}</h2>
        <div class="mo__box-body is-placeholder" data-box="${key}">No Data Collected</div></article>`).join('')}
    </section>

    </div>

    <div class="mo__pdf-row" data-el="pdfRow" hidden style="display:none">
      <button type="button" class="mo__btn" data-el="pdf" disabled title="Run a search first">Create PDF</button>
    </div>

  </div>`;

  /* ---------- module-scoped handles (reset on every mount) ---------- */

  let el = null;
  let boxes = null;
  let cfg = {};
  let mounted = false;
  let trackBusy = false;
  let unsubProfile = null;

  /* One per company (MktforgeKit.perCompany), kept across navigation for the
     life of the page; typed input also survives a refresh. */
  const pc = window.MktforgeKit.perCompany('marketing-opportunities', {
    create: () => ({
      form:    { companyUrl: '', jobTitle1: '', jobTitle2: '', jobTitle3: '', industry: '' },
      urlSeed: { seeded: false },   // My Company URL default, once per company
      run:     null,    // inputs + results of the last success (page and PDF)
      lastKey: null,    // normalized inputs of `run`, for the duplicate guard
      status:  '',
      error:   '',
      note:    '',
      running: false,
      channels: {}      // row URL -> the channel URL Track Channel saved for it
    }),
    held: ['form', 'channels'],
    snapshot: ['run', 'lastKey', 'status']
  });
  let state = pc.state;
  pc.bind((st) => { state = st; });
  const onScreen = (st) => mounted && st === state;

  /* ---------- helpers ---------- */

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // Only http(s) links from the Worker become clickable.
  function safeUrl(url) {
    return /^https?:\/\//i.test(String(url || '').trim()) ? String(url).trim() : '';
  }

  function normalizeKey({ email, companyUrl, jobTitles, industry }) {
    return JSON.stringify({
      email: email.trim().toLowerCase(),
      companyUrl: companyUrl.trim().toLowerCase().replace(/\/+$/, ''),
      jobTitles: jobTitles.map((t) => t.trim().toLowerCase()),
      industry: (industry || '').trim().toLowerCase()
    });
  }

  function showError(msg) { el.error.textContent = msg; el.error.hidden = false; }
  function clearError()   { el.error.hidden = true; el.error.textContent = ''; }

  function setPdfEnabled(on) {
    el.pdf.disabled = !on;
    el.pdf.title = on ? '' : 'Run a search first';
  }

  function eachBox(fn) { Object.values(boxes).forEach(fn); }

  function setAllBoxesLoading() {
    eachBox((b) => {
      b.className = 'mo__box-body is-loading';
      b.innerHTML = '<span class="mo__dot"></span><span class="mo__dot"></span><span class="mo__dot"></span>';
    });
    el.count.textContent = '';
  }

  function setAllBoxesPlaceholder() {
    eachBox((b) => {
      b.className = 'mo__box-body is-placeholder';
      b.textContent = 'No Data Collected';
    });
    el.count.textContent = '';
  }

  function emptyState(b) {
    b.className = 'mo__box-body is-placeholder';
    b.textContent = 'No Relevant Results Found';
  }

  function linkCell(url) {
    const safe = safeUrl(url);
    return safe
      ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">Visit Site</a>`
      : '<span class="mo__none">N/A</span>';
  }

  /* ---------- renderers ---------- */

  /* Painted as Track Channel; paintTrackButtons() sets the real state once
     the profile has been read. Rows with no usable link get no button. */
  function trackCell(key, i, url) {
    if (!safeUrl(url)) return '<td class="mo__col-track"></td>';
    return `<td class="mo__col-track"><button type="button" class="mo__track" data-track="${key}" data-i="${i}" hidden>${TRACK_ADD}</button></td>`;
  }

  function renderCategory(b, items, key) {
    if (!items || items.length === 0) { emptyState(b); return; }
    const trackable = TRACKABLE.has(key);
    b.className = 'mo__box-body';
    b.innerHTML =
      `<table><thead><tr><th>Name</th><th class="mo__col-link">Link</th>${
        trackable ? '<th class="mo__col-track"><span class="mo__sr">Track</span></th>' : ''}</tr></thead><tbody>` +
      items.slice(0, MAX_ROWS).map((i, n) =>
        `<tr><td>${escapeHtml(i.name || 'Untitled')}</td><td class="mo__col-link">${linkCell(i.url)}</td>${
          trackable ? trackCell(key, n, i.url) : ''}</tr>`
      ).join('') +
      '</tbody></table>';
  }

  // Uncapped, ordered by overall fit across every category (not grouped).
  function renderAll(b, items) {
    if (!items || items.length === 0) { emptyState(b); el.count.textContent = ''; return; }
    b.className = 'mo__box-body mo__box-body--scroll';
    b.innerHTML =
      '<table><thead><tr><th>Name</th><th>Channel</th><th class="mo__col-link">Link</th></tr></thead><tbody>' +
      items.map((i) =>
        `<tr><td>${escapeHtml(i.name || 'Untitled')}</td>` +
        `<td><span class="mo__channel">${escapeHtml(i.channel || '')}</span></td>` +
        `<td class="mo__col-link">${linkCell(i.url)}</td></tr>`
      ).join('') +
      '</tbody></table>';
    el.count.textContent = `(${items.length})`;
  }

  function buildAllResultsFallback(results) {
    const combined = [];
    CATEGORY_ORDER.forEach((key) => {
      (results[key] || []).forEach((i) => {
        combined.push({ name: i.name, url: i.url, channel: CATEGORY_LABELS[key] });
      });
    });
    return combined;
  }

  function renderResults(run) {
    CATEGORY_ORDER.forEach((key) => renderCategory(boxes[key], run.results[key], key));
    renderAll(boxes.all, run.allResults);
    refreshTrackButtons();
  }

  /* ---------- Track Channel ---------- */

  const U = () => window.MktforgeData && window.MktforgeData.util;

  function rowOf(btn) {
    const items = (state.run && state.run.results && state.run.results[btn.dataset.track]) || [];
    const item = items[Number(btn.dataset.i)];
    return item && safeUrl(item.url) ? item : null;
  }

  /* Every spelling this row could have been saved under: what Track Channel
     saved for it, the rule's guess at its channel, and the link itself. */
  function candidatesFor(url) {
    const u = U();
    const rule = u ? u.channelRule(url) : null;
    return [(state.channels || {})[url], rule && rule.url, url].filter(Boolean);
  }

  const trackedIn = (list, url) => {
    const u = U();
    return !!u && candidatesFor(url).some((c) => list.some((t) => u.sameChannel(t, c)));
  };

  function paintTrackButtons(list) {
    if (!mounted || !boxes) return;
    TRACKABLE.forEach((key) => {
      if (!boxes[key]) return;
      boxes[key].querySelectorAll('[data-track]').forEach((btn) => {
        const item = rowOf(btn);
        if (!item) { btn.hidden = true; return; }
        const on = trackedIn(list, item.url);
        btn.textContent = on ? TRACK_REMOVE : TRACK_ADD;
        btn.classList.toggle('is-tracked', on);
        btn.setAttribute('aria-label', `${on ? TRACK_REMOVE : TRACK_ADD}: ${item.name || item.url}`);
        btn.disabled = trackBusy;
        btn.hidden = false;
      });
    });
  }

  function refreshTrackButtons() {
    if (!window.MktforgeData) return;
    window.MktforgeData.getProfile()
      .then((p) => paintTrackButtons(p.trackedChannels || []))
      .catch((err) => console.warn('[Marketing Opportunities] profile unavailable for tracked channels', err));
  }

  /* The channel a row belongs to, from the Market Tracker Worker. Falls back
     to the page's own rules if it can't be reached in time. */
  async function channelFor(url) {
    const u = U();
    const rule = u.channelRule(url) || { url, lookup: false };
    const tracker = (window.MKTFORGE_CONFIG && window.MKTFORGE_CONFIG.marketTracker) || {};
    if (!rule.lookup || !tracker.API_BASE_URL) return rule.url;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CHANNEL_TIMEOUT_MS);
    try {
      const token = window.MktforgeAuth && window.MktforgeAuth.getIdToken
        ? await window.MktforgeAuth.getIdToken() : null;
      if (!token) return rule.url;
      const res = await fetch(`${tracker.API_BASE_URL}/api/channel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ url }),
        signal: ctl.signal
      });
      const data = res.ok ? await res.json().catch(() => null) : null;
      return (data && u.isValidUrl(data.url)) ? data.url : rule.url;
    } catch (err) {
      console.warn('[Marketing Opportunities] channel lookup failed; using the link’s own site', err);
      return rule.url;
    } finally {
      clearTimeout(timer);
    }
  }

  const shortUrl = (url) => String(url).replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '');

  async function handleTrackClick(e) {
    const btn = e.target.closest('[data-track]');
    if (!btn || trackBusy || !state.run) return;
    const item = rowOf(btn);
    if (!item) return;
    const st = state;
    const wasOn = btn.classList.contains('is-tracked');

    trackBusy = true;
    TRACKABLE.forEach((key) => boxes[key] && boxes[key].querySelectorAll('[data-track]').forEach((b) => { b.disabled = true; }));
    btn.textContent = wasOn ? 'Removing…' : 'Adding…';
    try {
      const D = await window.MktforgeData.scope();      // the company on screen now
      const u = U();
      let profile = await D.getProfile();
      const list = profile.trackedChannels || [];
      let message = '';
      if (trackedIn(list, item.url)) {
        const drop = candidatesFor(item.url);
        profile.trackedChannels = list.filter((t) => !drop.some((c) => u.sameChannel(t, c)));
        message = `Stopped tracking ${shortUrl(drop.find((c) => list.some((t) => u.sameChannel(t, c))) || item.url)}.`;
      } else {
        const channel = u.normalizeUrl(await channelFor(item.url));
        st.channels = { ...(st.channels || {}), [item.url]: channel };
        pc.hold(st);                                      // survives a refresh
        profile = await D.getProfile();                   // re-read: the lookup took a moment
        const now = profile.trackedChannels || [];
        profile.trackedChannels = now.some((t) => u.sameChannel(t, channel)) ? now : [...now, channel];
        message = `Now tracking ${shortUrl(channel)} in My Company’s Tracked News and Media URLs.`;
      }
      const saved = await D.saveProfile(profile);
      trackBusy = false;
      paintTrackButtons(saved.trackedChannels || []);
      document.dispatchEvent(new CustomEvent('mktforge:notify', { detail: { message, tone: 'info' } }));
    } catch (err) {
      console.error('[Marketing Opportunities] could not update tracked channels', err);
      trackBusy = false;
      refreshTrackButtons();
      document.dispatchEvent(new CustomEvent('mktforge:notify', {
        detail: { message: 'Couldn’t update your Tracked News and Media URLs. Please try again.', tone: 'error' }
      }));
    }
  }

  /* ---------- validation ---------- */

  function readForm() {
    return {
      companyUrl: el.companyUrl.value.trim(),
      jobTitle1:  el.jobTitle1.value.trim(),
      jobTitle2:  SHOW_EXTRA_TITLES ? el.jobTitle2.value.trim() : '',
      jobTitle3:  SHOW_EXTRA_TITLES ? el.jobTitle3.value.trim() : '',
      industry:   el.industry.value.trim()
    };
  }

  const REQUIRED = [['companyUrl', 'company URL'], ['jobTitle1', 'a job title']];

  function updateSubmitEnabled() {
    if (!mounted) return;
    const f = readForm();
    const missing = REQUIRED.filter(([k]) => !f[k]).map(([, label]) => label);
    el.submit.disabled = state.running || missing.length > 0;
    el.hint.textContent = !state.running && missing.length ? `Still needed: ${missing.join(', ')}.` : '';
  }

  // Same messages as the standalone app (and the Worker).
  function validate(f) {
    const missing = REQUIRED.filter(([k]) => !f[k]).map(([k]) => k);
    if (missing.length === 0) return null;
    if (missing.length >= 2) return 'Please Provide Required Information';
    return {
      jobTitle1: 'One Job Title Is Required',
      companyUrl: 'Company URL Is Required'
    }[missing[0]];
  }

  /* ---------- request ---------- */

  async function requestOpportunities(body, signal) {
    const headers = { 'Content-Type': 'application/json' };

    // Off by default: the Worker's CORS only allows Content-Type, so an
    // Authorization header would fail the preflight. See README.
    if (cfg.SEND_AUTH_TOKEN && window.MktforgeAuth && window.MktforgeAuth.getIdToken) {
      const token = await window.MktforgeAuth.getIdToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetch(cfg.API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal });
    const payload = await res.json().catch(() => null);
    return { res, payload };
  }

  /* ---------- submit ---------- */

  async function handleSubmit(e) {
    const st = state;
    e.preventDefault();
    if (st.running) return;
    clearError();
    st.error = '';

    const f = readForm();
    const problem = validate(f);
    if (problem) { showError(problem); return; }

    const noAccess = window.MktforgeKit.accessProblem();
    if (noAccess) { showError(noAccess); return; }
    const email = window.MktforgeKit.accountEmail();

    const jobTitles = [f.jobTitle1, f.jobTitle2, f.jobTitle3].filter(Boolean);
    const key = normalizeKey({ email, companyUrl: f.companyUrl, jobTitles, industry: f.industry });

    if (st.lastKey && key === st.lastKey) {
      showError('Results for these inputs are already collected and shown below.');
      return;
    }

    if (!cfg.API_URL) {
      showError('Marketing Opportunities isn’t configured — set marketingOpportunities.API_URL in assets/js/config.js.');
      return;
    }

    captureForm();
    const runId = pc.begin(st);
    st.running = true;
    Mktforge.reportActivity('marketing-opportunities', 'running');
    st.run = null;
    st.lastKey = null;
    st.status = 'Searching for channels… this can take a minute or two.';
    setPdfEnabled(false);
    setAllBoxesLoading();
    setView('loading');
    el.status.textContent = st.status;
    updateSubmitEnabled();

    const fail = (message) => {
      if (!pc.live(st, runId)) return;
      st.error = message;
      st.status = '';
      if (onScreen(st)) {
        setAllBoxesPlaceholder();
        setView('intro');
        showError(message);
        el.status.textContent = '';
      }
    };

    try {
      const runningStatus = st.status;
      const context = await window.MktforgeKit.savedMaterials(cfg, { jobTitles, data: window.MktforgeData.company(st._cid) },
        (t) => { st.status = t; if (onScreen(st)) el.status.textContent = t; });
      if (!pc.live(st, runId)) return;
      st.status = runningStatus;
      if (onScreen(st)) el.status.textContent = runningStatus;

      const { res, payload } = await requestOpportunities({
        ...(context ? { context } : {}),
        email,
        companyUrl: f.companyUrl,
        jobTitles,
        industry: f.industry || null,
        today: new Date().toISOString().slice(0, 10)
      }, st.controller.signal);
      if (!pc.live(st, runId)) return;

      if (!res.ok || !payload || payload.status === 'error') {
        const message = payload && payload.message;
        fail(window.MktforgeKit.accessError(res.status, message) || message || 'Something went wrong. Please try again.');
        return;
      }

      const results = payload.results || {};
      const allResults = Array.isArray(payload.allResults) && payload.allResults.length > 0
        ? payload.allResults
        : buildAllResultsFallback(results);

      // Recorded whether or not the module is on screen.
      st.run = {
        companyUrl:  f.companyUrl,
        companyName: payload.companyName || null,
        jobTitles,
        industry:    f.industry || null,
        results,
        allResults
      };
      st.lastKey = key;
      st.status = 'Search complete.';

      // The panda finishes his pass and puts the hammer down first, with
      // "Search complete." under him while he does.
      if (onScreen(st)) {
        el.status.textContent = st.status;
        await finishForge();
        if (!pc.live(st, runId)) return;
      }

      if (onScreen(st)) {
        setView('results');
        renderResults(st.run);
        setPdfEnabled(true);
      }
    } catch (err) {
      if (!pc.live(st, runId)) return;
      console.error('[Marketing Opportunities]', err);
      fail('Could not reach the backend. Please try again.');
    } finally {
      if (!pc.end(st, runId)) return;     // cancelled by a company switch
      st.running = false;
      Mktforge.reportActivity('marketing-opportunities', st.error ? 'error' : 'idle');
      updateSubmitEnabled();
    }
  }

  /* ---------- the single box that stands in for the results ----------
       'intro'   — before a run (or after one that failed): the panda + copy
       'loading' — while a run is searching: the forging panda + progress
       'results' — All Results plus the per-channel boxes */
  function setView(view) {
    el.grid.classList.toggle('is-idle', view !== 'results');
    el.grid.classList.toggle('is-running', view === 'loading');
    // Nothing to save until there are results. Set inline too, so no
    // stylesheet (even a stale cached one) can bring the button back early.
    el.pdfRow.hidden = view !== 'results';
    el.pdfRow.style.display = view === 'results' ? '' : 'none';
    playForge(view === 'loading');
    // A run that broke: the singed panda asks for another go.
    window.MktforgeKit.oops(el.grid, 'mo', view === 'intro' && !!state.error);
  }

  /* The forging panda: two clips stacked in one spot. `forge` loops while a
     run searches; `forgeEnd` (the last strike, then the hammer goes down)
     plays once when results arrive, before they're shown. Nothing plays for
     anyone who has asked their system for reduced motion — the first frame
     stays up and results appear straight away. */
  const reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let forgeDone = null;   // settles a finishForge() still waiting, if any

  function playForge(on) {
    const loop = el.forge, end = el.forgeEnd;
    if (!loop || !end) return;
    if (forgeDone) forgeDone();
    end.pause();
    end.currentTime = 0;
    end.classList.remove('is-on');
    loop.classList.remove('is-off');
    loop.loop = true;
    loop.currentTime = 0;
    if (on && !reducedMotion) {
      const p = loop.play();
      if (p && p.catch) p.catch(() => {});   // autoplay refused: first frame stays up
    } else {
      loop.pause();
    }
  }

  /* Lets the current pass of the loop finish, plays the ending, holds its
     last frame for a beat, then resolves. Resolves at once if the loop
     isn't actually playing, and never waits longer than both clips take. */
  function finishForge() {
    const loop = el && el.forge, end = el && el.forgeEnd;
    if (!loop || !end || reducedMotion || loop.paused) return Promise.resolve();

    return new Promise((resolve) => {
      let settled = false;
      const clipMs = (v, fallback) => (isFinite(v.duration) ? v.duration : fallback) * 1000;
      const timer = setTimeout(() => done(), clipMs(loop, 5) + clipMs(end, 4) + 2000);

      function done() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        loop.removeEventListener('ended', onLoopEnd);
        end.removeEventListener('ended', onEndEnd);
        if (forgeDone === done) forgeDone = null;
        resolve();
      }
      function onLoopEnd() {
        end.currentTime = 0;
        end.classList.add('is-on');
        loop.classList.add('is-off');
        const p = end.play();
        if (p && p.catch) p.catch(done);
      }
      function onEndEnd() { setTimeout(done, 600); }

      forgeDone = done;
      loop.addEventListener('ended', onLoopEnd);
      end.addEventListener('ended', onEndEnd);
      loop.loop = false;   // finish this pass, then fire 'ended'
    });
  }

  /* ---------- PDF export ---------- */

  async function handlePdf() {
    const pdfCid = state._cid;   // the PDF is saved to this company, or not at all
    if (!state.run) return;

    el.pdf.disabled = true;
    el.pdf.textContent = 'Preparing PDF…';

    try {
      // Order matters: autoTable attaches itself to the jsPDF global.
      await Mktforge.loadScript(JSPDF_SRC);
      await Mktforge.loadScript(AUTOTABLE_SRC);
      await Mktforge.loadScript(PDF_SRC);
      // Switched company while the PDF tools loaded: don't save it into the other one.
      if (state._cid !== pdfCid) return;
      await window.MktforgeOpportunitiesPdf.build(state.run, { CATEGORY_LABELS, CATEGORY_ORDER, safeUrl });
    } catch (err) {
      console.error('[Marketing Opportunities] PDF export failed', err);
      if (mounted) showError('Could not generate the PDF. Please try again.');
    } finally {
      if (mounted) {
        el.pdf.textContent = 'Create PDF';
        setPdfEnabled(!!state.run);
      }
    }
  }

  /* ---------- carrying state across mount/unmount ---------- */

  function captureForm() {
    if (!el) return;
    state.form = readForm();
  }

  function restore() {
    const f = state.form;
    el.companyUrl.value = f.companyUrl;
    el.jobTitle1.value  = f.jobTitle1;
    el.jobTitle2.value  = f.jobTitle2;
    el.jobTitle3.value  = f.jobTitle3;
    el.industry.value   = f.industry;

    setView(state.running ? 'loading' : state.run ? 'results' : 'intro');

    if (state.running) {
      setAllBoxesLoading();
      el.status.textContent = state.status;
    } else if (state.run) {
      renderResults(state.run);
      setPdfEnabled(true);
    }

    if (state.error) showError(state.error);
    else if (state.note) showError(state.note);
  }

  /* My Company defaults and drop-down choices (assets/js/module-kit.js). */
  function autofill() {
    if (!window.MktforgeKit) return;
    const K = window.MktforgeKit;
    K.seedCompanyUrl(el.companyUrl, state.urlSeed);
    [el.jobTitle1, el.jobTitle2, el.jobTitle3].forEach((input) =>
      K.attachPicker(input, (p) => p.targetTitles));
    K.attachPicker(el.industry, (p) => p.targetIndustries);
  }

  /* ---------- module contract ---------- */

  Mktforge.register({
    id:     'marketing-opportunities',
    label:  'Marketing Opportunities',
    icon:   'megaphone',
    companyAware: true,
    // The ?v= changes whenever this stylesheet does, so a browser holding the
    // old copy (GitHub Pages lets browsers cache for ~10 minutes) fetches the
    // new one instead of pairing new markup with old styles.
    styles: 'modules/marketing-opportunities/marketing-opportunities.css?v=2026-09-27i',

    mount(container) {
      container.innerHTML = MARKUP;
      mounted = true;
      cfg = (window.MKTFORGE_CONFIG && window.MKTFORGE_CONFIG.marketingOpportunities) || {};

      const q = (name) => container.querySelector(`[data-el="${name}"]`);
      el = {
        form: q('form'), companyUrl: q('companyUrl'),
        jobTitle1: q('jobTitle1'), jobTitle2: q('jobTitle2'), jobTitle3: q('jobTitle3'),
        industry: q('industry'), submit: q('submit'), hint: q('hint'),
        error: q('error'), pdf: q('pdf'), status: q('status'), count: q('count'),
        extraTitles: q('extraTitles'),
        grid: q('grid'), forge: q('forge'), forgeEnd: q('forgeEnd'), pdfRow: q('pdfRow')
      };

      el.extraTitles.hidden = !SHOW_EXTRA_TITLES;

      boxes = {};
      container.querySelectorAll('[data-box]').forEach((b) => { boxes[b.dataset.box] = b; });

      ['companyUrl', 'jobTitle1'].forEach((k) =>
        el[k].addEventListener('input', updateSubmitEnabled));
      el.form.addEventListener('submit', handleSubmit);
      el.pdf.addEventListener('click', handlePdf);
      TRACKABLE.forEach((key) => boxes[key].addEventListener('click', handleTrackClick));
      if (window.MktforgeData) {
        // Only fires for the company on screen; My Company edits land here too.
        unsubProfile = window.MktforgeData.onProfile((p) => paintTrackButtons(p.trackedChannels || []));
      }

      // Only the person's own typing clears a "Run stopped" note, not autofill.
      const hold = (e) => { captureForm(); pc.hold(e && e.isTrusted ? undefined : state); };
      container.addEventListener('input', hold);
      container.addEventListener('change', hold);

      restore();
      updateSubmitEnabled();
      autofill();
    },

    unmount() {
      captureForm();
      pc.hold(state);                   // keeps any "Run stopped" note
      mounted = false;
      if (unsubProfile) { unsubProfile(); unsubProfile = null; }
      if (el && el.forge) { el.forge.pause(); el.forgeEnd.pause(); }
      if (forgeDone) forgeDone();       // a waiting finish shows results on the way back
      // A run in flight is deliberately NOT aborted; it finishes into state.
      el = null;
      boxes = null;
    }
  });

})();

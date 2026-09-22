/* ==========================================================================
   Find My Customer — Mktforge module
   Ported from the standalone Customer Overview Dashboard
   (github.com/Twishnoff/Customer-Intelligence). Same Cloudflare Worker, same
   request/response contract, same five result boxes, same "already
   collected" guard and the same jsPDF + autoTable report. What changed:
     - the page's own header is gone; the shell provides the frame
     - every DOM lookup is scoped to the container the shell hands mount(),
       so nothing reaches outside this module
     - jsPDF and autoTable load on the first PDF click, not on page load
     - results, form values and an in-flight run survive navigating away
       (same pattern as Persona Builder)

   Response shape must keep matching the Worker's /api/dashboard payload:
     { customerList: { found, customers: [{ name, size, industry }] },
       jobTitles: [string],
       painPoints: [{ jobTitle, points: [string] }],
       topNeeds:   [{ jobTitle, points: [string] }],
       competitorsToWatch: [{ name, url, why? }] }        // optional

   competitorsToWatch is the only addition to the contract. A Worker that
   doesn't send it leaves the box on "No Competitors Found" and everything
   else behaves exactly as before, so the site can ship ahead of the Worker.
   The request now also carries `competitorUrls` — My Company's tracked
   competitors — which the agent reviews for relevance alongside its own
   research (see the Worker's competitors.js).
   ========================================================================== */

(function () {

  const JSPDF_SRC     = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  const AUTOTABLE_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/5.0.8/jspdf.plugin.autotable.min.js';
  const PDF_SRC       = 'modules/find-my-customer/customer-pdf.js';

  const MARKUP = `
  <div class="fmc">

    <header class="fmc__head">
      <p class="fmc__eyebrow">Find My Customer</p>
      <h1 class="fmc__title">Discover your ideal job titles</h1>
      <p class="fmc__dek">Use the information on your website to quickly find and define the
        job titles you should be selling into.</p>
    </header>

    <section class="fmc__submit" aria-label="Company inputs">
      <form class="fmc__form" data-el="form" autocomplete="off" novalidate>
        <div class="fmc__field fmc__field--wide">
          <label for="fmc-url">Company URL</label>
          <input type="text" id="fmc-url" data-el="url" placeholder="e.g. acme.com" required>
        </div>

        <div class="fmc__field fmc__field--action">
          <button type="submit" class="fmc__btn" data-el="submit">Find Customers</button>
        </div>
      </form>
      <p class="fmc__error" data-el="error" role="alert" hidden></p>
    </section>

    <section class="fmc__grid" aria-label="Customer research results">
      <article class="fmc__box fmc__box--wide"><h2>Customer List</h2>
        <div class="fmc__box-body is-placeholder" data-box="customers">No Data</div></article>
      <article class="fmc__box"><h2>Job Titles</h2>
        <div class="fmc__box-body is-placeholder" data-box="jobTitles">No Data</div></article>
      <article class="fmc__box"><h2>Pain Points / Initiatives</h2>
        <div class="fmc__box-body is-placeholder" data-box="painPoints">No Data</div></article>
      <article class="fmc__box"><h2>Top Needs</h2>
        <div class="fmc__box-body is-placeholder" data-box="topNeeds1">No Data</div></article>
      <article class="fmc__box"><h2>Top Needs</h2>
        <div class="fmc__box-body is-placeholder" data-box="topNeeds2">No Data</div></article>
      <article class="fmc__box fmc__box--wide fmc__box--tall"><h2>Competitors To Watch</h2>
        <div class="fmc__box-body is-placeholder" data-box="competitorsToWatch">No Data</div></article>
    </section>

    <div class="fmc__pdf-row">
      <button type="button" class="fmc__btn" data-el="pdf" disabled title="Run a search first">Save as PDF</button>
      <p class="fmc__status" data-el="status" aria-live="polite"></p>
    </div>

  </div>`;

  /* ---------- module-scoped handles (reset on every mount) ---------- */

  let el = null;
  let boxes = null;
  let cfg = {};
  let mounted = false;
  let unsubProfile = null;

  /* Everything worth keeping when the user navigates to another module and
     comes back — one per company (MktforgeKit.perCompany). Lives for the life
     of the page; typed input also survives a refresh. */
  const pc = window.MktforgeKit.perCompany('find-my-customer', {
    create: () => ({
      form:     { url: '' },
      urlSeed:  { seeded: false },   // My Company URL default, once per company
      data:     null,     // last successful payload, as rendered
      runUrl:   '',       // the URL exactly as submitted for `data` (PDF header)
      lastUrl:  null,     // normalized URL of `data`, for the duplicate guard
      status:   '',
      error:    '',
      note:     '',
      running:  false
    }),
    held: ['form'],
    snapshot: ['data', 'runUrl', 'lastUrl', 'status']
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

  function normalizeUrl(value) {
    return String(value || '').trim().toLowerCase().replace(/\/+$/, '');
  }

  /* Competitor URLs arrive in every shape the web uses ("rival.com",
     "https://www.rival.com/product/"). The host is what identifies them, so
     it's what both the tracked-competitor match and the stored tag use —
     the same bare form My Company's Competitors field asks for. */
  function hostOf(url) {
    const v = String(url || '').trim();
    if (!v) return '';
    try {
      return new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`)
        .hostname.toLowerCase().replace(/^www\./, '');
    } catch (e) {
      return v.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
    }
  }

  function hrefFor(url) {
    const v = String(url || '').trim();
    return /^https?:\/\//i.test(v) ? v : `https://${v}`;
  }

  const sameCompetitor = (a, b) => {
    const x = hostOf(a);
    return !!x && x === hostOf(b);
  };

  /* The Worker may send competitorsToWatch as a bare array or wrapped the
     way customerList is ({ found, competitors }). Either is accepted, rows
     are deduped by host, and the researched company never lists itself. */
  function readCompetitors(raw, companyUrl) {
    const arr = Array.isArray(raw) ? raw
      : (raw && Array.isArray(raw.competitors) ? raw.competitors : []);
    const self = hostOf(companyUrl);
    const seen = new Set();
    return arr.map((c) => ({
      name: String((c && (c.name || c.competitor)) || '').trim(),
      url:  String((c && (c.url || c.website || c.competitorUrl)) || '').trim(),
      why:  String((c && (c.why || c.reason)) || '').trim()
    })).filter((c) => {
      const host = hostOf(c.url);
      if (!host || !(c.name || host)) return false;
      if (self && host === self) return false;
      if (seen.has(host)) return false;
      seen.add(host);
      return true;
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
      b.className = 'fmc__box-body is-loading';
      b.innerHTML = '<span class="fmc__dot"></span><span class="fmc__dot"></span><span class="fmc__dot"></span>';
    });
  }

  function setAllBoxesPlaceholder() {
    eachBox((b) => {
      b.className = 'fmc__box-body is-placeholder';
      b.textContent = 'No Data';
    });
  }

  function setEmpty(b, msg) {
    b.className = 'fmc__box-body is-placeholder';
    b.textContent = msg;
  }

  /* ---------- renderers, one per box ---------- */

  function renderCustomerList(list) {
    const b = boxes.customers;
    if (!list || !list.found || !list.customers || list.customers.length === 0) {
      setEmpty(b, 'No Customers Found');
      return;
    }
    b.className = 'fmc__box-body';
    b.innerHTML =
      '<table><thead><tr><th>Customer</th><th>Size</th><th>Industry</th></tr></thead><tbody>' +
      list.customers.map((c) =>
        `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.size || 'N/A')}</td><td>${escapeHtml(c.industry || 'N/A')}</td></tr>`
      ).join('') +
      '</tbody></table>';
  }

  function renderJobTitles(titles) {
    const b = boxes.jobTitles;
    if (!titles || titles.length === 0) { setEmpty(b, 'No Data'); return; }
    b.className = 'fmc__box-body';
    b.innerHTML = '<ul class="fmc__titles">' +
      titles.map((t, i) => `
        <li>
          <span class="fmc__title-name">${escapeHtml(t)}</span>
          <button type="button" class="fmc__track" data-track="${i}" hidden></button>
        </li>`).join('') + '</ul>';
    refreshTrackButtons();
  }

  /* ---------- Tracked titles (My Company → Target Job Titles) ----------
     App-only controls: the PDF is built from state.data, never from this DOM,
     so these buttons never appear in it. */

  const TRACK_ADD = 'Add To Tracked Titles';
  const TRACK_REMOVE = 'Remove From Tracked Titles';
  const sameTitle = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  let trackBusy = false;

  function paintTrackButtons(tracked) {
    if (!mounted || !boxes || !state.data) return;
    const titles = state.data.jobTitles || [];
    boxes.jobTitles.querySelectorAll('[data-track]').forEach((btn) => {
      const title = titles[Number(btn.dataset.track)];
      const on = tracked.some((t) => sameTitle(t, title));
      btn.textContent = on ? TRACK_REMOVE : TRACK_ADD;
      btn.classList.toggle('is-tracked', on);
      btn.setAttribute('aria-label', `${on ? TRACK_REMOVE : TRACK_ADD}: ${title}`);
      btn.disabled = trackBusy;
      btn.hidden = false;
    });
  }

  /* One read, both sets of buttons — the profile holds Target Job Titles and
     Competitors, and either box may have just been re-rendered. */
  function refreshTrackButtons() {
    if (!window.MktforgeData) return;
    window.MktforgeData.getProfile()
      .then((p) => {
        paintTrackButtons(p.targetTitles || []);
        paintCompetitorButtons(p.competitors || []);
      })
      .catch((err) => console.warn('[Find My Customer] profile unavailable for tracked titles', err));
  }

  async function handleTrackClick(e) {
    const btn = e.target.closest('[data-track]');
    if (!btn || trackBusy || !state.data) return;
    const title = (state.data.jobTitles || [])[Number(btn.dataset.track)];
    if (!title) return;

    trackBusy = true;
    boxes.jobTitles.querySelectorAll('[data-track]').forEach((b) => { b.disabled = true; });
    try {
      const D = await window.MktforgeData.scope();      // the company on screen now
      const profile = await D.getProfile();
      const list = profile.targetTitles || [];
      const tracked = list.some((t) => sameTitle(t, title));
      profile.targetTitles = tracked
        ? list.filter((t) => !sameTitle(t, title))
        : [...list, String(title).trim()];
      const saved = await D.saveProfile(profile);
      trackBusy = false;
      paintTrackButtons(saved.targetTitles);
    } catch (err) {
      console.error('[Find My Customer] could not update tracked titles', err);
      trackBusy = false;
      refreshTrackButtons();
      document.dispatchEvent(new CustomEvent('mktforge:notify', {
        detail: { message: 'Couldn’t update your Target Job Titles. Please try again.', tone: 'error' }
      }));
    }
  }

  function renderPainPoints(groups) {
    const b = boxes.painPoints;
    if (!groups || groups.length === 0) { setEmpty(b, 'No Data'); return; }
    b.className = 'fmc__box-body';
    b.innerHTML = groups.map((g) => `
      <div class="fmc__group">
        <h3>${escapeHtml(g.jobTitle)}</h3>
        <ul>${(g.points || []).map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
      </div>`).join('');
  }

  function renderTopNeeds(b, group) {
    if (!group) { setEmpty(b, 'No Data'); return; }
    b.className = 'fmc__box-body';
    b.innerHTML = `
      <p class="fmc__needs-title">${escapeHtml(group.jobTitle)}</p>
      <ol class="fmc__rank">${(group.points || []).map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ol>`;
  }

  /* ---------- Competitors To Watch ----------
     Two columns the way the box is specced — name and URL — with the
     tracking button riding along at the end of the row. `why` (the agent's
     one-line case for why this company competes) is the row's tooltip and
     goes in the PDF; it doesn't take a column. */

  function renderCompetitors(list) {
    const b = boxes.competitorsToWatch;
    if (!list || list.length === 0) { setEmpty(b, 'No Competitors Found'); return; }
    b.className = 'fmc__box-body';
    b.innerHTML =
      '<table class="fmc__comp"><thead><tr><th>Competitor Name</th><th>Competitor URL</th>' +
      '<th class="fmc__comp-act"><span class="fmc__sr">Tracking</span></th></tr></thead><tbody>' +
      list.map((c, i) => `
        <tr${c.why ? ` title="${escapeHtml(c.why)}"` : ''}>
          <td>${escapeHtml(c.name || hostOf(c.url))}</td>
          <td><a class="fmc__comp-url" href="${escapeHtml(hrefFor(c.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(hostOf(c.url) || c.url)}</a></td>
          <td class="fmc__comp-act"><button type="button" class="fmc__track" data-comp="${i}" hidden></button></td>
        </tr>`).join('') +
      '</tbody></table>';
    refreshTrackButtons();
  }

  /* ---------- Tracked competitors (My Company → Competitors) ----------
     Same contract as tracked titles: already-tracked rows start on
     "Remove", the buttons live only in the app, and My Company picks the
     change up the next time it's opened. */

  const COMP_ADD = 'Add To Tracked Competitors';
  const COMP_REMOVE = 'Remove From Tracked Competitors';
  let compBusy = false;

  function competitorRows() {
    return (state.data && state.data.competitorsToWatch) || [];
  }

  function paintCompetitorButtons(tracked) {
    if (!mounted || !boxes || !state.data) return;
    const rows = competitorRows();
    boxes.competitorsToWatch.querySelectorAll('[data-comp]').forEach((btn) => {
      const row = rows[Number(btn.dataset.comp)];
      if (!row) return;
      const on = tracked.some((t) => sameCompetitor(t, row.url));
      btn.textContent = on ? COMP_REMOVE : COMP_ADD;
      btn.classList.toggle('is-tracked', on);
      btn.setAttribute('aria-label', `${on ? COMP_REMOVE : COMP_ADD}: ${row.name || hostOf(row.url)}`);
      btn.disabled = compBusy;
      btn.hidden = false;
    });
  }

  async function handleCompetitorClick(e) {
    const btn = e.target.closest('[data-comp]');
    if (!btn || compBusy || !state.data) return;
    const row = competitorRows()[Number(btn.dataset.comp)];
    if (!row || !row.url) return;

    compBusy = true;
    boxes.competitorsToWatch.querySelectorAll('[data-comp]').forEach((b) => { b.disabled = true; });
    try {
      const D = await window.MktforgeData.scope();      // the company on screen now
      const profile = await D.getProfile();
      const list = profile.competitors || [];
      const tracked = list.some((t) => sameCompetitor(t, row.url));
      profile.competitors = tracked
        ? list.filter((t) => !sameCompetitor(t, row.url))
        : [...list, hostOf(row.url) || String(row.url).trim()];
      const saved = await D.saveProfile(profile);
      compBusy = false;
      paintCompetitorButtons(saved.competitors);
    } catch (err) {
      console.error('[Find My Customer] could not update tracked competitors', err);
      compBusy = false;
      refreshTrackButtons();
      document.dispatchEvent(new CustomEvent('mktforge:notify', {
        detail: { message: 'Couldn’t update your Competitors. Please try again.', tone: 'error' }
      }));
    }
  }

  function renderDashboard(data) {
    renderCustomerList(data.customerList);
    renderJobTitles(data.jobTitles);
    renderPainPoints(data.painPoints);
    const needs = data.topNeeds || [];
    renderTopNeeds(boxes.topNeeds1, needs[0]);
    renderTopNeeds(boxes.topNeeds2, needs[1]);
    renderCompetitors(data.competitorsToWatch);
  }

  /* ---------- request ---------- */

  async function requestDashboard(payload, signal) {
    const headers = { 'Content-Type': 'application/json' };

    // Off by default: the Customer Intelligence Worker predates Mktforge's
    // login, and a header it doesn't list in Access-Control-Allow-Headers
    // fails the CORS preflight. Flip SEND_AUTH_TOKEN once the Worker verifies
    // Firebase ID tokens (same require-user.js as Persona Drafter).
    if (cfg.SEND_AUTH_TOKEN && window.MktforgeAuth && window.MktforgeAuth.getIdToken) {
      const token = await window.MktforgeAuth.getIdToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetch(cfg.API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal
    });
    const body = await res.json().catch(() => null);
    return { res, body };
  }

  /* ---------- submit ---------- */

  async function handleSubmit(e) {
    const st = state;
    e.preventDefault();
    if (st.running) return;
    clearError();
    st.error = '';

    const email  = window.MktforgeKit.accountEmail();
    const rawUrl = el.url.value.trim();

    const noAccess = window.MktforgeKit.accessProblem();
    if (noAccess) { showError(noAccess); return; }

    if (!rawUrl) {
      showError('Please enter a company URL.');
      return;
    }

    const normalized = normalizeUrl(rawUrl);
    if (st.lastUrl && normalized === st.lastUrl) {
      showError('Customer data for this company is already collected and shown below.');
      return;
    }

    if (!cfg.API_URL) {
      showError('Find My Customer isn’t configured — set findMyCustomer.API_URL in assets/js/config.js.');
      return;
    }

    captureForm();
    const runId = pc.begin(st);
    st.running = true;
    Mktforge.reportActivity('find-my-customer', 'running');
    st.data = null;
    st.lastUrl = null;
    st.status = 'Collecting data… this can take a minute.';
    el.submit.disabled = true;
    setPdfEnabled(false);
    setAllBoxesLoading();
    el.status.textContent = st.status;

    const fail = (message) => {
      if (!pc.live(st, runId)) return;
      st.error = message;
      st.status = '';
      if (onScreen(st)) {
        setAllBoxesPlaceholder();
        showError(message);
        el.status.textContent = '';
      }
    };

    try {
      const runningStatus = st.status;

      // My Company's Target Job Titles steer which saved materials are sent
      // in full, and its Competitors go with the request so the agent can
      // check them for relevance too. Neither is required to run.
      let profile = null;
      try {
        profile = window.MktforgeData ? await window.MktforgeData.company(st._cid).getProfile() : null;
      } catch (err) {
        console.warn('[Find My Customer] profile unavailable for the request', err);
      }
      const competitorUrls = (profile && profile.competitors) || [];

      const context = await window.MktforgeKit.savedMaterials(cfg,
        { jobTitles: (profile && profile.targetTitles) || [] },
        (t) => { st.status = t; if (onScreen(st)) el.status.textContent = t; });
      if (!pc.live(st, runId)) return;
      st.status = runningStatus;
      if (onScreen(st)) el.status.textContent = runningStatus;

      const { res, body } = await requestDashboard({
        companyUrl: rawUrl,
        email,
        ...(competitorUrls.length ? { competitorUrls } : {}),
        ...(context ? { context } : {})
      }, st.controller.signal);
      if (!pc.live(st, runId)) return;

      if (!res.ok || !body || body.status === 'error') {
        const message = body && body.message;
        fail(window.MktforgeKit.accessError(res.status, message) || message || 'Something went wrong. Please try again.');
        return;
      }

      // Recorded whether or not this module is on screen — a run started
      // before navigating away is painted on the way back in.
      st.data = {
        customerList: body.customerList || null,
        jobTitles:    body.jobTitles || [],
        painPoints:   body.painPoints || [],
        topNeeds:     body.topNeeds || [],
        competitorsToWatch: readCompetitors(body.competitorsToWatch, rawUrl)
      };
      st.runUrl  = rawUrl;
      st.lastUrl = normalized;
      st.status  = 'Research complete.';

      if (onScreen(st)) {
        renderDashboard(st.data);
        el.status.textContent = st.status;
        setPdfEnabled(true);
      }
    } catch (err) {
      if (!pc.live(st, runId)) return;
      console.error('[Find My Customer]', err);
      fail('Could not reach the customer research service. Please try again.');
    } finally {
      if (!pc.end(st, runId)) return;     // cancelled by a company switch
      st.running = false;
      Mktforge.reportActivity('find-my-customer', st.error ? 'error' : 'idle');
      if (onScreen(st)) el.submit.disabled = false;
    }
  }

  /* ---------- PDF export (jsPDF + autoTable load on first click) ---------- */

  async function handlePdf() {
    if (!state.data) return;

    el.pdf.disabled = true;
    el.pdf.textContent = 'Preparing PDF…';

    try {
      // Order matters: autoTable attaches itself to the jsPDF global.
      await Mktforge.loadScript(JSPDF_SRC);
      await Mktforge.loadScript(AUTOTABLE_SRC);
      await Mktforge.loadScript(PDF_SRC);
      await window.MktforgeCustomerPdf.build({ companyUrl: state.runUrl, ...state.data });
    } catch (err) {
      console.error('[Find My Customer] PDF export failed', err);
      if (mounted) showError('Could not generate the PDF. Please try again.');
    } finally {
      if (mounted) {
        el.pdf.textContent = 'Save as PDF';
        setPdfEnabled(!!state.data);
      }
    }
  }

  /* ---------- carrying state across mount/unmount ---------- */

  function captureForm() {
    if (!el) return;
    state.form = { url: el.url.value };
  }

  function restore() {
    el.url.value   = state.form.url;

    if (state.running) {
      setAllBoxesLoading();
      el.submit.disabled = true;
      el.status.textContent = state.status;
    } else if (state.data) {
      renderDashboard(state.data);
      el.status.textContent = state.status;
      setPdfEnabled(true);
    }

    if (state.error) showError(state.error);
    else if (state.note) showError(state.note);
  }

  /* Company URL defaults to My Company's (assets/js/module-kit.js). */
  function autofill() {
    if (!window.MktforgeKit) return;
    window.MktforgeKit.seedCompanyUrl(el.url, state.urlSeed);
  }

  /* ---------- module contract ---------- */

  Mktforge.register({
    id:     'find-my-customer',
    label:  'Find My Customer',
    icon:   'crosshair',
    companyAware: true,
    styles: 'modules/find-my-customer/find-my-customer.css',

    mount(container) {
      container.innerHTML = MARKUP;
      mounted = true;
      cfg = (window.MKTFORGE_CONFIG && window.MKTFORGE_CONFIG.findMyCustomer) || {};

      const q = (name) => container.querySelector(`[data-el="${name}"]`);
      el = {
        form: q('form'), url: q('url'), submit: q('submit'),
        error: q('error'), pdf: q('pdf'), status: q('status')
      };

      boxes = {};
      container.querySelectorAll('[data-box]').forEach((b) => { boxes[b.dataset.box] = b; });

      el.form.addEventListener('submit', handleSubmit);
      el.pdf.addEventListener('click', handlePdf);
      boxes.jobTitles.addEventListener('click', handleTrackClick);
      boxes.competitorsToWatch.addEventListener('click', handleCompetitorClick);
      if (window.MktforgeData) {
        unsubProfile = window.MktforgeData.onProfile((p) => {
          paintTrackButtons(p.targetTitles || []);
          paintCompetitorButtons(p.competitors || []);
        });
      }

      // Only the person's own typing clears a "Run stopped" note, not autofill.
      const hold = (e) => { captureForm(); pc.hold(e && e.isTrusted ? undefined : state); };
      container.addEventListener('input', hold);
      container.addEventListener('change', hold);

      restore();
      autofill();
    },

    unmount() {
      captureForm();
      pc.hold(state);                   // keeps any "Run stopped" note
      mounted = false;
      if (unsubProfile) { unsubProfile(); unsubProfile = null; }
      // A run in flight is deliberately NOT aborted; see Persona Builder.
      el = null;
      boxes = null;
    }
  });

})();

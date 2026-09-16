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
       topNeeds:   [{ jobTitle, points: [string] }] }
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
     comes back. Lives for the life of the page, not across a reload. */
  const state = {
    form:     { url: '' },
    urlSeed:  { seeded: false },   // My Company URL default, once per sign-in
    data:     null,     // last successful payload, as rendered
    runUrl:   '',       // the URL exactly as submitted for `data` (PDF header)
    lastUrl:  null,     // normalized URL of `data`, for the duplicate guard
    status:   '',
    error:    '',
    running:  false
  };

  /* ---------- helpers ---------- */

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function normalizeUrl(value) {
    return String(value || '').trim().toLowerCase().replace(/\/+$/, '');
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

  function refreshTrackButtons() {
    if (!window.MktforgeData) return;
    window.MktforgeData.getProfile()
      .then((p) => paintTrackButtons(p.targetTitles || []))
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
      const profile = await window.MktforgeData.getProfile();
      const list = profile.targetTitles || [];
      const tracked = list.some((t) => sameTitle(t, title));
      profile.targetTitles = tracked
        ? list.filter((t) => !sameTitle(t, title))
        : [...list, String(title).trim()];
      const saved = await window.MktforgeData.saveProfile(profile);
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

  function renderDashboard(data) {
    renderCustomerList(data.customerList);
    renderJobTitles(data.jobTitles);
    renderPainPoints(data.painPoints);
    const needs = data.topNeeds || [];
    renderTopNeeds(boxes.topNeeds1, needs[0]);
    renderTopNeeds(boxes.topNeeds2, needs[1]);
  }

  /* ---------- request ---------- */

  async function requestDashboard(payload) {
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
      body: JSON.stringify(payload)
    });
    const body = await res.json().catch(() => null);
    return { res, body };
  }

  /* ---------- submit ---------- */

  async function handleSubmit(e) {
    e.preventDefault();
    if (state.running) return;
    clearError();
    state.error = '';

    const email  = window.MktforgeKit.accountEmail();
    const rawUrl = el.url.value.trim();

    const noAccess = window.MktforgeKit.accessProblem();
    if (noAccess) { showError(noAccess); return; }

    if (!rawUrl) {
      showError('Please enter a company URL.');
      return;
    }

    const normalized = normalizeUrl(rawUrl);
    if (state.lastUrl && normalized === state.lastUrl) {
      showError('Customer data for this company is already collected and shown below.');
      return;
    }

    if (!cfg.API_URL) {
      showError('Find My Customer isn’t configured — set findMyCustomer.API_URL in assets/js/config.js.');
      return;
    }

    captureForm();
    state.running = true;
    Mktforge.reportActivity('find-my-customer', 'running');
    state.data = null;
    state.lastUrl = null;
    state.status = 'Collecting data… this can take a minute.';
    el.submit.disabled = true;
    setPdfEnabled(false);
    setAllBoxesLoading();
    el.status.textContent = state.status;

    const fail = (message) => {
      state.error = message;
      state.status = '';
      if (mounted) {
        setAllBoxesPlaceholder();
        showError(message);
        el.status.textContent = '';
      }
    };

    try {
      const runningStatus = state.status;
      const context = await window.MktforgeKit.savedMaterials(cfg, {},
        (t) => { state.status = t; if (mounted) el.status.textContent = t; });
      state.status = runningStatus;
      if (mounted) el.status.textContent = runningStatus;

      const { res, body } = await requestDashboard({ companyUrl: rawUrl, email, ...(context ? { context } : {}) });

      if (!res.ok || !body || body.status === 'error') {
        const message = body && body.message;
        fail(window.MktforgeKit.accessError(res.status, message) || message || 'Something went wrong. Please try again.');
        return;
      }

      // Recorded whether or not this module is on screen — a run started
      // before navigating away is painted on the way back in.
      state.data = {
        customerList: body.customerList || null,
        jobTitles:    body.jobTitles || [],
        painPoints:   body.painPoints || [],
        topNeeds:     body.topNeeds || []
      };
      state.runUrl  = rawUrl;
      state.lastUrl = normalized;
      state.status  = 'Research complete.';

      if (mounted) {
        renderDashboard(state.data);
        el.status.textContent = state.status;
        setPdfEnabled(true);
      }
    } catch (err) {
      console.error('[Find My Customer]', err);
      fail('Could not reach the customer research service. Please try again.');
    } finally {
      state.running = false;
      Mktforge.reportActivity('find-my-customer', state.error ? 'error' : 'idle');
      if (mounted) el.submit.disabled = false;
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
      if (window.MktforgeData) {
        unsubProfile = window.MktforgeData.onProfile((p) => paintTrackButtons(p.targetTitles || []));
      }

      restore();
      autofill();
    },

    unmount() {
      captureForm();
      mounted = false;
      if (unsubProfile) { unsubProfile(); unsubProfile = null; }
      // A run in flight is deliberately NOT aborted; see Persona Builder.
      el = null;
      boxes = null;
    }
  });

})();

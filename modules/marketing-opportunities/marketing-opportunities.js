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

  const MARKUP = `
  <div class="mo">

    <header class="mo__head">
      <p class="mo__eyebrow">Marketing Opportunities</p>
      <h1 class="mo__title">Find the best places to reach your buyers</h1>
      <p class="mo__dek">Spot some of the best events and hidden gems that are a great match
        for your product, target customer, and industry.</p>
    </header>

    <section class="mo__submit" aria-label="Search inputs">
      <form class="mo__form" data-el="form" autocomplete="off" novalidate>
        <div class="mo__row">
          <div class="mo__field mo__field--wide">
            <label for="mo-url">Company URL</label>
            <input type="text" id="mo-url" data-el="companyUrl" placeholder="yourcompany.com">
          </div>
        </div>

        <div class="mo__row">
          <div class="mo__field">
            <label for="mo-title1">Job Title</label>
            <input type="text" id="mo-title1" data-el="jobTitle1" placeholder="e.g. Data Engineer">
          </div>
          <div class="mo__field">
            <label for="mo-title2">Job Title <span class="mo__optional">(optional)</span></label>
            <input type="text" id="mo-title2" data-el="jobTitle2" placeholder="Optional">
          </div>
          <div class="mo__field">
            <label for="mo-title3">Job Title <span class="mo__optional">(optional)</span></label>
            <input type="text" id="mo-title3" data-el="jobTitle3" placeholder="Optional">
          </div>
          <div class="mo__field">
            <label for="mo-industry">Industry <span class="mo__optional">(optional)</span></label>
            <input type="text" id="mo-industry" data-el="industry" placeholder="e.g. Oil and Gas">
          </div>
        </div>

        <div class="mo__submit-row">
          <button type="submit" class="mo__btn" data-el="submit" disabled>Find Opportunities</button>
          <p class="mo__hint" data-el="hint" aria-live="polite"></p>
        </div>
      </form>
      <p class="mo__error" data-el="error" role="alert" hidden></p>
    </section>

    <section class="mo__box mo__box--all" aria-label="All results">
      <h2>All Results <span class="mo__count" data-el="count"></span></h2>
      <div class="mo__box-body is-placeholder" data-box="all">No Data Collected</div>
    </section>

    <section class="mo__grid" aria-label="Results by channel">
      ${CATEGORY_ORDER.map((key) => `
      <article class="mo__box${key === 'social' ? ' mo__box--last' : ''}"><h2>${CATEGORY_LABELS[key]}</h2>
        <div class="mo__box-body is-placeholder" data-box="${key}">No Data Collected</div></article>`).join('')}
    </section>

    <div class="mo__pdf-row">
      <button type="button" class="mo__btn" data-el="pdf" disabled title="Run a search first">Create PDF</button>
      <p class="mo__status" data-el="status" aria-live="polite"></p>
    </div>

  </div>`;

  /* ---------- module-scoped handles (reset on every mount) ---------- */

  let el = null;
  let boxes = null;
  let cfg = {};
  let mounted = false;

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
      running: false
    }),
    held: ['form'],
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

  function renderCategory(b, items) {
    if (!items || items.length === 0) { emptyState(b); return; }
    b.className = 'mo__box-body';
    b.innerHTML =
      '<table><thead><tr><th>Name</th><th class="mo__col-link">Link</th></tr></thead><tbody>' +
      items.slice(0, MAX_ROWS).map((i) =>
        `<tr><td>${escapeHtml(i.name || 'Untitled')}</td><td class="mo__col-link">${linkCell(i.url)}</td></tr>`
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
    CATEGORY_ORDER.forEach((key) => renderCategory(boxes[key], run.results[key]));
    renderAll(boxes.all, run.allResults);
  }

  /* ---------- validation ---------- */

  function readForm() {
    return {
      companyUrl: el.companyUrl.value.trim(),
      jobTitle1:  el.jobTitle1.value.trim(),
      jobTitle2:  el.jobTitle2.value.trim(),
      jobTitle3:  el.jobTitle3.value.trim(),
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
    el.status.textContent = st.status;
    updateSubmitEnabled();

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
      const context = await window.MktforgeKit.savedMaterials(cfg, { jobTitles },
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

      if (onScreen(st)) {
        renderResults(st.run);
        el.status.textContent = st.status;
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

  /* ---------- PDF export ---------- */

  async function handlePdf() {
    if (!state.run) return;

    el.pdf.disabled = true;
    el.pdf.textContent = 'Preparing PDF…';

    try {
      // Order matters: autoTable attaches itself to the jsPDF global.
      await Mktforge.loadScript(JSPDF_SRC);
      await Mktforge.loadScript(AUTOTABLE_SRC);
      await Mktforge.loadScript(PDF_SRC);
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

    if (state.running) {
      setAllBoxesLoading();
      el.status.textContent = state.status;
    } else if (state.run) {
      renderResults(state.run);
      el.status.textContent = state.status;
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
    styles: 'modules/marketing-opportunities/marketing-opportunities.css',

    mount(container) {
      container.innerHTML = MARKUP;
      mounted = true;
      cfg = (window.MKTFORGE_CONFIG && window.MKTFORGE_CONFIG.marketingOpportunities) || {};

      const q = (name) => container.querySelector(`[data-el="${name}"]`);
      el = {
        form: q('form'), companyUrl: q('companyUrl'),
        jobTitle1: q('jobTitle1'), jobTitle2: q('jobTitle2'), jobTitle3: q('jobTitle3'),
        industry: q('industry'), submit: q('submit'), hint: q('hint'),
        error: q('error'), pdf: q('pdf'), status: q('status'), count: q('count')
      };

      boxes = {};
      container.querySelectorAll('[data-box]').forEach((b) => { boxes[b.dataset.box] = b; });

      ['companyUrl', 'jobTitle1'].forEach((k) =>
        el[k].addEventListener('input', updateSubmitEnabled));
      el.form.addEventListener('submit', handleSubmit);
      el.pdf.addEventListener('click', handlePdf);

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
      // A run in flight is deliberately NOT aborted; it finishes into state.
      el = null;
      boxes = null;
    }
  });

})();

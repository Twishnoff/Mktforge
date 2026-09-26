/* ==========================================================================
   Battle Card Generator — Mktforge module
   Ported from the standalone Competitive Battle Card Generator
   (github.com/Twishnoff/Battlecard-Generator). Same Cloudflare Worker, same
   request/response contract, same nine boxes, same copy-length rules and the
   same landscape jsPDF battle card. What changed:
     - the page's own header is gone; the shell provides the frame
     - every DOM lookup is scoped to the container the shell hands mount()
     - jsPDF and the PDF engine (battle-card-pdf.js) load on first PDF click
     - results, form values and an in-flight run survive navigating away
       (same pattern as Persona Builder / Find My Customer)

   Request:  POST { email, companyUrl, competitorUrl, jobTitle, industry, today }
   Response: { status, companyName, competitorName, generatedAt,
               logoDataUri, brandColor, boxes: { competitorProduct,
               ourFeatures, theirFeatures, topInitiatives, whereWeWin,
               competitorChallenges, customerReferences, talkingPoints,
               pricing } }
   ========================================================================== */

/* ---------- copy-length rules, shared with battle-card-pdf.js ----------
   The page and the PDF must show the SAME copy, so the caps live in one
   place. Unchanged from the standalone app.js — see its comments for the
   reasoning (never fragment a sentence; drop trailing items instead). */

window.MktforgeBattleCardText = (function () {

  const COPY_LIMIT = 300;
  const ITEM_LIMIT = 220;
  const BOX_TOTAL_LIMIT = 1100;
  const TOP_INITIATIVES_ITEM_LIMIT = 130;
  const TOP_INITIATIVES_TOTAL_LIMIT = 1300;
  const FEATURE_NAME_LIMIT = 40;

  const BOX_TITLES = {
    competitorProduct: 'Competitor and Product',
    ourFeatures: 'Our Key Features',
    theirFeatures: 'Their Key Features',
    topInitiatives: 'Top Prospect Initiatives',
    whereWeWin: 'Where We Win',
    competitorChallenges: 'Competitor Considerations',
    customerReferences: 'Customer References',
    talkingPoints: 'Key Talking Points',
    pricing: 'Pricing Overview'
  };

  function indexToLetter(index) {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 25) return null;
    return String.fromCharCode(65 + index);
  }

  // Trims to the last full sentence under the limit, else the last full word.
  function capToLimit(text, limit) {
    const max = limit || COPY_LIMIT;
    const t = String(text == null ? '' : text).trim();
    if (t.length <= max) return t;
    const slice = t.slice(0, max);
    const lastSentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
    if (lastSentenceEnd > max / 2) return slice.slice(0, lastSentenceEnd + 1).trim();
    const lastSpace = slice.lastIndexOf(' ');
    const base = lastSpace > max / 2 ? slice.slice(0, lastSpace) : slice.slice(0, max - 1);
    return `${base.trim()}…`;
  }

  // Last COMPLETE sentence ending within maxLen, or null (drop the item).
  function trimToCompleteSentence(text, maxLen) {
    const t = String(text == null ? '' : text).trim();
    if (t.length <= maxLen) return t;
    let lastEnd = -1;
    for (let i = 0; i < maxLen && i < t.length; i += 1) {
      const c = t[i];
      if (c === '.' || c === '!' || c === '?') {
        const next = t[i + 1];
        if (next === undefined || next === ' ' || next === '\n') lastEnd = i;
      }
    }
    if (lastEnd === -1) return null;
    return t.slice(0, lastEnd + 1).trim();
  }

  // Per-item cap, then a per-box running total; never cuts a sentence.
  function capBoxItems(items, getText, setText, itemLimit, totalBudget) {
    const withinItemLimit = [];
    for (const item of items) {
      const raw = getText(item);
      const text = String(raw == null ? '' : raw).trim();
      if (text.length <= itemLimit) { withinItemLimit.push(setText(item, text)); continue; }
      const trimmed = trimToCompleteSentence(text, itemLimit);
      if (trimmed) withinItemLimit.push(setText(item, trimmed));
    }
    const kept = [];
    let used = 0;
    for (const item of withinItemLimit) {
      const text = getText(item);
      if (kept.length > 0 && used + text.length > totalBudget) break;
      kept.push(item);
      used += text.length;
    }
    return kept;
  }

  const capInitiatives = (items) => capBoxItems(
    items || [], (t) => t, (item, text) => text,
    TOP_INITIATIVES_ITEM_LIMIT, TOP_INITIATIVES_TOTAL_LIMIT);

  const capWinLose = (items) => capBoxItems(
    items || [], (i) => i.explanation, (i, text) => ({ ...i, explanation: text }),
    ITEM_LIMIT, BOX_TOTAL_LIMIT);

  const theirFeaturesTitle = (competitorName) =>
    competitorName ? `${competitorName} Key Features` : 'Competitor Key Features';

  return {
    BOX_TITLES, FEATURE_NAME_LIMIT,
    indexToLetter, capToLimit, capInitiatives, capWinLose, theirFeaturesTitle
  };
})();

(function () {

  const T = window.MktforgeBattleCardText;
  const JSPDF_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  const PDF_SRC   = 'modules/battle-card-generator/battle-card-pdf.js';
  const FALLBACK_BRAND = '#2F6F4E';   // Mktforge green, if the Worker sends none

  const BOX_ORDER = [
    'competitorProduct', 'ourFeatures', 'theirFeatures',
    'topInitiatives', 'whereWeWin', 'competitorChallenges',
    'customerReferences', 'talkingPoints', 'pricing'
  ];

  const boxMarkup = BOX_ORDER.map((key) => `
      <article class="bcg__box"><h2 data-title="${key}">${
        key === 'theirFeatures' ? T.theirFeaturesTitle(null) : T.BOX_TITLES[key]
      }</h2>
        <div class="bcg__box-body is-placeholder" data-box="${key}">No Data Collected</div></article>`).join('');

  const MARKUP = `
  <div class="bcg">

    <header class="bcg__head">
      <p class="bcg__eyebrow">Battle Card Generator</p>
      <h1 class="bcg__title">Draft competitor-specific battle cards</h1>
      <p class="bcg__dek">Better prepare yourself for competitive deals by aligning your
        messaging and product to stand out against specific competitors when selling into
        specific job titles.</p>
    </header>

    <section class="bcg__submit" aria-label="Battle card inputs">
      <form class="bcg__form" data-el="form" autocomplete="off" novalidate>
        <div class="bcg__fields">
          <div class="bcg__field">
            <label for="bcg-company">Company URL</label>
            <input type="text" id="bcg-company" data-el="companyUrl" placeholder="yourcompany.com">
          </div>
          <div class="bcg__field">
            <label for="bcg-competitor">Competitor URL</label>
            <input type="text" id="bcg-competitor" data-el="competitorUrl" placeholder="competitor.com">
          </div>
          <div class="bcg__field">
            <label for="bcg-jobTitle">Job Title</label>
            <input type="text" id="bcg-jobTitle" data-el="jobTitle" placeholder="e.g. VP of Sales">
          </div>
          <div class="bcg__field">
            <label for="bcg-industry">Industry <span class="bcg__optional">(optional)</span></label>
            <input type="text" id="bcg-industry" data-el="industry" placeholder="e.g. Healthcare">
          </div>
        </div>

        <div class="bcg__submit-row">
          <button type="submit" class="bcg__btn" data-el="generate" disabled>Generate Battle Card</button>
          <p class="bcg__hint" data-el="hint" aria-live="polite"></p>
        </div>
      </form>
      <p class="bcg__error" data-el="error" role="alert" hidden></p>
    </section>

    <section class="bcg__grid is-idle" data-el="grid" aria-label="Battle card results">
      <div class="bcg__idle">
        <div class="bcg__intro">
          <img class="bcg__intro-img" src="modules/battle-card-generator/battle-card-panda.png"
            alt="" width="640" height="549">
          <div class="bcg__intro-copy">
            <p class="bcg__intro-title">Let's prepare for battle!</p>
            <p class="bcg__intro-text">Any competitor. Any job title. Any industry. We'll use this
              information to draft tailored one-page battle cards you can use to win any sales
              scenario.</p>
          </div>
        </div>
        <div class="bcg__idle-loading">
          <!-- The forging clips are shared with Find My Customer. -->
          <div class="bcg__forge-stage" aria-hidden="true">
            <video class="bcg__forge" data-el="forge" muted loop playsinline preload="auto"
              width="660" height="540" aria-hidden="true">
              <source src="modules/find-my-customer/find-customer-forge.webm" type="video/webm">
              <source src="modules/find-my-customer/find-customer-forge.mp4" type="video/mp4">
            </video>
            <video class="bcg__forge bcg__forge--end" data-el="forgeEnd" muted playsinline preload="auto"
              width="660" height="540" aria-hidden="true">
              <source src="modules/find-my-customer/find-customer-forge-end.webm" type="video/webm">
              <source src="modules/find-my-customer/find-customer-forge-end.mp4" type="video/mp4">
            </video>
          </div>
          <p class="bcg__status" data-el="status" aria-live="polite"></p>
        </div>
      </div>${boxMarkup}
    </section>

    <div class="bcg__pdf-row" data-el="pdfRow" hidden style="display:none">
      <button type="button" class="bcg__btn" data-el="pdf" disabled title="Run the generator first">Create Battle Card PDF</button>
    </div>

  </div>`;

  /* ---------- module-scoped handles (reset on every mount) ---------- */

  let el = null;
  let boxes = null;
  let theirTitleEl = null;
  let cfg = {};
  let mounted = false;

  /* One per company (MktforgeKit.perCompany), kept across navigation for the
     life of the page; typed input also survives a refresh. A run takes 30–90
     seconds, so surviving a module switch matters here. */
  const pc = window.MktforgeKit.perCompany('battle-card-generator', {
    create: () => ({
      form:    { companyUrl: '', competitorUrl: '', jobTitle: '', industry: '' },
      urlSeed: { seeded: false },   // My Company URL default, once per company
      run:     null,     // everything the page and the PDF need from the last success
      status:  '',
      error:   '',
      note:    '',
      running: false
    }),
    held: ['form'],
    snapshot: ['run', 'status']
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
    return /^https?:\/\//i.test(String(url || '')) ? url : null;
  }

  function showError(msg) { el.error.textContent = msg; el.error.hidden = false; }
  function clearError()   { el.error.hidden = true; el.error.textContent = ''; }

  function setPdfEnabled(on) {
    el.pdf.disabled = !on;
    el.pdf.title = on ? '' : 'Run the generator first';
  }

  function setTheirTitle(name) { theirTitleEl.textContent = T.theirFeaturesTitle(name); }

  function setAllBoxesLoading() {
    Object.values(boxes).forEach((b) => {
      b.className = 'bcg__box-body is-loading';
      b.innerHTML = '<span class="bcg__dot"></span><span class="bcg__dot"></span><span class="bcg__dot"></span>';
    });
    setTheirTitle(null);
  }

  function setAllBoxesPlaceholder() {
    Object.values(boxes).forEach((b) => {
      b.className = 'bcg__box-body is-placeholder';
      b.textContent = 'No Data Collected';
    });
    setTheirTitle(null);
  }

  function emptyState(b) {
    b.className = 'bcg__box-body is-placeholder';
    b.textContent = 'No Relevant Results Found';
  }

  function filled(b, html) {
    b.className = 'bcg__box-body';
    b.innerHTML = html;
  }

  /* ---------- renderers (mirror the field shapes the Worker sends) ---------- */

  function renderCompetitorProduct(b, data) {
    const cp = (data && data.competitorProduct) || {};
    if (!cp.competitorName && !cp.valueProposition && !cp.primaryProducts) { emptyState(b); return; }
    filled(b, `
      <div class="bcg__kv"><span class="bcg__k">Competitor Name</span>${escapeHtml(cp.competitorName || '—')}</div>
      <div class="bcg__kv"><span class="bcg__k">Value Proposition</span>${escapeHtml(T.capToLimit(cp.valueProposition) || '—')}</div>
      <div class="bcg__kv"><span class="bcg__k">Primary Products</span>${escapeHtml(T.capToLimit(cp.primaryProducts) || '—')}</div>`);
  }

  function renderFeatureTable(b, items) {
    if (!items || items.length === 0) { emptyState(b); return; }
    filled(b, '<table><tbody>' + items.map((i) =>
      `<tr><td class="bcg__name">${escapeHtml(i.name)}</td><td>${escapeHtml(T.capToLimit(i.description))}</td></tr>`
    ).join('') + '</tbody></table>');
  }

  function renderInitiatives(b, items) {
    if (!items || items.length === 0) { emptyState(b); return; }
    filled(b, T.capInitiatives(items).map((t, idx) =>
      `<div class="bcg__initiative"><span class="bcg__badge">${escapeHtml(T.indexToLetter(idx) || idx + 1)}</span>` +
      `<span>${escapeHtml(t)}</span></div>`
    ).join(''));
  }

  function renderWinLose(b, items, competeFlag) {
    if (!items || items.length === 0) { emptyState(b); return; }
    filled(b, '<table><tbody>' + T.capWinLose(items).map((i) => {
      const badge = i.initiativeLetter
        ? `<span class="bcg__badge bcg__badge--lg" title="Ties to Top Prospect Initiative ${escapeHtml(i.initiativeLetter)}">${escapeHtml(i.initiativeLetter)}</span>`
        : '';
      const compete = competeFlag && i.whereWeCompete ? '<span class="bcg__compete">Where We Compete</span>' : '';
      return `<tr><td class="bcg__feature-col"><div class="bcg__feature"><strong>${escapeHtml(T.capToLimit(i.feature, T.FEATURE_NAME_LIMIT))}</strong>${badge}${compete}</div></td>` +
             `<td>${escapeHtml(i.explanation)}</td></tr>`;
    }).join('') + '</tbody></table>');
  }

  function renderCustomerReferences(b, items) {
    if (!items || items.length === 0) { emptyState(b); return; }
    filled(b, '<table class="bcg__refs"><tbody>' + items.map((i) => {
      const tag = i.inIndustry ? '<span class="bcg__tag">In Industry</span>' : '';
      const url = safeUrl(i.referenceUrl);
      const link = url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${i.referenceType === 'case_study' ? 'Case Study' : 'Reference'}</a>`
        : '<span class="bcg__none">—</span>';
      return `<tr><td>${escapeHtml(i.name)}${tag}</td><td>${link}</td></tr>`;
    }).join('') + '</tbody></table>');
  }

  function renderTalkingPoints(b, items) {
    if (!items || items.length === 0) { emptyState(b); return; }
    filled(b, items.map((i) =>
      `<div class="bcg__qa"><p class="bcg__q">Q: ${escapeHtml(i.question)}</p>` +
      `<p class="bcg__a">A: ${escapeHtml(T.capToLimit(i.answer))}</p></div>`
    ).join(''));
  }

  function renderPricing(b, pricing) {
    const p = pricing || {};
    if (!p.summary) { emptyState(b); return; }
    filled(b, `<p class="${p.isPlaceholder ? 'bcg__muted' : ''}">${escapeHtml(T.capToLimit(p.summary))}</p>`);
  }

  function renderResults(run) {
    const d = run.boxes || {};
    renderCompetitorProduct(boxes.competitorProduct, d);
    renderFeatureTable(boxes.ourFeatures, d.ourFeatures);
    renderFeatureTable(boxes.theirFeatures, d.theirFeatures);
    renderInitiatives(boxes.topInitiatives, d.topInitiatives);
    renderWinLose(boxes.whereWeWin, d.whereWeWin, false);
    renderWinLose(boxes.competitorChallenges, d.competitorChallenges, true);
    renderCustomerReferences(boxes.customerReferences, d.customerReferences);
    renderTalkingPoints(boxes.talkingPoints, d.talkingPoints);
    renderPricing(boxes.pricing, d.pricing);
    setTheirTitle(run.competitorName);
  }

  /* ---------- validation ---------- */

  const REQUIRED = [
    ['companyUrl', 'company URL'],
    ['competitorUrl', 'competitor URL'], ['jobTitle', 'job title']
  ];

  function readForm() {
    return {
      companyUrl:    el.companyUrl.value.trim(),
      competitorUrl: el.competitorUrl.value.trim(),
      jobTitle:      el.jobTitle.value.trim(),
      industry:      el.industry.value.trim()
    };
  }

  function updateGenerateEnabled() {
    if (!mounted) return;
    const f = readForm();
    const missing = REQUIRED.filter(([k]) => !f[k]).map(([, label]) => label);
    el.generate.disabled = state.running || missing.length > 0;
    el.hint.textContent = !state.running && missing.length ? `Still needed: ${missing.join(', ')}.` : '';
  }

  // Same messages as the standalone app (and the Worker).
  function validate(f) {
    const missing = REQUIRED.filter(([k]) => !f[k]).map(([k]) => k);
    if (missing.length === 0) return null;
    if (missing.length >= 2) return 'Please Provide Required Information';
    return {
      companyUrl: 'Company URL Is Required',
      competitorUrl: 'Competitor URL Is Required',
      jobTitle: 'Job Title Is Required'
    }[missing[0]];
  }

  /* ---------- request ---------- */

  async function requestBattleCard(body, signal) {
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

    if (!cfg.API_URL) {
      showError('Battle Card Generator isn’t configured — set battleCardGenerator.API_URL in assets/js/config.js.');
      return;
    }

    captureForm();
    const runId = pc.begin(st);
    st.running = true;
    Mktforge.reportActivity('battle-card-generator', 'running');
    st.run = null;
    st.status = 'Researching both companies… this usually takes 30–90 seconds.';
    setPdfEnabled(false);
    setAllBoxesLoading();
    setView('loading');
    el.status.textContent = st.status;
    updateGenerateEnabled();

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
      const context = await window.MktforgeKit.savedMaterials(cfg,
        { jobTitles: [f.jobTitle], competitorUrl: f.competitorUrl, data: window.MktforgeData.company(st._cid) },
        (t) => { st.status = t; if (onScreen(st)) el.status.textContent = t; });
      if (!pc.live(st, runId)) return;
      st.status = runningStatus;
      if (onScreen(st)) el.status.textContent = runningStatus;

      const { res, payload } = await requestBattleCard({
        ...(context ? { context } : {}),
        email: window.MktforgeKit.accountEmail(),
        companyUrl: f.companyUrl,
        competitorUrl: f.competitorUrl,
        jobTitle: f.jobTitle,
        industry: f.industry || null,
        today: new Date().toISOString().slice(0, 10)
      }, st.controller.signal);
      if (!pc.live(st, runId)) return;

      if (!res.ok || !payload || payload.status === 'error') {
        const message = payload && payload.message;
        fail(window.MktforgeKit.accessError(res.status, message) || message || 'Something went wrong. Please try again.');
        return;
      }

      // Recorded whether or not the module is on screen.
      st.run = {
        companyUrl:    f.companyUrl,
        competitorUrl: f.competitorUrl,
        companyName:    payload.companyName || f.companyUrl,
        competitorName: payload.competitorName || f.competitorUrl,
        jobTitle:  f.jobTitle,
        industry:  f.industry || null,
        generatedAt: payload.generatedAt || new Date().toISOString(),
        logoDataUri: payload.logoDataUri || null,
        brandColor:  payload.brandColor || FALLBACK_BRAND,
        boxes:       payload.boxes || {}
      };
      st.status = 'Battle card ready.';

      // The panda finishes his pass and puts the hammer down first, with
      // "Battle card ready." under him while he does.
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
      console.error('[Battle Card Generator]', err);
      fail('Could not reach the backend. Please try again.');
    } finally {
      if (!pc.end(st, runId)) return;     // cancelled by a company switch
      st.running = false;
      Mktforge.reportActivity('battle-card-generator', st.error ? 'error' : 'idle');
      updateGenerateEnabled();
    }
  }

  /* ---------- the single box that stands in for the results ----------
       'intro'   — before a run (or after one that failed): the panda + copy
       'loading' — while a run is researching: the forging panda + progress
       'results' — the nine boxes, with the battle card in them */
  function setView(view) {
    el.grid.classList.toggle('is-idle', view !== 'results');
    el.grid.classList.toggle('is-running', view === 'loading');
    // Nothing to save until there are results. Set inline too, so no
    // stylesheet (even a stale cached one) can bring the button back early.
    el.pdfRow.hidden = view !== 'results';
    el.pdfRow.style.display = view === 'results' ? '' : 'none';
    playForge(view === 'loading');
  }

  /* The forging panda: two clips stacked in one spot. `forge` loops while a
     run researches; `forgeEnd` (the last strike, then the hammer goes down)
     plays once when the battle card arrives, before it's shown. Nothing
     plays for anyone who has asked their system for reduced motion — the
     first frame stays up and results appear straight away. */
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
      await Mktforge.loadScript(JSPDF_SRC);
      await Mktforge.loadScript(PDF_SRC);
      // Switched company while the PDF tools loaded: don't save it into the other one.
      if (state._cid !== pdfCid) return;
      await window.MktforgeBattleCardPdf.build(state.run);
    } catch (err) {
      console.error('[Battle Card Generator] PDF export failed', err);
      if (mounted) showError('Could not generate the PDF. Please try again.');
    } finally {
      if (mounted) {
        el.pdf.textContent = 'Create Battle Card PDF';
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
    el.companyUrl.value    = f.companyUrl;
    el.competitorUrl.value = f.competitorUrl;
    el.jobTitle.value      = f.jobTitle;
    el.industry.value      = f.industry;

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
    window.MktforgeKit.seedCompanyUrl(el.companyUrl, state.urlSeed);
    window.MktforgeKit.attachPicker(el.competitorUrl, (p) => p.competitors);
    window.MktforgeKit.attachPicker(el.jobTitle,      (p) => p.targetTitles);
    window.MktforgeKit.attachPicker(el.industry,      (p) => p.targetIndustries);
  }

  /* ---------- module contract ---------- */

  Mktforge.register({
    id:     'battle-card-generator',
    label:  'Battle Card Generator',
    icon:   'swords',
    companyAware: true,
    // The ?v= changes whenever this stylesheet does, so a browser holding the
    // old copy (GitHub Pages lets browsers cache for ~10 minutes) fetches the
    // new one instead of pairing new markup with old styles.
    styles: 'modules/battle-card-generator/battle-card-generator.css?v=2026-09-26a',

    mount(container) {
      container.innerHTML = MARKUP;
      mounted = true;
      cfg = (window.MKTFORGE_CONFIG && window.MKTFORGE_CONFIG.battleCardGenerator) || {};

      const q = (name) => container.querySelector(`[data-el="${name}"]`);
      el = {
        form: q('form'), companyUrl: q('companyUrl'),
        competitorUrl: q('competitorUrl'), jobTitle: q('jobTitle'), industry: q('industry'),
        generate: q('generate'), hint: q('hint'), error: q('error'),
        pdf: q('pdf'), status: q('status'),
        grid: q('grid'), forge: q('forge'), forgeEnd: q('forgeEnd'), pdfRow: q('pdfRow')
      };
      theirTitleEl = container.querySelector('[data-title="theirFeatures"]');

      boxes = {};
      container.querySelectorAll('[data-box]').forEach((b) => { boxes[b.dataset.box] = b; });

      ['companyUrl', 'competitorUrl', 'jobTitle'].forEach((k) =>
        el[k].addEventListener('input', updateGenerateEnabled));
      el.form.addEventListener('submit', handleSubmit);
      el.pdf.addEventListener('click', handlePdf);

      // Only the person's own typing clears a "Run stopped" note, not autofill.
      const hold = (e) => { captureForm(); pc.hold(e && e.isTrusted ? undefined : state); };
      container.addEventListener('input', hold);
      container.addEventListener('change', hold);

      restore();
      updateGenerateEnabled();
      autofill();
    },

    unmount() {
      captureForm();
      pc.hold(state);                   // keeps any "Run stopped" note
      mounted = false;
      if (el && el.forge) { el.forge.pause(); el.forgeEnd.pause(); }
      if (forgeDone) forgeDone();       // a waiting finish shows results on the way back
      // A run in flight is deliberately NOT aborted; it finishes into state.
      el = null;
      boxes = null;
      theirTitleEl = null;
    }
  });

})();

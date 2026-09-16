/* ==========================================================================
   Persona Builder — Mktforge module
   Ported from the standalone Persona Drafter (twishnoff.github.io/Persona-Drafter).
   Same Cloudflare Worker, same SSE contract, same six result boxes.
   What changed:
     - the page's own header/footer are gone; the shell provides the frame
     - every DOM lookup is scoped to the container the shell hands mount(),
       so nothing reaches outside this module
     - no Turnstile checkbox: the Worker skips that check when the request
       carries a valid Mktforge sign-in token (Authorization: Bearer ...).
       The standalone site still shows it.
     - jsPDF loads on demand instead of on every page load
     - an in-flight run is aborted if the user navigates to another module

   Field names must keep matching worker/src/lib/schema.js (finalize_persona).
   ========================================================================== */

(function () {

  const JSPDF_SRC     = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

  const MARKUP = `
  <div class="pb">

    <header class="pb__head">
      <p class="pb__eyebrow">Persona Builder</p>
      <h1 class="pb__title">Create a buyer persona</h1>
      <p class="pb__dek">Better know your customer&rsquo;s challenges and needs so you can craft
        messaging that resonates and build more engaging GTM strategies.</p>
    </header>

    <section class="pb__submit" aria-label="Target persona inputs">
      <form class="pb__form" data-el="form" novalidate>
        <div class="pb__field">
          <label for="pb-jobTitle">Job Title</label>
          <input type="text" id="pb-jobTitle" data-el="jobTitle" placeholder="e.g. Growth Marketing Manager" required>
        </div>

        <div class="pb__field">
          <label for="pb-companySize">Company Size</label>
          <select id="pb-companySize" data-el="companySize" required>
            <option value="" disabled selected>Select Company Size</option>
            <option value="Enterprise ($1B+ ARR)">Enterprise ($1B+ ARR)</option>
            <option value="Midmarket ($50M - $999M ARR)">Midmarket ($50M - $999M ARR)</option>
            <option value="Small Business (&lt; $50M ARR)">Small Business (&lt; $50M ARR)</option>
            <option value="No Preference">No Preference</option>
          </select>
        </div>

        <div class="pb__field">
          <label for="pb-industry">Industry <span class="pb__optional">(optional)</span></label>
          <input type="text" id="pb-industry" data-el="industry" placeholder="e.g. Fintech">
        </div>

        <div class="pb__field pb__submit-row">
          <button type="submit" class="pb__btn" data-el="generate" disabled>Generate Persona</button>
          <p class="pb__hint" data-el="hint" aria-live="polite"></p>
          <p class="pb__error" data-el="error" role="alert" hidden></p>
        </div>
      </form>
    </section>

    <section class="pb__grid" aria-label="Persona research results">
      <article class="pb__box"><h2>Overview</h2>
        <div class="pb__box-body is-placeholder" data-box="overview">No Data Collected</div></article>
      <article class="pb__box"><h2>Sample Profiles</h2>
        <div class="pb__box-body is-placeholder" data-box="profiles">No Data Collected</div></article>
      <article class="pb__box"><h2>Where They Gather</h2>
        <div class="pb__box-body is-placeholder" data-box="gather">No Data Collected</div></article>
      <article class="pb__box"><h2>Organizational Structure</h2>
        <div class="pb__box-body is-placeholder" data-box="org">No Data Collected</div></article>
      <article class="pb__box"><h2>Their Immediate Work Priorities</h2>
        <div class="pb__box-body is-placeholder" data-box="work">No Data Collected</div></article>
      <article class="pb__box"><h2>Their Development Priorities</h2>
        <div class="pb__box-body is-placeholder" data-box="development">No Data Collected</div></article>
    </section>

    <div class="pb__pdf-row">
      <button class="pb__btn" data-el="pdf" disabled>Create Persona PDF</button>
      <p class="pb__status" data-el="status" aria-live="polite"></p>
    </div>

  </div>`;

  /* ---------- module-scoped state (reset on every mount) ---------- */

  let el = null;              // { form, jobTitle, ... } scoped element map
  let boxes = null;
  let cfg = {};
  let abortController = null;
  let mounted = false;

  /* Everything worth keeping when the user navigates to another module and
     comes back. This closure outlives mount/unmount, so it survives for the
     life of the page — but not a reload. */
  const state = {
    form:    { jobTitle: '', companySize: '', industry: '' },
    persona: null,
    status:  '',
    error:   '',
    running: false
  };

  /* ---------- helpers ---------- */

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function linkOrText(text, url) {
    const safeText = escapeHtml(text);
    if (!url) return safeText;
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${safeText}</a>`;
  }

  function setAllBoxesLoading() {
    Object.values(boxes).forEach((b) => {
      b.className = 'pb__box-body is-loading';
      b.innerHTML = '<span class="pb__dot"></span><span class="pb__dot"></span><span class="pb__dot"></span>';
    });
  }

  function setAllBoxesPlaceholder() {
    Object.values(boxes).forEach((b) => {
      b.className = 'pb__box-body is-placeholder';
      b.textContent = 'No Data Collected';
    });
  }

  function showFormError(msg) { el.error.textContent = msg; el.error.hidden = false; }
  function clearFormError()   { el.error.hidden = true; el.error.textContent = ''; }

  /* ---------- renderers, one per box ---------- */

  function renderOverview(o) {
    const b = boxes.overview;
    b.className = 'pb__box-body';
    if (!o) { b.innerHTML = '<p class="pb__empty">No overview data returned.</p>'; return; }

    const tools = (o.common_tools || [])
      .map((t) => linkOrText(t.name, t.url))
      .join(', ') || '<span class="pb__empty">none found</span>';

    const rows = [
      ['Primary Job Title', escapeHtml(o.primary_job_title)],
      ['Secondary Job Titles', escapeHtml((o.secondary_job_titles || []).join(', ')) || '<span class="pb__empty">none found</span>'],
      ['Job Level', escapeHtml(o.job_level)],
      ['Average Years of Experience', escapeHtml(o.avg_years_experience)],
      ['Company Size', escapeHtml(o.company_size_label)],
      ['Industry', escapeHtml(o.industry_label) || '<span class="pb__empty">not specified</span>'],
      ['Common Tools', tools]
    ];

    b.innerHTML = '<div class="pb__kv">' +
      rows.map(([k, v]) => `<div class="pb__kv-row"><span class="pb__k">${k}:</span><span class="pb__v">${v}</span></div>`).join('') +
      '</div>';
  }

  function renderProfiles(rows) {
    const b = boxes.profiles;
    b.className = 'pb__box-body';
    if (!rows || rows.length === 0) {
      b.innerHTML = '<p class="pb__empty">No matching public profiles found.</p>';
      return;
    }
    b.innerHTML =
      '<table><thead><tr><th>Job Title</th><th>Company</th><th>Link</th></tr></thead><tbody>' +
      rows.map((r) =>
        `<tr><td>${escapeHtml(r.job_title)}</td><td>${escapeHtml(r.company)}</td><td>${linkOrText('Profile', r.url)}</td></tr>`
      ).join('') +
      '</tbody></table>';
  }

  function renderGather(rows) {
    const b = boxes.gather;
    b.className = 'pb__box-body';
    if (!rows || rows.length === 0) {
      b.innerHTML = '<p class="pb__empty">No channels found.</p>';
      return;
    }
    b.innerHTML =
      '<table><thead><tr><th>Name</th><th>Type</th><th>Link</th></tr></thead><tbody>' +
      rows.map((r) =>
        `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.type)}</td><td>${linkOrText('Visit', r.url)}</td></tr>`
      ).join('') +
      '</tbody></table>';
  }

  function renderOrg(org) {
    const b = boxes.org;
    b.className = 'pb__box-body';
    if (!org) { b.innerHTML = '<p class="pb__empty">No org structure data returned.</p>'; return; }

    const parts = [];
    if (org.reports_to) {
      parts.push(`<div class="pb__tier"><span class="pb__tier-label">Reports To</span>${escapeHtml(org.reports_to)}</div>`);
      parts.push('<div class="pb__connector"></div>');
    }
    parts.push(`<div class="pb__tier is-this-role"><span class="pb__tier-label">This Role</span>${escapeHtml(org.this_role)}</div>`);

    const hasManages = !!org.manages;
    const hasStakeholders = (org.stakeholders || []).length > 0;
    if (hasManages || hasStakeholders) {
      parts.push('<div class="pb__connector"></div>');
      const branchParts = [];
      if (hasManages) {
        branchParts.push(`<div class="pb__tier"><span class="pb__tier-label">Manages</span>${escapeHtml(org.manages)}</div>`);
      }
      if (hasStakeholders) {
        const stakeholderHtml = org.stakeholders.map((s) => linkOrText(s.name, s.url)).join(', ');
        branchParts.push(`<div class="pb__tier"><span class="pb__tier-label">Stakeholders</span>${stakeholderHtml}</div>`);
      }
      parts.push(`<div class="pb__branches">${branchParts.join('')}</div>`);
    }

    b.innerHTML = `<div class="pb__orgchart">${parts.join('')}</div>`;
  }

  function renderRankList(target, items, emptyMsg) {
    const b = boxes[target];
    b.className = 'pb__box-body';
    if (!items || items.length === 0) {
      b.innerHTML = `<p class="pb__empty">${emptyMsg}</p>`;
      return;
    }
    b.innerHTML = '<ol class="pb__rank">' + items.map((i) => `<li>${escapeHtml(i)}</li>`).join('') + '</ol>';
  }

  function renderPersona(persona) {
    renderOverview(persona.overview);
    renderProfiles(persona.sample_profiles);
    renderGather(persona.where_they_gather);
    renderOrg(persona.org_structure);
    renderRankList('work', persona.work_priorities, 'No priorities found.');
    renderRankList('development', persona.development_priorities, 'No priorities found.');
  }

  /* ---------- form readiness ---------- */

  function updateGenerateEnabled() {
    if (!mounted) return;

    const missing = [];
    if (!el.jobTitle.value.trim())    missing.push('job title');
    if (!el.companySize.value)        missing.push('company size');

    el.generate.disabled = state.running || missing.length > 0;
    el.hint.textContent = !state.running && missing.length ? `Still needed: ${missing.join(', ')}.` : '';
  }

  /* ---------- SSE over fetch (EventSource can't POST a body) ---------- */

  async function streamGenerate(payload, { onStatus, onResult, onError }) {
    abortController = new AbortController();

    // Prove which account is calling. The Worker verifies this signature
    // against Google's public keys, and a valid one is what lets it skip the
    // Turnstile check the standalone site needs. The email in the body is
    // not trusted for anything.
    const headers = { 'content-type': 'application/json' };
    const token = await (window.MktforgeAuth.getIdToken
      ? window.MktforgeAuth.getIdToken()
      : Promise.resolve(null));
    if (!token) {
      onError(window.MktforgeKit.NO_ACCESS);
      return;
    }
    headers.authorization = `Bearer ${token}`;

    const resp = await fetch(`${cfg.API_BASE_URL}/api/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: abortController.signal
    });

    if (!resp.ok) {
      let message = `Request failed (${resp.status}).`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (e) { /* keep the default message */ }
      onError(window.MktforgeKit.accessError(resp.status, message) || message);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIndex;
      while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        const eventMatch = rawEvent.match(/^event:\s*(.+)$/m);
        const dataMatch = rawEvent.match(/^data:\s*(.+)$/m);
        if (!dataMatch) continue;

        const eventType = eventMatch ? eventMatch[1].trim() : 'message';
        let data;
        try { data = JSON.parse(dataMatch[1]); } catch (e) { continue; }

        if (eventType === 'status') onStatus(data.message);
        else if (eventType === 'result') onResult(data);
        else if (eventType === 'error') onError(window.MktforgeKit.accessError(null, data.message) || data.message);
      }
    }
  }

  /* ---------- submit ---------- */

  async function handleSubmit(e) {
    e.preventDefault();
    clearFormError();

    if (!cfg.API_BASE_URL) {
      showFormError('Persona Builder isn’t configured — set API_BASE_URL in assets/js/config.js.');
      return;
    }

    const noAccess = window.MktforgeKit.accessProblem();
    if (noAccess) { showFormError(noAccess); return; }

    if (abortController) abortController.abort();   // supersede any earlier run

    captureForm();
    el.generate.disabled = true;
    el.pdf.disabled = true;
    state.persona = null;
    state.error = '';
    state.running = true;
    Mktforge.reportActivity('persona-builder', 'running');
    updateGenerateEnabled();
    state.status = 'Conducting Research…';
    setAllBoxesLoading();
    el.status.textContent = state.status;

    const payload = {
      email: window.MktforgeKit.accountEmail(),
      jobTitle: el.jobTitle.value.trim(),
      companySize: el.companySize.value,
      industry: el.industry.value.trim()
    };

    try {
      await streamGenerate(payload, {
        onStatus: (message) => {
          state.status = message || 'Conducting Research…';
          if (mounted) el.status.textContent = state.status;
        },
        onResult: (data) => {
          // Recorded whether or not this module is on screen — a run started
          // before navigating away finishes into state and is painted on the
          // way back in.
          state.persona = data.persona;
          state.status = data.partial
            ? 'Done — research budget ran out before every box was fully filled in.'
            : 'Research complete.';
          if (mounted) {
            renderPersona(data.persona);
            el.status.textContent = state.status;
            el.pdf.disabled = false;
          }
        },
        onError: (message) => {
          state.error = message || 'Something went wrong. Please try again.';
          state.status = '';
          state.persona = null;
          if (mounted) {
            setAllBoxesPlaceholder();
            showFormError(state.error);
            el.status.textContent = '';
          }
        }
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return;   // superseded by a new run
      console.error(err);
      state.error = 'Network error — please try again.';
      state.status = '';
      if (mounted) {
        setAllBoxesPlaceholder();
        showFormError(state.error);
        el.status.textContent = '';
      }
    } finally {
      state.running = false;
      Mktforge.reportActivity('persona-builder', state.error ? 'error' : 'idle');
      abortController = null;
      updateGenerateEnabled();
    }
  }

  /* ---------- PDF export (jsPDF loads on first click) ---------- */

  async function handlePdf() {
    if (!state.persona) return;

    const original = el.pdf.textContent;
    el.pdf.disabled = true;
    el.pdf.textContent = 'Preparing PDF…';

    try {
      await Mktforge.loadScript(JSPDF_SRC);
      await Mktforge.loadScript('modules/persona-builder/persona-pdf.js');
      await window.MktforgePersonaPdf.build(state.persona);
    } catch (err) {
      console.error('PDF export failed:', err);
      if (mounted) showFormError("Couldn't generate the PDF — please try again.");
    } finally {
      if (mounted) {
        el.pdf.disabled = false;
        el.pdf.textContent = original;
      }
    }
  }

  /* ---------- carrying state across mount/unmount ---------- */

  function captureForm() {
    if (!el) return;
    state.form = {
      jobTitle:    el.jobTitle.value,
      companySize: el.companySize.value,
      industry:    el.industry.value
    };
  }

  function restore() {
    el.jobTitle.value    = state.form.jobTitle;
    el.companySize.value = state.form.companySize;
    el.industry.value    = state.form.industry;

    if (state.running) {
      setAllBoxesLoading();
      el.status.textContent = state.status || 'Conducting Research…';
    } else if (state.persona) {
      renderPersona(state.persona);
      el.status.textContent = state.status;
      el.pdf.disabled = false;
    }

    if (state.error) showFormError(state.error);
  }

  /* My Company values as drop-down choices (assets/js/module-kit.js). */
  function autofill() {
    if (!window.MktforgeKit) return;
    window.MktforgeKit.attachPicker(el.jobTitle, (p) => p.targetTitles);
    window.MktforgeKit.attachPicker(el.industry, (p) => p.targetIndustries);
  }

  /* ---------- module contract ---------- */

  Mktforge.register({
    id:     'persona-builder',
    label:  'Persona Builder',
    icon:   'persona',
    styles: 'modules/persona-builder/persona-builder.css',

    mount(container) {
      container.innerHTML = MARKUP;
      mounted = true;
      cfg = (window.MKTFORGE_CONFIG && window.MKTFORGE_CONFIG.personaBuilder) || {};

      const q = (name) => container.querySelector(`[data-el="${name}"]`);
      el = {
        form: q('form'), jobTitle: q('jobTitle'),
        companySize: q('companySize'), industry: q('industry'),
        generate: q('generate'), hint: q('hint'),
        error: q('error'), pdf: q('pdf'), status: q('status')
      };

      boxes = {};
      container.querySelectorAll('[data-box]').forEach((b) => { boxes[b.dataset.box] = b; });

      [el.jobTitle, el.companySize].forEach((node) =>
        node.addEventListener('input', updateGenerateEnabled));
      el.companySize.addEventListener('change', updateGenerateEnabled);
      el.form.addEventListener('submit', handleSubmit);
      el.pdf.addEventListener('click', handlePdf);

      restore();
      updateGenerateEnabled();
      autofill();
    },

    unmount() {
      captureForm();
      mounted = false;

      // A run in flight is deliberately NOT aborted. Leaving mid-research and
      // losing a minute of work is the exact frustration this is meant to fix;
      // the callbacks above write into `state` and check `mounted` before
      // touching any DOM, so it finishes safely with nothing on screen.
      el = null;
      boxes = null;
      // Listeners die with the DOM nodes the shell clears.
    }
  });

})();

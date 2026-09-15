/* ==========================================================================
   Persona Builder — Mktforge module
   Ported from the standalone Persona Drafter (twishnoff.github.io/Persona-Drafter).
   Same Cloudflare Worker, same Turnstile site key, same SSE contract, same
   six result boxes. What changed:
     - the page's own header/footer are gone; the shell provides the frame
     - every DOM lookup is scoped to the container the shell hands mount(),
       so nothing reaches outside this module
     - Turnstile and jsPDF load on demand instead of on every page load
     - an in-flight run is aborted if the user navigates to another module

   Field names must keep matching worker/src/lib/schema.js (finalize_persona).
   ========================================================================== */

(function () {

  const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  const JSPDF_SRC     = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

  const MARKUP = `
  <div class="pb">

    <header class="pb__head">
      <p class="pb__eyebrow">Persona Builder</p>
      <h1 class="pb__title">Draft a buyer persona</h1>
      <p class="pb__dek">First-draft buyer persona from a job title. Not a substitute for
        talking to real customers &mdash; a head start on the research before you do.</p>
    </header>

    <section class="pb__submit" aria-label="Target persona inputs">
      <form class="pb__form" data-el="form" novalidate>
        <div class="pb__field">
          <label for="pb-email">Email</label>
          <input type="email" id="pb-email" data-el="email" placeholder="you@company.com" required autocomplete="email">
        </div>

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

        <div class="pb__field pb__field--turnstile">
          <label>Verification</label>
          <div data-el="turnstile"></div>
          <p class="pb__note" data-el="turnstileNote">Loading verification…</p>
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

  let el = null;              // { form, email, ... } scoped element map
  let boxes = null;
  let cfg = {};
  let turnstileToken = null;
  let turnstileWidgetId = null;
  let lastPersona = null;
  let abortController = null;
  let mounted = false;

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

  /* ---------- Turnstile ---------- */

  function updateGenerateEnabled() {
    if (!mounted) return;

    const missing = [];
    if (!el.email.value.trim())       missing.push('email');
    if (!el.jobTitle.value.trim())    missing.push('job title');
    if (!el.companySize.value)        missing.push('company size');
    if (!turnstileToken)              missing.push('verification');

    el.generate.disabled = missing.length > 0;

    // A disabled button with no explanation is the worst possible failure
    // mode — if the captcha silently fails to load there is nothing on
    // screen telling you why nothing happens.
    el.hint.textContent = missing.length ? `Still needed: ${missing.join(', ')}.` : '';
  }

  function setTurnstileNote(msg, isError) {
    if (!mounted || !el.turnstileNote) return;
    el.turnstileNote.textContent = msg || '';
    el.turnstileNote.hidden = !msg;
    el.turnstileNote.classList.toggle('is-error', !!isError);
  }

  async function initTurnstile() {
    if (!cfg.TURNSTILE_SITE_KEY) {
      setTurnstileNote('No Turnstile site key set in assets/js/config.js.', true);
      return;
    }

    setTurnstileNote('Loading verification\u2026');

    try {
      // async:false matters. Turnstile inspects its own <script> tag and
      // refuses to initialize when it carries async or defer.
      await Mktforge.loadScript(TURNSTILE_SRC, { async: false });
    } catch (err) {
      console.error(err);
      if (mounted) setTurnstileNote("Couldn't reach Cloudflare to load the verification widget.", true);
      return;
    }

    if (!mounted) return;

    if (!window.turnstile || typeof window.turnstile.render !== 'function') {
      setTurnstileNote('Verification script loaded but did not initialize.', true);
      return;
    }

    // Deliberately NOT calling turnstile.ready(): on a script tag injected
    // at runtime it throws ("Remove async/defer ... before using
    // turnstile.ready()"). The tag's own onload has already fired by this
    // point, so the API is initialized and render() can be called directly.
    try {
      turnstileWidgetId = window.turnstile.render(el.turnstile, {
        sitekey: cfg.TURNSTILE_SITE_KEY,
        callback: (token) => {
          turnstileToken = token;
          setTurnstileNote('');
          updateGenerateEnabled();
        },
        'expired-callback': () => {
          turnstileToken = null;
          setTurnstileNote('Verification expired — tick the box again.');
          updateGenerateEnabled();
        },
        'error-callback': (code) => {
          turnstileToken = null;
          console.error('[Persona Builder] Turnstile error', code);
          setTurnstileNote(`Verification failed (${code || 'unknown'}). If this page is on a new domain, add it to the Turnstile widget's hostname list.`, true);
          updateGenerateEnabled();
        }
      });
      setTurnstileNote('');
    } catch (err) {
      console.error('[Persona Builder] Turnstile render failed', err);
      setTurnstileNote('Verification widget failed to render — see the browser console.', true);
    }
  }

  /* ---------- SSE over fetch (EventSource can't POST a body) ---------- */

  async function streamGenerate(payload, { onStatus, onResult, onError }) {
    abortController = new AbortController();

    const resp = await fetch(`${cfg.API_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abortController.signal
    });

    if (!resp.ok) {
      let message = `Request failed (${resp.status}).`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (e) { /* keep the default message */ }
      onError(message);
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
        else if (eventType === 'error') onError(data.message);
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

    el.generate.disabled = true;
    el.pdf.disabled = true;
    lastPersona = null;
    setAllBoxesLoading();
    el.status.textContent = 'Conducting Research…';

    const payload = {
      email: el.email.value.trim(),
      jobTitle: el.jobTitle.value.trim(),
      companySize: el.companySize.value,
      industry: el.industry.value.trim(),
      turnstileToken
    };

    try {
      await streamGenerate(payload, {
        onStatus: (message) => {
          if (mounted) el.status.textContent = message || 'Conducting Research…';
        },
        onResult: (data) => {
          if (!mounted) return;
          lastPersona = data.persona;
          renderPersona(data.persona);
          el.status.textContent = data.partial
            ? 'Done — research budget ran out before every box was fully filled in.'
            : 'Research complete.';
          el.pdf.disabled = false;
        },
        onError: (message) => {
          if (!mounted) return;
          setAllBoxesPlaceholder();
          showFormError(message || 'Something went wrong. Please try again.');
          el.status.textContent = '';
        }
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return;   // user left the module
      console.error(err);
      if (mounted) {
        setAllBoxesPlaceholder();
        showFormError('Network error — please try again.');
        el.status.textContent = '';
      }
    } finally {
      abortController = null;
      // Turnstile tokens are single-use; reset the widget for the next run.
      if (mounted && window.turnstile && turnstileWidgetId !== null) {
        window.turnstile.reset(turnstileWidgetId);
      }
      turnstileToken = null;
      updateGenerateEnabled();
    }
  }

  /* ---------- PDF export (jsPDF loads on first click) ---------- */

  async function handlePdf() {
    if (!lastPersona) return;

    const original = el.pdf.textContent;
    el.pdf.disabled = true;
    el.pdf.textContent = 'Preparing PDF…';

    try {
      await Mktforge.loadScript(JSPDF_SRC);
      await Mktforge.loadScript('modules/persona-builder/persona-pdf.js');
      window.MktforgePersonaPdf.build(lastPersona);
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
        form: q('form'), email: q('email'), jobTitle: q('jobTitle'),
        companySize: q('companySize'), industry: q('industry'),
        turnstile: q('turnstile'), turnstileNote: q('turnstileNote'),
        generate: q('generate'), hint: q('hint'),
        error: q('error'), pdf: q('pdf'), status: q('status')
      };

      boxes = {};
      container.querySelectorAll('[data-box]').forEach((b) => { boxes[b.dataset.box] = b; });

      [el.email, el.jobTitle, el.companySize].forEach((node) =>
        node.addEventListener('input', updateGenerateEnabled));
      el.companySize.addEventListener('change', updateGenerateEnabled);
      el.form.addEventListener('submit', handleSubmit);
      el.pdf.addEventListener('click', handlePdf);

      updateGenerateEnabled();
      initTurnstile();
    },

    unmount() {
      mounted = false;
      if (abortController) { abortController.abort(); abortController = null; }
      if (window.turnstile && turnstileWidgetId !== null) {
        try { window.turnstile.remove(turnstileWidgetId); } catch (e) {}
      }
      turnstileWidgetId = null;
      turnstileToken = null;
      lastPersona = null;
      el = null;
      boxes = null;
      // Listeners die with the DOM nodes the shell clears.
    }
  });

})();

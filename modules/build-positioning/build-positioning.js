/* ==========================================================================
   Build Positioning — Mktforge module
   Stages 0–5 of the Draft Messaging Framework (input audit → alternatives →
   differentiators → value ladder → champion → market category).

   Page, top to bottom:
     1. Run inputs: Company URL, Primary Champion, Closest Competitor,
        Target Industry (optional). Drop-downs come from My Company; anything
        can be typed. A typed industry is matched to the shared industry list.
     2. "Fill in the blanks": one row per question — question on the left,
        text box, then its buttons. Draft Answer / Edit / Save behave like
        My Company (see "Row states" below). Answers are saved to the account:
          company questions     once for the account
          competitor questions  once per Closest Competitor
          champion questions    once per Primary Champion
     3. Generate Positioning: streams stages 0–5 into the result boxes. Once a
        run starts, a second Create Positioning PDF button appears beside it.
     4. Create Positioning PDF: downloads it and saves it to My Company, where
        the next module can pick it up.

   Screen vs. PDF
     The PDF is the full record and is unchanged; the screen is organised for
     reading. BOXES is the stage list the Worker streams and the order the PDF
     prints. DISPLAY_BOXES is the on-screen layout only: one full-width column
     of boxes that each minimize to their title line, the positioning statement
     lifted out of Market Category into a leading "Draft" box, and stages 2 and
     3 merged into "Differentiators and Value" with each stage-3 row folded
     under the differentiator it belongs to. None of it touches the data.

   Saved materials: before drafting or generating, assets/js/research.js
   gathers Imported Materials (trusted most, newest first) and Generated
   Materials. Files that mention the chosen champion or competitor go in
   full; the rest go as short summaries made once per file and stored.

   Row states
     locked   — needs a Primary Champion / Closest Competitor first
     open     — no saved answer: editable box + [Draft Answer]
     saved    — read-only box + [Edit]
     editing  — editable box + [Draft Answer] stacked above [Save]
   The bottom Save saves every open or editing row that has text (and clears
   an editing row that was emptied). A row's own Save saves only that row.
   ========================================================================== */

(() => {

  const MODULE_ID = 'build-positioning';
  const MODULE_NAME = 'Build Positioning';
  const JSPDF_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  const PDF_SRC = 'modules/build-positioning/positioning-pdf.js';

  const Data = () => window.MktforgeData;
  const Kit = () => window.MktforgeKit;

  /* ---------- questions ----------
     Ids must match the Worker's src/questions.js. {champion} and
     {competitor} are filled with the current selections. */

  const GROUPS = [
    { id: 'company',    title: 'About your company' },
    { id: 'competitor', title: 'About your Closest Competitor' },
    { id: 'champion',   title: 'About your Primary Champion' },
    { id: 'optional',   title: 'Optional — helps with proof and wording' }
  ];

  const QUESTIONS = [
    { id: 'summary', scope: 'company', group: 'company', required: true,
      text: 'In one or two sentences, what does your product do and who is it for?' },
    { id: 'live_features', scope: 'company', group: 'company', required: true,
      text: 'Which features are live today, and which are still on the roadmap?' },
    { id: 'hidden_strengths', scope: 'company', group: 'company',
      text: 'What can your product or team do that isn’t on your website?',
      hint: 'e.g. proprietary data, integrations, setup speed, service model, pricing model, founder expertise' },
    { id: 'best_customers', scope: 'company', group: 'company',
      text: 'Who are your best current customers or design partners?',
      hint: 'company type, size, industry, and who pushed for the purchase' },
    { id: 'self_description', scope: 'company', group: 'company',
      text: 'How do you describe what you are today, and what words do prospects use for it?',
      hint: 'e.g. search terms, how inbound leads describe you' },
    { id: 'category_appetite', scope: 'company', group: 'company',
      text: 'How much appetite do you have for creating a new category?',
      hint: 'funding stage, marketing budget, how you pitch investors' },
    { id: 'alternatives', scope: 'competitor', group: 'competitor',
      text: 'What do prospects use today instead of you, and who do you lose deals to (including “no decision”)?' },
    { id: 'competitor_corrections', scope: 'competitor', group: 'competitor',
      text: 'Where are {competitor}’s claims wrong or overstated in practice?' },
    { id: 'trigger', scope: 'champion', group: 'champion',
      text: 'What usually happens right before a {champion} reaches out or starts looking?' },
    { id: 'excluded_tasks', scope: 'champion', group: 'champion',
      text: 'Which of a {champion}’s tasks does your product not handle?' },
    { id: 'proof', scope: 'company', group: 'optional',
      text: 'What proof do you have?',
      hint: 'results, quotes, logos, notable customers, founder background' },
    { id: 'customer_language', scope: 'company', group: 'optional',
      text: 'Paste any customer language.',
      hint: 'call notes, reviews, support tickets' }
  ];

  const REQUIRED_IDS = QUESTIONS.filter((q) => q.required).map((q) => q.id);

  /* ---------- result boxes ----------
     BOXES is the stage list the Worker streams and the shape the PDF prints:
     six stages, these titles, this order. The PDF is deliberately unchanged, so
     nothing in BOXES may be edited for the sake of the on-screen layout.

     DISPLAY_BOXES is the on-screen layout only. It reorganises the same data:
       - the positioning statement that used to close Market Category leads as
         "Draft", so the answer is readable without scrolling
       - Stage 0 arrives minimized (`collapsed`)
       - Stages 2 and 3 are merged into one "Differentiators and Value" box
       - `needs` lists the stage keys a box can show something from (any one is
         enough, so a run that stops halfway still shows what it reached)
       - `pick` is the stage data the box's renderer gets as its first argument */

  const BOXES = [
    { key: 'audit',           stage: 'Stage 0', title: 'Input Audit' },
    { key: 'alternatives',    stage: 'Stage 1', title: 'Competitive Alternatives' },
    { key: 'differentiators', stage: 'Stage 2', title: 'Differentiators' },
    { key: 'value',           stage: 'Stage 3', title: 'Value Ladder' },
    { key: 'champion',        stage: 'Stage 4', title: 'Champion & Situation' },
    { key: 'category',        stage: 'Stage 5', title: 'Market Category' }
  ];

  const DISPLAY_BOXES = [
    { key: 'draft',           stage: 'Draft',       title: 'Initial Positioning Statement',
      needs: ['category'],                    pick: (st) => st.category },
    { key: 'audit',           stage: 'Stage 0',     title: 'Input Audit',
      needs: ['audit'], collapsed: true,      pick: (st) => st.audit },
    { key: 'alternatives',    stage: 'Stage 1',     title: 'Competitive Alternatives',
      needs: ['alternatives'],                pick: (st) => st.alternatives },
    { key: 'differentiators', stage: 'Stage 2 & 3', title: 'Differentiators and Value',
      needs: ['differentiators', 'value'],    pick: (st) => st.differentiators || {} },
    { key: 'champion',        stage: 'Stage 4',     title: 'Champion & Situation',
      needs: ['champion'],                    pick: (st) => st.champion },
    { key: 'category',        stage: 'Stage 5',     title: 'Market Category',
      needs: ['category'],                    pick: (st) => st.category }
  ];

  const DEFAULT_COLLAPSED = () => new Set(DISPLAY_BOXES.filter((b) => b.collapsed).map((b) => b.key));

  /* ---------- helpers ---------- */

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

  function hostOf(raw) {
    const v = String(raw || '').trim();
    if (!v) return '';
    try {
      return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`).hostname
        .toLowerCase().replace(/^www\./, '');
    } catch (e) { return ''; }
  }

  const validUrl = (v) => !!v && Data().util.isValidUrl(v);

  function sel() {
    const f = state.form;
    const competitorOk = validUrl(f.competitor);
    return {
      companyUrl: f.companyUrl.trim(),
      champion: f.champion.trim(),
      competitorUrl: competitorOk ? Data().util.normalizeUrl(f.competitor) : '',
      competitorHost: competitorOk ? hostOf(f.competitor) : '',
      industry: industryMatch(f.industry).value
    };
  }

  function keyFor(q, s = sel()) {
    if (q.scope === 'company') return `company__${q.id}`;
    if (q.scope === 'competitor') {
      const k = slug(s.competitorHost);
      return k ? `competitor__${k}__${q.id}` : null;
    }
    const k = slug(s.champion);
    return k ? `champion__${k}__${q.id}` : null;
  }

  function questionText(q, s = sel()) {
    return q.text
      .replace(/\{champion\}/g, s.champion || 'Primary Champion')
      .replace(/\{competitor\}/g, s.competitorHost || 'your Closest Competitor');
  }

  function notify(message, tone = 'info') {
    document.dispatchEvent(new CustomEvent('mktforge:notify', { detail: { message, tone } }));
  }

  async function pool(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    return out;
  }

  /* ---------- industry matching ----------
     A My Company target industry or an exact list entry is used as is.
     Anything else is matched to the closest entry in the shared list
     (assets/data/industries.js). */

  function levenshtein(a, b) {
    if (a === b) return 0;
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const tmp = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[b.length];
  }

  const words = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

  function industryScore(name, q) {
    const n = norm(name);
    if (n === q) return 0;
    if (n.startsWith(q)) return 1 + (n.length - q.length) / 100;
    if (n.split(/[\s/()-]+/).some((w) => w.startsWith(q))) return 2 + n.length / 1000;
    if (n.includes(q)) return 3 + n.length / 1000;
    if (n.length >= 4 && q.includes(n)) return 3.5 - n.length / 1000;
    const qw = words(q);
    const nw = words(n);
    if (qw.length && nw.length) {
      const hits = qw.filter((w) => nw.some((x) => x.startsWith(w) || w.startsWith(x))).length;
      if (hits) return 4 + (1 - hits / Math.max(qw.length, nw.length));
    }
    const d = levenshtein(q, n);
    if (d / Math.max(q.length, n.length) <= 0.34) return 5 + d / 100;
    return -1;
  }

  const industryMemo = new Map();

  function industryMatch(raw) {
    const v = String(raw || '').trim();
    if (!v) return { value: '', note: '' };
    if (industryMemo.has(v)) return industryMemo.get(v);
    const q = norm(v);
    const list = window.MKTFORGE_INDUSTRIES || [];
    const targets = (profileCache && profileCache.targetIndustries) || [];
    let result;
    const own = targets.find((t) => norm(t) === q) || list.find((t) => norm(t) === q);
    if (own) {
      result = { value: own, note: '' };
    } else {
      let best = null;
      list.forEach((name) => {
        const s = industryScore(name, q);
        if (s >= 0 && (!best || s < best.s)) best = { name, s };
      });
      result = best
        ? { value: best.name, note: `Matched to “${best.name}”.` }
        : { value: v, note: 'No close match in the industry list — it will be used as typed.' };
    }
    industryMemo.set(v, result);
    return result;
  }

  /* ---------- state that outlives mount/unmount ---------- */

  const state = {
    form: { companyUrl: '', champion: '', competitor: '', industry: '' },
    urlSeed: { seeded: false },
    answers: null,          // saved answers { key: text }
    answersError: '',
    drafts: {},             // unsaved text per key
    editing: new Set(),     // keys opened with Edit
    drafting: new Set(),    // keys waiting on Draft Answer
    progress: {},           // key -> progress text while drafting
    rowErrors: {},          // key -> message
    rowSaving: new Set(),
    saving: false,
    saveError: '',
    flash: new Set(),       // keys that just saved (animation)
    run: null,
    running: false,
    collapsed: DEFAULT_COLLAPSED(),   // display box keys currently minimized
    innerOpen: new Set(),             // ids of nested boxes the user opened
    status: '',
    error: '',
    contextNote: '',
    fileCount: null
  };

  let root = null;
  let mounted = false;
  let cfg = {};
  let profileCache = null;
  let unsubFiles = null;
  let unsubProfile = null;
  let scopeTimer = null;

  /* ---------- markup ---------- */

  const MARKUP = `
  <div class="bpos">
    <header class="bpos__head">
      <p class="bpos__eyebrow">Build Positioning</p>
      <h1 class="bpos__title">Draft your positioning</h1>
      <p class="bpos__dek">Decide what you are, who it’s for, and why you’re different before
        writing a single headline. Pick who you’re selling to and who you’re up against,
        fill in what only you know, and Mktforge works through the first five stages of the
        positioning framework using your website and every report you’ve saved.</p>
    </header>

    <section class="bpos__card" aria-label="Run inputs">
      <div class="bpos__fields">
        <div class="bpos__field">
          <label for="bpos-company">Company URL</label>
          <input type="text" id="bpos-company" data-el="companyUrl" placeholder="yourcompany.com" inputmode="url" spellcheck="false">
          <p class="bpos__field-note is-error" data-note="companyUrl" hidden></p>
        </div>
        <div class="bpos__field">
          <label for="bpos-champion">Primary Champion</label>
          <input type="text" id="bpos-champion" data-el="champion" placeholder="Job title, e.g. Head of RevOps">
        </div>
        <div class="bpos__field">
          <label for="bpos-competitor">Closest Competitor</label>
          <input type="text" id="bpos-competitor" data-el="competitor" placeholder="competitor.com" inputmode="url" spellcheck="false">
          <p class="bpos__field-note is-error" data-note="competitor" hidden></p>
        </div>
        <div class="bpos__field">
          <label for="bpos-industry">Target Industry <span class="bpos__optional">(optional)</span></label>
          <input type="text" id="bpos-industry" data-el="industry" placeholder="e.g. Financial Services">
          <p class="bpos__field-note" data-note="industry" hidden></p>
        </div>
      </div>
      <p class="bpos__resources" data-el="resources"></p>
    </section>

    <section class="bpos__card bpos__card--qa" aria-labelledby="bpos-qa-title">
      <div class="bpos__qa-head">
        <h2 class="bpos__h2" id="bpos-qa-title">Fill in the blanks</h2>
        <p class="bpos__qa-dek">Research can’t see inside your business. Answer what you can —
          or press <strong>Draft Answer</strong> to have a first pass written from your website
          and saved reports, then check it. Lines marked “Assumption:” need your review.</p>
      </div>
      <div data-el="qa"><p class="bpos__loading">Loading your answers…</p></div>
      <div class="bpos__qa-actions">
        <p class="bpos__error" data-el="save-error" role="alert" hidden></p>
        <button type="button" class="bpos__btn" data-el="save-all">Save</button>
      </div>
    </section>

    <section class="bpos__generate" aria-label="Generate positioning">
      <div class="bpos__gen-row">
        <button type="button" class="bpos__btn bpos__btn--lg" data-el="generate" disabled>Generate Positioning</button>
        <button type="button" class="bpos__btn bpos__btn--lg" data-el="pdf-top" disabled hidden title="Generate positioning first">Create Positioning PDF</button>
      </div>
      <p class="bpos__hint" data-el="hint" aria-live="polite"></p>
      <p class="bpos__status" data-el="status" aria-live="polite"></p>
      <p class="bpos__error" data-el="error" role="alert" hidden></p>
    </section>

    <section class="bpos__grid" data-el="results" aria-label="Positioning results">
      ${DISPLAY_BOXES.map((b) => `
        <article class="bpos__box${b.collapsed ? ' is-collapsed' : ''}" data-box-wrap="${b.key}">
          <h2>
            <span class="bpos__stage">${b.stage}</span>
            <span class="bpos__box-title">${b.title}</span>
            <button type="button" class="bpos__collapse" data-collapse="${b.key}"
              aria-expanded="${b.collapsed ? 'false' : 'true'}" aria-controls="bpos-box-${b.key}"
              title="${b.collapsed ? 'Maximize' : 'Minimize'}"
              aria-label="${b.collapsed ? 'Maximize' : 'Minimize'} ${b.title}">
              <span class="bpos__collapse-min" aria-hidden="true">&#8722;</span><span class="bpos__collapse-max" aria-hidden="true">+</span>
            </button>
          </h2>
          <div class="bpos__box-body is-placeholder" id="bpos-box-${b.key}" data-box="${b.key}">No Data Collected</div>
        </article>`).join('')}
    </section>

    <div class="bpos__pdf-row">
      <button type="button" class="bpos__btn" data-el="pdf" disabled title="Generate positioning first">Create Positioning PDF</button>
      <p class="bpos__status" data-el="pdf-status" aria-live="polite"></p>
    </div>
  </div>`;

  const q = (s) => root.querySelector(s);
  const el = (name) => root.querySelector(`[data-el="${name}"]`);

  /* ---------- question table ---------- */

  function rowState(qn, s) {
    const key = keyFor(qn, s);
    if (!key) return { key, mode: 'locked' };
    const saved = state.answers && state.answers[key];
    if (!saved) return { key, mode: 'open' };
    return { key, mode: state.editing.has(key) ? 'editing' : 'saved' };
  }

  function boxValue(key, mode) {
    if (!key) return '';
    if (mode === 'saved') return state.answers[key] || '';
    if (key in state.drafts) return state.drafts[key];
    return (state.answers && state.answers[key]) || '';
  }

  function lockText(qn) {
    return qn.scope === 'competitor'
      ? 'Choose a Closest Competitor above to answer this.'
      : 'Choose a Primary Champion above to answer this.';
  }

  function rowHtml(qn, s = sel()) {
    const { key, mode } = rowState(qn, s);
    const drafting = key && state.drafting.has(key);
    const busy = drafting || (key && state.rowSaving.has(key));
    const value = boxValue(key, mode);
    const err = key && state.rowErrors[key];
    const id = `bpos-a-${qn.id}`;
    const readOnly = mode === 'saved';
    const disabled = mode === 'locked' || busy;

    const draftBtn = `<button type="button" class="bpos__row-btn" data-draft="${qn.id}" ${mode === 'locked' || busy ? 'disabled' : ''}>${drafting ? 'Drafting…' : 'Draft Answer'}</button>`;
    let actions;
    if (mode === 'saved') {
      actions = `<button type="button" class="bpos__row-btn bpos__row-btn--quiet" data-edit="${qn.id}" aria-label="Edit answer: ${esc(questionText(qn, s))}">Edit</button>`;
    } else if (mode === 'editing') {
      const savingRow = state.rowSaving.has(key);
      actions = `${draftBtn}<button type="button" class="bpos__row-btn bpos__row-btn--solid" data-save="${qn.id}" ${busy ? 'disabled' : ''}>${savingRow ? 'Saving…' : 'Save'}</button>`;
    } else {
      actions = draftBtn;
    }

    const classes = ['bpos__row', `is-${mode}`];
    if (drafting) classes.push('is-drafting');
    if (key && state.flash.has(key)) classes.push('is-flash');

    return `
      <tr class="${classes.join(' ')}" data-q="${qn.id}">
        <th scope="row" class="bpos__q">
          <label for="${id}">${esc(questionText(qn, s))}</label>
          ${qn.hint ? `<span class="bpos__q-hint">${esc(qn.hint)}</span>` : ''}
          ${qn.required ? '<span class="bpos__req">Required</span>' : ''}
        </th>
        <td class="bpos__a">
          <textarea id="${id}" data-answer="${qn.id}" rows="3"
            ${readOnly ? 'readonly' : ''} ${disabled ? 'disabled' : ''}
            placeholder="${esc(mode === 'locked' ? lockText(qn) : drafting ? (state.progress[key] || 'Drafting an answer…') : 'Type your answer')}"
            aria-invalid="${err ? 'true' : 'false'}">${esc(drafting ? '' : value)}</textarea>
          <p class="bpos__row-error" ${err ? '' : 'hidden'}>${esc(err || '')}</p>
        </td>
        <td class="bpos__act"><div class="bpos__act-stack">${actions}</div></td>
      </tr>`;
  }

  function renderQa() {
    if (!mounted) return;
    const box = el('qa');
    if (!state.answers) {
      box.innerHTML = state.answersError
        ? `<p class="bpos__error">${esc(state.answersError)} <button type="button" class="bpos__link" data-el="answers-retry">Try again</button></p>`
        : '<p class="bpos__loading">Loading your answers…</p>';
      const retry = el('answers-retry');
      if (retry) retry.addEventListener('click', loadAnswers);
      updateSaveAll();
      return;
    }
    const s = sel();
    box.innerHTML = `
      <table class="bpos__qa">
        <colgroup><col class="bpos__col-q"><col><col class="bpos__col-act"></colgroup>
        <thead><tr><th scope="col">Question</th><th scope="col">Your answer</th><th scope="col"><span class="bpos__sr">Actions</span></th></tr></thead>
        ${GROUPS.map((g) => `
          <tbody data-group="${g.id}">
            <tr class="bpos__group"><th colspan="3" scope="colgroup">${esc(groupTitle(g, s))}</th></tr>
            ${QUESTIONS.filter((x) => x.group === g.id).map((x) => rowHtml(x, s)).join('')}
          </tbody>`).join('')}
      </table>`;
    box.querySelectorAll('textarea').forEach(autoGrow);
    state.flash.clear();
    updateSaveAll();
    updateGenerate();
  }

  function groupTitle(g, s) {
    if (g.id === 'competitor' && s.competitorHost) return `About ${s.competitorHost}`;
    if (g.id === 'champion' && s.champion) return `About your ${s.champion} buyers`;
    return g.title;
  }

  function renderRow(qn) {
    if (!mounted || !state.answers) return;
    const row = q(`tr[data-q="${qn.id}"]`);
    if (!row) return;
    const tmp = document.createElement('tbody');
    tmp.innerHTML = rowHtml(qn);
    const next = tmp.firstElementChild;
    row.replaceWith(next);
    const ta = next.querySelector('textarea');
    if (ta) autoGrow(ta);
    state.flash.clear();
    updateSaveAll();
    updateGenerate();
  }

  function renderScope(scope) {
    if (!mounted || !state.answers) return;
    const s = sel();
    QUESTIONS.filter((x) => x.scope === scope).forEach((x) => renderRow(x));
    GROUPS.forEach((g) => {
      const th = q(`tbody[data-group="${g.id}"] .bpos__group th`);
      if (th) th.textContent = groupTitle(g, s);
    });
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(ta.scrollHeight + 2, 72)}px`;
  }

  function openRowsWithText(s = sel()) {
    return QUESTIONS.filter((x) => {
      const { key, mode } = rowState(x, s);
      if (mode !== 'open' && mode !== 'editing') return false;
      return mode === 'editing' || String(boxValue(key, mode)).trim();
    });
  }

  function updateSaveAll() {
    if (!mounted) return;
    const btn = el('save-all');
    const s = sel();
    const anyOpen = !!state.answers && QUESTIONS.some((x) => {
      const m = rowState(x, s).mode;
      return m === 'open' || m === 'editing';
    });
    btn.hidden = !anyOpen;
    btn.disabled = state.saving;
    btn.textContent = state.saving ? 'Saving…' : 'Save';
    const err = el('save-error');
    err.textContent = state.saveError;
    err.hidden = !state.saveError;
  }

  /* ---------- saving ---------- */

  async function saveKeys(keys) {
    const changes = {};
    keys.forEach((key) => { changes[key] = String(state.drafts[key] ?? state.answers[key] ?? '').trim() || null; });
    state.answers = await Data().savePositioningAnswers(changes);
    keys.forEach((key) => {
      delete state.drafts[key];
      delete state.rowErrors[key];
      state.editing.delete(key);
      if (changes[key]) state.flash.add(key);
    });
  }

  async function handleSaveAll() {
    if (state.saving || !state.answers) return;
    const s = sel();
    const keys = openRowsWithText(s)
      .map((x) => rowState(x, s).key)
      .filter((k) => k && !state.drafting.has(k));
    state.saveError = '';
    if (!keys.length) { updateSaveAll(); return; }
    state.saving = true;
    updateSaveAll();
    try {
      await saveKeys(keys);
    } catch (err) {
      console.error('[Build Positioning] save failed', err);
      state.saveError = 'Couldn’t save — check your connection and try again.';
    } finally {
      state.saving = false;
      if (mounted) renderQa();
    }
  }

  async function handleSaveRow(qn) {
    const key = keyFor(qn);
    if (!key || state.rowSaving.has(key)) return;
    state.rowSaving.add(key);
    delete state.rowErrors[key];
    renderRow(qn);
    try {
      await saveKeys([key]);
    } catch (err) {
      console.error('[Build Positioning] row save failed', err);
      state.rowErrors[key] = 'Couldn’t save this answer. Please try again.';
    } finally {
      state.rowSaving.delete(key);
      renderRow(qn);
    }
  }

  function handleEdit(qn) {
    const key = keyFor(qn);
    if (!key) return;
    state.editing.add(key);
    delete state.drafts[key];
    renderRow(qn);
    const ta = q(`textarea[data-answer="${qn.id}"]`);
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  /* ---------- nav light ----------
     Yellow while a positioning run or at least one Draft Answer is in
     flight. When the last one finishes: red if anything in that stretch
     failed, otherwise green. (The shell only shows it while you're on
     another module.) */

  const activity = { busy: false, failed: false };

  function syncActivity(failed = false) {
    const active = state.running || state.drafting.size > 0;
    if (active && !activity.busy) {
      activity.busy = true;
      activity.failed = false;
      Mktforge.reportActivity(MODULE_ID, 'running');
    }
    if (failed) activity.failed = true;
    if (!active && activity.busy) {
      activity.busy = false;
      Mktforge.reportActivity(MODULE_ID, activity.failed ? 'error' : 'idle');
      activity.failed = false;
    }
  }

  /* ---------- saved answers for the current selections ---------- */

  function answersFor(s = sel()) {
    const out = {};
    QUESTIONS.forEach((x) => {
      const key = keyFor(x, s);
      const v = key && state.answers && state.answers[key];
      if (v) out[x.id] = v;
    });
    return out;
  }

  /* ---------- Worker requests ---------- */

  async function api(path, body, { signal } = {}) {
    if (!cfg.API_BASE_URL) throw new Error('Build Positioning isn’t configured — set buildPositioning.API_BASE_URL in assets/js/config.js.');
    const noAccess = Kit().accessProblem();
    if (noAccess) throw new Error(noAccess);
    const token = window.MktforgeAuth && window.MktforgeAuth.getIdToken
      ? await window.MktforgeAuth.getIdToken() : null;
    if (!token) throw new Error(Kit().NO_ACCESS);
    const res = await fetch(`${cfg.API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal
    });
    return res;
  }

  async function apiJson(path, body) {
    const res = await api(path, body);
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload || payload.status === 'error') {
      const message = payload && payload.message;
      throw new Error(Kit().accessError(res.status, message) || message || `Request failed (${res.status}).`);
    }
    return payload;
  }

  /* ---------- saved materials → context ----------
     Shared with every module (assets/js/research.js). Imported Materials
     come first and are trusted most; the Worker applies the trust rules. */

  async function buildContext(s, onProgress = () => {}) {
    return window.MktforgeResearch.build({
      jobTitles: s.champion ? [s.champion] : [],
      competitorHost: s.competitorHost,
      budget: window.MktforgeResearch.BUDGETS.large
    }, { onProgress });
  }

  function contextSummary(ctx, s) {
    let note = window.MktforgeResearch.summary(ctx.meta);
    if (ctx.meta.total && s.champion && !ctx.meta.titleReport('persona-builder')) {
      note += ` No Persona Builder report for ${s.champion} yet, so their priorities come from your imported files or web research.`;
    }
    return note;
  }

  /* ---------- Draft Answer ---------- */

  async function handleDraft(qn) {
    const s = sel();
    const key = keyFor(qn, s);
    if (!key || state.drafting.has(key)) return;
    delete state.rowErrors[key];

    if (!validUrl(s.companyUrl)) {
      state.rowErrors[key] = 'Add a valid Company URL above first.';
      renderRow(qn);
      return;
    }

    state.drafting.add(key);
    state.progress[key] = 'Drafting an answer…';
    syncActivity();
    renderRow(qn);

    const setProgress = (text) => {
      state.progress[key] = text;
      const ta = mounted && q(`textarea[data-answer="${qn.id}"]`);
      if (ta && keyFor(qn) === key) ta.placeholder = text;
    };

    try {
      const context = await buildContext(s, setProgress);
      setProgress('Drafting an answer — this can take up to a minute…');
      const payload = await apiJson('/api/draft-answer', {
        questionId: qn.id,
        companyUrl: s.companyUrl,
        champion: s.champion,
        competitorUrl: s.competitorUrl,
        industry: s.industry,
        today: new Date().toISOString().slice(0, 10),
        answers: answersFor(s),
        context: context.context
      });
      const sources = (payload.sources || []).filter(Boolean);
      state.drafts[key] = `${payload.answer}${sources.length ? `\n\nSources: ${sources.join('; ')}` : ''}`;
    } catch (err) {
      console.error('[Build Positioning] draft failed', err);
      state.rowErrors[key] = err && err.message && !/fetch/i.test(err.message)
        ? err.message : 'Couldn’t reach the drafting service. Please try again.';
    } finally {
      state.drafting.delete(key);
      delete state.progress[key];
      syncActivity(!!state.rowErrors[key]);
      // The row may now show a different champion/competitor; its own draft
      // is kept under its key either way.
      renderRow(qn);
    }
  }

  /* ---------- Generate Positioning ---------- */

  function missingForRun(s = sel()) {
    const missing = [];
    if (!validUrl(s.companyUrl)) missing.push('Company URL');
    if (!s.champion) missing.push('Primary Champion');
    if (!s.competitorUrl) missing.push('Closest Competitor');
    const saved = answersFor(s);
    REQUIRED_IDS.forEach((id) => {
      if (!saved[id]) {
        const qn = QUESTIONS.find((x) => x.id === id);
        missing.push(id === 'summary' ? 'a saved product summary' : `a saved answer to “${qn.text.replace(/\?$/, '')}”`);
      }
    });
    return missing;
  }

  function updateGenerate() {
    if (!mounted) return;
    const s = sel();
    const missing = state.answers ? missingForRun(s) : ['your answers'];
    el('generate').disabled = state.running || missing.length > 0;
    let hint = '';
    if (!state.running) {
      if (missing.length) hint = `Still needed: ${missing.join(', ')}.`;
      else if (state.answers) {
        const unsaved = QUESTIONS.some((x) => {
          const { key, mode } = rowState(x, s);
          return (mode === 'open' || mode === 'editing') && key in state.drafts
            && String(state.drafts[key]).trim() !== String(state.answers[key] || '').trim();
        });
        if (unsaved) hint = 'Some answers aren’t saved yet — only saved answers are used.';
      }
    }
    el('hint').textContent = hint;
  }

  function setBoxesLoading(keys) {
    keys.forEach((k) => {
      const b = q(`[data-box="${k}"]`);
      if (!b) return;
      b.className = 'bpos__box-body is-loading';
      b.innerHTML = '<span class="bpos__dot"></span><span class="bpos__dot"></span><span class="bpos__dot"></span>';
    });
  }

  function setBoxesPlaceholder(keys, text = 'No Data Collected') {
    keys.forEach((k) => {
      const b = q(`[data-box="${k}"]`);
      if (!b) return;
      b.className = 'bpos__box-body is-placeholder';
      b.textContent = text;
    });
  }

  /* ---------- minimize / maximize ---------- */

  function paintCollapse(key) {
    const wrap = q(`[data-box-wrap="${key}"]`);
    if (!wrap) return;
    const open = !state.collapsed.has(key);
    const box = DISPLAY_BOXES.find((b) => b.key === key);
    wrap.classList.toggle('is-collapsed', !open);
    const btn = wrap.querySelector('[data-collapse]');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.title = open ? 'Minimize' : 'Maximize';
    btn.setAttribute('aria-label', `${open ? 'Minimize' : 'Maximize'} ${box ? box.title : 'box'}`);
  }

  function toggleBox(key) {
    if (state.collapsed.has(key)) state.collapsed.delete(key);
    else state.collapsed.add(key);
    paintCollapse(key);
  }

  // Nested boxes live inside a result box's HTML, so they are re-rendered on
  // every paint; `state.innerOpen` is what survives that.
  function toggleInner(id, wrap) {
    const open = !state.innerOpen.has(id);
    if (open) state.innerOpen.add(id);
    else state.innerOpen.delete(id);
    wrap.classList.toggle('is-open', open);
    const btn = wrap.querySelector('[data-inner]');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.title = open ? 'Minimize' : 'Maximize';
  }

  function handleResultsClick(e) {
    const boxBtn = e.target.closest('button[data-collapse]');
    if (boxBtn) { toggleBox(boxBtn.dataset.collapse); return; }
    const innerBtn = e.target.closest('button[data-inner]');
    if (innerBtn) toggleInner(innerBtn.dataset.inner, innerBtn.closest('[data-inner-wrap]'));
  }

  function paintRun() {
    if (!mounted) return;
    const run = state.run;
    DISPLAY_BOXES.forEach((box) => {
      const b = q(`[data-box="${box.key}"]`);
      if (!b) return;
      const ready = !!run && box.needs.some((k) => run.stages[k]);
      if (ready) {
        b.className = 'bpos__box-body';
        b.innerHTML = RENDER[box.key](box.pick(run.stages), run);
      } else if (state.running) {
        setBoxesLoading([box.key]);
      } else {
        setBoxesPlaceholder([box.key], run ? 'Not reached — run again to complete this stage.' : 'No Data Collected');
      }
      paintCollapse(box.key);
    });
    el('status').textContent = state.status;
    const err = el('error');
    err.textContent = state.error;
    err.hidden = !state.error;
    paintPdfButtons();
  }

  // Both PDF buttons do the same thing; the top one only exists once there are
  // results on the page, so it can be reached without scrolling to the bottom.
  function paintPdfButtons() {
    if (!mounted) return;
    const complete = !!(state.run && state.run.complete);
    const top = el('pdf-top');
    top.hidden = !state.run;
    [el('pdf'), top].forEach((btn) => {
      btn.disabled = !complete;
      btn.title = complete ? '' : 'Generate positioning first';
    });
  }

  async function handleGenerate() {
    if (state.running) return;
    const s = sel();
    const missing = missingForRun(s);
    if (missing.length) { updateGenerate(); return; }

    state.running = true;
    state.error = '';
    state.status = 'Getting ready…';
    state.collapsed = DEFAULT_COLLAPSED();
    state.innerOpen = new Set();
    state.run = {
      input: { ...s, companyName: '', competitorName: '' },
      answers: answersFor(s),
      stages: {},
      complete: false,
      contextNote: ''
    };
    syncActivity();
    paintRun();
    updateGenerate();

    const setStatus = (t) => { state.status = t; if (mounted) el('status').textContent = t; };

    try {
      const context = await buildContext(s, setStatus);
      state.run.contextNote = contextSummary(context, s);
      state.contextNote = state.run.contextNote;
      paintResources();

      const res = await api('/api/positioning', {
        companyUrl: s.companyUrl,
        champion: s.champion,
        competitorUrl: s.competitorUrl,
        industry: s.industry,
        today: new Date().toISOString().slice(0, 10),
        answers: state.run.answers,
        context: context.context
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        const message = payload && payload.message;
        throw new Error(Kit().accessError(res.status, message) || message || `Request failed (${res.status}).`);
      }

      await readStream(res, {
        status: (d) => setStatus(d.message || ''),
        stage: (d) => {
          if (!d || !BOXES.some((b) => b.key === d.key)) return;
          state.run.stages[d.key] = d.data;
          if (d.key === 'audit') {
            state.run.input.companyName = d.data.company_name || '';
            state.run.input.competitorName = d.data.competitor_name || '';
          }
          paintRun();
        },
        result: (d) => {
          state.run.stages = { ...state.run.stages, ...(d.stages || {}) };
          state.run.input.companyName = d.companyName || state.run.input.companyName;
          state.run.input.competitorName = d.competitorName || state.run.input.competitorName;
          state.run.generatedAt = d.generatedAt || new Date().toISOString();
          state.run.complete = true;
        },
        error: (d) => { throw new Error(Kit().accessError(null, d.message) || d.message || 'Something went wrong.'); }
      });

      if (!state.run.complete) throw new Error('The connection closed before the run finished. Please try again.');
      state.status = 'Positioning drafted. Review it, then create the PDF to use it in the next module.';
    } catch (err) {
      console.error('[Build Positioning] run failed', err);
      state.error = err && err.message && !/Failed to fetch|NetworkError/i.test(err.message)
        ? err.message : 'Could not reach the backend. Please try again.';
      state.status = '';
    } finally {
      state.running = false;
      syncActivity(!!state.error);
      paintRun();
      updateGenerate();
    }
  }

  async function readStream(res, handlers) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const type = ((raw.match(/^event:\s*(.+)$/m) || [])[1] || 'message').trim();
        const dataLine = (raw.match(/^data:\s*(.+)$/m) || [])[1];
        if (!dataLine) continue;
        let data;
        try { data = JSON.parse(dataLine); } catch (e) { continue; }
        if (handlers[type]) handlers[type](data);
      }
    }
  }

  /* ---------- result renderers ---------- */

  const PRIORITY_SOURCE = { imported: 'From your imported files', saved_resource: 'From a saved report', research: 'Researched' };

  const SOURCE_LABELS = {
    imported: 'Your imported file',
    website: 'Website', competitor_site: 'Competitor site', user_answer: 'Your answer',
    saved_resource: 'Saved report', research: 'Research', assumption: 'Assumption'
  };

  const list = (items, cls = '') => (items && items.length
    ? `<ul class="bpos__list ${cls}">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
    : '<p class="bpos__empty">None found.</p>');

  const kv = (k, v) => (v ? `<div class="bpos__kv"><span class="bpos__k">${esc(k)}</span><span>${esc(v)}</span></div>` : '');

  const chip = (text, tone = '') => `<span class="bpos__chip ${tone ? `is-${tone}` : ''}">${esc(text)}</span>`;

  /* A nested minimize/maximize box inside a result box. Minimized by default —
     `state.innerOpen` holds the ones the user has opened this run. */
  function innerBox(id, title, body) {
    const open = state.innerOpen.has(id);
    return `
      <div class="bpos__inner${open ? ' is-open' : ''}" data-inner-wrap="${id}">
        <button type="button" class="bpos__inner-head" data-inner="${id}"
          aria-expanded="${open ? 'true' : 'false'}" aria-controls="bpos-inner-${id}"
          title="${open ? 'Minimize' : 'Maximize'}">
          <span class="bpos__inner-title">${esc(title)}</span>
          <span class="bpos__inner-icon" aria-hidden="true"></span>
        </button>
        <div class="bpos__inner-body" id="bpos-inner-${id}">${body}</div>
      </div>`;
  }

  /* ---------- pairing value rows with differentiators ----------
     Stage 3 rows name a feature; stage 2 rows name an attribute. Neither
     carries an id, so they are paired on wording: an outright containment wins,
     otherwise the share of meaningful words they have in common. Rows that
     match nothing well enough end up in "Additional Values & Benefits". */

  const MATCH_STOP = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'without', 'into',
    'to', 'of', 'in', 'on', 'at', 'by', 'from', 'as', 'that', 'this', 'these', 'those', 'it', 'its',
    'is', 'are', 'was', 'be', 'been', 'being', 'you', 'your', 'our', 'their', 'them', 'they', 'we',
    'can', 'not', 'all', 'any', 'more', 'less', 'than', 'per', 'via', 'each', 'own', 'one', 'also',
    'has', 'have', 'had', 'get', 'gets', 'lets', 'let', 'so', 'they', 'what', 'which', 'when']);

  const stem = (w) => w.replace(/ies$/, 'y').replace(/(ses|xes|zes|ches|shes)$/, (m) => m.slice(0, -2))
    .replace(/([^s])s$/, '$1');

  function matchTokens(text) {
    return new Set(norm(text).split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !MATCH_STOP.has(w))
      .map(stem));
  }

  function tokenScore(a, b) {
    if (!a.size || !b.size) return 0;
    let hits = 0;
    a.forEach((w) => {
      if (b.has(w)) { hits += 1; return; }
      for (const x of b) {
        if ((w.length >= 5 && x.startsWith(w)) || (x.length >= 5 && w.startsWith(x))) { hits += 0.6; return; }
      }
    });
    return hits / Math.min(a.size, b.size);
  }

  function phraseScore(aText, bText) {
    const a = norm(aText);
    const b = norm(bText);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length >= 6 && b.includes(a)) return 0.95;
    if (b.length >= 6 && a.includes(b)) return 0.95;
    return tokenScore(matchTokens(a), matchTokens(b));
  }

  const MATCH_FLOOR = 0.34;

  function pairValueRows(differentiators, rows) {
    const byDiff = differentiators.map(() => []);
    const extra = [];
    rows.forEach((row) => {
      let bestIdx = -1;
      let best = 0;
      differentiators.forEach((d, i) => {
        const head = phraseScore(row.feature, d.attribute);
        const wide = phraseScore(
          [row.feature, row.capability, row.benefit].filter(Boolean).join(' '),
          [d.attribute, d.evidence].filter(Boolean).join(' ')
        );
        const score = Math.max(head, wide * 0.85);
        if (score > best) { best = score; bestIdx = i; }
      });
      if (bestIdx >= 0 && best >= MATCH_FLOOR) byDiff[bestIdx].push(row);
      else extra.push(row);
    });
    return { byDiff, extra };
  }

  const ladderRow = (v) => `
    <div class="bpos__ladder">
      <p><span class="bpos__rung">Feature</span>${esc(v.feature)}</p>
      <p><span class="bpos__rung">Lets them</span>${esc(v.capability)}</p>
      <p><span class="bpos__rung">So they get</span>${esc(v.benefit)}</p>
      <p><span class="bpos__rung">Matters because</span>${esc(v.priority)}</p>
    </div>`;

  const RENDER = {
    /* Stage 5 still produces this; on screen it leads the results instead of
       closing the Market Category box. The PDF keeps it where it was. */
    draft(d) {
      const summary = d.positioning_summary
        ? `<p class="bpos__summary">${esc(d.positioning_summary)}</p>` : '';
      const validate = (d.next_questions || []).length
        ? `<p class="bpos__label">What to Validate With Real Buyers</p>${list(d.next_questions)}` : '';
      if (!summary && !validate) return '<p class="bpos__empty">No positioning statement returned.</p>';
      return summary + validate;
    },

    audit(d) {
      const cp = d.company_profile || {};
      const xp = d.competitor_profile || {};
      return `
        <div class="bpos__sub">
          <h3>${esc(d.company_name || 'Your company')}</h3>
          ${kv('What it is', cp.what_it_is)}${kv('Who it serves', cp.who_it_serves)}
        </div>
        <div class="bpos__sub">
          <h3>${esc(d.competitor_name || 'Closest competitor')}</h3>
          ${kv('What it is', xp.what_it_is)}${kv('Who it serves', xp.who_it_serves)}
        </div>
        <div class="bpos__sub">
          <h3>Champion priorities ${chip(PRIORITY_SOURCE[d.title_priorities_source] || 'Researched', d.title_priorities_source === 'research' ? 'warn' : 'good')}</h3>
          ${(d.title_priorities || []).length ? `<ol class="bpos__list">${d.title_priorities.map((p) => `<li>${esc(p)}</li>`).join('')}</ol>` : '<p class="bpos__empty">None found.</p>'}
        </div>
        <div class="bpos__sub">
          <h3>Input gaps ${chip(`Overall confidence: ${d.overall_confidence}`, d.overall_confidence === 'high' ? 'good' : d.overall_confidence === 'low' ? 'bad' : 'warn')}</h3>
          ${(d.input_gaps || []).length ? `<ul class="bpos__list">${d.input_gaps.map((g) =>
            `<li>${esc(g.input)}${g.impact ? ` <span class="bpos__muted">— ${esc(g.impact)}</span>` : ''} ${chip(g.confidence, g.confidence === 'high' ? 'good' : g.confidence === 'low' ? 'bad' : 'warn')}</li>`).join('')}</ul>`
            : '<p class="bpos__empty">No major gaps.</p>'}
          ${d.confidence_note ? `<p class="bpos__muted">${esc(d.confidence_note)}</p>` : ''}
        </div>`;
    },

    alternatives(d) {
      const items = d.alternatives || [];
      if (!items.length) return '<p class="bpos__empty">No alternatives found.</p>';
      return items.map((a) => `
        <div class="bpos__item">
          <p class="bpos__item-head"><strong>${esc(a.name)}</strong> ${chip(a.type === 'status_quo' ? 'Status quo' : 'Competitor', a.type === 'status_quo' ? '' : 'accent')}</p>
          ${a.why_chosen ? `<p class="bpos__muted">${esc(a.why_chosen)}</p>` : ''}
          ${(a.shortcomings || []).length ? `<p class="bpos__label">Where it falls short</p>${list(a.shortcomings)}` : ''}
        </div>`).join('');
    },

    /* Stages 2 and 3 in one box: the value themes read first, then each
       differentiator with its own value rows folded away underneath. The PDF
       still prints the two stages separately. */
    differentiators(d, run) {
      const value = (run && run.stages && run.stages.value) || {};
      const items = d.differentiators || [];
      const rows = value.value_map || [];

      const themes = (value.value_themes || []).length ? `
        <p class="bpos__label">Value themes</p>
        <div class="bpos__themes">${value.value_themes.map((t) =>
          `<div class="bpos__theme"><strong>${esc(t.theme)}</strong><span>${esc(t.summary)}</span></div>`).join('')}</div>` : '';

      const warn = d.differentiation_warning
        ? `<p class="bpos__warn"><strong>Weak differentiation.</strong> ${esc(d.differentiation_warning)}</p>` : '';

      const { byDiff, extra } = pairValueRows(items, rows);

      const stageMissing = !(run && run.stages && run.stages.differentiators)
        ? '<p class="bpos__empty">Stage 2 didn’t finish — run again for the differentiators.</p>' : '';

      const body = items.length ? items.map((x, i) => `
        <div class="bpos__item">
          <p class="bpos__item-head"><strong>${esc(x.attribute)}</strong> ${chip(SOURCE_LABELS[x.source] || x.source, x.source === 'assumption' ? 'warn' : '')}</p>
          ${(x.versus || []).length ? `<p class="bpos__muted">vs. ${esc(x.versus.join(', '))}</p>` : ''}
          ${x.evidence ? `<p>${esc(x.evidence)}</p>` : ''}
          ${byDiff[i].length ? innerBox(`vb-${i}`, 'Value & Benefits', byDiff[i].map(ladderRow).join('')) : ''}
        </div>`).join('')
        : (stageMissing || '<p class="bpos__empty">No clear differentiators found.</p>');

      const roadmap = (d.roadmap_not_counted || []).length
        ? `<p class="bpos__label">Not counted (not live yet)</p>${list(d.roadmap_not_counted, 'is-muted')}` : '';

      const leftover = extra.length
        ? innerBox('vb-extra', 'Additional Values & Benefits', extra.map(ladderRow).join('')) : '';

      const themesSection = themes ? `<div class="bpos__merge-top">${themes}</div>` : '';
      return themesSection + warn + body + roadmap + leftover;
    },

    champion(d) {
      const c = d.champion || {};
      const seg = d.best_fit_segment || {};
      return `
        ${kv('Champion', c.title)}${kv('Budget holder', c.budget_holder)}${kv('Company type', c.company_type)}
        ${kv('Best-fit segment', seg.description)}${seg.why ? `<p class="bpos__muted">${esc(seg.why)}</p>` : ''}
        <p class="bpos__label">Triggers</p>${list(c.triggers)}
        <p class="bpos__label">Pains (most painful first)</p>
        ${(c.pains || []).length ? `<ol class="bpos__list">${c.pains.map((p) => `<li>${esc(p)}</li>`).join('')}</ol>` : '<p class="bpos__empty">None found.</p>'}
        <p class="bpos__label">Tasks it helps with</p>${list(c.tasks)}
        <p class="bpos__label">Tasks it doesn’t touch</p>${list(c.tasks_excluded)}`;
    },

    category(d) {
      const rec = d.category_recommendation || {};
      const names = { existing: 'Existing category', subcategory: 'Subcategory', new: 'New category' };
      const options = (d.category_options || []).map((o) => {
        const picked = rec.name && norm(rec.name) === norm(o.name);
        return `
          <div class="bpos__option${picked ? ' is-picked' : ''}">
            <p class="bpos__item-head">${chip(names[o.type] || o.type)} <strong>${esc(o.name)}</strong>${picked ? ' ' + chip('Recommended', 'good') : ''}</p>
            ${o.helps ? `<p><span class="bpos__k">Helps</span> ${esc(o.helps)}</p>` : ''}
            ${o.hurts ? `<p><span class="bpos__k">Hurts</span> ${esc(o.hurts)}</p>` : ''}
          </div>`;
      }).join('');
      return `
        ${d.first_glance_comparison ? `<p class="bpos__muted">${esc(d.first_glance_comparison)}</p>` : ''}
        <div class="bpos__options">${options || '<p class="bpos__empty">No options returned.</p>'}</div>
        ${rec.name ? `<p class="bpos__label">Recommendation</p><p><strong>${esc(rec.name)}</strong> — ${esc(rec.rationale)}</p>` : ''}`;
      // positioning_summary and next_questions are rendered by the Draft box
      // above; they stay in the data untouched for the PDF.
    }
  };

  /* ---------- PDF ---------- */

  async function handlePdf() {
    const run = state.run;
    if (!run || !run.complete) return;
    const btns = [el('pdf'), el('pdf-top')];
    btns.forEach((b) => { b.disabled = true; b.textContent = 'Preparing PDF…'; });
    try {
      await Mktforge.loadScript(JSPDF_SRC);
      await Mktforge.loadScript(PDF_SRC);
      const questions = QUESTIONS.map((x) => ({ id: x.id, text: questionText(x, run.input) }));
      // BOXES, not DISPLAY_BOXES: the PDF keeps the original six-stage layout.
      await window.MktforgePositioningPdf.build(run, { questions, boxes: BOXES, sourceLabels: SOURCE_LABELS });
    } catch (err) {
      console.error('[Build Positioning] PDF failed', err);
      if (mounted) { state.error = 'Could not generate the PDF. Please try again.'; paintRun(); }
    } finally {
      if (mounted) {
        btns.forEach((b) => { b.textContent = 'Create Positioning PDF'; });
        paintPdfButtons();
      }
    }
  }

  /* ---------- inputs ---------- */

  function paintResources() {
    if (!mounted) return;
    const p = el('resources');
    const n = state.fileCount;
    let text;
    if (state.contextNote) text = state.contextNote;
    else if (n == null) text = '';
    else if (!n) text = 'No saved materials yet, so drafts will use your website and web research. For better results, import your own research in My Company, or run Persona Builder and Battle Card Generator first.';
    else text = `${n} saved material${n === 1 ? '' : 's'} will be read. Your imported files are trusted first (newest first), then generated reports; reports about your Primary Champion and Closest Competitor are read in full.`;
    p.textContent = text;
    p.hidden = !text;
  }

  function paintFieldNotes() {
    if (!mounted) return;
    const f = state.form;
    const set = (name, text) => {
      const n = q(`[data-note="${name}"]`);
      n.textContent = text || '';
      n.hidden = !text;
    };
    const ind = industryMatch(f.industry);
    set('industry', ind.note);
    const input = el('competitor');
    const compBad = f.competitor.trim() && !validUrl(f.competitor) && document.activeElement !== input;
    set('competitor', compBad ? 'Enter a valid website address, like rival.com.' : '');
    input.setAttribute('aria-invalid', compBad ? 'true' : 'false');
    const cu = el('companyUrl');
    const cuBad = f.companyUrl.trim() && !validUrl(f.companyUrl) && document.activeElement !== cu;
    set('companyUrl', cuBad ? 'Enter a valid website address, like yourcompany.com.' : '');
    cu.setAttribute('aria-invalid', cuBad ? 'true' : 'false');
  }

  function onFieldInput(name) {
    const before = sel();
    state.form[name] = el(name).value;
    if (name === 'champion' || name === 'competitor') {
      state.contextNote = '';
      paintResources();
      clearTimeout(scopeTimer);
      scopeTimer = setTimeout(() => {
        const after = sel();
        if (name === 'champion' && keyFor(QUESTIONS.find((x) => x.scope === 'champion'), before)
            !== keyFor(QUESTIONS.find((x) => x.scope === 'champion'), after)) renderScope('champion');
        if (name === 'competitor') renderScope('competitor');
        updateGenerate();
      }, 200);
    }
    if (name === 'industry') paintFieldNotes();
    updateGenerate();
  }

  function wireInputs() {
    ['companyUrl', 'champion', 'competitor', 'industry'].forEach((name) => {
      const input = el(name);
      input.value = state.form[name];
      input.addEventListener('input', () => onFieldInput(name));
      input.addEventListener('blur', () => setTimeout(() => { if (mounted) paintFieldNotes(); }, 0));
    });
    Kit().seedCompanyUrl(el('companyUrl'), state.urlSeed);
    Kit().attachPicker(el('champion'), (p) => p.targetTitles);
    Kit().attachPicker(el('competitor'), (p) => p.competitors);
    Kit().attachPicker(el('industry'), (p) => p.targetIndustries);
  }

  function handleQaInput(e) {
    const ta = e.target.closest('textarea[data-answer]');
    if (!ta) return;
    const qn = QUESTIONS.find((x) => x.id === ta.dataset.answer);
    const key = keyFor(qn);
    if (!key) return;
    state.drafts[key] = ta.value;
    if (state.rowErrors[key]) {
      delete state.rowErrors[key];
      const p = ta.parentElement.querySelector('.bpos__row-error');
      if (p) p.hidden = true;
      ta.setAttribute('aria-invalid', 'false');
    }
    autoGrow(ta);
    updateGenerate();
  }

  function handleQaClick(e) {
    const btn = e.target.closest('button[data-draft], button[data-edit], button[data-save]');
    if (!btn) return;
    const id = btn.dataset.draft || btn.dataset.edit || btn.dataset.save;
    const qn = QUESTIONS.find((x) => x.id === id);
    if (!qn) return;
    if (btn.dataset.draft) handleDraft(qn);
    else if (btn.dataset.edit) handleEdit(qn);
    else handleSaveRow(qn);
  }

  /* ---------- loading ---------- */

  async function loadAnswers() {
    state.answersError = '';
    renderQa();
    try {
      state.answers = await Data().getPositioningAnswers();
    } catch (err) {
      console.error('[Build Positioning] could not load answers', err);
      state.answersError = 'Couldn’t load your saved answers.';
    }
    renderQa();
  }

  async function loadFileCount() {
    try {
      state.fileCount = (await Data().listFiles()).length;
    } catch (err) {
      state.fileCount = null;
    }
    paintResources();
  }

  /* ---------- module ---------- */

  Mktforge.register({
    id:     MODULE_ID,
    label:  MODULE_NAME,
    icon:   'crane',
    styles: 'modules/build-positioning/build-positioning.css',

    mount(container) {
      mounted = true;
      cfg = (window.MKTFORGE_CONFIG && window.MKTFORGE_CONFIG.buildPositioning) || {};
      container.innerHTML = MARKUP;
      root = container.firstElementChild;

      Data().getProfile().then((p) => {
        profileCache = p;
        industryMemo.clear();
        if (mounted) { paintFieldNotes(); updateGenerate(); }
      }).catch(() => {});
      unsubProfile = Data().onProfile((p) => { profileCache = p; industryMemo.clear(); });

      wireInputs();
      el('qa').addEventListener('input', handleQaInput);
      el('qa').addEventListener('click', handleQaClick);
      el('save-all').addEventListener('click', handleSaveAll);
      el('generate').addEventListener('click', handleGenerate);
      el('pdf').addEventListener('click', handlePdf);
      el('pdf-top').addEventListener('click', handlePdf);
      el('results').addEventListener('click', handleResultsClick);

      if (state.answers) renderQa(); else loadAnswers();
      paintRun();
      paintFieldNotes();
      paintResources();
      loadFileCount();
      unsubFiles = Data().onFiles(() => {
        if (mounted) loadFileCount();
      });
      updateGenerate();
    },

    unmount() {
      mounted = false;
      clearTimeout(scopeTimer);
      if (unsubFiles) { unsubFiles(); unsubFiles = null; }
      if (unsubProfile) { unsubProfile(); unsubProfile = null; }
      // Drafts and a run in flight keep going and land in `state`.
      root = null;
    }
  });
})();

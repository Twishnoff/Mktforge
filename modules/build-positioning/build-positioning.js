/* ==========================================================================
   Build Positioning — Mktforge module
   Stages 0–5 of the Draft Messaging Framework (input audit → alternatives →
   differentiators → value ladder → champion → market category).

   Page, top to bottom:
     1. Run inputs: Primary Champion, Closest Competitor, Target Industry
        (optional), with Generate Positioning on the same row. Drop-downs come
        from My Company; anything can be typed. A typed industry is matched to
        the shared industry list. There's no Company URL field: the URL saved
        in My Company is used, and until it has one a note says so and
        Generate / Draft Answer stay off.
     2. "Assumptions": hidden until the first run has drafted them, then shown
        minimized. One row per question — question on the left, text box,
        then its buttons. Draft Answer / Edit / Save behave like My Company
        (see "Row states" below). Answers are saved to the account:
          company questions     once for the account
          competitor questions  once per Closest Competitor
          champion questions    once per Primary Champion
     3. Generate Positioning (in the inputs box): first drafts every assumption that has no saved
        answer (exactly what Draft Answer does, all at once) and saves them,
        then streams stages 0–5. Typed-but-unsaved text is saved as is rather
        than drafted over.
     4. Results: until a run finishes, one panel stands in for the result
        boxes — the panda and intro copy, then the forging panda while a run
        works (same clips as Find My Customer). Stage 0 (Input Audit) is never
        shown on screen; it is still in the PDF.
     5. Create Positioning PDF: downloads it and saves it to My Company, where
        the next module can pick it up. Hidden until there are results.

   Category choice
     Stage 5 offers three market categories and recommends one. The user can
     position in a different one: the three cards at the top of the Initial
     Positioning Statement box (and the same options in the Market Category
     box) are selectable and share one selection. The Worker writes a
     positioning statement and summary for every option at the end of the
     run, so switching is instant. The agent's pick keeps its "Recommended"
     badge; "Selected" follows the choice. Only an override is stored — under
     the company's positioning answers as CHOICE_KEY — so it comes back after
     a refresh and pre-selects the same category on the next run when that
     category is offered again; choosing the recommended card clears it. The
     PDF records the chosen category as the decision and never says which one
     was recommended (see positioning-pdf.js), so Draft Messaging builds on
     the choice.

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
     open     — no saved answer: editable box + [Draft Answer], with [Save]
                below it as soon as the box has text
     saved    — read-only box + [Edit]
     editing  — editable box + [Draft Answer] stacked above [Save]
   The bottom Save saves every open or editing row that has text (and clears
   an editing row that was emptied). A row's own Save saves only that row.
   ========================================================================== */

(() => {

  const MODULE_ID = 'build-positioning';
  const MODULE_NAME = 'Build Positioning';
  const JSPDF_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  const PDF_SRC = 'modules/build-positioning/positioning-pdf.js?v=2026-09-29a';

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

  /* The category the user chose instead of the recommended one, kept in the
     same per-company map as the answers (company scope; never a question id,
     so it is never shown in the table or sent as an answer). */
  const CHOICE_KEY = 'company__category_choice';

  /* ---------- result boxes ----------
     BOXES is the stage list the Worker streams and the shape the PDF prints:
     six stages, these titles, this order. The PDF is deliberately unchanged, so
     nothing in BOXES may be edited for the sake of the on-screen layout.

     DISPLAY_BOXES is the on-screen layout only. It reorganises the same data:
       - the positioning statement that used to close Market Category leads as
         "Draft", so the answer is readable without scrolling
       - Stage 0 (Input Audit) isn't shown at all; it's only in the PDF
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
      companyUrl: myCompanyUrl(),
      champion: f.champion.trim(),
      competitorUrl: competitorOk ? Data().util.normalizeUrl(f.competitor) : '',
      competitorHost: competitorOk ? hostOf(f.competitor) : '',
      industry: industryMatch(f.industry).value
    };
  }

  /* Company URL always comes from My Company (profileCache is the active
     company's profile; null until it has loaded). */
  function myCompanyUrl() {
    return String((profileCache && profileCache.companyUrl) || '').trim();
  }
  const NO_COMPANY_URL = 'Company URL required. Please add your company’s URL in the My Company module before building positioning.';

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

  /* One per company (MktforgeKit.perCompany). Typed inputs and unsaved
     answers also survive a refresh. */
  const DRAFT_STOPPED = 'Draft stopped when you switched companies. Draft again.';
  const pc = window.MktforgeKit.perCompany(MODULE_ID, {
    create: () => ({
    form: { champion: '', competitor: '', industry: '' },
    answers: null,          // saved answers { key: text }
    answersError: '',
    drafts: {},             // unsaved text per key
    editing: new Set(),     // keys opened with Edit
    expanded: new Set(),    // saved answers the user expanded to read in full
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
    qaCollapsed: true,                // "Assumptions" card minimized
    qaShown: false,                   // Assumptions card revealed (after a run drafted them)
    innerOpen: new Set(),             // ids of nested boxes the user opened
    status: '',
    error: '',
    contextNote: '',
    fileCount: null,
    note: '',
    activity: { busy: false, failed: false },
    draftCtl: new Map()               // key -> AbortController for each Draft Answer
    }),
    held: ['form', 'drafts', 'editing'],
    snapshot: ['run', 'status', 'error', 'contextNote', 'collapsed', 'innerOpen', 'qaCollapsed', 'qaShown'],
    // Draft Answer rows still going for the company being left: stop them.
    onLeave(st) {
      st.draftCtl.forEach((ctl, key) => {
        try { ctl.abort(); } catch (e) { /* done */ }
        st.rowErrors[key] = DRAFT_STOPPED;
      });
      st.draftCtl.clear();
      st.drafting.clear();
      st.progress = {};
      st.activity = { busy: false, failed: false };
    }
  });
  let state = pc.state;
  pc.bind((st) => {
    state = st;
    profileCache = null;          // the new company's My Company is read on mount
    industryMemo.clear();
  });
  const onScreen = (st) => mounted && st === state;
  const dataOf = (st) => Data().company(st._cid);

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
      <h1 class="bpos__eyebrow">Build Positioning</h1>
      <p class="bpos__dek">Create a foundation for your messaging.</p>
    </header>

    <section class="bpos__card" aria-label="Run inputs">
      <div class="bpos__fields">
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
        <div class="bpos__field bpos__field--action">
          <span class="bpos__label-spacer" aria-hidden="true">&nbsp;</span>
          <button type="button" class="bpos__btn" data-el="generate" disabled>Generate Positioning</button>
        </div>
      </div>
      <!-- Company URL comes from My Company; this says so when it's missing. -->
      <p class="bpos__error bpos__url-note" data-el="url-note" role="alert" hidden>
        Company URL required. Please add your company’s URL in the
        <a href="#/my-company">My Company</a> module before building positioning.
      </p>
      <p class="bpos__hint bpos__hint--inputs" data-el="hint" aria-live="polite"></p>
      <p class="bpos__resources" data-el="resources" hidden></p>
    </section>

    <section class="bpos__card bpos__card--qa is-collapsed" data-el="qa-card" aria-labelledby="bpos-qa-title" hidden>
      <div class="bpos__qa-head">
        <div class="bpos__qa-headline">
          <h2 class="bpos__h2" id="bpos-qa-title">Assumptions</h2>
          <button type="button" class="bpos__collapse" data-el="qa-collapse"
            aria-expanded="false" aria-controls="bpos-qa-body"
            title="Maximize" aria-label="Maximize Assumptions">
            <span class="bpos__collapse-min" aria-hidden="true">&#8722;</span><span class="bpos__collapse-max" aria-hidden="true">+</span>
          </button>
        </div>
        <p class="bpos__qa-dek">Additional assumptions were made when building positioning.
          Further refine your results by editing the assumptions where appropriate.</p>
      </div>
      <div class="bpos__qa-body" id="bpos-qa-body">
        <div data-el="qa"><p class="bpos__loading">Loading your answers…</p></div>
        <div class="bpos__qa-actions">
          <p class="bpos__error" data-el="save-error" role="alert" hidden></p>
          <button type="button" class="bpos__btn" data-el="save-all">Save</button>
        </div>
      </div>
    </section>

    <section class="bpos__generate" aria-label="Generate positioning">
      <div class="bpos__gen-row">
        <button type="button" class="bpos__btn bpos__btn--lg" data-el="pdf-top" disabled hidden title="Generate positioning first">Create Positioning PDF</button>
      </div>
      <p class="bpos__status" data-el="status" aria-live="polite"></p>
      <p class="bpos__error" data-el="error" role="alert" hidden></p>
    </section>

    <section class="bpos__grid is-idle" data-el="results" aria-label="Positioning results">
      <div class="bpos__idle">
        <div class="bpos__intro">
          <img class="bpos__intro-img" src="modules/build-positioning/build-positioning-panda.png?v=2"
            alt="" width="640" height="543">
          <div class="bpos__intro-copy">
            <p class="bpos__intro-title">Let's build your positioning!</p>
            <p class="bpos__intro-text">We'll need to draft positioning before we craft your messaging.
              Using your company URL from My Company, tell us the primary buyer you want to go after, the competitor you're
              most likely to go against, and a specific industry (optional). We'll make some
              assumptions you can update after we've made a first pass at your positioning.</p>
          </div>
        </div>
        <div class="bpos__idle-loading">
          <div class="bpos__forge-stage" aria-hidden="true">
            <video class="bpos__forge" data-el="forge" muted loop playsinline preload="auto"
              width="660" height="540" aria-hidden="true">
              <source src="modules/find-my-customer/find-customer-forge.webm" type="video/webm">
              <source src="modules/find-my-customer/find-customer-forge.mp4" type="video/mp4">
            </video>
            <video class="bpos__forge bpos__forge--end" data-el="forgeEnd" muted playsinline preload="auto"
              width="660" height="540" aria-hidden="true">
              <source src="modules/find-my-customer/find-customer-forge-end.webm" type="video/webm">
              <source src="modules/find-my-customer/find-customer-forge-end.mp4" type="video/mp4">
            </video>
          </div>
          <p class="bpos__forge-status" data-el="forge-status" aria-live="polite"></p>
        </div>
      </div>
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

    <div class="bpos__pdf-row" data-el="pdf-row" hidden>
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
    const savingRow = key && state.rowSaving.has(key);
    const saveBtn = (hidden) => `<button type="button" class="bpos__row-btn bpos__row-btn--solid" data-save="${qn.id}"${hidden ? ' hidden' : ''} ${busy ? 'disabled' : ''}>${savingRow ? 'Saving…' : 'Save'}</button>`;
    let actions;
    if (mode === 'saved') {
      actions = `<button type="button" class="bpos__row-btn bpos__row-btn--quiet" data-edit="${qn.id}" aria-label="Edit answer: ${esc(questionText(qn, s))}">Edit</button>`;
    } else if (mode === 'editing') {
      // Kept even when emptied: Save on a blank box is how one answer is cleared.
      actions = `${draftBtn}${saveBtn(false)}`;
    } else if (mode === 'open') {
      // A row with nothing saved yet still needs its own Save as soon as there
      // is something in the box — typed, pasted or just drafted.
      actions = `${draftBtn}${saveBtn(!String(value).trim())}`;
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
        </th>
        <td class="bpos__a">
          <div class="bpos__a-box"${readOnly ? ` data-clamp="1" data-key="${esc(key)}"` : ''}>
            <textarea id="${id}" data-answer="${qn.id}" rows="3"
              ${readOnly ? 'readonly' : ''} ${disabled ? 'disabled' : ''}
              placeholder="${esc(mode === 'locked' ? lockText(qn) : drafting ? (state.progress[key] || 'Drafting an answer…') : 'Type your answer')}"
              aria-invalid="${err ? 'true' : 'false'}">${esc(drafting ? '' : value)}</textarea>
            ${readOnly ? `<button type="button" class="bpos__expand" data-expand="${qn.id}"
              aria-controls="${id}" aria-expanded="false" title="Show the full answer" aria-label="Show the full answer"
              ><span class="bpos__expand-more" aria-hidden="true">+</span><span class="bpos__expand-less" aria-hidden="true">&#8722;</span></button>` : ''}
          </div>
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
    box.querySelectorAll('textarea').forEach(fitAnswer);
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
    if (ta) fitAnswer(ta);
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

  const ROW_MIN_H = 72;   // matches the textarea min-height in the stylesheet

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(ta.scrollHeight + 2, ROW_MIN_H)}px`;
  }

  /* A saved answer drops back to the height the empty box started at, so the
     table stops growing as answers get longer and editing a later row doesn't
     mean scrolling past the earlier ones. The expand control only appears when
     there is more text than fits; `state.expanded` holds the rows opened to
     read in full, and saving a row closes it again. */
  function fitAnswer(ta) {
    const box = ta.closest('.bpos__a-box');
    if (!box || !box.dataset.clamp) { autoGrow(ta); return; }
    const key = box.dataset.key;
    // Clearing the inline height drops the box to the height it starts at
    // (its rows="3" size), which is what clientHeight then reports; scrollHeight
    // reports what the answer actually needs. Both get autoGrow's +2 so a
    // collapsed box is the same height as one nobody has answered yet.
    ta.style.height = '';
    const base = ta.clientHeight + 2;
    const full = ta.scrollHeight + 2;
    const more = full > base + 2;
    const open = more && state.expanded.has(key);
    ta.style.height = `${open ? full : base}px`;
    box.classList.toggle('has-more', more);
    box.classList.toggle('is-expanded', open);
    const btn = box.querySelector('[data-expand]');
    if (btn) {
      const label = open ? 'Collapse answer' : 'Show the full answer';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.title = label;
      btn.setAttribute('aria-label', label);
    }
  }

  function handleExpand(qn) {
    const ta = q(`textarea[data-answer="${qn.id}"]`);
    if (!ta) return;
    const box = ta.closest('.bpos__a-box');
    const key = box && box.dataset.key;
    if (!key) return;
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
    fitAnswer(ta);
  }

  /* Called on every keystroke, so it flips the button rather than re-rendering
     the row (a re-render would drop focus and the caret). Editing rows keep
     Save visible at all times. */
  function updateRowSave(qn, key) {
    if (!mounted) return;
    const row = q(`tr[data-q="${qn.id}"]`);
    if (!row) return;
    const btn = row.querySelector('button[data-save]');
    if (!btn || rowState(qn, sel()).mode !== 'open') return;
    btn.hidden = !String(state.drafts[key] ?? '').trim();
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

  async function saveKeys(st, keys) {
    const changes = {};
    keys.forEach((key) => { changes[key] = String(st.drafts[key] ?? st.answers[key] ?? '').trim() || null; });
    st.answers = await dataOf(st).savePositioningAnswers(changes);
    keys.forEach((key) => {
      delete st.drafts[key];
      delete st.rowErrors[key];
      st.editing.delete(key);
      st.expanded.delete(key);
      if (changes[key]) st.flash.add(key);
    });
    pc.hold(st);
  }

  async function handleSaveAll() {
    const st = state;
    if (st.saving || !st.answers) return;
    const s = sel();
    const keys = openRowsWithText(s)
      .map((x) => rowState(x, s).key)
      .filter((k) => k && !st.drafting.has(k));
    st.saveError = '';
    if (!keys.length) { updateSaveAll(); return; }
    st.saving = true;
    updateSaveAll();
    try {
      await saveKeys(st, keys);
    } catch (err) {
      console.error('[Build Positioning] save failed', err);
      st.saveError = 'Couldn’t save — check your connection and try again.';
    } finally {
      st.saving = false;
      if (onScreen(st)) renderQa();
    }
  }

  async function handleSaveRow(qn) {
    const st = state;
    const key = keyFor(qn);
    if (!key || st.rowSaving.has(key)) return;
    st.rowSaving.add(key);
    delete st.rowErrors[key];
    renderRow(qn);
    try {
      await saveKeys(st, [key]);
    } catch (err) {
      console.error('[Build Positioning] row save failed', err);
      st.rowErrors[key] = 'Couldn’t save this answer. Please try again.';
    } finally {
      st.rowSaving.delete(key);
      if (onScreen(st)) renderRow(qn);
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

  // The light belongs to the company on screen; a company left behind has
  // had its work stopped, so it never reports.
  function syncActivity(failed = false, st = state) {
    if (st !== state) return;
    const activity = st.activity;
    const active = st.running || st.drafting.size > 0;
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

  function answersFor(s = sel(), st = state) {
    const out = {};
    QUESTIONS.forEach((x) => {
      const key = keyFor(x, s);
      const v = key && st.answers && st.answers[key];
      if (v) out[x.id] = v;
    });
    return out;
  }

  /* ---------- category choice ----------
     One selection shared by the Draft box's cards and the Market Category
     box's options. The stored override (CHOICE_KEY) wins when the run offers
     a category of that name; otherwise the agent's recommendation; otherwise
     the first option. */

  const CATEGORY_TYPES = { existing: 'Existing category', subcategory: 'Subcategory', new: 'New category' };

  function categoryView(run, st = state) {
    const d = (run && run.stages && run.stages.category) || {};
    const options = d.category_options || [];
    const rec = d.category_recommendation || {};
    const recIdx = rec.name ? options.findIndex((o) => norm(o.name) === norm(rec.name)) : -1;
    const stored = st.answers && st.answers[CHOICE_KEY];
    let selIdx = stored ? options.findIndex((o) => norm(o.name) === norm(stored)) : -1;
    if (selIdx < 0) selIdx = recIdx >= 0 ? recIdx : 0;
    return {
      data: d,
      options,
      recIdx,
      selIdx,
      selected: options[selIdx] || null,
      recommended: options[recIdx] || null,
      override: recIdx >= 0 && selIdx !== recIdx
    };
  }

  /* The statement, summary and buyer questions for the selected category.
     Runs from before this feature only carry them at the top level (for the
     recommended category), so that is the fallback there. */
  function statementFor(v) {
    const o = v.selected || {};
    const top = v.selIdx === v.recIdx || v.recIdx < 0;
    return {
      statement: o.positioning_statement || (top ? v.data.positioning_statement : '') || '',
      summary: o.positioning_summary || (top ? v.data.positioning_summary : '') || '',
      questions: (o.next_questions && o.next_questions.length ? o.next_questions : (top ? v.data.next_questions : null)) || []
    };
  }

  async function handleChoose(name) {
    const st = state;
    const v = categoryView(st.run, st);
    const opt = v.options.find((o) => norm(o.name) === norm(name));
    if (!opt) return;
    const isRec = !!v.recommended && norm(opt.name) === norm(v.recommended.name);
    const value = isRec ? null : opt.name;     // only an override is stored
    if (!st.answers) st.answers = {};
    if (value) st.answers[CHOICE_KEY] = value; else delete st.answers[CHOICE_KEY];
    paintCategory();
    try {
      st.answers = await dataOf(st).savePositioningAnswers({ [CHOICE_KEY]: value });
    } catch (err) {
      console.error('[Build Positioning] could not save the category choice', err);
      notify('Couldn’t save your category choice — it will still be used for this PDF, but may reset after a refresh.', 'error');
    }
  }

  // Repaints only the two boxes the selection shows in.
  function paintCategory() {
    if (!mounted || !state.run || !state.run.stages.category) return;
    ['draft', 'category'].forEach((key) => {
      const box = DISPLAY_BOXES.find((b) => b.key === key);
      const b = q(`[data-box="${key}"]`);
      if (!box || !b) return;
      b.className = 'bpos__box-body';
      b.innerHTML = RENDER[key](box.pick(state.run.stages), state.run);
    });
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

  async function apiJson(path, body, opts = {}) {
    const res = await api(path, body, opts);
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

  async function buildContext(s, st, onProgress = () => {}) {
    return window.MktforgeResearch.build({
      jobTitles: s.champion ? [s.champion] : [],
      competitorHost: s.competitorHost,
      budget: window.MktforgeResearch.BUDGETS.large,
      data: dataOf(st)
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
    const st = state;
    const s = sel();
    const key = keyFor(qn, s);
    if (!key || st.drafting.has(key)) return;
    delete st.rowErrors[key];

    if (!validUrl(s.companyUrl)) {
      st.rowErrors[key] = 'Add your company’s URL in the My Company module first.';
      renderRow(qn);
      return;
    }

    const ctl = new AbortController();
    st.draftCtl.set(key, ctl);
    const live = () => st.draftCtl.get(key) === ctl;   // false once a switch stopped it
    st.drafting.add(key);
    st.progress[key] = 'Drafting an answer…';
    pc.flagOn(st);
    syncActivity(false, st);
    renderRow(qn);

    const setProgress = (text) => {
      if (!live()) return;
      st.progress[key] = text;
      const ta = onScreen(st) && q(`textarea[data-answer="${qn.id}"]`);
      if (ta && keyFor(qn) === key) ta.placeholder = text;
    };

    try {
      const context = await buildContext(s, st, setProgress);
      if (!live()) return;
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
      }, { signal: ctl.signal });
      if (!live()) return;
      const sources = (payload.sources || []).filter(Boolean);
      st.drafts[key] = `${payload.answer}${sources.length ? `\n\nSources: ${sources.join('; ')}` : ''}`;
      pc.hold(st);
    } catch (err) {
      if (!live()) return;
      console.error('[Build Positioning] draft failed', err);
      st.rowErrors[key] = err && err.message && !/fetch/i.test(err.message)
        ? err.message : 'Couldn’t reach the drafting service. Please try again.';
    } finally {
      pc.flagOff(st);
      if (live()) {
        st.draftCtl.delete(key);
        st.drafting.delete(key);
        delete st.progress[key];
        syncActivity(!!st.rowErrors[key], st);
        // The row may now show a different champion/competitor; its own draft
        // is kept under its key either way.
        if (onScreen(st)) renderRow(qn);
      }
    }
  }

  /* ---------- Generate Positioning ---------- */

  function missingForRun(s = sel()) {
    const missing = [];
    if (!validUrl(s.companyUrl)) missing.push('Company URL');
    if (!s.champion) missing.push('Primary Champion');
    if (!s.competitorUrl) missing.push('Closest Competitor');
    return missing;
  }

  function updateGenerate() {
    if (!mounted) return;
    const s = sel();
    const missing = missingForRun(s);
    // The Company URL gets its own note (it's fixed in My Company, not here);
    // only once the profile has loaded, so it doesn't flash on the way in.
    const noUrl = !!profileCache && !validUrl(s.companyUrl);
    el('url-note').hidden = !noUrl;
    el('generate').disabled = state.running || missing.length > 0;
    const rest = missing.filter((m) => m !== 'Company URL');
    let hint = '';
    if (!state.running) {
      if (rest.length) hint = `Still needed: ${rest.join(', ')}.`;
      else if (state.answers && qaVisible()) {
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

  // The "Assumptions" card stays hidden until a run has drafted the
  // assumptions (or, for a company that already has results from before this
  // change, once there is a finished run). It then shows minimized, and
  // minimizes the same way a result box does.
  const qaVisible = (st = state) => !!(st.qaShown || (st.run && st.run.complete));

  function paintQaCollapse() {
    if (!root) return;
    const card = el('qa-card');
    const btn = el('qa-collapse');
    if (!card || !btn) return;
    card.hidden = !qaVisible();
    const open = !state.qaCollapsed;
    card.classList.toggle('is-collapsed', !open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.title = open ? 'Minimize' : 'Maximize';
    btn.setAttribute('aria-label', `${open ? 'Minimize' : 'Maximize'} Assumptions`);
  }

  function toggleQa() {
    state.qaCollapsed = !state.qaCollapsed;
    paintQaCollapse();
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
    const chooseBtn = e.target.closest('button[data-choose]');
    if (chooseBtn) { handleChoose(chooseBtn.dataset.choose); return; }
    const innerBtn = e.target.closest('button[data-inner]');
    if (innerBtn) toggleInner(innerBtn.dataset.inner, innerBtn.closest('[data-inner-wrap]'));
  }

  /* ---------- results panel ----------
     Until a run has something to show, one panel stands in for the result
     boxes (same as Find My Customer):
       'intro'   — before a run, or after one that failed with nothing to show
       'loading' — while a run drafts assumptions and builds positioning
       'results' — the result boxes */

  function viewFor(st = state) {
    if (st.running) return 'loading';
    const run = st.run;
    return run && Object.keys(run.stages || {}).length ? 'results' : 'intro';
  }

  function setView(view) {
    const grid = el('results');
    grid.classList.toggle('is-idle', view !== 'results');
    grid.classList.toggle('is-running', view === 'loading');
    playForge(view === 'loading');
  }

  /* The forging panda: two clips stacked in one spot. `forge` loops while a
     run works; `forgeEnd` (the last strike, then the hammer goes down) plays
     once when results arrive, before they're shown. Nothing plays for anyone
     who has asked their system for reduced motion. */
  const reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let forgeDone = null;   // settles a finishForge() still waiting, if any

  function playForge(on) {
    const loop = el('forge');
    const end = el('forgeEnd');
    if (!loop || !end) return;
    if (on && !loop.paused && !end.classList.contains('is-on')) return;   // already looping
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
     last frame for a beat, then resolves. Resolves at once if the loop isn't
     actually playing, and never waits longer than both clips should take. */
  function finishForge() {
    const loop = root && el('forge');
    const end = root && el('forgeEnd');
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

  // Progress sits under the forging panda while a run works, and under the
  // Generate button once it's done.
  function paintStatus() {
    if (!mounted) return;
    el('forge-status').textContent = state.running ? state.status : '';
    el('status').textContent = state.running ? '' : state.status;
  }

  function paintRun() {
    if (!mounted) return;
    const run = state.run;
    const view = viewFor();
    setView(view);
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
    paintStatus();
    const err = el('error');
    err.textContent = state.error || state.note;
    err.hidden = !(state.error || state.note);
    paintPdfButtons();
  }

  // Both PDF buttons do the same thing; the top one only exists once there are
  // results on the page, so it can be reached without scrolling to the bottom.
  function paintPdfButtons() {
    if (!mounted) return;
    const complete = !!(state.run && state.run.complete);
    const shown = viewFor() === 'results';
    const top = el('pdf-top');
    top.hidden = !shown;
    el('pdf-row').hidden = !shown;
    [el('pdf'), top].forEach((btn) => {
      btn.disabled = !complete;
      btn.title = complete ? '' : 'Generate positioning first';
    });
  }

  /* ---------- drafting the assumptions for a run ----------
     Drafts every question that has no saved answer for the current Company /
     Champion / Competitor, using the saved-materials context the run already
     built. The two core company questions go first so the rest can draw on
     them. Text someone typed but didn't save is kept and saved instead of
     drafted over. A question that fails keeps its row error and is left for
     the user; the run only stops if the product summary or live features
     couldn't be drafted. */

  const DRAFT_LIMIT = 3;   // Draft Answer requests in flight at once

  async function draftAssumptions(st, s, context, live, setStatus) {
    if (!st.answers) st.answers = await dataOf(st).getPositioningAnswers();
    if (!live()) return;

    const changes = {};
    const todo = [];
    QUESTIONS.forEach((qn) => {
      const key = keyFor(qn, s);
      if (!key || st.answers[key] || st.drafting.has(key)) return;
      const typed = String(st.drafts[key] ?? '').trim();
      if (typed) changes[key] = typed;
      else todo.push(qn);
    });

    let done = 0;
    const total = todo.length;
    const tick = () => setStatus(`Drafting assumptions — ${done} of ${total} done…`);

    const draftOne = async (qn) => {
      const key = keyFor(qn, s);
      st.drafting.add(key);
      st.progress[key] = 'Drafting an answer…';
      delete st.rowErrors[key];
      if (onScreen(st)) renderRow(qn);
      try {
        const payload = await apiJson('/api/draft-answer', {
          questionId: qn.id,
          companyUrl: s.companyUrl,
          champion: s.champion,
          competitorUrl: s.competitorUrl,
          industry: s.industry,
          today: new Date().toISOString().slice(0, 10),
          answers: { ...answersFor(s, st), ...draftedSoFar() },
          context: context.context
        }, { signal: st.controller.signal });
        if (!live()) return;
        const sources = (payload.sources || []).filter(Boolean);
        changes[key] = `${payload.answer}${sources.length ? `\n\nSources: ${sources.join('; ')}` : ''}`;
      } catch (err) {
        if (!live()) return;
        console.error('[Build Positioning] assumption draft failed', qn.id, err);
        st.rowErrors[key] = err && err.message && !/fetch/i.test(err.message)
          ? err.message : 'Couldn’t draft this assumption. Draft it again or type your own.';
      } finally {
        if (live()) {
          st.drafting.delete(key);
          delete st.progress[key];
          done += 1;
          tick();
          if (onScreen(st)) renderRow(qn);
        }
      }
    };

    // Answers drafted earlier in this run, by question id, for later drafts.
    function draftedSoFar() {
      const out = {};
      QUESTIONS.forEach((x) => {
        const k = keyFor(x, s);
        if (k && changes[k]) out[x.id] = changes[k];
      });
      return out;
    }

    if (total) {
      tick();
      const first = todo.filter((x) => REQUIRED_IDS.includes(x.id));
      const rest = todo.filter((x) => !REQUIRED_IDS.includes(x.id));
      await pool(first, DRAFT_LIMIT, draftOne);
      if (!live()) return;
      await pool(rest, DRAFT_LIMIT, draftOne);
      if (!live()) return;
    }

    const keys = Object.keys(changes);
    if (keys.length) {
      setStatus('Saving your assumptions…');
      keys.forEach((k) => { delete st.drafts[k]; });
      st.answers = await dataOf(st).savePositioningAnswers(changes);
      if (!live()) return;
      pc.hold(st);
    }

    // From here on the Assumptions card is part of the page (minimized).
    st.qaShown = true;
    if (onScreen(st)) { paintQaCollapse(); renderQa(); }

    const saved = answersFor(s, st);
    const missing = REQUIRED_IDS.filter((id) => !saved[id]);
    if (missing.length) {
      throw new Error('Couldn’t draft the core assumptions about your product. Open Assumptions below the inputs, answer or redraft the ones marked, then generate again.');
    }
  }

  let checkingUrl = false;
  async function handleGenerate() {
    const st = state;
    if (st.running || checkingUrl) return;
    // Re-read My Company so the run uses the URL saved there right now.
    checkingUrl = true;
    try {
      const p = await dataOf(st).getProfile();
      if (st === state) { profileCache = p; industryMemo.clear(); }
    } catch (err) {
      console.warn('[Build Positioning] could not re-read My Company', err);
    } finally {
      checkingUrl = false;
    }
    if (!mounted || st !== state || st.running) return;
    const s = sel();
    const missing = missingForRun(s);
    if (missing.length) {
      updateGenerate();
      if (!validUrl(s.companyUrl)) notify(NO_COMPANY_URL, 'error');
      return;
    }

    const runId = pc.begin(st);
    const live = () => pc.live(st, runId);
    st.running = true;
    st.error = '';
    st.status = 'Getting ready…';
    st.qaCollapsed = true;
    paintQaCollapse();
    st.collapsed = DEFAULT_COLLAPSED();
    st.innerOpen = new Set();
    st.run = {
      input: { ...s, companyName: '', competitorName: '' },
      answers: {},
      stages: {},
      complete: false,
      contextNote: ''
    };
    const run = st.run;
    syncActivity(false, st);
    paintRun();
    updateGenerate();

    const setStatus = (t) => { if (!live()) return; st.status = t; if (onScreen(st)) paintStatus(); };

    try {
      const context = await buildContext(s, st, setStatus);
      if (!live()) return;
      run.contextNote = contextSummary(context, s);
      st.contextNote = run.contextNote;
      if (onScreen(st)) paintResources();

      // Every assumption without a saved answer is drafted now, the same way
      // its Draft Answer button would, and saved, so the run has them all.
      await draftAssumptions(st, s, context, live, setStatus);
      if (!live()) return;
      run.answers = answersFor(s, st);
      setStatus('Building your positioning…');

      const res = await api('/api/positioning', {
        companyUrl: s.companyUrl,
        champion: s.champion,
        competitorUrl: s.competitorUrl,
        industry: s.industry,
        today: new Date().toISOString().slice(0, 10),
        answers: run.answers,
        context: context.context
      }, { signal: st.controller.signal });
      if (!live()) return;
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        const message = payload && payload.message;
        throw new Error(Kit().accessError(res.status, message) || message || `Request failed (${res.status}).`);
      }

      await readStream(res, {
        status: (d) => setStatus(d.message || ''),
        stage: (d) => {
          if (!live() || !d || !BOXES.some((b) => b.key === d.key)) return;
          run.stages[d.key] = d.data;
          if (d.key === 'audit') {
            run.input.companyName = d.data.company_name || '';
            run.input.competitorName = d.data.competitor_name || '';
          }
          if (onScreen(st)) paintRun();
        },
        result: (d) => {
          if (!live()) return;
          run.stages = { ...run.stages, ...(d.stages || {}) };
          run.input.companyName = d.companyName || run.input.companyName;
          run.input.competitorName = d.competitorName || run.input.competitorName;
          run.generatedAt = d.generatedAt || new Date().toISOString();
          run.complete = true;
        },
        error: (d) => { throw new Error(Kit().accessError(null, d.message) || d.message || 'Something went wrong.'); }
      });
      if (!live()) return;

      if (!run.complete) throw new Error('The connection closed before the run finished. Please try again.');
      st.status = 'Positioning drafted. Review it, then create the PDF to use it in the next module.';

      // The panda finishes his pass and puts the hammer down before the
      // results replace him.
      if (onScreen(st)) {
        el('forge-status').textContent = 'Positioning drafted.';
        await finishForge();
        if (!live()) return;
      }
    } catch (err) {
      if (!live()) return;
      console.error('[Build Positioning] run failed', err);
      st.error = err && err.message && !/Failed to fetch|NetworkError/i.test(err.message)
        ? err.message : 'Could not reach the backend. Please try again.';
      st.status = '';
    } finally {
      if (pc.end(st, runId)) {             // false: cancelled by a company switch
        st.running = false;
        syncActivity(!!st.error, st);
        if (onScreen(st)) { paintRun(); paintQaCollapse(); renderQa(); updateGenerate(); }
      }
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
    draft(d, run) {
      const v = categoryView(run);
      const cards = v.options.length ? `
        <div class="bpos__choose">
          <div class="bpos__choose-head">
            <p class="bpos__label">Market category</p>
            <p class="bpos__choose-hint">Pick the category to position in. Details for each are in Market Category below.</p>
          </div>
          <div class="bpos__cats" role="group" aria-label="Market category">
            ${v.options.map((o, i) => {
              const on = i === v.selIdx;
              return `
              <button type="button" class="bpos__cat${on ? ' is-on' : ''}" data-choose="${esc(o.name)}" aria-pressed="${on ? 'true' : 'false'}">
                <span class="bpos__cat-chips">${chip(CATEGORY_TYPES[o.type] || o.type)}${i === v.recIdx ? chip('Recommended', 'good') : ''}</span>
                <span class="bpos__cat-name">${esc(o.name)}</span>
                ${o.blurb ? `<span class="bpos__cat-blurb">${esc(o.blurb)}</span>` : ''}
              </button>`;
            }).join('')}
          </div>
          <p class="bpos__choice-note">Selected: <strong>${esc(v.selected.name)}</strong> — Draft Messaging will build on this category.${
            v.override ? ` The agent recommended <strong>${esc(v.recommended.name)}</strong>; the PDF records your choice.` : ''}</p>
        </div>` : '';

      const s = statementFor(v);
      const statement = s.statement ? `<p class="bpos__statement">${esc(s.statement)}</p>` : '';
      const summary = s.summary ? `<p class="bpos__summary">${esc(s.summary)}</p>` : '';
      const validate = s.questions.length
        ? `<p class="bpos__label">What to Validate With Real Buyers</p>${list(s.questions)}` : '';
      let missing = '';
      if (!statement && !summary) {
        missing = `<p class="bpos__empty">${!v.options.length ? 'No positioning statement returned.'
          : state.running ? 'Writing the positioning for this category…'
            : 'No positioning statement was written for this category — generate positioning again to get one.'}</p>`;
      }
      return cards + (cards ? '<p class="bpos__label">Positioning statement</p>' : '') + statement + summary + validate + missing;
    },

    alternatives(d) {
      // Status quo first, competitors after, each group keeping the order the
      // stage returned. A copy, so the PDF still prints the original order.
      const items = [...(d.alternatives || [])]
        .sort((a, b) => (a.type === 'status_quo' ? 0 : 1) - (b.type === 'status_quo' ? 0 : 1));
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

    /* The same three options as the Draft box's cards, selectable here too
       and sharing the selection. "Recommended" stays on the agent's pick;
       "Selected" follows the choice. The rationale stays on screen only —
       the PDF never says which category was recommended. */
    category(d, run) {
      const v = categoryView(run);
      const rec = d.category_recommendation || {};
      const options = v.options.map((o, i) => {
        const on = i === v.selIdx;
        return `
          <button type="button" class="bpos__option bpos__option--pick${on ? ' is-picked' : ''}" data-choose="${esc(o.name)}" aria-pressed="${on ? 'true' : 'false'}">
            <span class="bpos__item-head">${chip(CATEGORY_TYPES[o.type] || o.type)} <strong>${esc(o.name)}</strong>${i === v.recIdx ? ' ' + chip('Recommended', 'good') : ''}${on ? ' ' + chip('Selected', 'sel') : ''}</span>
            ${o.helps ? `<span class="bpos__option-line"><span class="bpos__k">Helps</span> ${esc(o.helps)}</span>` : ''}
            ${o.hurts ? `<span class="bpos__option-line"><span class="bpos__k">Hurts</span> ${esc(o.hurts)}</span>` : ''}
          </button>`;
      }).join('');
      return `
        ${d.first_glance_comparison ? `<p class="bpos__muted">${esc(d.first_glance_comparison)}</p>` : ''}
        <div class="bpos__options">${options || '<p class="bpos__empty">No options returned.</p>'}</div>
        ${rec.name ? `<p class="bpos__label">Recommendation</p><p><strong>${esc(rec.name)}</strong> — ${esc(rec.rationale)}</p>` : ''}`;
      // Each option's positioning statement and summary are rendered by the
      // Draft box above; they stay in the data untouched for the PDF.
    }
  };

  /* ---------- PDF ---------- */

  async function handlePdf() {
    const pdfCid = state._cid;   // the PDF is saved to this company, or not at all
    const run = state.run;
    if (!run || !run.complete) return;
    const btns = [el('pdf'), el('pdf-top')];
    btns.forEach((b) => { b.disabled = true; b.textContent = 'Preparing PDF…'; });
    try {
      await Mktforge.loadScript(JSPDF_SRC);
      await Mktforge.loadScript(PDF_SRC);
      const questions = QUESTIONS.map((x) => ({ id: x.id, text: questionText(x, run.input) }));
      // BOXES, not DISPLAY_BOXES: the PDF keeps the original six-stage layout.
      // Switched company while the PDF tools loaded: don't save it into the other one.
      if (state._cid !== pdfCid) return;
      // The chosen category is the decision the PDF records; statementFor
      // gives its statement, summary and buyer questions.
      const category = categoryView(run);
      await window.MktforgePositioningPdf.build(run, {
        questions, boxes: BOXES, sourceLabels: SOURCE_LABELS,
        category: { ...category, statement: statementFor(category), typeNames: CATEGORY_TYPES }
      });
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
    // Kept up to date on the page but never shown: the summary of saved
    // materials is background detail (the run's own note still goes in the PDF).
    p.textContent = text;
    p.hidden = true;
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
    ['champion', 'competitor', 'industry'].forEach((name) => {
      const input = el(name);
      input.value = state.form[name];
      input.addEventListener('input', () => onFieldInput(name));
      input.addEventListener('blur', () => setTimeout(() => { if (mounted) paintFieldNotes(); }, 0));
    });
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
    fitAnswer(ta);
    updateRowSave(qn, key);
    updateGenerate();
  }

  function handleQaClick(e) {
    const btn = e.target.closest('button[data-draft], button[data-edit], button[data-save], button[data-expand]');
    if (!btn) return;
    const id = btn.dataset.draft || btn.dataset.edit || btn.dataset.save || btn.dataset.expand;
    const qn = QUESTIONS.find((x) => x.id === id);
    if (!qn) return;
    if (btn.dataset.draft) handleDraft(qn);
    else if (btn.dataset.edit) handleEdit(qn);
    else if (btn.dataset.expand) handleExpand(qn);
    else handleSaveRow(qn);
  }

  /* ---------- loading ---------- */

  async function loadAnswers() {
    const st = state;
    st.answersError = '';
    renderQa();
    try {
      st.answers = await dataOf(st).getPositioningAnswers();
    } catch (err) {
      console.error('[Build Positioning] could not load answers', err);
      st.answersError = 'Couldn’t load your saved answers.';
    }
    if (onScreen(st)) { renderQa(); paintCategory(); }   // a stored category choice may apply
  }

  async function loadFileCount() {
    const st = state;
    try {
      st.fileCount = (await dataOf(st).listFiles()).length;
    } catch (err) {
      st.fileCount = null;
    }
    if (onScreen(st)) paintResources();
  }

  /* ---------- module ---------- */

  Mktforge.register({
    id:     MODULE_ID,
    label:  MODULE_NAME,
    icon:   'crane',
    companyAware: true,
    // The ?v= changes whenever this stylesheet does, so a browser holding the
    // old copy fetches the new one instead of pairing new markup with old styles.
    styles: 'modules/build-positioning/build-positioning.css?v=2026-09-29a',

    mount(container) {
      mounted = true;
      cfg = (window.MKTFORGE_CONFIG && window.MKTFORGE_CONFIG.buildPositioning) || {};
      container.innerHTML = MARKUP;
      root = container.firstElementChild;

      const st = state;
      dataOf(st).getProfile().then((p) => {
        if (st !== state) return;              // a different company by now
        profileCache = p;
        industryMemo.clear();
        if (onScreen(st)) { paintFieldNotes(); updateGenerate(); }
      }).catch(() => {});
      unsubProfile = Data().onProfile((p) => {
        profileCache = p;
        industryMemo.clear();
        if (mounted) updateGenerate();       // a URL added in My Company switches Generate on
      });

      wireInputs();
      el('qa').addEventListener('input', handleQaInput);
      el('qa').addEventListener('click', handleQaClick);
      el('save-all').addEventListener('click', handleSaveAll);
      el('qa-collapse').addEventListener('click', toggleQa);
      el('generate').addEventListener('click', handleGenerate);
      el('pdf').addEventListener('click', handlePdf);
      el('pdf-top').addEventListener('click', handlePdf);
      el('results').addEventListener('click', handleResultsClick);
      // Typed inputs and unsaved answers are held per company (survive a refresh).
      root.addEventListener('input', (e) => pc.hold(e.isTrusted ? undefined : state));

      if (state.answers) renderQa(); else loadAnswers();
      paintQaCollapse();
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
      pc.hold(state);
      if (root) { el('forge').pause(); el('forgeEnd').pause(); }
      if (forgeDone) forgeDone();       // a waiting finish shows results on the way back
      mounted = false;
      clearTimeout(scopeTimer);
      if (unsubFiles) { unsubFiles(); unsubFiles = null; }
      if (unsubProfile) { unsubProfile(); unsubProfile = null; }
      // Drafts and a run in flight keep going and land in `state`.
      root = null;
    }
  });
})();

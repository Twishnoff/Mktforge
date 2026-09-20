/* ==========================================================================
   Market Tracker
   Watches two things at once and lays each finding out as a row.

   Tracked Buyers  — one box per job title. What that title is saying online
     about the user's company, its competitors, and the problems the product
     solves, coloured by what it means for the user. Unchanged.

   Tracked Competitors — one box per competitor URL. What that competitor has
     published or had published about it since the last look: homepage
     messaging changes, new customer stories, blog posts, news and product
     pages, plus mentions off their own site. No sentiment colour — it is a
     record of activity, not an opportunity list.

   Page
     Job Title  [dropdown of My Company's Target Job Titles] [Track Title]
     Competitor [dropdown of My Company's Competitors]       [Track Competitor]
     Tracked Buyers      — title boxes, alphabetical
     Tracked Competitors — competitor boxes, alphabetical by name

   What "new" means for a competitor box
     Every run is a report of what the agent had not shown before. A ledger
     (users/{uid}/competitorLedger) remembers every page seen on the site and
     every URL already reported, so a refresh does not repeat itself. Rows
     first shown less than 48 hours ago are carried over so a quick second
     refresh does not blank the box. The competitor's homepage is the one
     exception to URL filtering — it is judged on whether its heading, copy
     or CTA changed, not on whether the link has been seen.

   Runs
     Each box runs its own request to the Worker (/api/track, Server-Sent
     Events). The Worker is still deployed as "customer-tracker" — the module
     was renamed, its backend URL was not. Runs keep going while you're on other
     modules, and several boxes can run at once. A reload or sign-out ends
     them; the box then offers Refresh Data. Nav light: yellow while any box
     is researching, then green, or red if a run failed.

   Storage
     users/{uid}/tracker/{boxId}               the boxes and their rows
     users/{uid}/competitorLedger/{ledgerId}   what has already been seen
     A title or competitor URL removed from My Company takes its box with it.
     Stop Tracking removes the box but keeps the ledger. The ledger is deleted
     when the URL leaves My Company — tracked against the competitor list
     itself, not against the boxes, so it happens whether or not a box was
     still there at the time.
   ========================================================================== */

(() => {

  const MODULE_ID = 'market-tracker';
  const MODULE_NAME = 'Market Tracker';
  const RUN_TIMEOUT_MS = 9 * 60 * 1000;
  const CONFIRM_MS = 4000;

  /* A row first shown less than this ago survives the next refresh, so a
     refresh an hour later still shows what the last one found. */
  const CARRY_MS = 48 * 60 * 60 * 1000;

  const Data = () => window.MktforgeData;
  const Kit = () => window.MktforgeKit;
  const config = () => (window.MKTFORGE_CONFIG && window.MKTFORGE_CONFIG.marketTracker) || {};

  /* Titles that already have a box of their own. A title that exactly matches
     one of them is never borrowed as an alternative title for another box —
     a Data Platform Engineer box stops using "Data Engineer" once a Data
     Engineer box exists. Results already on screen are left alone; the rule
     bites the next time a box is refreshed. */
  function otherTrackedTitles(box) {
    return [...state.boxes.values()]
      .filter((b) => b !== box && b.kind === 'title' && b.title)
      .map((b) => b.title);
  }

  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* Box keys are namespaced so a job title and a competitor can never collide. */
  const titleKey = (title) => `t:${String(title || '').trim().toLowerCase()}`;
  const hostOf = (url) => (Data() && Data().competitorKey ? Data().competitorKey(url)
    : String(url || '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0]);
  const compKey = (url) => `c:${hostOf(url)}`;
  const keyOfBox = (b) => (b.kind === 'competitor' ? compKey(b.competitorUrl) : titleKey(b.title));

  /* ---------- state (outlives mount/unmount) ---------- */

  const state = {
    loaded: false,
    loading: null,          // Promise while the first load is in flight
    loadError: '',
    profile: null,          // My Company profile
    boxes: new Map(),       // key -> box
    selectedTitle: '',
    selectedCompetitor: ''
  };

  /* box: { id, key, kind, title, competitorUrl, rows, lastRefreshed, status,
            note, companyName, stats, runs, createdAt,
            running, progress, error, controller, confirmStop, confirmTimer } */

  let root = null;
  let mounted = false;

  /* ---------- nav light ---------- */

  const activity = { busy: false, failed: false };

  function syncActivity(failed = false) {
    const running = [...state.boxes.values()].some((b) => b.running);
    if (running && !activity.busy) {
      activity.busy = true;
      activity.failed = false;
      Mktforge.reportActivity(MODULE_ID, 'running');
    }
    if (failed) activity.failed = true;
    if (!running && activity.busy) {
      activity.busy = false;
      Mktforge.reportActivity(MODULE_ID, activity.failed ? 'error' : 'idle');
      activity.failed = false;
    }
  }

  /* ---------- loading and keeping in step with My Company ---------- */

  function profileTitles() {
    return (state.profile && state.profile.targetTitles) || [];
  }

  function profileCompetitors() {
    return ((state.profile && state.profile.competitors) || []).filter((u) => hostOf(u));
  }

  function load() {
    if (state.loaded) return Promise.resolve();
    if (state.loading) return state.loading;
    state.loading = (async () => {
      try {
        const [profile, boxes] = await Promise.all([Data().getProfile(), Data().listTrackerBoxes()]);
        state.profile = profile;
        syncLedgers(profile);
        boxes.forEach((b) => {
          const key = keyOfBox(b);
          if (!state.boxes.has(key)) state.boxes.set(key, { ...b, key, running: false, progress: '', error: '' });
        });
        state.loaded = true;
        state.loadError = '';
        reconcile();
      } catch (err) {
        console.error('[Market Tracker] could not load', err);
        state.loadError = 'Couldn’t load what you’re tracking. Check your connection and reopen this module.';
      } finally {
        state.loading = null;
        paint();
      }
    })();
    return state.loading;
  }

  /* A title or competitor URL removed (or edited) in My Company takes its box
     with it. For a competitor that also means the ledger goes: the history was
     about that URL, and re-adding it later should start clean. */
  function reconcile() {
    if (!state.profile) return;
    const keepTitles = new Set(profileTitles().map(titleKey));
    const keepComps = new Set(profileCompetitors().map(compKey));
    [...state.boxes.values()].forEach((box) => {
      const alive = box.kind === 'competitor' ? keepComps.has(box.key) : keepTitles.has(box.key);
      if (!alive) removeBox(box, { quiet: true });
    });
    if (state.selectedTitle
      && (!keepTitles.has(titleKey(state.selectedTitle)) || state.boxes.has(titleKey(state.selectedTitle)))) {
      state.selectedTitle = '';
    }
    if (state.selectedCompetitor
      && (!keepComps.has(compKey(state.selectedCompetitor)) || state.boxes.has(compKey(state.selectedCompetitor)))) {
      state.selectedCompetitor = '';
    }
  }

  /* Ledgers live and die with the competitor list in My Company, and nothing
     else. Tying the deletion to a box was wrong: Stop Tracking deliberately
     keeps the ledger, so removing the box first and the competitor second
     left the ledger with nothing to delete it — and re-adding that competitor
     picked up a history the user thought they had thrown away.

     This runs off the profile itself, from a listener registered when the
     module's script loads rather than when the module is opened, so it works
     whichever module the user is looking at when they edit My Company. */
  let knownCompetitors = null;          // key -> url, as of the last profile seen

  function syncLedgers(profile) {
    const now = new Map();
    ((profile && profile.competitors) || []).forEach((u) => {
      const host = hostOf(u);
      if (host) now.set(compKey(u), u);
    });
    if (knownCompetitors) {
      knownCompetitors.forEach((url, key) => {
        if (now.has(key)) return;
        Data().deleteCompetitorLedger(url)
          .catch((err) => console.warn('[Market Tracker] could not clear competitor history', err));
      });
    }
    knownCompetitors = now;
  }

  if (window.MktforgeData) {
    window.MktforgeData.onProfile((p) => {
      state.profile = p;
      syncLedgers(p);
      if (state.loaded) reconcile();
      paint();
    });
  }

  /* ---------- boxes ---------- */

  const byName = (a, b) => displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' });
  const displayName = (box) => box.title || hostOf(box.competitorUrl) || 'Competitor';

  function boxesOfKind(kind) {
    return [...state.boxes.values()].filter((b) => (b.kind === 'competitor') === (kind === 'competitor')).sort(byName);
  }

  function persist(box) {
    const rec = {
      id: box.id,
      title: box.title, kind: box.kind, competitorUrl: box.competitorUrl || '',
      rows: box.rows || [], lastRefreshed: box.lastRefreshed || 0,
      status: box.status || 'pending', note: box.note || '', companyName: box.companyName || '',
      stats: box.stats || null, runs: box.runs || 0, createdAt: box.createdAt || Date.now()
    };
    return Data().saveTrackerBox(rec).catch((err) => {
      console.error('[Market Tracker] could not save', err);
      notify(`Couldn’t save the results for “${displayName(box)}” to your account.`, 'error');
    });
  }

  function removeBox(box, { quiet = false } = {}) {
    clearTimeout(box.confirmTimer);
    if (box.controller) box.controller.abort();
    box.running = false;
    box.removed = true;
    state.boxes.delete(box.key);
    syncActivity();
    Data().deleteTrackerBox(box.id).catch((err) => {
      console.error('[Market Tracker] could not delete', err);
      if (!quiet) notify(`Couldn’t remove “${displayName(box)}” from your account. Try again.`, 'error');
    });
  }

  function trackTitle(title) {
    const key = titleKey(title);
    if (!String(title || '').trim() || state.boxes.has(key)) return;
    const box = {
      id: Data().trackerId(title), key, kind: 'title', title, competitorUrl: '',
      rows: [], lastRefreshed: 0, status: 'pending', note: '', companyName: '', runs: 0,
      createdAt: Date.now(), running: false, progress: '', error: ''
    };
    state.boxes.set(key, box);
    state.selectedTitle = '';
    persist(box);
    run(box);
  }

  function trackCompetitor(url) {
    const host = hostOf(url);
    const key = compKey(url);
    if (!host || state.boxes.has(key)) return;
    const box = {
      id: Data().trackerCompetitorId(url), key, kind: 'competitor',
      title: host,                      // until the agent works out whose site it is
      competitorUrl: url,
      rows: [], lastRefreshed: 0, status: 'pending', note: '', companyName: '', runs: 0,
      createdAt: Date.now(), running: false, progress: '', error: ''
    };
    state.boxes.set(key, box);
    state.selectedCompetitor = '';
    persist(box);
    run(box);
  }

  /* ---------- saved materials ----------
     A title box reads only the files about that title. A competitor box reads
     everything saved for the company, ranked so files that mention this
     competitor (battle cards above all) come first. */

  let contextQueue = Promise.resolve();

  function contextFor(box) {
    const job = contextQueue.then(async () => {
      if (!window.MktforgeResearch) return null;
      try {
        if (box.kind === 'competitor') {
          const { context } = await window.MktforgeResearch.build(
            { competitorHost: hostOf(box.competitorUrl), budget: window.MktforgeResearch.BUDGETS.small });
          return context.imported.length || context.generated.length ? context : null;
        }
        const { context } = await window.MktforgeResearch.build(
          { jobTitles: [box.title], budget: window.MktforgeResearch.BUDGETS.small });
        const aboutTitle = (e) => /job title/.test(e.match || '');
        const imported = context.imported.filter(aboutTitle);
        const generated = context.generated.filter(aboutTitle);
        return imported.length || generated.length ? { imported, generated } : null;
      } catch (err) {
        console.warn('[Market Tracker] continuing without saved materials', err);
        return null;
      }
    });
    contextQueue = job.catch(() => null);   // one build at a time; they share caches
    return job;
  }

  /* ---------- the title's family, from persona files ----------
     A Persona Builder PDF's Overview lists "Primary Job Title:" and
     "Secondary Job Titles:" (comma-separated). If the tracked title is the
     primary or one of the secondaries, every title in that persona counts
     as the same role when the agent matches posts. Imported files laid out
     the same way count too. */

  const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9&+/]+/g, ' ').trim();

  function personaTitles(text) {
    const t = String(text || '').replace(/\s+/g, ' ');
    const primary = /Primary Job Title:\s*(.+?)\s*Secondary Job Titles:/i.exec(t);
    if (!primary) return null;
    const second = /Secondary Job Titles:\s*(.+?)\s*(?:Job Level:|Average Years|Company Size:|Industry:|Common Tools:|$)/i.exec(t);
    const pieces = (second ? second[1] : '').split(/\s*[,;]\s*/)
      .map((x) => x.trim()).filter((x) => x.length > 1 && !/^none found$/i.test(x) && x !== '—');
    // The PDF joins titles with ", ", so "Senior Manager, Growth Marketing"
    // arrives as two pieces. A piece that is only a level ("Senior Manager",
    // "Director") belongs with the piece after it.
    const secondaries = [];
    for (let i = 0; i < pieces.length; i += 1) {
      if (onlyLevel(pieces[i]) && i + 1 < pieces.length) {
        secondaries.push(`${pieces[i]}, ${pieces[i + 1]}`);
        i += 1;
      } else if (!onlyLevel(pieces[i])) {
        secondaries.push(pieces[i]);
      }
    }
    return { primary: primary[1].trim(), secondaries };
  }

  const LEVEL_WORDS = new Set(['senior', 'sr', 'junior', 'jr', 'lead', 'manager', 'director', 'head', 'vp', 'svp', 'evp',
    'avp', 'vice', 'president', 'chief', 'principal', 'associate', 'assistant', 'staff', 'officer', 'executive', 'of', 'the', 'and', '&']);
  const onlyLevel = (t) => normTitle(t).split(' ').every((w) => LEVEL_WORDS.has(w));

  const personaMemo = new Map();   // fileId -> { primary, secondaries } | null

  async function titleFamily(title, exclude = []) {
    const want = normTitle(title);
    const blocked = new Set(exclude.map(normTitle).filter(Boolean));
    const out = new Map();         // normalized -> { title, from }
    let files = [];
    try { files = await Data().listFiles(); } catch (err) { return []; }
    const personas = files.filter((f) => f.moduleId === 'persona-builder'
      || (f.source === 'imported' && /persona/i.test(f.name)));
    for (const f of personas.slice(0, 30)) {
      if (!personaMemo.has(f.id)) {
        try { personaMemo.set(f.id, personaTitles(await Data().getFileText(f.id))); }
        catch (err) { personaMemo.set(f.id, null); }
      }
      const p = personaMemo.get(f.id);
      if (!p) continue;
      const all = [p.primary, ...p.secondaries];
      if (!all.some((x) => normTitle(x) === want)) continue;
      all.forEach((x) => {
        const k = normTitle(x);
        if (k && k !== want && !blocked.has(k) && !onlyLevel(x) && !out.has(k)) {
          out.set(k, { title: x, from: `${f.name}${f.ext || ''}` });
        }
      });
    }
    return [...out.values()].slice(0, 20);
  }

  /* ---------- merging a competitor report into the box ----------
     The agent only ever returns what it had not shown before. Anything shown
     in the last 48 hours is carried over so the box does not empty out between
     two refreshes on the same day; anything older has been seen and read and
     drops off. A row that comes back again (the homepage, when its copy
     changed again) replaces the carried copy. */

  function mergeRows(box, fresh) {
    const now = Date.now();
    const stamped = fresh.map((r) => ({ ...r, firstSurfaced: now }));
    const seen = new Set(stamped.map((r) => r.url).filter(Boolean));
    const carried = (box.rows || [])
      .filter((r) => Number(r.firstSurfaced) && now - Number(r.firstSurfaced) < CARRY_MS)
      .filter((r) => !r.url || !seen.has(r.url));
    return stamped.concat(carried).slice(0, 50);
  }

  /* ---------- a run ---------- */

  async function run(box) {
    if (box.running) return;
    const cfg = config();
    box.running = true;
    box.error = '';
    box.progress = 'Starting…';
    box.controller = new AbortController();
    const controller = box.controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, RUN_TIMEOUT_MS);
    syncActivity();
    paint();

    let failed = false;
    try {
      if (!cfg.API_BASE_URL) throw new Error('Market Tracker isn’t configured — set marketTracker.API_BASE_URL in assets/js/config.js.');
      const noAccess = Kit().accessProblem();
      if (noAccess) throw new Error(noAccess);

      const profile = await Data().getProfile();
      if (!profile.companyUrl) throw new Error('Company URL required. Please add a URL in your My Company module');

      box.progress = box.kind === 'competitor'
        ? 'Reading your saved research about this competitor…'
        : 'Reading your saved research about this title…';
      paintBox(box);
      const context = await contextFor(box);
      if (controller.signal.aborted) throw abortError();

      let body;
      let ledger = null;
      if (box.kind === 'competitor') {
        box.progress = 'Checking what you’ve already been shown…';
        paintBox(box);
        ledger = await Data().getCompetitorLedger(box.competitorUrl).catch((err) => {
          console.warn('[Market Tracker] starting without competitor history', err);
          return null;
        });
        if (controller.signal.aborted) throw abortError();
        body = {
          mode: 'competitor',
          competitorUrl: box.competitorUrl,
          companyUrl: profile.companyUrl,
          companyName: profile.companyName || '',
          otherCompetitorUrls: profileCompetitors().filter((u) => compKey(u) !== box.key),
          context,
          ledger,
          firstRun: !box.runs,
          today: localDay()
        };
      } else {
        const others = otherTrackedTitles(box);
        const family = await titleFamily(box.title, others).catch(() => []);
        if (controller.signal.aborted) throw abortError();
        body = {
          mode: 'jobTitle',
          jobTitle: box.title,
          companyUrl: profile.companyUrl,
          companyName: profile.companyName || '',
          competitorUrls: profile.competitors || [],
          context,
          titleFamily: family,
          otherTitles: others,
          today: localDay()
        };
      }

      const token = window.MktforgeAuth && window.MktforgeAuth.getIdToken
        ? await window.MktforgeAuth.getIdToken() : null;
      if (!token) throw new Error(Kit().NO_ACCESS);

      box.progress = 'Sending to the research agent…';
      paintBox(box);
      const res = await fetch(`${cfg.API_BASE_URL}/api/track`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        const message = payload && payload.message;
        throw new Error(Kit().accessError(res.status, message) || message || `Request failed (${res.status}).`);
      }

      let result = null;
      await readStream(res, {
        status: (d) => { box.progress = d.message || box.progress; paintBox(box); },
        result: (d) => { result = d; },
        error: (d) => { throw Object.assign(new Error(d.message || 'Something went wrong.'), { code: d.code }); }
      });
      if (!result) throw new Error('The connection closed before the research finished. Try Refresh Data.');

      if (box.removed) return;
      const rows = Array.isArray(result.rows) ? result.rows : [];
      if (box.kind === 'competitor') {
        box.rows = mergeRows(box, rows);
        box.companyName = result.companyName || box.companyName || '';
        if (box.companyName) box.title = box.companyName;
        if (result.ledger) {
          Data().saveCompetitorLedger(box.competitorUrl, result.ledger)
            .catch((err) => {
              console.error('[Market Tracker] could not save competitor history', err);
              notify(`Couldn’t save what’s been shown for “${displayName(box)}”, so the next refresh may repeat itself.`, 'error');
            });
        }
      } else {
        box.rows = rows;
        box.companyName = result.companyName || '';
      }
      box.note = result.note || '';
      box.stats = result.stats || null;
      box.runs = (box.runs || 0) + 1;
      box.lastRefreshed = Date.now();
      box.status = 'done';
      persist(box);
    } catch (err) {
      if (box.removed) return;                       // Stop Tracking, or the title went away
      if (err && err.name === 'AbortError' && !timedOut) return;
      failed = true;
      console.error('[Market Tracker] run failed', err);
      box.error = timedOut
        ? 'The research took too long and was stopped. Try Refresh Data.'
        : (err && err.message && !/Failed to fetch|NetworkError|Load failed/i.test(err.message)
          ? err.message : 'Could not reach the research service. Try Refresh Data.');
    } finally {
      clearTimeout(timer);
      if (box.controller === controller) box.controller = null;
      box.running = false;
      box.progress = '';
      syncActivity(failed);
      if (!box.removed) paintBox(box);
    }
  }

  function abortError() {
    const e = new Error('Aborted');
    e.name = 'AbortError';
    return e;
  }

  function localDay() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
        if (!dataLine) continue;              // ": ping" keep-alives
        let data;
        try { data = JSON.parse(dataLine); } catch (e) { continue; }
        if (handlers[type]) handlers[type](data);
      }
    }
  }

  function notify(message, tone = 'info') {
    document.dispatchEvent(new CustomEvent('mktforge:notify', { detail: { message, tone } }));
  }

  /* ---------- rendering ---------- */

  const MARKUP = `
  <div class="mtrk">
    <header class="mtrk__head">
      <p class="mtrk__eyebrow">${MODULE_NAME}</p>
      <h1 class="mtrk__title">Hear what buyers and competitors are saying</h1>
      <p class="mtrk__dek">Track what potential buyers and competitors are saying about the challenges you
        can solve, your company and products, and other market news.</p>
    </header>

    <section class="mtrk__card" aria-label="Track a job title or a competitor">
      <div class="mtrk__picks">
        <div class="mtrk__pick">
          <label class="mtrk__label" for="mtrk-title">Job Title</label>
          <select id="mtrk-title" data-el="select"></select>
          <button type="button" class="mtrk__btn" data-el="track">Track Title</button>
        </div>
        <div class="mtrk__pick">
          <label class="mtrk__label" for="mtrk-competitor">Competitor</label>
          <select id="mtrk-competitor" data-el="comp-select"></select>
          <button type="button" class="mtrk__btn" data-el="track-comp">Track Competitor</button>
        </div>
      </div>
      <div class="mtrk__messages" data-el="messages"></div>
    </section>

    <div class="mtrk__boxes" data-el="boxes"></div>
  </div>`;

  const el = (name) => root && root.querySelector(`[data-el="${name}"]`);

  const availableTitles = () => profileTitles().filter((t) => !state.boxes.has(titleKey(t)));
  const availableCompetitors = () => profileCompetitors().filter((u) => !state.boxes.has(compKey(u)));

  function paint() {
    if (!mounted || !root) return;
    paintPicker();
    paintBoxes();
  }

  function paintPicker() {
    const select = el('select');
    const track = el('track');
    const compSelect = el('comp-select');
    const trackComp = el('track-comp');
    const messages = el('messages');
    if (!select || !compSelect) return;

    const p = state.profile;
    const noUrl = !!p && !p.companyUrl;

    const titles = availableTitles();
    if (state.selectedTitle && !titles.some((t) => titleKey(t) === titleKey(state.selectedTitle))) state.selectedTitle = '';
    select.innerHTML = `<option value="">Select A Job Title To Track</option>`
      + titles.map((t) => `<option value="${esc(t)}"${titleKey(t) === titleKey(state.selectedTitle) ? ' selected' : ''}>${esc(t)}</option>`).join('');
    select.disabled = !state.loaded || titles.length === 0;
    track.disabled = !state.loaded || noUrl || !state.selectedTitle;

    const comps = availableCompetitors();
    if (state.selectedCompetitor && !comps.some((u) => compKey(u) === compKey(state.selectedCompetitor))) state.selectedCompetitor = '';
    compSelect.innerHTML = `<option value="">Select A Competitor To Track</option>`
      + comps.map((u) => `<option value="${esc(u)}"${compKey(u) === compKey(state.selectedCompetitor) ? ' selected' : ''}>${esc(hostOf(u))}</option>`).join('');
    compSelect.disabled = !state.loaded || comps.length === 0;
    trackComp.disabled = !state.loaded || noUrl || !state.selectedCompetitor;

    const noTitles = !!p && profileTitles().length === 0;
    const noComps = !!p && profileCompetitors().length === 0;

    const msgs = [];
    if (state.loadError) msgs.push(['error', state.loadError]);
    else if (!state.loaded) msgs.push(['muted', 'Loading your job titles and competitors…']);
    if (noUrl) msgs.push(['error', 'Company URL required. Please add a URL in your My Company module']);
    if (noTitles) {
      msgs.push(['error', 'No job titles found. Add them through the My Company module or generate them with the Find My Customer module.']);
    } else if (state.loaded && titles.length === 0) {
      msgs.push(['muted', 'Every job title in My Company is being tracked. Add more titles there to track them here.']);
    }
    if (noComps) {
      msgs.push(['error', 'No competitors found. Add competitor URLs in your My Company module to track them here — '
        + 'they also let your buyer research pick up competitor mentions.']);
    } else if (state.loaded && comps.length === 0) {
      msgs.push(['muted', 'Every competitor in My Company is being tracked. Add more competitors there to track them here.']);
    }
    messages.innerHTML = msgs.map(([tone, text]) => `<p class="mtrk__msg is-${tone}">${esc(text)}</p>`).join('');
  }

  /* Section headers appear only once their section has a box, so a user who
     only tracks job titles never sees an empty "Tracked Competitors". */
  function paintBoxes() {
    const host = el('boxes');
    if (!host) return;
    const sections = [
      ['Tracked Buyers', boxesOfKind('title')],
      ['Tracked Competitors', boxesOfKind('competitor')]
    ].filter(([, boxes]) => boxes.length);
    host.innerHTML = sections.map(([label, boxes]) => `
      <section class="mtrk__group" aria-label="${esc(label)}">
        <h2 class="mtrk__group-head">${esc(label)}</h2>
        ${boxes.map(boxHtml).join('')}
      </section>`).join('');
  }

  function paintBox(box) {
    if (!mounted || !root) return;
    const node = root.querySelector(`[data-box="${cssKey(box.key)}"]`);
    if (!node) { paintBoxes(); return; }
    node.outerHTML = boxHtml(box);
  }

  const cssKey = (key) => encodeURIComponent(key);

  /* "2026-09-03" -> "Sep 3, 2026"; "2026-08" -> "Aug 2026". Approximate
     dates (month-only, or worked out from "2 weeks ago") get a leading ~. */
  const fmtDay = (iso, approx) => {
    const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    const m = /^(\d{4})-(\d{2})$/.exec(iso || '');
    let out = '';
    if (d) out = new Date(+d[1], +d[2] - 1, +d[3]).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    else if (m) out = new Date(+m[1], +m[2] - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    return out && (approx || m) ? `~${out}` : out;
  };

  /* The Date column. A publish date when the page gave one; otherwise the day
     we first showed the row, which is the only date we honestly have. It is
     labelled, so nobody reads a discovery date as a publication date. */
  function dateCell(r) {
    if (r.date) {
      const approx = r.approx || /^\d{4}-\d{2}$/.test(r.date);
      return `<td class="mtrk__c-date"${approx ? ' title="Approximate date"' : ''}>${esc(fmtDay(r.date, r.approx))}</td>`;
    }
    if (r.firstSurfaced) {
      return `<td class="mtrk__c-date is-found" title="This page doesn’t show a publish date. This is when Market Tracker first surfaced it to you.">${
        esc(fmtDay(new Date(Number(r.firstSurfaced)).toISOString().slice(0, 10)))}<span class="mtrk__found">first seen</span></td>`;
    }
    return `<td class="mtrk__c-date is-undated" title="No publish date could be found">Undated</td>`;
  }

  /* What the agent looked at and why things were left out. */
  function statsText(box) {
    const stats = box.stats;
    if (!stats || typeof stats !== 'object') return '';
    const d = stats.dropped || {};
    const n = (v) => Number(v) || 0;
    const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
    const parts = [];
    if (box.kind === 'competitor') {
      /* Each of these is a different reason, and they used to share one
         counter — which had a first run reporting that things had been
         "shown before" when the box had never run. */
      if (n(d.date)) parts.push(`${n(d.date)} older than 30 days`);
      if (n(d.baseline)) parts.push(`${n(d.baseline)} recorded as a baseline for next time`);
      if (n(d.unchanged)) parts.push(`${n(d.unchanged)} already on the site last time`);
      if (n(d.seen)) parts.push(`${n(d.seen)} already shown to you before`);
      if (n(d.unverified)) parts.push(`${n(d.unverified)} whose publish date couldn’t be confirmed`);
      if (n(d.notRelevant)) parts.push(`${n(d.notRelevant)} not about this competitor`);
      if (n(d.other)) parts.push(`${n(d.other)} unusable (bad link or no text)`);
    } else {
      if (n(d.date)) parts.push(`${n(d.date)} older than 90 days`);
      if (n(d.match)) parts.push(`${n(d.match)} not tied to this job title`);
      if (n(d.perspective)) parts.push(`${n(d.perspective)} reporting or explainers rather than first-hand experience`);
      if (n(d.paper)) parts.push(`${n(d.paper)} research papers`);
      if (n(d.notRelevant)) parts.push(`${n(d.notRelevant)} off-topic`);
      if (n(d.owned)) parts.push(`${n(d.owned)} on your or a competitor’s own site`);
      if (n(d.vendor)) parts.push(`${n(d.vendor)} on the site of a vendor selling into the same industry`);
      if (n(d.other)) parts.push(`${n(d.other)} unusable (bad link or no text)`);
    }
    const head = `${plural(n(stats.searched), 'search', 'searches')} · ${plural(n(stats.found), 'item', 'items')} found`
      + `${n(stats.threadsRead) ? ` · ${plural(n(stats.threadsRead), 'thread', 'threads')} read for comments` : ''}`
      + `${n(stats.datesRead) ? ` · ${plural(n(stats.datesRead), 'date', 'dates')} read from the pages` : ''} · ${n(stats.kept)} shown`;
    return parts.length ? `${head}. Left out: ${parts.join(', ')}.` : `${head}.`;
  }

  const fmtWhen = (ms) => new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
  });

  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');

  const KIND = { post: 'Post', comment: 'Comment', review: 'Review', article: 'Article', page: 'Page' };
  const TONE = { green: 'Opportunity', red: 'Risk', neutral: 'Neutral' };

  /* Competitor findings are grouped by what kind of move they are, in the
     order the agent looks for them. Anything unrecognised falls to the end. */
  const GROUPS = [
    ['messaging', 'Messaging Update'],
    ['story', 'Use Cases & Customer Stories'],
    ['blog', 'Blog Posts'],
    ['news', 'News & Announcements'],
    ['product', 'Product & Solution Pages'],
    ['offsite', 'Mentions Elsewhere'],
    ['other', 'Other']
  ];
  const groupOf = (r) => (GROUPS.some(([k]) => k === r.group) ? r.group : 'other');

  function rowHtml(r, kind) {
    const url = safeUrl(r.url);
    const competitor = kind === 'competitor';
    const tone = ['green', 'red'].includes(r.opportunity) ? r.opportunity : 'neutral';
    const role = r.roleBasis === 'stated' && r.role ? `Stated role: ${r.role}`
      : r.roleBasis === 'inferred' ? `Role inferred${r.role ? ` (${r.role})` : ''}${r.why ? ` — ${r.why}` : ''}`
      : r.why || '';
    const thread = r.threadTitle ? `In thread: “${r.threadTitle}”` : '';
    /* The homepage row says which parts of the messaging moved, when the
       agent can tell — it is comparing all three anyway. */
    const changed = competitor && Array.isArray(r.changed) && r.changed.length
      ? `<p class="mtrk__thread">Changed: ${esc(r.changed.join(', '))}</p>` : '';
    return `
      <tr class="mtrk__row${competitor ? '' : ` is-${tone}`}">
        ${dateCell(r)}
        <td class="mtrk__c-source">
          <span class="mtrk__source">${esc(r.source)}</span>
          <span class="mtrk__kind">${esc(KIND[r.kind] || 'Post')}${r.companySite ? ' · company’s own site' : ''}</span>
        </td>
        <td class="mtrk__c-excerpt">
          ${competitor ? '' : `<span class="mtrk__tone">${esc(TONE[tone])}${r.churn ? ' · left you' : ''}</span>`}
          <p>${esc(r.excerpt)}</p>
          ${changed}
          ${thread ? `<p class="mtrk__thread">${esc(thread)}</p>` : ''}
          ${!competitor && role ? `<p class="mtrk__role">${esc(role)}</p>` : ''}
        </td>
        <td class="mtrk__c-mentions">${(r.mentions || []).map((m) => `<span class="mtrk__chip">${esc(m)}</span>`).join('')}</td>
        <td class="mtrk__c-link">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open<span class="mtrk__sr"> ${esc(r.source)} (opens in a new tab)</span> ↗</a>` : ''}</td>
      </tr>`;
  }

  function tableHtml(box) {
    const competitor = box.kind === 'competitor';
    let body;
    if (competitor) {
      const buckets = new Map(GROUPS.map(([k, label]) => [k, { label, rows: [] }]));
      box.rows.forEach((r) => buckets.get(groupOf(r)).rows.push(r));
      body = [...buckets.values()].filter((b) => b.rows.length).map((b) => `
        <tr class="mtrk__group-row"><th scope="colgroup" colspan="5">${esc(b.label)}</th></tr>
        ${b.rows.map((r) => rowHtml(r, box.kind)).join('')}`).join('');
    } else {
      body = box.rows.map((r) => rowHtml(r, box.kind)).join('');
    }
    return `
      <div class="mtrk__table-wrap">
        <table class="mtrk__table">
          <thead><tr>
            <th scope="col">Date</th><th scope="col">Source</th><th scope="col">Excerpt / summary</th>
            <th scope="col">Mentions</th><th scope="col"><span class="mtrk__sr">Link</span></th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  /* A competitor box reports what is new, so "nothing" is a real and common
     answer. If the homepage moved but nothing else did, say so beside it
     rather than contradicting the row above. */
  function quietNote(box) {
    if (box.kind !== 'competitor') return '';
    const others = box.rows.filter((r) => groupOf(r) !== 'messaging');
    if (others.length) return '';
    return box.rows.length
      ? 'No other new activity found since your last refresh.'
      : 'No new activity found since your last refresh.';
  }

  function bodyHtml(box) {
    if (box.running) {
      return `<div class="mtrk__state is-loading" role="status">
          <span class="mtrk__dots" aria-hidden="true"><span></span><span></span><span></span></span>
          <span>${esc(box.progress || 'Researching…')}</span>
        </div>`;
    }
    const parts = [];
    if (box.error) parts.push(`<p class="mtrk__error" role="alert">${esc(box.error)}</p>`);
    if (!box.lastRefreshed) {
      if (!box.error) parts.push('<div class="mtrk__state">Research was interrupted before it finished. Click Refresh Data to run it again.</div>');
      return parts.join('');
    }
    const competitor = box.kind === 'competitor';
    const stats = statsText(box);
    const baseline = competitor && box.runs === 1
      ? `<p class="mtrk__stats">First run — this competitor’s existing pages were recorded as a baseline, so later refreshes can show what’s changed.</p>`
      : '';

    if (!box.rows.length) {
      parts.push(`<div class="mtrk__state">
          <p>${esc(competitor ? quietNote(box)
            : 'No posts or articles from the last 90 days matched this job title.')}</p>
          ${baseline}
          ${stats ? `<p class="mtrk__stats">${esc(stats)}</p>` : ''}
        </div>`);
      return parts.join('');
    }

    if (!competitor) {
      parts.push(`
        <div class="mtrk__legend" aria-hidden="true">
          <span><i class="is-green"></i>Opportunity — unhappy with a competitor, or happy with you</span>
          <span><i class="is-red"></i>Risk — unhappy with you, or left you</span>
          <span><i></i>Neutral</span>
        </div>`);
    }
    parts.push(tableHtml(box));
    const quiet = quietNote(box);
    if (quiet) parts.push(`<p class="mtrk__quiet">${esc(quiet)}</p>`);
    if (baseline) parts.push(baseline);
    if (stats) parts.push(`<p class="mtrk__stats">${esc(stats)}</p>`);
    return parts.join('');
  }

  function boxHtml(box) {
    const competitor = box.kind === 'competitor';
    const name = displayName(box);
    const meta = box.running ? 'Researching…'
      : box.lastRefreshed ? `Last refreshed ${fmtWhen(box.lastRefreshed)}` : 'Not refreshed yet';
    const count = !box.running && box.lastRefreshed
      ? ` · ${box.rows.length} ${competitor ? 'new item' : 'result'}${box.rows.length === 1 ? '' : 's'}` : '';
    const host = competitor ? hostOf(box.competitorUrl) : '';
    const sub = competitor && host && host !== name ? `<p class="mtrk__box-url">${esc(host)}</p>` : '';
    return `
      <section class="mtrk__box${box.running ? ' is-running' : ''}${competitor ? ' is-competitor' : ''}" data-box="${cssKey(box.key)}" aria-label="${esc(name)}">
        <header class="mtrk__box-head">
          <div class="mtrk__box-title">
            <h3>${esc(name)}</h3>
            ${sub}
            <p class="mtrk__meta">${esc(meta + count)}</p>
          </div>
          <button type="button" class="mtrk__stop${box.confirmStop ? ' is-confirm' : ''}" data-act="stop">
            ${box.confirmStop ? 'Click again to stop' : 'Stop Tracking'}
          </button>
        </header>
        <div class="mtrk__box-body">${bodyHtml(box)}</div>
        <footer class="mtrk__box-foot">
          <p class="mtrk__note">${box.note && !box.running ? esc(box.note) : ''}</p>
          <button type="button" class="mtrk__btn mtrk__btn--ghost" data-act="refresh"${box.running ? ' disabled' : ''}>Refresh Data</button>
        </footer>
      </section>`;
  }

  /* ---------- events ---------- */

  function onChange(e) {
    if (e.target.matches('[data-el="select"]')) {
      state.selectedTitle = e.target.value;
      paintPicker();
    } else if (e.target.matches('[data-el="comp-select"]')) {
      state.selectedCompetitor = e.target.value;
      paintPicker();
    }
  }

  function onClick(e) {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;

    if (btn.matches('[data-el="track"]')) {
      if (state.selectedTitle) trackTitle(state.selectedTitle);
      paint();
      return;
    }
    if (btn.matches('[data-el="track-comp"]')) {
      if (state.selectedCompetitor) trackCompetitor(state.selectedCompetitor);
      paint();
      return;
    }

    const node = btn.closest('[data-box]');
    if (!node) return;
    const box = state.boxes.get(decodeURIComponent(node.dataset.box));
    if (!box) return;

    if (btn.dataset.act === 'refresh') {
      run(box);
    } else if (btn.dataset.act === 'stop') {
      if (!box.confirmStop) {
        box.confirmStop = true;
        clearTimeout(box.confirmTimer);
        box.confirmTimer = setTimeout(() => { box.confirmStop = false; paintBox(box); }, CONFIRM_MS);
        paintBox(box);
        const again = root && root.querySelector(`[data-box="${cssKey(box.key)}"] [data-act="stop"]`);
        if (again) again.focus();
        return;
      }
      const wasCompetitor = box.kind === 'competitor';
      removeBox(box);          // the ledger stays; only My Company can wipe it
      paint();
      const select = el(wasCompetitor ? 'comp-select' : 'select');
      if (select) select.focus();
    }
  }

  /* ---------- module ---------- */

  Mktforge.register({
    id:     MODULE_ID,
    label:  MODULE_NAME,
    icon:   'radar',
    styles: 'modules/market-tracker/market-tracker.css',

    mount(container) {
      mounted = true;
      container.innerHTML = MARKUP;
      root = container.firstElementChild;
      root.addEventListener('change', onChange);
      root.addEventListener('click', onClick);
      paint();
      if (state.loaded) {
        // Pick up anything changed elsewhere (e.g. titles added from Find My Customer).
        Data().getProfile().then((p) => { state.profile = p; syncLedgers(p); reconcile(); paint(); }).catch(() => {});
      } else {
        load();
      }
    },

    unmount() {
      mounted = false;
      // Runs in flight keep going and land in `state`.
      root = null;
    }
  });
})();

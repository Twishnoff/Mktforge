/* ==========================================================================
   Market Tracker
   Watches two things at once and lays each finding out as a row.

   Tracked Buyers  — one box per job title. What that title is saying online
     about the user's company, its competitors, and the problems the product
     solves. Guided by the account's own reports: the personas decide which
     titles count and where they gather, Marketing Opportunities supplies the
     publications and social sites, Find My Customer the competitors and the
     initiatives. Colour is only ever about the user's own company.

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

   What "new" means
     Both kinds of box report what the agent had not shown before. A ledger
     remembers every URL already reported, and for a competitor also every
     page seen on its site, so a refresh does not repeat itself. Rows first
     shown recently are carried over so a quick second refresh does not blank
     the box — 48 hours for a competitor, 24 for a job title. The competitor's homepage is the one
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
     refresh an hour later still shows what the last one found. The two kinds
     were given different windows deliberately. */
  const CARRY_MS = 48 * 60 * 60 * 1000;          // competitor boxes
  const CARRY_TITLE_MS = 24 * 60 * 60 * 1000;    // job-title boxes

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
  let knownTitles = null;               // key -> title

  function syncLedgers(profile) {
    const comps = new Map();
    ((profile && profile.competitors) || []).forEach((u) => {
      if (hostOf(u)) comps.set(compKey(u), u);
    });
    if (knownCompetitors) {
      knownCompetitors.forEach((url, key) => {
        if (comps.has(key)) return;
        Data().deleteCompetitorLedger(url)
          .catch((err) => console.warn('[Market Tracker] could not clear competitor history', err));
      });
    }
    knownCompetitors = comps;

    /* Job titles follow the same rule: a renamed title is a remove plus an
       add as far as My Company is concerned, so its history goes with it. */
    const titles = new Map();
    ((profile && profile.targetTitles) || []).forEach((t) => {
      if (String(t || '').trim()) titles.set(titleKey(t), t);
    });
    if (knownTitles) {
      knownTitles.forEach((title, key) => {
        if (titles.has(key)) return;
        Data().deleteTitleLedger(title)
          .catch((err) => console.warn('[Market Tracker] could not clear title history', err));
      });
    }
    knownTitles = titles;
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
      stats: box.stats || null, guide: box.guide || null,
      runs: box.runs || 0, createdAt: box.createdAt || Date.now()
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

  /* ---------- reading the account's own reports ----------
     The job-title agent is only as good as what it knows about the title, and
     everything it can know is already sitting in My Company: who the title
     is, what they are working on, and where they spend time online. Three
     reports carry it, each in a fixed layout Mktforge wrote itself, so the
     parts that matter are pulled out here rather than left for the model to
     find in a wall of text.

       Persona Builder      primary + secondary titles, Where They Gather,
                            Their Immediate Work Priorities, Their
                            Development Priorities
       Marketing Opportunities   Publications, Other Syndication Platforms,
                            Influencers, Social Media and Blogs
       Find My Customer     Pain Points / Initiatives, Competitors To Watch

     Addresses are the point of two of those lists, and until recently they
     existed only as click targets — see getFileText({ withLinks }). */

  const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9&+/]+/g, ' ').trim();

  /* LINKS ON THIS PAGE is what extraction appends after a page's text. It has
     to terminate a section like any other heading, or the last section on a
     page absorbs every link on it. */
  const LINKS_HEADING = 'LINKS ON THIS PAGE';
  const PERSONA_HEADINGS = ['Overview', 'Sample Profiles', 'Where They Gather',
    'Organizational Structure', 'Their Immediate Work Priorities', 'Their Development Priorities',
    LINKS_HEADING];
  const MO_HEADINGS = ['All Results', 'Events and Tradeshows', 'Smaller Group Events', 'Newsletters',
    'Influencers', 'Publications', 'Other Syndication Platforms', 'Social Media and Blogs',
    LINKS_HEADING];
  const FMC_HEADINGS = ['Customer List', 'Job Titles', 'Pain Points / Initiatives', 'Top Needs',
    'Competitors To Watch', LINKS_HEADING];

  /* The run of text under one heading, up to whichever heading comes next. */
  function section(text, heading, headings) {
    const flat = String(text || '');
    const at = flat.search(new RegExp(`(^|\\n|\\s)${escapeRe(heading)}\\b`, 'i'));
    if (at === -1) return '';
    const from = at + heading.length;
    let to = flat.length;
    headings.forEach((h) => {
      if (h === heading) return;
      const i = flat.slice(from).search(new RegExp(`(^|\\n|\\s)${escapeRe(h)}\\b`, 'i'));
      if (i !== -1 && from + i < to) to = from + i;
    });
    return flat.slice(from, to);
  }

  const escapeRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* "The New Stack — https://thenewstack.io" lines that extraction appends for
     every link annotation, plus any address printed as ordinary text. */
  function linkPairs(text) {
    const out = [];
    const re = /^(.*?)\s+[—-]\s+(https?:\/\/\S+)\s*$/gm;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
      out.push({ name: m[1].trim().replace(/\s+/g, ' ').slice(0, 120), url: m[2].replace(/[),.]+$/, '') });
    }
    return out;
  }

  /* Links whose label shows up inside this section. Falls back to bare URLs
     printed in the section itself, which is how the reports read once the
     generators started writing addresses out. */
  function linksIn(slice, pairs) {
    const out = new Map();
    pairs.forEach((p) => {
      const label = p.name.replace(/\s*\(.*?\)\s*$/, '').trim();
      if (!label || label.length < 3) return;
      if (slice.includes(label) && !out.has(p.url)) out.set(p.url, { name: label, url: p.url });
    });
    (slice.match(/https?:\/\/\S+/g) || []).forEach((raw) => {
      const url = raw.replace(/[),.]+$/, '');
      if (!out.has(url)) out.set(url, { name: '', url });
    });
    return [...out.values()];
  }

  /* Bullet or line items under a heading, minus the report's own filler. */
  function items(slice, max = 14) {
    return String(slice || '')
      .split(/\n+|(?:^|\s)[•·▪]\s*/)
      .map((x) => x.replace(/\s+/g, ' ').trim())
      .filter((x) => x.length > 8 && x.length < 300)
      .filter((x) => !/^(no |none found|n\/a|not specified)/i.test(x))
      .filter((x) => !/^LINKS ON THIS PAGE/i.test(x))
      .slice(0, max);
  }

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

  const kindOf = (f, text) => {
    if (f.moduleId === 'persona-builder' || /Primary Job Title:/i.test(text)) return 'persona';
    if (f.moduleId === 'marketing-opportunities' || /Job Titles Provided/i.test(text)) return 'opportunities';
    if (f.moduleId === 'find-my-customer' || /Competitors To Watch/i.test(text)) return 'customers';
    return '';
  };

  const textMemo = new Map();      // fileId -> text, for one run

  async function reportText(f) {
    if (!textMemo.has(f.id)) {
      try { textMemo.set(f.id, await Data().getFileText(f.id, { withLinks: true })); }
      catch (err) { textMemo.set(f.id, ''); }
    }
    return textMemo.get(f.id);
  }

  /* Everything the account knows about one job title. `exclude` drops titles
     that have a box of their own, so two boxes never chase the same posts. */
  async function readReports(title, exclude = []) {
    const want = normTitle(title);
    const blocked = new Set(exclude.map(normTitle).filter(Boolean));
    const out = {
      secondaries: [], gather: [], platforms: [], work: [], development: [],
      initiatives: [], competitors: [], used: []
    };
    let files = [];
    try { files = await Data().listFiles(); } catch (err) { return out; }

    const read = [];
    for (const f of files.slice(0, 40)) {
      const text = await reportText(f);
      if (!text) continue;
      read.push({ f, text, kind: kindOf(f, text) });
    }

    /* Pass one: the personas, which decide what else counts as this title. */
    const family = new Set([want]);
    read.filter((r) => r.kind === 'persona').forEach((r) => {
      const p = personaTitles(r.text);
      if (!p) return;
      const all = [p.primary, ...p.secondaries];
      if (!all.some((x) => normTitle(x) === want)) return;
      out.used.push(`${r.f.name}${r.f.ext || ''}`);
      all.forEach((x) => {
        const k = normTitle(x);
        if (k && k !== want && !blocked.has(k) && !onlyLevel(x)) {
          family.add(k);
          if (!out.secondaries.some((y) => normTitle(y) === k)) out.secondaries.push(x);
        }
      });
      const pairs = linkPairs(r.text);
      const gather = section(r.text, 'Where They Gather', PERSONA_HEADINGS);
      linksIn(gather, pairs).forEach((l) => {
        if (!out.gather.some((g) => g.url === l.url)) out.gather.push({ ...l, from: r.f.name });
      });
      out.work.push(...items(section(r.text, 'Their Immediate Work Priorities', PERSONA_HEADINGS)));
      out.development.push(...items(section(r.text, 'Their Development Priorities', PERSONA_HEADINGS)));
    });

    const mentionsFamily = (t) => [...family].some((k) => normTitle(t).includes(k) || k.includes(normTitle(t)));

    /* Pass two: the reports that are only relevant once the family is known. */
    read.forEach((r) => {
      if (r.kind === 'opportunities') {
        const provided = /Job Titles Provided\s*(.+?)\s*(?:Industry Provided|Generated)/i.exec(r.text.replace(/\s+/g, ' '));
        const titles = (provided ? provided[1] : '').split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean);
        if (!titles.some(mentionsFamily)) return;
        out.used.push(`${r.f.name}${r.f.ext || ''}`);
        const pairs = linkPairs(r.text);
        ['Publications', 'Other Syndication Platforms', 'Influencers', 'Social Media and Blogs'].forEach((name) => {
          linksIn(section(r.text, name, MO_HEADINGS), pairs).forEach((l) => {
            if (!out.platforms.some((p) => p.url === l.url)) {
              out.platforms.push({ ...l, section: name, from: r.f.name });
            }
          });
        });
      } else if (r.kind === 'customers') {
        const pairs = linkPairs(r.text);
        const comps = section(r.text, 'Competitors To Watch', FMC_HEADINGS);
        linksIn(comps, pairs).forEach((l) => {
          if (!out.competitors.some((c) => c.url === l.url)) out.competitors.push({ ...l, from: r.f.name });
        });
        const titles = section(r.text, 'Job Titles', FMC_HEADINGS);
        if (mentionsFamily(titles) || !titles) {
          out.used.push(`${r.f.name}${r.f.ext || ''}`);
          out.initiatives.push(...items(section(r.text, 'Pain Points / Initiatives', FMC_HEADINGS)));
        }
      }
    });

    const trim = (list, n) => [...new Set(list.map((x) => String(x).trim()).filter(Boolean))].slice(0, n);
    out.secondaries = trim(out.secondaries, 12);
    out.work = trim(out.work, 16);
    out.development = trim(out.development, 16);
    out.initiatives = trim(out.initiatives, 16);
    out.gather = out.gather.slice(0, 25);
    out.platforms = out.platforms.slice(0, 40);
    out.competitors = out.competitors.slice(0, 15);
    out.used = trim(out.used, 12);
    return out;
  }

  /* ---------- merging a competitor report into the box ----------
     The agent only ever returns what it had not shown before. Anything shown
     in the last 48 hours is carried over so the box does not empty out between
     two refreshes on the same day; anything older has been seen and read and
     drops off. A row that comes back again (the homepage, when its copy
     changed again) replaces the carried copy. */

  function mergeRows(box, fresh, window = CARRY_MS) {
    const now = Date.now();
    const stamped = fresh.map((r) => ({ ...r, firstSurfaced: now }));
    const seen = new Set(stamped.map((r) => r.url).filter(Boolean));
    const carried = (box.rows || [])
      .filter((r) => Number(r.firstSurfaced) && now - Number(r.firstSurfaced) < window)
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
        box.progress = 'Reading your personas, opportunity lists and customer research…';
        paintBox(box);
        const reports = await readReports(box.title, others).catch((err) => {
          console.warn('[Market Tracker] continuing without the account reports', err);
          return null;
        });
        if (controller.signal.aborted) throw abortError();
        box.progress = 'Checking what you’ve already been shown…';
        paintBox(box);
        ledger = await Data().getTitleLedger(box.title).catch((err) => {
          console.warn('[Market Tracker] starting without the title history', err);
          return null;
        });
        if (controller.signal.aborted) throw abortError();
        body = {
          mode: 'jobTitle',
          jobTitle: box.title,
          companyUrl: profile.companyUrl,
          companyName: profile.companyName || '',
          competitorUrls: profile.competitors || [],
          context,
          reports,
          otherTitles: others,
          ledger,
          firstRun: !box.runs,
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
        box.rows = mergeRows(box, rows, CARRY_MS);
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
        box.rows = mergeRows(box, rows, CARRY_TITLE_MS);
        box.companyName = result.companyName || '';
        if (result.ledger) {
          Data().saveTitleLedger(box.title, result.ledger)
            .catch((err) => {
              console.error('[Market Tracker] could not save the title history', err);
              notify(`Couldn’t save what’s been shown for “${displayName(box)}”, so the next refresh may repeat itself.`, 'error');
            });
        }
      }
      box.note = result.note || '';
      box.stats = result.stats || null;
      box.guide = box.kind === 'competitor' ? null : {
        used: Array.isArray(result.usedReports) ? result.usedReports : [],
        sites: Number(result.reportSites) || 0,
        guided: result.guided !== false
      };
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

  const dayOf = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

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
        can solve, your company and products, and other market news. Each refresh reports what’s
        turned up in the last 30 days that you haven’t already been shown.</p>
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
      /* The reader's own day, not UTC's. toISOString() here put an evening in
         California a day into the future. */
      return `<td class="mtrk__c-date is-found" title="This page doesn’t show a publish date. This is when Market Tracker first surfaced it to you.">${
        esc(fmtDay(dayOf(Number(r.firstSurfaced))))}<span class="mtrk__found">first seen</span></td>`;
    }
    return `<td class="mtrk__c-date is-undated" title="No publish date could be found">Undated</td>`;
  }

  /* Which of the account's own reports steered the run. A job-title box that
     finds nothing is usually a box that was told nothing: with no persona and
     no opportunity list, the agent has no priorities to match a post against
     and falls back to demanding the author state their job title outright,
     which on a forum means finding nothing at all. Saying so out loud is the
     difference between a puzzle and an answer. */
  function guideText(box) {
    const g = box.guide;
    if (!g || box.kind === 'competitor') return '';
    if (!g.used.length) {
      return 'No persona, opportunity list or customer report matched this title, so the agent '
        + 'searched only the default sources and could only count posts where the author states '
        + 'their job title. Run Persona Builder for this title to change that.';
    }
    const sites = g.sites ? `, and ${g.sites} site${g.sites === 1 ? '' : 's'} they name` : '';
    return `Guided by ${g.used.join(', ')}${sites}.`;
  }

  /* What the agent looked at and why things were left out. */
  function statsText(box) {
    const stats = box.stats;
    if (!stats || typeof stats !== 'object') return '';
    const d = stats.dropped || {};
    const n = (v) => Number(v) || 0;
    const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
    const parts = [];
    /* Each of these is a different reason, and they used to share one
       counter — which had a first run reporting that things had been
       "shown before" when the box had never run. */
    if (n(d.date)) parts.push(`${n(d.date)} older than 30 days`);
    if (n(d.seen)) parts.push(`${n(d.seen)} already shown to you before`);
    if (n(d.unverified)) parts.push(`${n(d.unverified)} whose publish date couldn’t be confirmed`);
    if (box.kind === 'competitor') {
      if (n(d.baseline)) parts.push(`${n(d.baseline)} recorded as a baseline for next time`);
      if (n(d.unchanged)) parts.push(`${n(d.unchanged)} already on the site last time`);
      if (n(d.budget)) parts.push(`${n(d.budget)} found but not opened — the run hit its page limit`);
      if (n(d.notRelevant)) parts.push(`${n(d.notRelevant)} not about this competitor`);
    } else {
      if (n(d.match)) parts.push(`${n(d.match)} not tied to this job title`);
      if (n(d.reviewer)) parts.push(`${n(d.reviewer)} reviews whose reviewer isn’t one of these titles`);
      if (n(d.perspective)) parts.push(`${n(d.perspective)} articles explaining a challenge rather than living it`);
      if (n(d.owned)) parts.push(`${n(d.owned)} published by you or by a competitor`);
      if (n(d.vendor)) parts.push(`${n(d.vendor)} on the site of a vendor selling into the same market`);
      if (n(d.notRelevant)) parts.push(`${n(d.notRelevant)} off-topic`);
    }
    if (n(d.other)) parts.push(`${n(d.other)} unusable (bad link or no text)`);
    const direct = box.kind !== 'competitor' && n(stats.fetched)
      ? ` · ${plural(n(stats.fetched), 'post', 'posts')} read from Reddit and Hacker News` : '';
    const head = `${plural(n(stats.searched), 'search', 'searches')}${direct} · ${plural(n(stats.found), 'item', 'items')} kept after reading`
      + `${n(stats.threadsRead) ? ` · ${plural(n(stats.threadsRead), 'thread', 'threads')} read for comments` : ''}`
      + `${n(stats.datesRead) ? ` · ${plural(n(stats.datesRead), 'date', 'dates')} read from the pages` : ''} · ${n(stats.kept)} shown`;
    const reddit = box.kind === 'competitor' ? ''
      : stats.reddit === 'not connected' ? ' Reddit isn’t connected, so it wasn’t read.'
      : stats.reddit === 'rejected' ? ' Reddit refused the sign-in — check the Worker’s Reddit secrets.'
      : stats.reddit === 'error' ? ' Reddit couldn’t be reached this run.'
      : '';
    return (parts.length ? `${head}. Left out: ${parts.join(', ')}.` : `${head}.`) + reddit;
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
    const guide = guideText(box);
    const baseline = competitor && box.runs === 1
      ? `<p class="mtrk__stats">First run — this competitor’s existing pages were recorded as a baseline, so later refreshes can show what’s changed.</p>`
      : '';

    if (!box.rows.length) {
      parts.push(`<div class="mtrk__state">
          <p>${esc(quietNote(box))}</p>
          ${baseline}
          ${guide ? `<p class="mtrk__stats">${esc(guide)}</p>` : ''}
          ${stats ? `<p class="mtrk__stats">${esc(stats)}</p>` : ''}
        </div>`);
      return parts.join('');
    }

    if (!competitor) {
      parts.push(`
        <div class="mtrk__legend" aria-hidden="true">
          <span><i class="is-green"></i>Positive about you</span>
          <span><i class="is-red"></i>Negative about you</span>
          <span><i></i>Everything else — including competitor mentions</span>
        </div>`);
    }
    parts.push(tableHtml(box));
    const quiet = quietNote(box);
    if (quiet) parts.push(`<p class="mtrk__quiet">${esc(quiet)}</p>`);
    if (baseline) parts.push(baseline);
    if (guide) parts.push(`<p class="mtrk__stats">${esc(guide)}</p>`);
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

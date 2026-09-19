/* ==========================================================================
   Customer Tracker
   Watches what one job title at a time is saying online — about the user's
   company, its competitors, and the problems its product solves — and lays
   each finding out as a row coloured by what it means for the user.

   Page
     Job Title [dropdown of My Company's Target Job Titles] [Track Title]
     one full-width box per tracked title, alphabetical:
       Stop Tracking (top right) · results table · Refresh Data (bottom right)

   Runs
     Each box runs its own request to the customer-tracker Worker
     (/api/track, Server-Sent Events). Runs keep going while you're on other
     modules, and several boxes can run at once. A reload or sign-out ends
     them; the box then offers Refresh Data. Nav light: yellow while any box
     is researching, then green, or red if a run failed.

   Storage
     users/{uid}/tracker/{boxId} (MktforgeData.saveTrackerBox). A title
     removed from My Company takes its box with it.
   ========================================================================== */

(() => {

  const MODULE_ID = 'customer-tracker';
  const MODULE_NAME = 'Customer Tracker';
  const RUN_TIMEOUT_MS = 7 * 60 * 1000;
  const CONFIRM_MS = 4000;

  const Data = () => window.MktforgeData;
  const Kit = () => window.MktforgeKit;
  const config = () => (window.MKTFORGE_CONFIG && window.MKTFORGE_CONFIG.customerTracker) || {};

  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const keyOf = (title) => String(title || '').trim().toLowerCase();

  /* ---------- state (outlives mount/unmount) ---------- */

  const state = {
    loaded: false,
    loading: null,          // Promise while the first load is in flight
    loadError: '',
    profile: null,          // My Company profile
    profileError: false,
    boxes: new Map(),       // key -> box
    selected: ''
  };

  /* box: { key, title, rows, lastRefreshed, status, note, companyName, createdAt,
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

  function load() {
    if (state.loaded) return Promise.resolve();
    if (state.loading) return state.loading;
    state.loading = (async () => {
      try {
        const [profile, boxes] = await Promise.all([Data().getProfile(), Data().listTrackerBoxes()]);
        state.profile = profile;
        state.profileError = false;
        boxes.forEach((b) => {
          const key = keyOf(b.title);
          if (!state.boxes.has(key)) state.boxes.set(key, { ...b, key, running: false, progress: '', error: '' });
        });
        state.loaded = true;
        state.loadError = '';
        reconcile();
      } catch (err) {
        console.error('[Customer Tracker] could not load', err);
        state.loadError = 'Couldn’t load your tracked titles. Check your connection and reopen this module.';
      } finally {
        state.loading = null;
        paint();
      }
    })();
    return state.loading;
  }

  /* A title removed (or renamed) in My Company takes its box with it. */
  function reconcile() {
    if (!state.profile) return;
    const keep = new Set(profileTitles().map(keyOf));
    [...state.boxes.values()].forEach((box) => {
      if (!keep.has(box.key)) removeBox(box, { quiet: true });
    });
    if (state.selected && (!keep.has(keyOf(state.selected)) || state.boxes.has(keyOf(state.selected)))) {
      state.selected = '';
    }
  }

  if (window.MktforgeData) {
    window.MktforgeData.onProfile((p) => {
      state.profile = p;
      state.profileError = false;
      if (state.loaded) reconcile();
      paint();
    });
  }

  /* ---------- boxes ---------- */

  function sortedBoxes() {
    return [...state.boxes.values()]
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  }

  function persist(box) {
    const rec = {
      title: box.title, rows: box.rows || [], lastRefreshed: box.lastRefreshed || 0,
      status: box.status || 'pending', note: box.note || '', companyName: box.companyName || '',
      createdAt: box.createdAt || Date.now()
    };
    return Data().saveTrackerBox(rec).catch((err) => {
      console.error('[Customer Tracker] could not save', err);
      notify(`Couldn’t save the results for “${box.title}” to your account.`, 'error');
    });
  }

  function removeBox(box, { quiet = false } = {}) {
    clearTimeout(box.confirmTimer);
    if (box.controller) box.controller.abort();
    box.running = false;
    box.removed = true;
    state.boxes.delete(box.key);
    syncActivity();
    Data().deleteTrackerBox(box.id || Data().trackerId(box.title)).catch((err) => {
      console.error('[Customer Tracker] could not delete', err);
      if (!quiet) notify(`Couldn’t remove “${box.title}” from your account. Try again.`, 'error');
    });
  }

  function trackTitle(title) {
    const key = keyOf(title);
    if (!key || state.boxes.has(key)) return;
    const box = {
      id: Data().trackerId(title), key, title, rows: [], lastRefreshed: 0, status: 'pending', note: '', companyName: '',
      createdAt: Date.now(), running: false, progress: '', error: ''
    };
    state.boxes.set(key, box);
    state.selected = '';
    persist(box);
    run(box);
  }

  /* ---------- saved materials: only the ones about this title ---------- */

  let contextQueue = Promise.resolve();

  function contextFor(title) {
    const job = contextQueue.then(async () => {
      if (!window.MktforgeResearch) return null;
      try {
        const { context } = await window.MktforgeResearch.build(
          { jobTitles: [title], budget: window.MktforgeResearch.BUDGETS.small });
        const aboutTitle = (e) => /job title/.test(e.match || '');
        const imported = context.imported.filter(aboutTitle);
        const generated = context.generated.filter(aboutTitle);
        return imported.length || generated.length ? { imported, generated } : null;
      } catch (err) {
        console.warn('[Customer Tracker] continuing without saved materials', err);
        return null;
      }
    });
    contextQueue = job.catch(() => null);   // one build at a time; they share caches
    return job;
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
      if (!cfg.API_BASE_URL) throw new Error('Customer Tracker isn’t configured — set customerTracker.API_BASE_URL in assets/js/config.js.');
      const noAccess = Kit().accessProblem();
      if (noAccess) throw new Error(noAccess);

      const profile = await Data().getProfile();
      if (!profile.companyUrl) throw new Error('Company URL required. Please add a URL in your My Company module');

      box.progress = 'Reading your saved research about this title…';
      paintBox(box);
      const context = await contextFor(box.title);
      if (controller.signal.aborted) throw abortError();

      const token = window.MktforgeAuth && window.MktforgeAuth.getIdToken
        ? await window.MktforgeAuth.getIdToken() : null;
      if (!token) throw new Error(Kit().NO_ACCESS);

      box.progress = 'Sending to the research agent…';
      paintBox(box);
      const res = await fetch(`${cfg.API_BASE_URL}/api/track`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jobTitle: box.title,
          companyUrl: profile.companyUrl,
          companyName: profile.companyName || '',
          competitorUrls: profile.competitors || [],
          context,
          today: localDay()
        }),
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
      box.rows = Array.isArray(result.rows) ? result.rows : [];
      box.note = result.note || '';
      box.companyName = result.companyName || '';
      box.lastRefreshed = Date.now();
      box.status = 'done';
      persist(box);
    } catch (err) {
      if (box.removed) return;                       // Stop Tracking, or the title went away
      if (err && err.name === 'AbortError' && !timedOut) return;
      failed = true;
      console.error('[Customer Tracker] run failed', err);
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
  <div class="ctrk">
    <header class="ctrk__head">
      <p class="ctrk__eyebrow">${MODULE_NAME}</p>
      <h1 class="ctrk__title">Hear what your buyers are saying</h1>
      <p class="ctrk__dek">Pick a job title and an agent searches Reddit, review sites, Hacker News,
        and the forums, blogs and news your buyers read for the last 90 days of posts about your
        company, your competitors and the problems you solve. Green rows are openings for you; red
        rows are risks.</p>
    </header>

    <section class="ctrk__card" aria-label="Track a job title">
      <div class="ctrk__pick">
        <label class="ctrk__label" for="ctrk-title">Job Title</label>
        <select id="ctrk-title" data-el="select"></select>
        <button type="button" class="ctrk__btn" data-el="track">Track Title</button>
      </div>
      <div class="ctrk__messages" data-el="messages"></div>
    </section>

    <div class="ctrk__boxes" data-el="boxes"></div>
  </div>`;

  const el = (name) => root && root.querySelector(`[data-el="${name}"]`);

  function available() {
    return profileTitles().filter((t) => !state.boxes.has(keyOf(t)));
  }

  function paint() {
    if (!mounted || !root) return;
    paintPicker();
    paintBoxes();
  }

  function paintPicker() {
    const select = el('select');
    const track = el('track');
    const messages = el('messages');
    if (!select) return;

    const titles = available();
    if (state.selected && !titles.some((t) => keyOf(t) === keyOf(state.selected))) state.selected = '';
    select.innerHTML = `<option value="">Select A Job Title To Track</option>`
      + titles.map((t) => `<option value="${esc(t)}"${keyOf(t) === keyOf(state.selected) ? ' selected' : ''}>${esc(t)}</option>`).join('');

    const p = state.profile;
    const noUrl = !!p && !p.companyUrl;
    const noTitles = !!p && profileTitles().length === 0;
    select.disabled = !state.loaded || titles.length === 0;
    track.disabled = !state.loaded || noUrl || !state.selected;

    const msgs = [];
    if (state.loadError) msgs.push(['error', state.loadError]);
    else if (!state.loaded) msgs.push(['muted', 'Loading your job titles…']);
    if (noUrl) msgs.push(['error', 'Company URL required. Please add a URL in your My Company module']);
    if (noTitles) {
      msgs.push(['error', 'No job titles found. Add them through the My Company module or generate them with the Find My Customer module.']);
    } else if (state.loaded && titles.length === 0) {
      msgs.push(['muted', 'Every job title in My Company is being tracked. Add more titles there to track them here.']);
    }
    if (p && state.loaded && !(p.competitors || []).length) {
      msgs.push(['warn', 'You currently have no competitors assigned to your company. To track competitor mentions, add competitors to your company information in your My Company module.']);
    }
    messages.innerHTML = msgs.map(([tone, text]) => `<p class="ctrk__msg is-${tone}">${esc(text)}</p>`).join('');
  }

  function paintBoxes() {
    const host = el('boxes');
    if (!host) return;
    const boxes = sortedBoxes();
    host.innerHTML = boxes.map(boxHtml).join('');
  }

  function paintBox(box) {
    if (!mounted || !root) return;
    const node = root.querySelector(`[data-box="${cssKey(box.key)}"]`);
    if (!node) { paintBoxes(); return; }
    node.outerHTML = boxHtml(box);
  }

  const cssKey = (key) => encodeURIComponent(key);

  const fmtDay = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    if (!m) return '';
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const fmtWhen = (ms) => new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
  });

  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');

  const KIND = { post: 'Post', comment: 'Comment', review: 'Review', article: 'Article' };
  const TONE = { green: 'Opportunity', red: 'Risk', neutral: 'Neutral' };

  function rowHtml(r) {
    const url = safeUrl(r.url);
    const tone = ['green', 'red'].includes(r.opportunity) ? r.opportunity : 'neutral';
    const role = r.roleBasis === 'stated' && r.role ? `Stated role: ${r.role}`
      : r.roleBasis === 'inferred' ? `Role inferred${r.role ? ` (${r.role})` : ''}${r.why ? ` — ${r.why}` : ''}`
      : r.why || '';
    return `
      <tr class="ctrk__row is-${tone}">
        <td class="ctrk__c-date">${esc(fmtDay(r.date))}</td>
        <td class="ctrk__c-source">
          <span class="ctrk__source">${esc(r.source)}</span>
          <span class="ctrk__kind">${esc(KIND[r.kind] || 'Post')}</span>
        </td>
        <td class="ctrk__c-excerpt">
          <span class="ctrk__tone">${esc(TONE[tone])}</span>
          <p>${esc(r.excerpt)}</p>
          ${role ? `<p class="ctrk__role">${esc(role)}</p>` : ''}
        </td>
        <td class="ctrk__c-mentions">${(r.mentions || []).map((m) => `<span class="ctrk__chip">${esc(m)}</span>`).join('')}</td>
        <td class="ctrk__c-link">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open<span class="ctrk__sr"> ${esc(r.source)} (opens in a new tab)</span> ↗</a>` : ''}</td>
      </tr>`;
  }

  function bodyHtml(box) {
    if (box.running) {
      return `<div class="ctrk__state is-loading" role="status">
          <span class="ctrk__dots" aria-hidden="true"><span></span><span></span><span></span></span>
          <span>${esc(box.progress || 'Researching…')}</span>
        </div>`;
    }
    const parts = [];
    if (box.error) parts.push(`<p class="ctrk__error" role="alert">${esc(box.error)}</p>`);
    if (!box.lastRefreshed) {
      if (!box.error) parts.push('<div class="ctrk__state">Research was interrupted before it finished. Click Refresh Data to run it again.</div>');
      return parts.join('');
    }
    if (!box.rows.length) {
      parts.push('<div class="ctrk__state">No posts or articles from the last 90 days matched this job title.</div>');
      return parts.join('');
    }
    parts.push(`
      <div class="ctrk__legend" aria-hidden="true">
        <span><i class="is-green"></i>Opportunity for you</span>
        <span><i class="is-red"></i>Risk to you</span>
        <span><i></i>Neutral</span>
      </div>
      <div class="ctrk__table-wrap">
        <table class="ctrk__table">
          <thead><tr>
            <th scope="col">Date</th><th scope="col">Source</th><th scope="col">Excerpt / summary</th>
            <th scope="col">Mentions</th><th scope="col"><span class="ctrk__sr">Link</span></th>
          </tr></thead>
          <tbody>${box.rows.map(rowHtml).join('')}</tbody>
        </table>
      </div>`);
    return parts.join('');
  }

  function boxHtml(box) {
    const meta = box.running ? 'Researching…'
      : box.lastRefreshed ? `Last refreshed ${fmtWhen(box.lastRefreshed)}` : 'Not refreshed yet';
    const count = !box.running && box.lastRefreshed ? ` · ${box.rows.length} result${box.rows.length === 1 ? '' : 's'}` : '';
    return `
      <section class="ctrk__box${box.running ? ' is-running' : ''}" data-box="${cssKey(box.key)}" aria-label="${esc(box.title)}">
        <header class="ctrk__box-head">
          <div class="ctrk__box-title">
            <h2>${esc(box.title)}</h2>
            <p class="ctrk__meta">${esc(meta + count)}</p>
          </div>
          <button type="button" class="ctrk__stop${box.confirmStop ? ' is-confirm' : ''}" data-act="stop">
            ${box.confirmStop ? 'Click again to stop' : 'Stop Tracking'}
          </button>
        </header>
        <div class="ctrk__box-body">${bodyHtml(box)}</div>
        <footer class="ctrk__box-foot">
          <p class="ctrk__note">${box.note && !box.running ? esc(box.note) : ''}</p>
          <button type="button" class="ctrk__btn ctrk__btn--ghost" data-act="refresh"${box.running ? ' disabled' : ''}>Refresh Data</button>
        </footer>
      </section>`;
  }

  /* ---------- events ---------- */

  function onChange(e) {
    if (e.target.matches('[data-el="select"]')) {
      state.selected = e.target.value;
      paintPicker();
    }
  }

  function onClick(e) {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;

    if (btn.matches('[data-el="track"]')) {
      if (state.selected) trackTitle(state.selected);
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
      removeBox(box);
      paint();
      const select = el('select');
      if (select) select.focus();
    }
  }

  /* ---------- module ---------- */

  Mktforge.register({
    id:     MODULE_ID,
    label:  MODULE_NAME,
    icon:   'radar',
    styles: 'modules/customer-tracker/customer-tracker.css',

    mount(container) {
      mounted = true;
      container.innerHTML = MARKUP;
      root = container.firstElementChild;
      root.addEventListener('change', onChange);
      root.addEventListener('click', onClick);
      paint();
      if (state.loaded) {
        // Pick up anything changed elsewhere (e.g. titles added from Find My Customer).
        Data().getProfile().then((p) => { state.profile = p; reconcile(); paint(); }).catch(() => {});
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

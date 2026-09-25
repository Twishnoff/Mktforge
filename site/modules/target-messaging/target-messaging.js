/* ==========================================================================
   Target Messaging — Mktforge module
   Draft email copy / talking points and landing page messaging aimed at one
   job title, or at one contact in the company's HubSpot.

   Page, top to bottom:
     1. "Define Your Customer", two tabs:
        By Job Title  — Job Title (My Company's target titles), then Messaging
                        Sources: a Draft Messaging file, an imported file, or a
                        drag-and-drop upload (imported to My Company too). All
                        three feed one table of what goes with the run. Then
                        "Use company website to supplement messaging." and
                        Generate Messaging (needs a job title plus a file or
                        the website box).
        By Individual — needs HubSpot on this company (Connect button if not).
                        Type a name or email, pick one contact; it sits as a
                        tag under Targeted Contact. Generate Messaging.
     2. Results: Draft Email / Draft Landing Page tabs, each a small rich-text
        editor (bold, italic, lists, links). What's in them is saved to the
        company as it's edited, and stays until edited again or a new run
        overwrites it (after a confirm).

   The Worker (target-messaging):
     By Job Title  — the drafting agent. Besides the sources chosen here, every
                     run also sends the company's Persona Builder and Battle
                     Card Generator PDFs (role "persona" / "battlecard"); the
                     Worker keeps only the ones written for this job title.
     By Individual — still a plumbing test ("Hello World" plus a summary).
   ========================================================================== */

(() => {

  const MODULE_ID = 'target-messaging';
  const MODULE_NAME = 'Target Messaging';
  const MESSAGING_ID = 'draft-messaging';     // the only generated files offered here

  const FILE_CHARS = 60000;                   // per chosen file sent to the Worker
  const FILES_TOTAL_CHARS = 240000;
  // Persona Builder / Battle Card PDFs sent automatically with a Job Title run.
  const AUTO_MODULES = { 'persona-builder': 'persona', 'battle-card-generator': 'battlecard' };
  const AUTO_PER_MODULE = 15;                 // newest first
  const AUTO_FILE_CHARS = 40000;
  const AUTO_TOTAL_CHARS = 300000;
  const SAVE_DELAY_MS = 800;
  const SEARCH_DELAY_MS = 250;

  const OVERWRITE = 'Generating messaging will overwrite the current copy in the Email and Landing Page editors below. Are you sure you wish to continue?';
  const HS_REQUIRED = 'Individual targeting requires a connected HubSpot account. Connect to activate this functionality.';

  const EDITORS = [
    { key: 'email', label: 'Draft Email' },
    { key: 'landingPage', label: 'Draft Landing Page' }
  ];

  const Data = () => window.MktforgeData;
  const Kit = () => window.MktforgeKit;

  /* ---------- helpers ---------- */

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function formatDate(ms) {
    if (!ms) return '';
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB`
                               : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const stamp = (ms) => (ms ? `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC` : '');
  const extFor = (f) => (f.source === 'imported' ? (f.ext || '') : '.pdf');
  const fullName = (f) => `${f.name}${extFor(f)}`;
  const kindLabel = (f) => (window.MktforgeExtract && window.MktforgeExtract.LABELS[f.kind])
    || (f.ext ? f.ext.slice(1).toUpperCase() : 'PDF');
  const contactLabel = (c) => `${c.name || c.email || 'Unnamed contact'}${c.email ? ` <${c.email}>` : ''}`;

  async function pool(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }));
    return out;
  }

  /* ---------- rich text ----------
     Only light formatting survives: paragraphs, line breaks, bold, italic,
     underline, bulleted and numbered lists, and http(s)/mailto links. That
     pastes cleanly into email clients, docs and chat tools. Everything goes
     through clean() — pasted HTML, the saved copy, and the agent's output. */

  const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE']);
  const INLINE_MAP = { B: 'strong', STRONG: 'strong', I: 'em', EM: 'em', U: 'u' };

  function safeHref(href) {
    const v = String(href || '').trim();
    return /^(https?:|mailto:)/i.test(v) ? v : '';
  }

  function clean(html) {
    const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
    const out = document.createElement('div');

    const walk = (node, into) => {
      node.childNodes.forEach((n) => {
        if (n.nodeType === 3) { into.appendChild(document.createTextNode(n.nodeValue)); return; }
        if (n.nodeType !== 1) return;
        const tag = n.tagName;
        if (['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'HEAD', 'META', 'TITLE'].includes(tag)) return;
        if (tag === 'BR') { into.appendChild(document.createElement('br')); return; }
        let el = null;
        if (INLINE_MAP[tag]) el = document.createElement(INLINE_MAP[tag]);
        else if (tag === 'UL' || tag === 'OL') el = document.createElement(tag.toLowerCase());
        else if (tag === 'LI') el = document.createElement('li');
        else if (tag === 'A') {
          const href = safeHref(n.getAttribute('href'));
          if (href) {
            el = document.createElement('a');
            el.setAttribute('href', href);
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noopener noreferrer');
          }
        } else if (BLOCK.has(tag)) {
          el = document.createElement('p');
          if (/^H[1-6]$/.test(tag)) {
            const strong = document.createElement('strong');
            el.appendChild(strong);
            walk(n, strong);
            into.appendChild(el);
            return;
          }
        }
        if (el) { walk(n, el); into.appendChild(el); } else walk(n, into);
      });
    };
    walk(doc.body, out);
    // Paragraphs can't nest: lift any <p> found inside another block.
    out.querySelectorAll('p p, li p').forEach((p) => {
      const frag = document.createDocumentFragment();
      while (p.firstChild) frag.appendChild(p.firstChild);
      if (p.parentNode.tagName === 'P') frag.appendChild(document.createElement('br'));
      p.replaceWith(frag);
    });
    out.querySelectorAll('p').forEach((p) => { if (!p.textContent.trim() && !p.querySelector('br')) p.remove(); });
    return out.innerHTML;
  }

  const textOf = (html) => {
    const d = document.createElement('div');
    d.innerHTML = html || '';
    return d.textContent.replace(/\s+/g, ' ').trim();
  };

  /* The Worker writes light Markdown; this turns it into the editor's HTML. */
  function inlineMd(s) {
    let t = esc(s);
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const href = safeHref(url.replace(/&amp;/g, '&'));
      return href ? `<a href="${esc(href)}">${label}</a>` : label;
    });
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    return t;
  }

  function mdToHtml(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let para = [];
    let list = null;          // { tag, items }
    const flushPara = () => { if (para.length) { html.push(`<p>${para.map(inlineMd).join('<br>')}</p>`); para = []; } };
    const flushList = () => {
      if (list) { html.push(`<${list.tag}>${list.items.map((i) => `<li>${inlineMd(i)}</li>`).join('')}</${list.tag}>`); list = null; }
    };
    lines.forEach((raw) => {
      const line = raw.replace(/\s+$/, '');
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
      if (!line.trim()) { flushPara(); flushList(); return; }
      if (bullet || numbered) {
        flushPara();
        const tag = bullet ? 'ul' : 'ol';
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push((bullet || numbered)[1]);
        return;
      }
      flushList();
      if (heading) { flushPara(); html.push(`<p><strong>${inlineMd(heading[1])}</strong></p>`); return; }
      para.push(line);
    });
    flushPara();
    flushList();
    return clean(html.join(''));
  }

  /* ---------- state that outlives mount/unmount ---------- */

  const pc = window.MktforgeKit.perCompany(MODULE_ID, {
    create: () => ({
      tab: 'job-title',          // 'job-title' | 'individual'
      jobTitle: '',
      picked: [],                // [{ id, name }] — the name is kept to report a deleted file
      useWebsite: false,
      contact: null,             // { id, name, email }
      editorTab: 'email',

      profile: null,
      files: null,
      filesError: '',
      uploads: [],
      pumping: false,
      menu: '',                  // 'title' | 'generated' | 'imported' | ''

      hs: null,                  // HubSpot status, null until checked
      hsError: '',
      hsBusy: false,
      search: { q: '', results: [], loading: false, error: '', open: false, active: -1, seq: 0 },
      pickError: '',

      editors: { email: '', landingPage: '' },
      editorsLoaded: false,
      saveState: '',             // '' | 'saving' | 'saved' | 'error'

      running: false,
      status: '',
      error: '',
      note: '',
      activity: { busy: false, failed: false }
    }),
    held: ['tab', 'jobTitle', 'picked', 'useWebsite', 'contact', 'editorTab'],
    snapshot: ['status', 'error'],
    onLeave(st) {
      st.activity = { busy: false, failed: false };
      st.menu = '';
      st.search = { ...st.search, open: false, loading: false };
    }
  });
  let state = pc.state;
  pc.bind((st) => { state = st; });   // the shell remounts the module after a switch
  const onScreen = (st) => mounted && st === state;
  const dataOf = (st) => Data().company(st._cid);

  let root = null;
  let mounted = false;
  let cfg = {};
  let unsubFiles = null;
  let unsubProfile = null;
  let searchTimer = null;
  const saveTimers = new Map();     // st -> { timer, go }

  /* ---------- markup ---------- */

  const MARKUP = `
  <div class="tmsg">
    <header class="tmsg__head">
      <p class="tmsg__eyebrow">Target Messaging</p>
      <h1 class="tmsg__title">Refine your messaging for any customer</h1>
      <p class="tmsg__dek">Draft email copy and talking points or landing page messaging to better resonate
        with a given job title or specific customer in your CRM.</p>
    </header>

    <section class="tmsg__card" aria-labelledby="tmsg-define-title">
      <h2 class="tmsg__h2" id="tmsg-define-title">Define Your Customer</h2>
      <div class="tmsg__tabs" role="tablist" aria-label="Define your customer">
        <button type="button" class="tmsg__tab" role="tab" id="tmsg-tab-job-title" data-tab="job-title"
          aria-controls="tmsg-panel-job-title">By Job Title</button>
        <button type="button" class="tmsg__tab" role="tab" id="tmsg-tab-individual" data-tab="individual"
          aria-controls="tmsg-panel-individual">By Individual</button>
      </div>

      <div class="tmsg__panel" role="tabpanel" id="tmsg-panel-job-title" aria-labelledby="tmsg-tab-job-title" data-panel="job-title">
        <div class="tmsg__row">
          <span class="tmsg__label" id="tmsg-title-label">Job Title</span>
          <div class="tmsg__row-body">
            <div class="tmsg__select" data-el="title-select"></div>
            <div data-el="title-note"></div>
          </div>
        </div>

        <h3 class="tmsg__h3">Messaging Sources</h3>
        <p class="tmsg__sub">Select or upload one or more sources to use to draft messaging</p>

        <div class="tmsg__sources">
          <div class="tmsg__source">
            <p class="tmsg__source-label">Select from Mktforge Results</p>
            <div class="tmsg__select" data-el="generated-select"></div>
          </div>
          <div class="tmsg__source">
            <p class="tmsg__source-label">Select an imported file</p>
            <div class="tmsg__select" data-el="imported-select"></div>
          </div>
          <div class="tmsg__source tmsg__import" data-el="import-zone">
            <p class="tmsg__source-label">Upload a file</p>
            <input type="file" multiple hidden data-el="import-input" accept="${window.MktforgeExtract ? window.MktforgeExtract.ACCEPT : ''}">
            <div class="tmsg__drop" data-el="drop">
              <p class="tmsg__drop-main"><strong>Drag and drop</strong> or
                <button type="button" class="tmsg__link" data-el="import-link">browse</button></p>
              <p class="tmsg__drop-sub">Word, PDF or slide deck · up to 15 MB. Also added to My Company.</p>
            </div>
            <ul class="tmsg__uploads" data-el="uploads" aria-live="polite"></ul>
          </div>
        </div>

        <div data-el="picked"></div>

        <div class="tmsg__center">
          <label class="tmsg__check">
            <input type="checkbox" data-el="use-website">
            <span>Use company website to supplement messaging.</span>
          </label>
          <p class="tmsg__fine" data-el="website-note"></p>
          <button type="button" class="tmsg__btn tmsg__btn--lg" data-generate="job-title" disabled>Generate Messaging</button>
          <p class="tmsg__hint" data-hint="job-title" aria-live="polite"></p>
        </div>
      </div>

      <div class="tmsg__panel" role="tabpanel" id="tmsg-panel-individual" aria-labelledby="tmsg-tab-individual" data-panel="individual" hidden>
        <div data-el="individual"></div>
      </div>

      <div class="tmsg__run">
        <p class="tmsg__status" data-el="status" aria-live="polite"></p>
        <p class="tmsg__error" data-el="error" role="alert" hidden></p>
      </div>
    </section>

    <section class="tmsg__card tmsg__results" aria-label="Drafted messaging">
      <div class="tmsg__results-head">
        <div class="tmsg__tabs" role="tablist" aria-label="Drafts">
          ${EDITORS.map((e) => `
            <button type="button" class="tmsg__tab" role="tab" id="tmsg-etab-${e.key}" data-etab="${e.key}"
              aria-controls="tmsg-editor-${e.key}">${e.label}</button>`).join('')}
        </div>
        <span class="tmsg__saved" data-el="saved" aria-live="polite"></span>
      </div>
      <div class="tmsg__toolbar" role="toolbar" aria-label="Formatting" data-el="toolbar">
        <button type="button" data-cmd="bold" title="Bold (Ctrl+B)" aria-label="Bold"><strong>B</strong></button>
        <button type="button" data-cmd="italic" title="Italic (Ctrl+I)" aria-label="Italic"><em>I</em></button>
        <button type="button" data-cmd="underline" title="Underline (Ctrl+U)" aria-label="Underline"><u>U</u></button>
        <span class="tmsg__tool-sep" aria-hidden="true"></span>
        <button type="button" data-cmd="insertUnorderedList" title="Bulleted list" aria-label="Bulleted list">&bull;&nbsp;List</button>
        <button type="button" data-cmd="insertOrderedList" title="Numbered list" aria-label="Numbered list">1.&nbsp;List</button>
        <button type="button" data-cmd="link" title="Add a link" aria-label="Add a link">Link</button>
        <button type="button" data-cmd="removeFormat" title="Clear formatting" aria-label="Clear formatting">Clear</button>
        <span class="tmsg__tool-grow"></span>
        <button type="button" class="tmsg__copy" data-el="copy">Copy</button>
      </div>
      ${EDITORS.map((e) => `
        <div class="tmsg__editor" role="tabpanel" aria-labelledby="tmsg-etab-${e.key}" id="tmsg-editor-${e.key}"
          data-editor="${e.key}" contenteditable="true" spellcheck="true" aria-multiline="true"
          aria-label="${e.label}" data-placeholder="Generated ${e.key === 'email' ? 'email copy and talking points' : 'landing page messaging'} will appear here. You can edit it, then copy it wherever you need it."></div>`).join('')}
    </section>
  </div>`;

  const el = (name) => root.querySelector(`[data-el="${name}"]`);

  /* ---------- file lists ---------- */

  const byId = (id, st = state) => (st.files || []).find((f) => f.id === id) || null;
  const titles = (st = state) => ((st.profile && st.profile.targetTitles) || []).filter(Boolean);
  const companyUrl = (st = state) => (st.profile && st.profile.companyUrl) || '';
  const pickedIds = (st = state) => st.picked.map((p) => p.id);

  function generatedFiles() {
    return (state.files || []).filter((f) => f.source !== 'imported' && f.moduleId === MESSAGING_ID);
  }
  function importedFiles() {
    return (state.files || []).filter((f) => f.source === 'imported');
  }
  function addPicked(st, f) {
    if (!f || st.picked.some((p) => p.id === f.id)) return;
    st.picked.push({ id: f.id, name: fullName(f) });
    pc.hold(st);
  }

  /* ---------- drop-downs ----------
     A listbox rather than a <select>, like Draft Messaging's: each file's
     date reads under its name. The two file drop-downs add to the table;
     the job title one holds its choice. */

  function selectHtml(name, { label, placeholder, open, options, empty, labelledBy }) {
    const opts = options.map((o, i) => `
      <li class="tmsg__option${o.selected ? ' is-selected' : ''}" role="option" aria-selected="${o.selected ? 'true' : 'false'}"
        id="tmsg-${name}-opt-${i}" data-choose="${esc(o.id)}">
        <span class="tmsg__option-name">${esc(o.name)}</span>
        ${o.meta ? `<span class="tmsg__option-meta">${esc(o.meta)}</span>` : ''}
      </li>`).join('');
    return `
      <button type="button" class="tmsg__select-btn${open ? ' is-open' : ''}${label ? '' : ' is-placeholder'}" data-menu="${name}"
        aria-haspopup="listbox" aria-expanded="${open ? 'true' : 'false'}" aria-controls="tmsg-${name}-list"
        ${labelledBy ? `aria-labelledby="${labelledBy} tmsg-${name}-value"` : ''}>
        <span class="tmsg__select-value" id="tmsg-${name}-value">${esc(label || placeholder)}</span>
        <span class="tmsg__select-caret" aria-hidden="true"></span>
      </button>
      <ul class="tmsg__options" id="tmsg-${name}-list" role="listbox" ${open ? '' : 'hidden'}>
        ${options.length ? opts : `<li class="tmsg__option is-empty" role="presentation">${esc(empty)}</li>`}
      </ul>`;
  }

  function renderTitleSelect() {
    if (!mounted) return;
    const box = el('title-select');
    const note = el('title-note');
    if (!state.profile) {
      box.innerHTML = '<p class="tmsg__loading">Loading your job titles…</p>';
      note.innerHTML = '';
      return;
    }
    const list = titles();
    box.innerHTML = selectHtml('title', {
      label: state.jobTitle,
      placeholder: 'Select job title to target',
      open: state.menu === 'title',
      options: list.map((t) => ({ id: t, name: t, selected: t === state.jobTitle })),
      empty: 'No job titles in My Company yet.',
      labelledBy: 'tmsg-title-label'
    });
    note.innerHTML = list.length ? '' : `
      <p class="tmsg__note">Add the job titles you target in My Company to use this tab.
        <button type="button" class="tmsg__link" data-go="my-company">Go to My Company</button></p>`;
  }

  function renderFileSelects() {
    if (!mounted) return;
    const gen = el('generated-select');
    const imp = el('imported-select');
    if (!state.files) {
      gen.innerHTML = imp.innerHTML = '<p class="tmsg__loading">Loading your files…</p>';
      return;
    }
    if (state.filesError) {
      gen.innerHTML = `<p class="tmsg__error">${esc(state.filesError)} <button type="button" class="tmsg__link" data-retry-files>Try again</button></p>`;
      imp.innerHTML = '';
      return;
    }
    const taken = new Set(pickedIds());
    const genAll = generatedFiles();
    const impAll = importedFiles();
    gen.innerHTML = selectHtml('generated', {
      placeholder: 'Select a Mktforge-generated file',
      open: state.menu === 'generated',
      options: genAll.filter((f) => !taken.has(f.id))
        .map((f) => ({ id: f.id, name: fullName(f), meta: formatDate(f.createdAt) })),
      empty: genAll.length ? 'Every Draft Messaging file is already added.'
        : 'No Draft Messaging files yet. Create one in the Draft Messaging module.'
    });
    imp.innerHTML = selectHtml('imported', {
      placeholder: 'Select an imported file',
      open: state.menu === 'imported',
      options: impAll.filter((f) => !taken.has(f.id))
        .map((f) => ({ id: f.id, name: fullName(f), meta: `${kindLabel(f)} · ${formatDate(f.createdAt)}` })),
      empty: impAll.length ? 'Every imported file is already added.' : 'No imported files yet.'
    });
  }

  function renderPicked() {
    if (!mounted) return;
    const box = el('picked');
    if (!state.picked.length) { box.innerHTML = ''; return; }
    const rows = state.picked.map((p) => {
      const f = byId(p.id);
      const missing = state.files && !state.filesError && !f;
      const kind = f ? (f.source === 'imported' ? 'Imported' : 'Draft Messaging') : '';
      return `
        <tr data-file="${esc(p.id)}"${missing ? ' class="is-missing"' : ''}>
          <td class="tmsg__cell-name">
            <span class="tmsg__file">${esc(f ? fullName(f) : p.name)}</span>
            ${f ? `<span class="tmsg__meta">${esc(formatSize(f.size))}</span>` : ''}
            ${missing ? '<span class="tmsg__flag is-crit">Deleted from My Company</span>' : ''}
            ${f && f.textStatus === 'empty' ? '<span class="tmsg__flag" title="Agents can’t read this file, e.g. a scanned PDF with no text layer.">No readable text</span>' : ''}
          </td>
          <td>${esc(kind)}</td>
          <td>${esc(f ? kindLabel(f) : '')}</td>
          <td>${esc(f ? formatDate(f.createdAt) : '')}</td>
          <td class="tmsg__cell-action">
            <button type="button" class="tmsg__remove" data-remove="${esc(p.id)}"
              title="Remove from this run" aria-label="Remove ${esc(p.name)} from this run">×</button>
          </td>
        </tr>`;
    }).join('');
    box.innerHTML = `
      <div class="tmsg__table-wrap">
        <p class="tmsg__table-title">Sources for this run (${state.picked.length})</p>
        <table class="tmsg__table">
          <thead><tr>
            <th scope="col">File</th><th scope="col">From</th><th scope="col">Type</th><th scope="col">Added</th>
            <th scope="col"><span class="tmsg__sr">Remove</span></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function renderWebsite() {
    if (!mounted) return;
    const box = el('use-website');
    box.checked = !!state.useWebsite;
    const note = el('website-note');
    note.textContent = state.useWebsite && state.profile && !companyUrl()
      ? 'My Company has no Company URL yet, so the website can’t be used. Add it in My Company.'
      : (state.useWebsite && companyUrl() ? `Using ${companyUrl()}` : '');
    note.classList.toggle('is-warn', !!(state.useWebsite && state.profile && !companyUrl()));
  }

  function closeMenu() {
    if (!state.menu) return;
    state.menu = '';
    renderTitleSelect();
    renderFileSelects();
  }

  function handleJobTitleClick(e) {
    const go = e.target.closest('[data-go]');
    if (go) { Mktforge.go(go.dataset.go); return; }
    if (e.target.closest('[data-retry-files]')) { loadFiles(); return; }

    const menuBtn = e.target.closest('button[data-menu]');
    if (menuBtn) {
      const name = menuBtn.dataset.menu;
      state.menu = state.menu === name ? '' : name;
      renderTitleSelect();
      renderFileSelects();
      return;
    }
    const opt = e.target.closest('[data-choose]');
    if (opt) {
      const id = opt.dataset.choose;
      if (opt.closest('[data-el="title-select"]')) {
        state.jobTitle = id;
        pc.hold();
      } else {
        addPicked(state, byId(id));
        renderPicked();
      }
      closeMenu();
      updateGenerate();
      return;
    }
    const x = e.target.closest('button[data-remove]');
    if (x) {
      // Only takes it out of this run; the file stays in My Company.
      state.picked = state.picked.filter((p) => p.id !== x.dataset.remove);
      pc.hold();
      renderPicked();
      renderFileSelects();
      updateGenerate();
    }
  }

  /* ---------- importing ----------
     The same pipeline My Company uses, so a dropped file lands in the
     account's Imported Materials and in this run's table. */

  let uploadSeq = 0;

  function renderUploads() {
    if (!mounted) return;
    const ul = el('uploads');
    const words = { queued: 'Waiting…', reading: 'Reading…', saving: 'Saving…', done: 'Imported' };
    ul.innerHTML = state.uploads.map((u) => `
      <li class="tmsg__upload is-${u.status}">
        <span class="tmsg__upload-name">${esc(u.name)}</span>
        <span class="tmsg__upload-status">${esc(u.status === 'error' ? u.message : (u.note || words[u.status]))}</span>
        ${u.status === 'error' ? `<button type="button" class="tmsg__upload-x" data-dismiss="${u.id}" aria-label="Dismiss">×</button>` : ''}
      </li>`).join('');
    ul.hidden = !state.uploads.length;
  }

  function addUploads(fileList) {
    const X = window.MktforgeExtract;
    Array.from(fileList || []).forEach((file) => {
      const u = { id: ++uploadSeq, name: file.name, file, status: 'queued', message: '' };
      if (X && !X.supported(file.name, file.type)) {
        Object.assign(u, { status: 'error', message: X.unsupportedReason(file.name) });
      } else if (file.size > Data().MAX_FILE_BYTES) {
        Object.assign(u, { status: 'error', message: `Larger than ${Data().MAX_FILE_BYTES / (1024 * 1024)} MB.` });
      } else if (!file.size) {
        Object.assign(u, { status: 'error', message: 'This file is empty.' });
      }
      state.uploads.push(u);
    });
    renderUploads();
    pump(state);
  }

  async function pump(st) {
    if (st.pumping) return;
    st.pumping = true;
    const D = dataOf(st);
    const paint = () => { if (onScreen(st)) renderUploads(); };
    try {
      for (;;) {
        const u = st.uploads.find((x) => x.status === 'queued');
        if (!u) break;
        try {
          const res = await D.importFile(u.file, { onStage: (stage) => { u.status = stage; paint(); } });
          u.status = 'done';
          u.note = res.empty ? 'Imported — no readable text found'
            : res.truncated ? 'Imported — only the first part could be read' : 'Imported — added to the table';
          if (!st.picked.some((p) => p.id === res.id)) {
            st.picked.push({ id: res.id, name: `${res.name}${res.ext || ''}` });
            pc.hold(st);
          }
          const id = u.id;
          setTimeout(() => { st.uploads = st.uploads.filter((x) => x.id !== id); paint(); }, 5000);
        } catch (err) {
          console.error('[Target Messaging] import failed', err);
          u.status = 'error';
          u.message = err && err.code ? err.message : 'Couldn’t import this file. Check your connection and try again.';
        }
        u.file = null;
        paint();
      }
    } finally {
      st.pumping = false;
      // The file list listener repaints the table; this covers a list that
      // hasn't refreshed yet.
      if (onScreen(st)) { renderPicked(); renderFileSelects(); updateGenerate(); }
    }
  }

  function wireImport() {
    const zone = el('import-zone');
    const input = el('import-input');
    el('import-link').addEventListener('click', () => input.click());
    input.addEventListener('change', () => { addUploads(input.files); input.value = ''; });

    let depth = 0;
    const hasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
    zone.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      zone.classList.add('is-dragging');
    });
    zone.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    zone.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) zone.classList.remove('is-dragging');
    });
    zone.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      zone.classList.remove('is-dragging');
      addUploads(e.dataTransfer.files);
    });
    el('uploads').addEventListener('click', (e) => {
      const x = e.target.closest('[data-dismiss]');
      if (!x) return;
      state.uploads = state.uploads.filter((u) => String(u.id) !== x.dataset.dismiss);
      renderUploads();
    });
  }

  /* ---------- Individual tab (HubSpot) ---------- */

  function renderIndividual() {
    if (!mounted) return;
    const box = el('individual');
    const s = state.hs;

    if (!s) {
      box.innerHTML = state.hsError
        ? `<div class="tmsg__empty-state"><p class="tmsg__error">${esc(state.hsError)}</p>
             <button type="button" class="tmsg__btn tmsg__btn--sm" data-hs="retry">Try again</button></div>`
        : '<div class="tmsg__empty-state"><p class="tmsg__loading">Checking HubSpot…</p></div>';
      return;
    }

    if (!s.connected || s.needsReconnect) {
      const reconnect = s.connected && s.needsReconnect;
      box.innerHTML = `
        <div class="tmsg__empty-state">
          <p class="tmsg__empty-msg">${reconnect
            ? 'Your HubSpot connection has expired or was removed. Reconnect to activate individual targeting.'
            : esc(HS_REQUIRED)}</p>
          <button type="button" class="tmsg__btn" data-hs="connect" ${state.hsBusy ? 'disabled' : ''}>
            ${state.hsBusy ? 'Opening HubSpot…' : (reconnect ? 'Reconnect My HubSpot Account' : 'Connect My HubSpot Account')}</button>
          ${state.hsError ? `<p class="tmsg__error">${esc(state.hsError)}</p>` : ''}
        </div>`;
      return;
    }

    const portal = s.portalDomain || (s.portalId ? `HubSpot account ${s.portalId}` : 'your HubSpot account');
    box.innerHTML = `
      <p class="tmsg__connected"><span class="tmsg__dot-ok" aria-hidden="true"></span>Searching ${esc(portal)}
        <span class="tmsg__muted">· manage in <button type="button" class="tmsg__link" data-go="my-company">My Company</button></span></p>

      <div class="tmsg__row">
        <label class="tmsg__label" for="tmsg-contact-input">Individual To Target</label>
        <div class="tmsg__row-body tmsg__search" data-el="search">
          <input type="text" id="tmsg-contact-input" class="tmsg__input" data-el="contact-input"
            placeholder="Search by name or email" autocomplete="off" role="combobox"
            aria-autocomplete="list" aria-expanded="false" aria-controls="tmsg-contact-list">
          <ul class="tmsg__options tmsg__results-list" id="tmsg-contact-list" role="listbox" data-el="contact-list" hidden></ul>
        </div>
      </div>

      <div class="tmsg__row">
        <span class="tmsg__label">Targeted Contact</span>
        <div class="tmsg__row-body" data-el="contact-tag"></div>
      </div>
      <p class="tmsg__error" data-el="pick-error" role="alert" hidden></p>

      <div class="tmsg__center">
        <button type="button" class="tmsg__btn tmsg__btn--lg" data-generate="individual" disabled>Generate Messaging</button>
        <p class="tmsg__hint" data-hint="individual" aria-live="polite"></p>
      </div>`;

    const input = el('contact-input');
    input.value = state.search.q;
    input.addEventListener('input', onSearchInput);
    input.addEventListener('keydown', onSearchKeydown);
    input.addEventListener('focus', () => { if (state.search.q.trim().length >= 2) { state.search.open = true; renderSearch(); } });
    input.addEventListener('blur', () => setTimeout(() => {
      if (mounted && document.activeElement !== el('contact-input')) { state.search.open = false; renderSearch(); }
    }, 0));
    el('contact-list').addEventListener('mousedown', (e) => {
      const li = e.target.closest('[data-index]');
      if (!li) return;
      e.preventDefault();
      chooseContact(Number(li.dataset.index));
    });
    renderSearch();
    renderContactTag();
    updateGenerate();
  }

  function renderContactTag() {
    if (!mounted) return;
    const box = el('contact-tag');
    if (!box) return;
    const c = state.contact;
    box.innerHTML = c
      ? `<span class="tmsg__tag">${esc(contactLabel(c))}
           <button type="button" class="tmsg__tag-x" data-untag aria-label="Remove ${esc(contactLabel(c))}" title="Remove">×</button></span>`
      : '<span class="tmsg__muted">No contact selected yet.</span>';
    const err = el('pick-error');
    err.textContent = state.pickError;
    err.hidden = !state.pickError;
  }

  function renderSearch() {
    if (!mounted) return;
    const list = el('contact-list');
    const input = el('contact-input');
    if (!list || !input) return;
    const s = state.search;
    let html = '';
    if (s.loading && !s.results.length) html = '<li class="tmsg__option is-empty" role="presentation">Searching…</li>';
    else if (s.error) html = `<li class="tmsg__option is-empty is-crit" role="presentation">${esc(s.error)}</li>`;
    else if (!s.results.length) html = '<li class="tmsg__option is-empty" role="presentation">No contacts match.</li>';
    else {
      html = s.results.map((c, i) => `
        <li class="tmsg__option${i === s.active ? ' is-active' : ''}" role="option" id="tmsg-contact-${i}"
          aria-selected="${i === s.active ? 'true' : 'false'}" data-index="${i}">
          <span class="tmsg__option-name">${esc(c.name || c.email || 'Unnamed contact')}</span>
          <span class="tmsg__option-meta">${esc(c.email || 'No email on this contact')}${c.jobTitle ? ` · ${esc(c.jobTitle)}` : ''}</span>
        </li>`).join('');
    }
    list.innerHTML = html;
    const show = s.open && s.q.trim().length >= 2;
    list.hidden = !show;
    input.setAttribute('aria-expanded', String(show));
    if (show && s.active >= 0) input.setAttribute('aria-activedescendant', `tmsg-contact-${s.active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function onSearchInput(e) {
    const st = state;
    st.search.q = e.target.value;
    st.search.active = -1;
    st.search.error = '';
    clearTimeout(searchTimer);
    if (st.search.q.trim().length < 2) {
      st.search.results = [];
      st.search.loading = false;
      st.search.open = false;
      renderSearch();
      return;
    }
    st.search.open = true;
    st.search.loading = true;
    renderSearch();
    searchTimer = setTimeout(() => runSearch(st), SEARCH_DELAY_MS);
  }

  async function runSearch(st) {
    const q = st.search.q.trim();
    const seq = ++st.search.seq;
    try {
      const data = await Kit().hubspot(st._cid).call('/api/read/contact-search', { query: q, limit: 8 });
      if (seq !== st.search.seq) return;              // a newer search is on its way
      st.search.results = (data.contacts || []).filter((c) => c && c.id);
      st.search.error = '';
    } catch (err) {
      if (seq !== st.search.seq) return;
      console.warn('[Target Messaging] contact search failed', err);
      st.search.results = [];
      st.search.error = err.message || 'Couldn’t search HubSpot. Try again.';
      if (err.code === 'reconnect_needed' || err.code === 'not_connected') {
        st.hs = { ...(st.hs || {}), connected: err.code !== 'not_connected', needsReconnect: err.code === 'reconnect_needed' };
        if (onScreen(st)) { renderIndividual(); return; }
      }
    }
    st.search.loading = false;
    if (onScreen(st)) renderSearch();
  }

  function onSearchKeydown(e) {
    const s = state.search;
    const n = s.results.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!s.open) { s.open = true; renderSearch(); return; }
      if (n) { s.active = (s.active + 1) % n; renderSearch(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) { s.active = s.active <= 0 ? n - 1 : s.active - 1; renderSearch(); }
    } else if (e.key === 'Enter') {
      if (s.open && s.active >= 0) { e.preventDefault(); chooseContact(s.active); }
    } else if (e.key === 'Escape') {
      if (s.open) { e.preventDefault(); s.open = false; renderSearch(); }
    }
  }

  function chooseContact(i) {
    const c = state.search.results[i];
    if (!c) return;
    if (state.contact) {
      state.pickError = `“${contactLabel(state.contact)}” already selected, remove before selecting another contact.`;
      state.search.open = false;
      renderSearch();
      renderContactTag();
      return;
    }
    state.contact = { id: String(c.id), name: c.name || '', email: c.email || '' };
    state.pickError = '';
    state.search = { ...state.search, q: '', results: [], open: false, active: -1, loading: false };
    pc.hold();
    const input = el('contact-input');
    if (input) input.value = '';
    renderSearch();
    renderContactTag();
    updateGenerate();
  }

  async function loadHubSpot() {
    const st = state;
    st.hsError = '';
    if (onScreen(st) && !st.hs) renderIndividual();
    try {
      st.hs = await Kit().hubspot(st._cid).status();
    } catch (err) {
      console.warn('[Target Messaging] HubSpot status unavailable', err);
      if (!st.hs) st.hsError = err.message || 'Couldn’t check the HubSpot connection.';
    }
    if (onScreen(st)) renderIndividual();
  }

  async function handleIndividualClick(e) {
    const go = e.target.closest('[data-go]');
    if (go) { Mktforge.go(go.dataset.go); return; }
    if (e.target.closest('[data-untag]')) {
      state.contact = null;
      state.pickError = '';
      pc.hold();
      renderContactTag();
      updateGenerate();
      const input = el('contact-input');
      if (input) input.focus();
      return;
    }
    const btn = e.target.closest('[data-hs]');
    if (!btn) return;
    const st = state;
    if (btn.dataset.hs === 'retry') { st.hs = null; loadHubSpot(); return; }
    if (btn.dataset.hs === 'connect') {
      st.hsBusy = true;
      st.hsError = '';
      st.tab = 'individual';          // come back to this tab after HubSpot
      pc.hold(st);
      renderIndividual();
      try {
        await Kit().hubspot(st._cid).connect({ returnTo: MODULE_ID });   // leaves the page on success
      } catch (err) {
        console.error('[Target Messaging] HubSpot connect failed', err);
        st.hsError = err.message || 'Couldn’t start the HubSpot connection.';
        st.hsBusy = false;
        if (onScreen(st)) renderIndividual();
      }
    }
  }

  /* ---------- tabs ---------- */

  function paintTabs() {
    if (!mounted) return;
    root.querySelectorAll('[data-tab]').forEach((b) => {
      const on = b.dataset.tab === state.tab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    root.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== state.tab; });
  }

  function setTab(tab) {
    if (tab === state.tab) return;
    state.tab = tab;
    state.menu = '';
    pc.hold();
    paintTabs();
    if (tab === 'individual') loadHubSpot();    // always re-check on open
    updateGenerate();
  }

  /* ---------- editors ---------- */

  const editorEl = (key) => root && root.querySelector(`[data-editor="${key}"]`);

  function paintEditorTabs() {
    if (!mounted) return;
    root.querySelectorAll('[data-etab]').forEach((b) => {
      const on = b.dataset.etab === state.editorTab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    EDITORS.forEach((e) => { editorEl(e.key).hidden = e.key !== state.editorTab; });
  }

  function paintEditors() {
    if (!mounted) return;
    EDITORS.forEach((e) => {
      const ed = editorEl(e.key);
      const html = state.editors[e.key] || '';
      if (ed.innerHTML !== html) ed.innerHTML = html;
      ed.classList.toggle('is-empty', !textOf(html));
      ed.setAttribute('contenteditable', state.running || !state.editorsLoaded ? 'false' : 'true');
      ed.classList.toggle('is-busy', state.running);
    });
    paintSaved();
  }

  function paintSaved() {
    if (!mounted) return;
    const words = { saving: 'Saving…', saved: 'Saved', error: 'Couldn’t save — check your connection' };
    const s = el('saved');
    s.textContent = !state.editorsLoaded ? 'Loading…' : (words[state.saveState] || '');
    s.classList.toggle('is-error', state.saveState === 'error');
  }

  function scheduleSave(st, now = false) {
    const pending = saveTimers.get(st);
    if (pending) clearTimeout(pending.timer);
    const go = async () => {
      const mine = saveTimers.get(st);
      if (mine) clearTimeout(mine.timer);
      saveTimers.delete(st);
      const snapshot = { ...st.editors };
      st.saveState = 'saving';
      if (onScreen(st)) paintSaved();
      try {
        await dataOf(st).saveTargetMessaging(snapshot);
        st.saveState = 'saved';
      } catch (err) {
        console.error('[Target Messaging] save failed', err);
        st.saveState = 'error';
      }
      if (onScreen(st)) paintSaved();
    };
    if (now) go();
    else saveTimers.set(st, { timer: setTimeout(go, SAVE_DELAY_MS), go });
  }

  /* Leaving the module or the company: save what's waiting right away, so
     the shell's settle() sees it before the company changes. */
  function flushSaves() {
    [...saveTimers.values()].forEach((p) => p.go());
  }

  function onEditorInput(e) {
    const ed = e.target.closest('[data-editor]');
    if (!ed || state.running) return;
    const key = ed.dataset.editor;
    state.editors[key] = ed.innerHTML;
    ed.classList.toggle('is-empty', !ed.textContent.trim());
    state.saveState = 'saving';
    paintSaved();
    scheduleSave(state);
  }

  // Pasted content keeps only the light formatting the editor allows.
  function onEditorPaste(e) {
    const ed = e.target.closest('[data-editor]');
    if (!ed || !e.clipboardData) return;
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    const safe = html ? clean(html) : esc(text).replace(/\r?\n/g, '<br>');
    document.execCommand('insertHTML', false, safe);
  }

  function onToolbar(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.el === 'copy') { copyActive(btn); return; }
    const cmd = btn.dataset.cmd;
    if (!cmd || state.running || !state.editorsLoaded) return;
    const ed = editorEl(state.editorTab);
    ed.focus();
    if (cmd === 'link') {
      const sel = window.getSelection();
      const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      const url = window.prompt('Link address (https://…)', 'https://');
      if (!url) return;
      const href = safeHref(/^[\w.-]+\.[a-z]{2,}/i.test(url) ? `https://${url}` : url);
      if (!href) { notify('Links need to start with https://, http:// or mailto:', 'error'); return; }
      if (range) { sel.removeAllRanges(); sel.addRange(range); }
      if (range && !range.collapsed) document.execCommand('createLink', false, href);
      else document.execCommand('insertHTML', false, `<a href="${esc(href)}">${esc(href)}</a>`);
    } else {
      document.execCommand(cmd, false, null);
    }
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Keep the selection in the editor when a toolbar button is pressed.
  function onToolbarMousedown(e) {
    if (e.target.closest('button[data-cmd]')) e.preventDefault();
  }

  async function copyActive(btn) {
    const html = state.editors[state.editorTab] || '';
    const text = editorEl(state.editorTab).innerText.trim();
    if (!text) { notify('There’s nothing to copy yet.'); return; }
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' })
        })]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      btn.textContent = 'Copied';
      setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy'; }, 1500);
    } catch (err) {
      console.warn('[Target Messaging] copy failed', err);
      notify('Couldn’t copy. Select the text and press Ctrl+C instead.', 'error');
    }
  }

  function notify(message, tone = 'info') {
    document.dispatchEvent(new CustomEvent('mktforge:notify', { detail: { message, tone } }));
  }

  /* ---------- nav light ---------- */

  function syncActivity(failed = false, st = state) {
    if (st !== state) return;              // a company left behind never reports
    const activity = st.activity;
    if (st.running && !activity.busy) {
      activity.busy = true;
      activity.failed = false;
      Mktforge.reportActivity(MODULE_ID, 'running');
    }
    if (failed) activity.failed = true;
    if (!st.running && activity.busy) {
      activity.busy = false;
      Mktforge.reportActivity(MODULE_ID, activity.failed ? 'error' : 'idle');
      activity.failed = false;
    }
  }

  /* ---------- readiness ---------- */

  function jobTitleReady(st = state) {
    const titleOk = !!st.jobTitle && titles(st).includes(st.jobTitle);
    const sourceOk = st.picked.length > 0 || (st.useWebsite && !!companyUrl(st));
    return { ok: titleOk && sourceOk, titleOk, sourceOk };
  }

  function individualReady(st = state) {
    return !!(st.contact && st.hs && st.hs.connected && !st.hs.needsReconnect);
  }

  function updateGenerate() {
    if (!mounted) return;
    const jt = jobTitleReady();
    const jBtn = root.querySelector('[data-generate="job-title"]');
    jBtn.disabled = state.running || !jt.ok;
    jBtn.textContent = state.running && state.runMode === 'job-title' ? 'Generating…' : 'Generate Messaging';
    const jHint = root.querySelector('[data-hint="job-title"]');
    jHint.textContent = state.running || jt.ok ? ''
      : !jt.titleOk && !jt.sourceOk ? 'Choose a job title and at least one source (or use your company website).'
      : !jt.titleOk ? 'Choose a job title to target.'
      : 'Add at least one source, or tick “Use company website to supplement messaging.”';

    const iBtn = root.querySelector('[data-generate="individual"]');
    if (iBtn) {
      iBtn.disabled = state.running || !individualReady();
      iBtn.textContent = state.running && state.runMode === 'individual' ? 'Generating…' : 'Generate Messaging';
      root.querySelector('[data-hint="individual"]').textContent =
        state.running || individualReady() ? '' : 'Search for a contact and select one to continue.';
    }
  }

  function paintRun() {
    if (!mounted) return;
    el('status').textContent = state.status;
    const err = el('error');
    err.textContent = state.error || state.note;
    err.hidden = !(state.error || state.note);
    paintEditors();
    updateGenerate();
  }

  /* ---------- the run ---------- */

  async function api(body, signal) {
    if (!cfg.API_BASE_URL) throw new Error('Target Messaging isn’t configured — set targetMessaging.API_BASE_URL in assets/js/config.js.');
    const noAccess = Kit().accessProblem();
    if (noAccess) throw new Error(noAccess);
    const token = window.MktforgeAuth && window.MktforgeAuth.getIdToken
      ? await window.MktforgeAuth.getIdToken() : null;
    if (!token) throw new Error(Kit().NO_ACCESS);
    return fetch(`${cfg.API_BASE_URL.replace(/\/+$/, '')}/api/target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal
    });
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

  /* Reads the chosen files' text out of the account. Every chosen file must
     still exist: one deleted since it was chosen stops the run by name. */
  async function readSources(st, setStatus) {
    const D = dataOf(st);
    setStatus('Checking your sources…');
    const files = await D.listFiles();
    st.files = files;
    const missing = st.picked.filter((p) => !files.some((f) => f.id === p.id));
    if (missing.length) {
      throw new Error(`${missing.map((m) => m.name).join(', ')} missing. Try again with a different file.`);
    }
    const chosen = st.picked.map((p) => files.find((f) => f.id === p.id));
    // Persona Builder and Battle Card PDFs go with every Job Title run; the
    // Worker decides which of them were written for this title.
    const chosenIds = new Set(chosen.map((f) => f.id));
    const auto = [];
    Object.keys(AUTO_MODULES).forEach((mid) => {
      files.filter((f) => f.source !== 'imported' && f.moduleId === mid && !chosenIds.has(f.id))
        .slice(0, AUTO_PER_MODULE)
        .forEach((f) => auto.push(f));
    });
    const all = [...chosen.map((f) => ({ f, auto: false })), ...auto.map((f) => ({ f, auto: true }))];
    if (!all.length) return [];
    let done = 0;
    const say = () => setStatus(`Reading your sources, personas and battle cards (${done} of ${all.length})…`);
    say();
    const rows = await pool(all, 3, async (row) => {
      let text = '';
      try { text = await D.getFileText(row.f.id); } catch (err) { console.warn('[Target Messaging] could not read', row.f.name, err); }
      done += 1;
      say();
      return { ...row, text: String(text || '') };
    });
    let room = FILES_TOTAL_CHARS;
    let autoRoom = AUTO_TOTAL_CHARS;
    return rows.map(({ f, auto: isAuto, text }) => {
      let t;
      if (isAuto) {
        t = text.slice(0, Math.max(0, Math.min(AUTO_FILE_CHARS, autoRoom)));
        autoRoom -= t.length;
      } else {
        t = text.slice(0, Math.max(0, Math.min(FILE_CHARS, room)));
        room -= t.length;
      }
      return {
        name: fullName(f),
        origin: f.source === 'imported' ? 'imported' : 'generated',
        moduleId: f.source === 'imported' ? 'imported' : (f.moduleId || ''),
        role: isAuto ? AUTO_MODULES[f.moduleId] : 'selected',
        type: kindLabel(f),
        date: stamp(f.createdAt),
        text: t
      };
    }).filter((r) => r.role === 'selected' || r.text);
  }

  function editorsHaveCopy(st) {
    return EDITORS.some((e) => textOf(st.editors[e.key]));
  }

  async function handleGenerate(mode) {
    const st = state;
    if (st.running) return;
    if (mode === 'job-title' ? !jobTitleReady(st).ok : !individualReady(st)) return;

    if (editorsHaveCopy(st)) {
      const ok = await Mktforge.confirm({ message: OVERWRITE, confirmLabel: 'Yes, Continue', cancelLabel: 'Cancel' });
      if (!ok || st !== state || st.running) return;
    }
    // An edit waiting to save must not land after the new results.
    const pending = saveTimers.get(st);
    if (pending) clearTimeout(pending.timer);
    saveTimers.delete(st);

    const runId = pc.begin(st);
    const live = () => pc.live(st, runId);
    st.running = true;
    st.runMode = mode;
    st.error = '';
    st.status = 'Getting ready…';
    closeMenu();
    syncActivity(false, st);
    paintRun();

    const setStatus = (t) => { if (!live()) return; st.status = t; if (onScreen(st)) el('status').textContent = t; };
    let result = null;

    try {
      let profile = st.profile;
      try { profile = await dataOf(st).getProfile(); } catch (e) { /* use what we have */ }
      if (!live()) return;
      const base = {
        mode,
        companyId: st._cid,
        companyName: (profile && profile.companyName) || '',
        companyUrl: (profile && profile.companyUrl) || '',
        today: new Date().toISOString().slice(0, 10)
      };

      let body;
      if (mode === 'job-title') {
        const files = await readSources(st, setStatus);
        if (!live()) return;
        if (onScreen(st)) renderPicked();
        body = { ...base, jobTitle: st.jobTitle, files, useWebsite: !!st.useWebsite };
        if (!st.useWebsite) body.companyUrl = '';
      } else {
        body = { ...base, contactId: st.contact.id, contactLabel: contactLabel(st.contact) };
      }

      setStatus('Sending to the drafting agent…');
      const res = await api(body, st.controller.signal);
      if (!live()) return;
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        const message = payload && payload.message;
        throw new Error(Kit().accessError(res.status, message) || message || `Request failed (${res.status}).`);
      }

      await readStream(res, {
        status: (d) => setStatus(d.message || ''),
        result: (d) => { if (live()) result = d; },
        error: (d) => { throw new Error(Kit().accessError(null, d.message) || d.message || 'Something went wrong.'); }
      });
      if (!live()) return;
      if (!result) throw new Error('The connection closed before the run finished. Please try again.');

      st.editors = { email: mdToHtml(result.email), landingPage: mdToHtml(result.landingPage) };
      st.status = 'Messaging drafted. Review and edit it below, then copy it wherever you need it.';
    } catch (err) {
      if (!live()) return;
      if (err && err.name === 'AbortError') return;
      console.error('[Target Messaging] run failed', err);
      st.error = err && err.message && !/Failed to fetch|NetworkError|Load failed/i.test(err.message)
        ? err.message : 'Could not reach the backend. Please try again.';
      st.status = '';
    } finally {
      if (pc.end(st, runId)) {            // false: cancelled by a company switch
        st.running = false;
        st.runMode = '';
        if (result && !st.error) scheduleSave(st, true);
        syncActivity(!!st.error, st);
        if (onScreen(st)) paintRun();
      }
    }
  }

  /* ---------- loading ---------- */

  async function loadFiles() {
    const st = state;
    st.filesError = '';
    if (!st.files && onScreen(st)) { renderFileSelects(); }
    try {
      st.files = await dataOf(st).listFiles();
    } catch (err) {
      console.error('[Target Messaging] could not load files', err);
      st.filesError = 'Couldn’t load your saved files.';
      st.files = st.files || [];
    }
    // Chosen files that were deleted stay in the table, marked, so the run
    // can name them; the person takes them out with the ×.
    if (!onScreen(st)) return;
    renderFileSelects();
    renderPicked();
    updateGenerate();
  }

  async function loadProfile() {
    const st = state;
    try {
      st.profile = await dataOf(st).getProfile();
    } catch (err) {
      console.warn('[Target Messaging] profile unavailable', err);
      st.profile = st.profile || { targetTitles: [], companyUrl: '' };
    }
    if (st.jobTitle && !titles(st).includes(st.jobTitle)) { st.jobTitle = ''; pc.hold(st); }
    if (!onScreen(st)) return;
    renderTitleSelect();
    renderWebsite();
    updateGenerate();
  }

  async function loadEditors() {
    const st = state;
    if (st.editorsLoaded) return;
    try {
      const saved = await dataOf(st).getTargetMessaging();
      if (!st.editorsLoaded && !st.running) {
        st.editors = { email: clean(saved.email), landingPage: clean(saved.landingPage) };
      }
    } catch (err) {
      console.error('[Target Messaging] could not load drafts', err);
      if (onScreen(st)) notify('Couldn’t load your saved drafts. Refresh to try again.', 'error');
    }
    st.editorsLoaded = true;
    if (onScreen(st)) paintEditors();
  }

  function loadAll() {
    loadProfile();
    loadFiles();
    loadEditors();
    if (state.tab === 'individual') loadHubSpot();
  }

  function paintAll() {
    paintTabs();
    paintEditorTabs();
    renderTitleSelect();
    renderFileSelects();
    renderPicked();
    renderUploads();
    renderWebsite();
    renderIndividual();
    paintRun();
  }

  /* ---------- module ---------- */

  Mktforge.register({
    id:     MODULE_ID,
    label:  MODULE_NAME,
    icon:   'pin',
    companyAware: true,
    styles: 'modules/target-messaging/target-messaging.css',

    mount(container) {
      mounted = true;
      cfg = (window.MKTFORGE_CONFIG && window.MKTFORGE_CONFIG.targetMessaging) || {};
      container.innerHTML = MARKUP;
      root = container.firstElementChild;

      root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
      root.querySelectorAll('[data-etab]').forEach((b) => b.addEventListener('click', () => {
        state.editorTab = b.dataset.etab;
        pc.hold();
        paintEditorTabs();
      }));
      root.querySelector('[data-panel="job-title"]').addEventListener('click', handleJobTitleClick);
      el('individual').addEventListener('click', handleIndividualClick);
      el('use-website').addEventListener('change', (e) => {
        state.useWebsite = e.target.checked;
        pc.hold();
        renderWebsite();
        updateGenerate();
      });
      root.addEventListener('click', (e) => {
        const g = e.target.closest('[data-generate]');
        if (g && !g.disabled) handleGenerate(g.dataset.generate);
      });
      wireImport();

      const results = root.querySelector('.tmsg__results');
      results.addEventListener('input', onEditorInput);
      results.addEventListener('paste', onEditorPaste);
      el('toolbar').addEventListener('mousedown', onToolbarMousedown);
      el('toolbar').addEventListener('click', onToolbar);

      document.addEventListener('click', onDocumentClick, true);
      document.addEventListener('keydown', onKeydown);

      paintAll();
      loadAll();
      unsubFiles = Data().onFiles(() => { if (mounted) loadFiles(); });
      unsubProfile = Data().onProfile((p) => {
        state.profile = p;
        if (!mounted) return;
        if (state.jobTitle && !titles().includes(state.jobTitle)) { state.jobTitle = ''; pc.hold(); }
        renderTitleSelect();
        renderWebsite();
        updateGenerate();
      });
    },

    unmount() {
      flushSaves();
      pc.hold(state);
      mounted = false;
      state.menu = '';
      state.search.open = false;
      clearTimeout(searchTimer);
      document.removeEventListener('click', onDocumentClick, true);
      document.removeEventListener('keydown', onKeydown);
      if (unsubFiles) { unsubFiles(); unsubFiles = null; }
      if (unsubProfile) { unsubProfile(); unsubProfile = null; }
      // A run in flight keeps going and lands in `state`.
      root = null;
    }
  });

  /* A click anywhere else closes an open drop-down; Escape does the same. */
  function onDocumentClick(e) {
    if (!mounted || !state.menu) return;
    if (e.target.closest('.tmsg__select')) return;
    closeMenu();
  }

  function onKeydown(e) {
    if (!mounted || e.key !== 'Escape' || !state.menu) return;
    closeMenu();
  }
})();

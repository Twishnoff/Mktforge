/* ==========================================================================
   Draft Messaging — Mktforge module
   Stages 6–9 of the Draft Messaging Framework, picking up where Build
   Positioning (stages 0–5) left off.

   Page, top to bottom:
     1. Two columns of inputs:
        left  — "Select your positioning document": every PDF the Build
                Positioning module has saved to the account, newest first. With
                none saved, a button goes to that module instead.
        right — "Provide additional research (optional)": the same drag-and-drop
                import as My Company (anything dropped here is imported to the
                account too), plus a drop-down of files already in My Company.
                Chosen files sit in a table; the × takes one back out and it
                returns to the drop-down.
     2. Draft Messaging: disabled until a positioning document is chosen.
        Streams the run and fills the two boxes when it finishes.
     3. Messaging Hierarchy (stage 7) and Drafted Homepage Copy (stage 8),
        each minimizing to its title line like Build Positioning's boxes.
     4. Create Messaging PDF: downloads it and saves a copy to My Company.

   What the agent gets
     The positioning document is the spine of the run — it carries the champion,
     alternatives, differentiators, value themes and category the user already
     reviewed. The files chosen here go with it as the user's own research,
     which the Worker trusts above anything Mktforge generated. Both are read
     out of the account as text (`getFileText`, which extracts a generated PDF
     the first time anything needs it).

   What comes back
     Stage 6 (the strategic narrative) and stage 9 (the quality check) are
     deliberately invisible: 6 is working material for 7 and 8, and 9 is the
     gate the copy has to clear before any of it reaches this page. Both are
     kept on the run for the record; neither is shown or printed.
   ========================================================================== */

(() => {

  const MODULE_ID = 'draft-messaging';
  const MODULE_NAME = 'Draft Messaging';
  const POSITIONING_ID = 'build-positioning';
  const JSPDF_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  const PDF_SRC = 'modules/draft-messaging/messaging-pdf.js';

  /* How much of each chosen file travels with the request. The Worker caps
     the whole payload again (research-context.js), so these only decide what
     gets cut here, where the file names are still known. */
  const FILE_CHARS = 20000;
  const FILES_TOTAL_CHARS = 80000;
  const POSITIONING_CHARS = 90000;

  const Data = () => window.MktforgeData;
  const Kit = () => window.MktforgeKit;

  /* ---------- result boxes ---------- */

  const BOXES = [
    { key: 'hierarchy', stage: 'Stage 7', title: 'Messaging Hierarchy' },
    { key: 'homepage',  stage: 'Stage 8', title: 'Drafted Homepage Copy' }
  ];

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

  // Second precision, UTC — the shape the Worker's research context accepts.
  const stamp = (ms) => (ms ? `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC` : '');

  const extFor = (f) => (f.source === 'imported' ? (f.ext || '') : '.pdf');
  const fullName = (f) => `${f.name}${extFor(f)}`;
  const kindLabel = (f) => (window.MktforgeExtract && window.MktforgeExtract.LABELS[f.kind])
    || (f.ext ? f.ext.slice(1).toUpperCase() : 'File');

  function notify(message, tone = 'info') {
    document.dispatchEvent(new CustomEvent('mktforge:notify', { detail: { message, tone } }));
  }

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

  /* ---------- state that outlives mount/unmount ---------- */

  const state = {
    files: null,             // every saved file, newest first
    filesError: '',
    positioningId: '',       // the chosen positioning document
    picked: [],              // ids of the extra files chosen for this run
    uploads: [],             // the import queue
    menu: '',                // which drop-down is open: 'doc' | 'files' | ''
    run: null,
    running: false,
    status: '',
    error: '',
    collapsed: new Set(),    // boxes minimized (both start open)
    innerOpen: new Set()     // nested boxes the user opened this run
  };

  let root = null;
  let mounted = false;
  let cfg = {};
  let unsubFiles = null;

  /* ---------- markup ---------- */

  const MARKUP = `
  <div class="dmsg">
    <header class="dmsg__head">
      <p class="dmsg__eyebrow">Draft Messaging</p>
      <h1 class="dmsg__title">Start Drafting Marketing Copy</h1>
      <p class="dmsg__dek">Use your positioning research and any other notes you’ve collected to craft a
        customized messaging hierarchy and homepage copy ideas that can serve as a foundation for
        everything you write.</p>
    </header>

    <div class="dmsg__columns">
      <section class="dmsg__card" aria-labelledby="dmsg-doc-title">
        <h2 class="dmsg__h2" id="dmsg-doc-title">Select your positioning document</h2>
        <p class="dmsg__card-dek">The run is built on this: the champion, alternatives, differentiators and
          category you already reviewed in Build Positioning.</p>
        <div class="dmsg__select" data-el="doc-select"></div>
        <div data-el="doc-empty"></div>
      </section>

      <section class="dmsg__card" aria-labelledby="dmsg-research-title">
        <h2 class="dmsg__h2" id="dmsg-research-title">Provide additional research <span class="dmsg__optional">(optional)</span></h2>
        <p class="dmsg__card-dek">Call notes, customer interviews, sales decks, competitor teardowns — anything
          you want the agent to write from. Files added here are imported to My Company too.</p>

        <div class="dmsg__import" data-el="import-zone">
          <input type="file" multiple hidden data-el="import-input" accept="${window.MktforgeExtract ? window.MktforgeExtract.ACCEPT : ''}">
          <div class="dmsg__drop" data-el="drop">
            <p class="dmsg__drop-main"><strong>Drag and drop files here</strong> or
              <button type="button" class="dmsg__link" data-el="import-link">browse your computer</button></p>
            <p class="dmsg__drop-sub">PDF, Word, PowerPoint, Excel, CSV, text, Markdown, JSON or HTML · up to 15 MB each</p>
          </div>
          <ul class="dmsg__uploads" data-el="uploads" aria-live="polite"></ul>
        </div>

        <p class="dmsg__pick-label" id="dmsg-files-label">You can also choose files already uploaded to Mktforge</p>
        <div class="dmsg__select" data-el="files-select"></div>
        <div data-el="picked"></div>
      </section>
    </div>

    <section class="dmsg__run" aria-label="Draft messaging">
      <div class="dmsg__run-row">
        <button type="button" class="dmsg__btn dmsg__btn--lg" data-el="generate" disabled>Draft Messaging</button>
        <button type="button" class="dmsg__btn dmsg__btn--lg" data-el="pdf-top" disabled hidden title="Draft messaging first">Create Messaging PDF</button>
      </div>
      <p class="dmsg__hint" data-el="hint" aria-live="polite"></p>
      <p class="dmsg__status" data-el="status" aria-live="polite"></p>
      <p class="dmsg__error" data-el="error" role="alert" hidden></p>
    </section>

    <section class="dmsg__grid" data-el="results" aria-label="Drafted messaging">
      ${BOXES.map((b) => `
        <article class="dmsg__box" data-box-wrap="${b.key}">
          <h2>
            <span class="dmsg__stage">${b.stage}</span>
            <span class="dmsg__box-title">${b.title}</span>
            <button type="button" class="dmsg__collapse" data-collapse="${b.key}"
              aria-expanded="true" aria-controls="dmsg-box-${b.key}"
              title="Minimize" aria-label="Minimize ${b.title}">
              <span class="dmsg__collapse-min" aria-hidden="true">&#8722;</span><span class="dmsg__collapse-max" aria-hidden="true">+</span>
            </button>
          </h2>
          <div class="dmsg__box-body is-placeholder" id="dmsg-box-${b.key}" data-box="${b.key}">No Data Collected</div>
        </article>`).join('')}
    </section>

    <div class="dmsg__pdf-row">
      <button type="button" class="dmsg__btn" data-el="pdf" disabled title="Draft messaging first">Create Messaging PDF</button>
      <p class="dmsg__status" data-el="pdf-status" aria-live="polite"></p>
    </div>
  </div>`;

  const q = (s) => root.querySelector(s);
  const el = (name) => root.querySelector(`[data-el="${name}"]`);

  /* ---------- file lists ---------- */

  const byId = (id) => (state.files || []).find((f) => f.id === id) || null;

  function positioningDocs() {
    return (state.files || []).filter((f) => f.source !== 'imported' && f.moduleId === POSITIONING_ID);
  }

  function importedFiles() {
    return (state.files || []).filter((f) => f.source === 'imported');
  }

  // Chosen files keep the order they were chosen in; a file deleted from My
  // Company while it sat in the table simply drops out.
  function pickedFiles() {
    return state.picked.map(byId).filter(Boolean);
  }

  function availableFiles() {
    return importedFiles().filter((f) => !state.picked.includes(f.id));
  }

  /* ---------- drop-downs ----------
     A listbox rather than a <select>: the positioning document's created date
     reads under its name, which a native option can't do. */

  function selectHtml(name, { label, open, options, empty }) {
    const opts = options.map((o, i) => `
      <li class="dmsg__option" role="option" aria-selected="false" id="dmsg-${name}-opt-${i}" data-choose="${esc(o.id)}">
        <span class="dmsg__option-name">${esc(o.name)}</span>
        ${o.meta ? `<span class="dmsg__option-meta">${esc(o.meta)}</span>` : ''}
      </li>`).join('');
    return `
      <button type="button" class="dmsg__select-btn${open ? ' is-open' : ''}" data-menu="${name}"
        aria-haspopup="listbox" aria-expanded="${open ? 'true' : 'false'}" aria-controls="dmsg-${name}-list">
        <span class="dmsg__select-value">${esc(label)}</span>
        <span class="dmsg__select-caret" aria-hidden="true"></span>
      </button>
      <ul class="dmsg__options" id="dmsg-${name}-list" role="listbox" ${open ? '' : 'hidden'}
        aria-label="${name === 'doc' ? 'Positioning documents' : 'Files already uploaded to Mktforge'}">
        ${options.length ? opts : `<li class="dmsg__option is-empty" role="presentation">${esc(empty)}</li>`}
      </ul>`;
  }

  function renderDocSelect() {
    if (!mounted) return;
    const box = el('doc-select');
    const empty = el('doc-empty');
    if (!state.files) {
      box.innerHTML = '<p class="dmsg__loading">Loading your documents…</p>';
      empty.innerHTML = '';
      return;
    }
    if (state.filesError) {
      box.innerHTML = `<p class="dmsg__error">${esc(state.filesError)} <button type="button" class="dmsg__link" data-el="files-retry">Try again</button></p>`;
      empty.innerHTML = '';
      const retry = el('files-retry');
      if (retry) retry.addEventListener('click', loadFiles);
      return;
    }
    const docs = positioningDocs();
    const chosen = byId(state.positioningId);
    box.innerHTML = selectHtml('doc', {
      label: chosen ? fullName(chosen) : 'Select your positioning document',
      open: state.menu === 'doc',
      options: docs.map((f) => ({ id: f.id, name: fullName(f), meta: formatDate(f.createdAt) })),
      empty: 'No positioning documents found.'
    });
    empty.innerHTML = docs.length ? '' : `
      <p class="dmsg__note">No positioning documents found. Generate one in the Build Positioning module to continue.</p>
      <button type="button" class="dmsg__btn dmsg__btn--sm" data-el="go-positioning">Build Positioning Document</button>`;
    const go = el('go-positioning');
    if (go) go.addEventListener('click', () => Mktforge.go(POSITIONING_ID));
  }

  function renderFilesSelect() {
    if (!mounted) return;
    const box = el('files-select');
    if (!state.files) {
      box.innerHTML = '<p class="dmsg__loading">Loading your files…</p>';
      return;
    }
    const available = availableFiles();
    box.innerHTML = selectHtml('files', {
      label: 'Select files',
      open: state.menu === 'files',
      options: available.map((f) => ({ id: f.id, name: fullName(f), meta: `${kindLabel(f)} · ${formatDate(f.createdAt)}` })),
      empty: importedFiles().length ? 'Every imported file is already added.' : 'No imported files yet.'
    });
  }

  function renderPicked() {
    if (!mounted) return;
    const box = el('picked');
    const files = pickedFiles();
    if (!files.length) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="dmsg__table-wrap">
        <table class="dmsg__table">
          <thead><tr>
            <th scope="col">File</th><th scope="col">Type</th><th scope="col">Imported</th>
            <th scope="col"><span class="dmsg__sr">Remove</span></th>
          </tr></thead>
          <tbody>${files.map((f) => `
            <tr data-file="${esc(f.id)}">
              <td class="dmsg__cell-name">
                <span class="dmsg__file">${esc(fullName(f))}</span>
                <span class="dmsg__meta">${esc(formatSize(f.size))}</span>
                ${fileNote(f)}
              </td>
              <td>${esc(kindLabel(f))}</td>
              <td>${esc(formatDate(f.createdAt))}</td>
              <td class="dmsg__cell-action">
                <button type="button" class="dmsg__remove" data-remove="${esc(f.id)}"
                  title="Remove from this run" aria-label="Remove ${esc(fullName(f))} from this run">×</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function fileNote(f) {
    if (f.textStatus === 'empty') return '<span class="dmsg__flag" title="Agents can’t read this file, e.g. a scanned PDF with no text layer.">No readable text</span>';
    if (f.truncated) return '<span class="dmsg__flag" title="The file was very long, so only the first part was read.">Partly read</span>';
    return '';
  }

  function closeMenu() {
    if (!state.menu) return;
    state.menu = '';
    renderDocSelect();
    renderFilesSelect();
  }

  function toggleMenu(name) {
    state.menu = state.menu === name ? '' : name;
    renderDocSelect();
    renderFilesSelect();
  }

  function handleSelectClick(e) {
    const menuBtn = e.target.closest('button[data-menu]');
    if (menuBtn) { toggleMenu(menuBtn.dataset.menu); return; }
    const opt = e.target.closest('[data-choose]');
    if (!opt) return;
    const id = opt.dataset.choose;
    if (opt.closest('[data-el="doc-select"]')) {
      state.positioningId = id;
      closeMenu();
      updateGenerate();
    } else {
      if (!state.picked.includes(id)) state.picked.push(id);
      closeMenu();
      renderPicked();
    }
  }

  function handlePickedClick(e) {
    const x = e.target.closest('button[data-remove]');
    if (!x) return;
    state.picked = state.picked.filter((id) => id !== x.dataset.remove);
    renderPicked();
    renderFilesSelect();
  }

  /* ---------- importing ----------
     The same pipeline My Company uses, so a file dropped here lands in the
     account's Imported Materials as well. A file that imports cleanly is
     added to this run straight away. */

  let uploadSeq = 0;
  let pumping = false;

  function renderUploads() {
    if (!mounted) return;
    const ul = el('uploads');
    const words = { queued: 'Waiting…', reading: 'Reading…', saving: 'Saving…', done: 'Imported' };
    ul.innerHTML = state.uploads.map((u) => `
      <li class="dmsg__upload is-${u.status}">
        <span class="dmsg__upload-name">${esc(u.name)}</span>
        <span class="dmsg__upload-status">${esc(u.status === 'error' ? u.message : (u.note || words[u.status]))}</span>
        ${u.status === 'error' ? `<button type="button" class="dmsg__upload-x" data-dismiss="${u.id}" aria-label="Dismiss">×</button>` : ''}
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
    pump();
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const u = state.uploads.find((x) => x.status === 'queued');
        if (!u) break;
        try {
          const res = await Data().importFile(u.file, {
            onStage: (stage) => { u.status = stage; renderUploads(); }
          });
          u.status = 'done';
          u.note = res.empty ? 'Imported — no readable text found'
            : res.truncated ? 'Imported — only the first part could be read' : 'Imported — added below';
          if (res.name !== u.name.replace(/\.[^.]+$/, '')) u.note += ` as “${res.name}${res.ext}”`;
          if (!state.picked.includes(res.id)) state.picked.push(res.id);
          const id = u.id;
          setTimeout(() => {
            state.uploads = state.uploads.filter((x) => x.id !== id);
            renderUploads();
          }, 5000);
        } catch (err) {
          console.error('[Draft Messaging] import failed', err);
          u.status = 'error';
          u.message = err && err.code ? err.message : 'Couldn’t import this file. Check your connection and try again.';
        }
        u.file = null;
        renderUploads();
      }
    } finally {
      pumping = false;
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

  /* ---------- nav light ---------- */

  const activity = { busy: false, failed: false };

  function syncActivity(failed = false) {
    if (state.running && !activity.busy) {
      activity.busy = true;
      activity.failed = false;
      Mktforge.reportActivity(MODULE_ID, 'running');
    }
    if (failed) activity.failed = true;
    if (!state.running && activity.busy) {
      activity.busy = false;
      Mktforge.reportActivity(MODULE_ID, activity.failed ? 'error' : 'idle');
      activity.failed = false;
    }
  }

  /* ---------- gathering the run's inputs ---------- */

  async function readPositioning(setStatus) {
    const file = byId(state.positioningId);
    if (!file) throw new Error('That positioning document is no longer in your account. Choose another.');
    setStatus(`Reading ${fullName(file)}…`);
    const text = await Data().getFileText(file.id);
    if (!String(text || '').trim()) {
      throw new Error('That positioning document has no readable text. Create it again in Build Positioning, then try once more.');
    }
    return { name: fullName(file), date: stamp(file.createdAt), text: String(text).slice(0, POSITIONING_CHARS) };
  }

  /* The chosen files, in the shape the Worker's research context expects.
     A file too long to send whole goes as the summary research.js stored for
     it when another module last read it, and only falls back to its opening
     pages when there is no summary. */
  async function readPicked(setStatus) {
    const files = pickedFiles();
    if (!files.length) return { imported: [], generated: [] };
    let done = 0;
    const say = () => setStatus(`Reading your research (${done} of ${files.length})…`);
    say();
    const rows = await pool(files, 3, async (f) => {
      let text = '';
      try { text = await Data().getFileText(f.id); } catch (err) { console.warn('[Draft Messaging] could not read', f.name, err); }
      let digest = '';
      if (text.length > FILE_CHARS) {
        try {
          const stored = await Data().getFileDigest(f.id);
          digest = (stored && stored.digestText) || '';
        } catch (e) { digest = ''; }
      }
      done += 1;
      say();
      return { f, text: String(text || ''), digest };
    });

    let room = FILES_TOTAL_CHARS;
    const imported = [];
    rows.forEach((r) => {
      if (!r.text) return;
      const entry = { name: fullName(r.f), type: kindLabel(r.f), date: stamp(r.f.createdAt), match: '' };
      if (r.text.length <= FILE_CHARS && r.text.length <= room) {
        entry.text = r.text;
        room -= r.text.length;
      } else if (r.digest) {
        entry.digest = r.digest;
        room -= r.digest.length;
      } else if (room > 2000) {
        entry.text = r.text.slice(0, Math.min(FILE_CHARS, room));
        room -= entry.text.length;
      } else {
        return;
      }
      imported.push(entry);
    });
    const unread = rows.filter((r) => !r.text).map((r) => r.f.name);
    return { imported, generated: [], unread };
  }

  /* ---------- Worker ---------- */

  async function api(path, body) {
    if (!cfg.API_BASE_URL) throw new Error('Draft Messaging isn’t configured — set draftMessaging.API_BASE_URL in assets/js/config.js.');
    const noAccess = Kit().accessProblem();
    if (noAccess) throw new Error(noAccess);
    const token = window.MktforgeAuth && window.MktforgeAuth.getIdToken
      ? await window.MktforgeAuth.getIdToken() : null;
    if (!token) throw new Error(Kit().NO_ACCESS);
    return fetch(`${cfg.API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
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

  /* ---------- the run ---------- */

  function updateGenerate() {
    if (!mounted) return;
    const ready = !!byId(state.positioningId);
    el('generate').disabled = state.running || !ready;
    el('generate').textContent = state.running ? 'Drafting…' : 'Draft Messaging';
    let hint = '';
    if (!state.running && !ready) {
      hint = positioningDocs().length
        ? 'Choose a positioning document to continue.'
        : 'Generate a positioning document in Build Positioning to continue.';
    }
    el('hint').textContent = hint;
  }

  function setBoxesLoading() {
    BOXES.forEach((b) => {
      const box = q(`[data-box="${b.key}"]`);
      if (!box) return;
      box.className = 'dmsg__box-body is-loading';
      box.innerHTML = '<span class="dmsg__dot"></span><span class="dmsg__dot"></span><span class="dmsg__dot"></span>';
    });
  }

  function paintRun() {
    if (!mounted) return;
    const run = state.run;
    BOXES.forEach((b) => {
      const box = q(`[data-box="${b.key}"]`);
      if (!box) return;
      const data = run && run.stages && run.stages[b.key];
      if (data) {
        box.className = 'dmsg__box-body';
        box.innerHTML = RENDER[b.key](data, run);
      } else if (state.running) {
        box.className = 'dmsg__box-body is-loading';
        box.innerHTML = '<span class="dmsg__dot"></span><span class="dmsg__dot"></span><span class="dmsg__dot"></span>';
      } else {
        box.className = 'dmsg__box-body is-placeholder';
        box.textContent = run ? 'Not reached — run again to complete this stage.' : 'No Data Collected';
      }
      paintCollapse(b.key);
    });
    el('status').textContent = state.status;
    const err = el('error');
    err.textContent = state.error;
    err.hidden = !state.error;
    paintPdfButtons();
  }

  function paintPdfButtons() {
    if (!mounted) return;
    const complete = !!(state.run && state.run.complete);
    const top = el('pdf-top');
    top.hidden = !state.run;
    [el('pdf'), top].forEach((btn) => {
      btn.disabled = !complete;
      btn.title = complete ? '' : 'Draft messaging first';
    });
  }

  async function handleGenerate() {
    if (state.running || !byId(state.positioningId)) return;

    state.running = true;
    state.error = '';
    state.status = 'Getting ready…';
    state.run = { stages: {}, complete: false, input: {}, sources: {} };
    state.collapsed = new Set();
    state.innerOpen = new Set();
    closeMenu();
    syncActivity();
    setBoxesLoading();
    paintRun();
    updateGenerate();

    const setStatus = (t) => { state.status = t; if (mounted) el('status').textContent = t; };

    try {
      const positioning = await readPositioning(setStatus);
      const context = await readPicked(setStatus);
      state.run.sources = {
        positioning: positioning.name,
        files: pickedFiles().map(fullName),
        unread: context.unread || []
      };
      if ((context.unread || []).length) {
        notify(`Couldn’t read ${context.unread.length} of your files; the run continues without them.`, 'error');
      }
      setStatus('Sending your research to the drafting agent…');

      const res = await api('/api/messaging', {
        positioning,
        context: { imported: context.imported, generated: context.generated },
        today: new Date().toISOString().slice(0, 10)
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
          paintRun();
        },
        result: (d) => {
          state.run.stages = { ...state.run.stages, ...(d.stages || {}) };
          state.run.input = {
            companyName: d.companyName || '',
            champion: d.champion || '',
            competitorName: d.competitorName || '',
            category: d.category || ''
          };
          state.run.internal = d.internal || null;
          state.run.attempts = d.attempts || 1;
          state.run.passed = d.passed !== false;
          state.run.checked = d.checked !== false;
          state.run.generatedAt = d.generatedAt || new Date().toISOString();
          state.run.complete = true;
        },
        error: (d) => { throw new Error(Kit().accessError(null, d.message) || d.message || 'Something went wrong.'); }
      });

      if (!state.run.complete) throw new Error('The connection closed before the run finished. Please try again.');
      state.status = state.run.passed
        ? 'Messaging drafted and checked against the stage 9 quality rules. Review it, then create the PDF.'
        : state.run.checked === false
          ? 'Messaging drafted, but the quality check didn’t finish, so it hasn’t been checked. Read it closely, or run again for a checked version.'
          : 'Messaging drafted. The quality check still had notes after three passes — read it closely before you use it.';
    } catch (err) {
      console.error('[Draft Messaging] run failed', err);
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

  /* ---------- minimize / maximize ---------- */

  function paintCollapse(key) {
    const wrap = q(`[data-box-wrap="${key}"]`);
    if (!wrap) return;
    const open = !state.collapsed.has(key);
    const box = BOXES.find((b) => b.key === key);
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

  // Nested boxes are re-rendered with their parent, so `state.innerOpen` is
  // what survives a repaint.
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

  /* ---------- renderers ---------- */

  const list = (items, cls = '') => (items && items.length
    ? `<ul class="dmsg__list ${cls}">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
    : '');

  const chip = (text, tone = '') => `<span class="dmsg__chip ${tone ? `is-${tone}` : ''}">${esc(text)}</span>`;

  const label = (text) => `<p class="dmsg__label">${esc(text)}</p>`;

  const proofChip = (status) => (status === 'real'
    ? chip('Proof', 'good')
    : chip('Placeholder — proof to collect', 'warn'));

  function innerBox(id, title, body) {
    const open = state.innerOpen.has(id);
    return `
      <div class="dmsg__inner${open ? ' is-open' : ''}" data-inner-wrap="${id}">
        <button type="button" class="dmsg__inner-head" data-inner="${id}"
          aria-expanded="${open ? 'true' : 'false'}" aria-controls="dmsg-inner-${id}"
          title="${open ? 'Minimize' : 'Maximize'}">
          <span class="dmsg__inner-title">${esc(title)}</span>
          <span class="dmsg__inner-icon" aria-hidden="true"></span>
        </button>
        <div class="dmsg__inner-body" id="dmsg-inner-${id}">${body}</div>
      </div>`;
  }

  const RENDER = {
    /* Stage 7 — the reusable core. The positioning statement is the one piece
       here that is never shipped as copy, so it says so. */
    hierarchy(d) {
      if (!d) return '<p class="dmsg__empty">Nothing returned.</p>';

      const vp = d.value_prop
        ? `${label('Value proposition')}<p class="dmsg__summary">${esc(d.value_prop)}</p>` : '';

      const ps = d.positioning_statement ? `
        ${label('Positioning statement')}
        <p class="dmsg__internal">${esc(d.positioning_statement)}</p>
        <p class="dmsg__muted dmsg__fine">${chip('Internal only', 'warn')} Sets the frame for everything below — don’t ship it as copy.</p>` : '';

      const pillars = (d.pillars || []).length ? `
        ${label(`Pillars (${d.pillars.length})`)}
        <div class="dmsg__pillars">
          ${d.pillars.map((p, i) => `
            <div class="dmsg__pillar">
              <p class="dmsg__pillar-n">Pillar ${i + 1}</p>
              <p class="dmsg__pillar-head">${esc(p.headline)}</p>
              ${p.pain ? `<p class="dmsg__muted"><span class="dmsg__k">Answers</span> ${esc(p.pain)}</p>` : ''}
              ${list(p.capabilities)}
              ${p.proof ? `<p class="dmsg__proof">${proofChip(p.proof_status)} ${esc(p.proof)}</p>` : ''}
            </div>`).join('')}
        </div>` : '';

      const shortForms = (d.one_liner || d.elevator_pitch || d.boilerplate) ? `
        ${label('Short forms')}
        <div class="dmsg__forms">
          ${d.one_liner ? `<div class="dmsg__form"><span class="dmsg__k">One-liner</span><p>${esc(d.one_liner)}</p></div>` : ''}
          ${d.elevator_pitch ? `<div class="dmsg__form"><span class="dmsg__k">30-second pitch</span><p>${esc(d.elevator_pitch)}</p></div>` : ''}
          ${d.boilerplate ? `<div class="dmsg__form"><span class="dmsg__k">Boilerplate</span><p>${esc(d.boilerplate)}</p></div>` : ''}
        </div>` : '';

      const talk = (d.competitive_talk_track || []).length
        ? innerBox('talk-track', `Competitive talk track (${d.competitive_talk_track.length})`,
            d.competitive_talk_track.map((t) => `
              <div class="dmsg__talk">
                <p class="dmsg__item-head"><strong>${esc(t.alternative)}</strong> ${chip(t.type === 'status_quo' ? 'Status quo' : 'Competitor', t.type === 'status_quo' ? '' : 'accent')}</p>
                ${t.unlike_line ? `<p>${esc(t.unlike_line)}</p>` : ''}
                ${t.objection ? `<p class="dmsg__muted"><span class="dmsg__k">They’ll say</span> ${esc(t.objection)}</p>` : ''}
                ${t.response ? `<p class="dmsg__muted"><span class="dmsg__k">You say</span> ${esc(t.response)}</p>` : ''}
              </div>`).join(''))
        : '';

      return vp + ps + pillars + shortForms + talk;
    },

    /* Stage 8 — Pierri's homepage order, top to bottom, as the page would
       read it. */
    homepage(d) {
      if (!d) return '<p class="dmsg__empty">Nothing returned.</p>';
      const hero = d.hero || {};
      const problem = d.problem || {};
      const intro = d.solution_intro || {};
      const proof = d.proof || {};
      const close = d.closing_cta || {};

      const heroBlock = (hero.headline || hero.subhead) ? `
        <div class="dmsg__section dmsg__section--hero">
          ${label('Hero')}
          <p class="dmsg__headline">${esc(hero.headline)}</p>
          ${hero.subhead ? `<p class="dmsg__subhead">${esc(hero.subhead)}</p>` : ''}
          <p class="dmsg__ctas">
            ${hero.cta ? chip(hero.cta, 'accent') : ''}
            ${hero.cta_secondary ? chip(hero.cta_secondary) : ''}
          </p>
          ${hero.headline_variant_b ? `
            <p class="dmsg__variant"><span class="dmsg__k">Variant B to test</span> ${esc(hero.headline_variant_b)}</p>` : ''}
        </div>` : '';

      const problemBlock = (problem.heading || problem.body || (problem.bullets || []).length) ? `
        <div class="dmsg__section">
          ${label('Problem')}
          ${problem.heading ? `<p class="dmsg__section-head">${esc(problem.heading)}</p>` : ''}
          ${problem.body ? `<p>${esc(problem.body)}</p>` : ''}
          ${list(problem.bullets)}
        </div>` : '';

      const introBlock = (intro.heading || intro.body) ? `
        <div class="dmsg__section">
          ${label('Solution intro')}
          ${intro.heading ? `<p class="dmsg__section-head">${esc(intro.heading)}</p>` : ''}
          ${intro.body ? `<p>${esc(intro.body)}</p>` : ''}
        </div>` : '';

      const props = (d.value_props || []).length ? `
        <div class="dmsg__section">
          ${label('Value props')}
          ${d.value_props.map((v) => `
            <div class="dmsg__prop">
              ${v.heading ? `<p class="dmsg__section-head">${esc(v.heading)}</p>` : ''}
              ${v.body ? `<p>${esc(v.body)}</p>` : ''}
              ${list(v.bullets)}
            </div>`).join('')}
        </div>` : '';

      const proofBlock = (proof.items || []).length ? `
        <div class="dmsg__section">
          ${label('Proof')}
          ${proof.heading ? `<p class="dmsg__section-head">${esc(proof.heading)}</p>` : ''}
          ${proof.items.map((i) => `
            <p class="dmsg__proof">${proofChip(i.status)} ${esc(i.text)}${i.source ? ` <span class="dmsg__muted">— ${esc(i.source)}</span>` : ''}</p>`).join('')}
        </div>` : '';

      const closeBlock = (close.heading || close.cta) ? `
        <div class="dmsg__section">
          ${label('Closing call to action')}
          ${close.heading ? `<p class="dmsg__section-head">${esc(close.heading)}</p>` : ''}
          ${close.body ? `<p>${esc(close.body)}</p>` : ''}
          ${close.cta ? `<p class="dmsg__ctas">${chip(close.cta, 'accent')}</p>` : ''}
        </div>` : '';

      const borrowed = (d.words_borrowed_from_customers || []).length
        ? innerBox('borrowed', 'Words borrowed from your customers', list(d.words_borrowed_from_customers))
        : '';

      return heroBlock + problemBlock + introBlock + props + proofBlock + closeBlock + borrowed;
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
      await window.MktforgeMessagingPdf.build(run, { boxes: BOXES });
    } catch (err) {
      console.error('[Draft Messaging] PDF failed', err);
      if (mounted) { state.error = 'Could not generate the PDF. Please try again.'; paintRun(); }
    } finally {
      if (mounted) {
        btns.forEach((b) => { b.textContent = 'Create Messaging PDF'; });
        paintPdfButtons();
      }
    }
  }

  /* ---------- loading ---------- */

  async function loadFiles() {
    state.filesError = '';
    if (!state.files) { renderDocSelect(); renderFilesSelect(); }
    try {
      state.files = await Data().listFiles();
    } catch (err) {
      console.error('[Draft Messaging] could not load files', err);
      state.filesError = 'Couldn’t load your saved files.';
      state.files = state.files || [];
    }
    // A document deleted elsewhere shouldn't leave a stale selection behind.
    if (state.positioningId && !byId(state.positioningId)) state.positioningId = '';
    state.picked = state.picked.filter((id) => byId(id));
    renderDocSelect();
    renderFilesSelect();
    renderPicked();
    updateGenerate();
  }

  /* ---------- module ---------- */

  Mktforge.register({
    id:     MODULE_ID,
    label:  MODULE_NAME,
    icon:   'doc',
    styles: 'modules/draft-messaging/draft-messaging.css',

    mount(container) {
      mounted = true;
      cfg = (window.MKTFORGE_CONFIG && window.MKTFORGE_CONFIG.draftMessaging) || {};
      container.innerHTML = MARKUP;
      root = container.firstElementChild;

      wireImport();
      el('doc-select').addEventListener('click', handleSelectClick);
      el('files-select').addEventListener('click', handleSelectClick);
      el('picked').addEventListener('click', handlePickedClick);
      el('generate').addEventListener('click', handleGenerate);
      el('pdf').addEventListener('click', handlePdf);
      el('pdf-top').addEventListener('click', handlePdf);
      el('results').addEventListener('click', handleResultsClick);
      document.addEventListener('click', onDocumentClick, true);
      document.addEventListener('keydown', onKeydown);

      renderUploads();
      renderDocSelect();
      renderFilesSelect();
      renderPicked();
      paintRun();
      updateGenerate();
      loadFiles();
      unsubFiles = Data().onFiles(() => { if (mounted) loadFiles(); });
    },

    unmount() {
      mounted = false;
      state.menu = '';
      document.removeEventListener('click', onDocumentClick, true);
      document.removeEventListener('keydown', onKeydown);
      if (unsubFiles) { unsubFiles(); unsubFiles = null; }
      // A run in flight keeps going and lands in `state`.
      root = null;
    }
  });

  /* A click anywhere else closes an open drop-down; Escape does the same. */
  function onDocumentClick(e) {
    if (!mounted || !state.menu) return;
    if (e.target.closest('[data-el="doc-select"], [data-el="files-select"]')) return;
    closeMenu();
  }

  function onKeydown(e) {
    if (!mounted || e.key !== 'Escape' || !state.menu) return;
    closeMenu();
  }
})();

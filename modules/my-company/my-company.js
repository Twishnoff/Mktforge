/* ==========================================================================
   My Company
   The account's company profile, plus Your Saved Resources: Generated
   Materials (PDFs other modules made) and Imported Materials (files the
   person uploads — agents trust these most). Profile values persist to the account (assets/js/data.js) and
   prefill matching empty fields in the other modules.

   Rows have two states:
     editing — an input (or tag box). Empty rows are always editing.
     saved   — the saved value with an Edit button.
   Save writes every row, then redraws with a short refresh effect.
   ========================================================================== */

(() => {

  const Data = () => window.MktforgeData;

  const FIELDS = [
    { key: 'companyName', label: 'Company Name', kind: 'text',
      placeholder: 'e.g. Acme Robotics' },
    { key: 'companyUrl', label: 'Company URL', kind: 'url',
      placeholder: 'e.g. acme.com' },
    { key: 'industry', label: 'Your Industry', kind: 'industry',
      placeholder: 'Start typing, e.g. SaaS' },
    { key: 'targetTitles', label: 'Target Job Titles', kind: 'tags',
      placeholder: 'Type a title and press Enter' },
    { key: 'targetIndustries', label: 'Target Industries', kind: 'tags', suggest: true,
      placeholder: 'Type an industry and press Enter' },
    { key: 'competitors', label: 'Competitors', hint: 'Enter URLs', kind: 'tags', url: true,
      placeholder: 'e.g. rival.com, then Enter' }
  ];

  const isArrayField = (f) => f.kind === 'tags';
  const hasValue = (f, v) => (isArrayField(f) ? (v || []).length > 0 : !!String(v || '').trim());

  /* ---------- industry suggestions ---------- */

  const MIN_CHARS = 2;
  const MAX_SUGGESTIONS = 8;

  function scoreIndustry(name, q) {
    const n = name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.split(/[\s/()-]+/).some((w) => w.startsWith(q))) return 2;
    if (n.includes(q)) return 3;
    // loose match for 3+ letters: starts where a word starts, then every
    // typed letter appears in order ("mktg" -> "Marketing")
    if (q.length < 3) return -1;
    const starts = n.split(/[\s/()-]+/).map((w) => w[0]);
    if (!starts.includes(q[0])) return -1;
    let i = 0;
    for (const ch of n) if (ch === q[i]) i += 1;
    return i === q.length ? 4 : -1;
  }

  function suggestIndustries(query, exclude = []) {
    const q = query.trim().toLowerCase();
    if (q.length < MIN_CHARS) return [];
    const skip = new Set(exclude.map((x) => x.toLowerCase()));
    const scored = (window.MKTFORGE_INDUSTRIES || [])
      .map((name) => ({ name, s: scoreIndustry(name, q) }))
      .filter((x) => x.s >= 0 && !skip.has(x.name.toLowerCase()));
    // Loose matches only show when nothing matches the letters directly.
    const direct = scored.filter((x) => x.s < 4);
    return (direct.length ? direct : scored)
      .sort((a, b) => a.s - b.s || a.name.length - b.name.length || a.name.localeCompare(b.name))
      .slice(0, MAX_SUGGESTIONS)
      .map((x) => x.name);
  }

  /* ---------- helpers ---------- */

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function hrefFor(url) {
    const v = String(url || '').trim();
    return /^https?:\/\//i.test(v) ? v : `https://${v}`;
  }

  function formatDate(ms) {
    if (!ms) return '';
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB`
                               : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /* ---------- state that outlives mount/unmount ---------- */

  /* One per company (MktforgeKit.perCompany). Unsaved edits (drafts and
     which rows are open) also survive a refresh. */
  const pc = window.MktforgeKit.perCompany('my-company', {
    create: () => ({
      loaded: false,
      loadError: '',
      profile: null,         // last saved profile
      editing: new Set(),    // keys a person opened with Edit
      drafts: {},            // unsaved input per key, kept across navigation
      files: null,
      filesError: '',
      renaming: null,        // { id, value, error, saving } while a file name is being edited
      uploads: [],           // import status lines
      pumping: false,
      hs: null,              // HubSpot status from the Worker, null until loaded
      hsError: '',
      hsBusy: ''             // 'connect' | 'disconnect' while a button is working
    }),
    held: ['drafts', 'editing']
  });
  let state = pc.state;
  pc.bind((st) => { state = st; });
  const onScreen = (st) => mounted && st === state;
  const here = () => Data().company(state._cid);   // the company on screen now

  const DELETE_WARNING = 'WARNING: Deleting this company cannot be undone. By deleting this company you will lose all data and files created or uploaded while using this company. Are you sure you wish to do this?';
  let unsubCompanies = null;

  let root = null;
  let mounted = false;
  let unsubFiles = null;
  let unsubProfile = null;
  let comboCleanup = [];

  /* ---------- markup ---------- */

  function shell() {
    return `
      <div class="mc">
        <header class="mc__head">
          <div class="mc__title-row">
            <h1 class="mc__title">My Company</h1>
            <button type="button" class="mc__delete-company" data-el="delete-company" hidden>Delete This Company</button>
          </div>
          <p class="mc__dek">Provide what information you have about your business below. It’s ok if you don’t have much, your profile will get fleshed out as time goes on.</p>
        </header>

        <section class="mc__card" aria-label="Company profile">
          <form class="mc__form" data-el="form" novalidate>
            <div class="mc__rows" data-el="rows"><p class="mc__loading">Loading your profile…</p></div>
            <div class="mc__actions">
              <p class="mc__error" data-el="error" role="alert" hidden></p>
              <button type="submit" class="mc__btn" data-el="save">Save</button>
            </div>
          </form>
        </section>

        <section class="mc__integrations" aria-labelledby="mc-integrations-title">
          <h2 class="mc__h2" id="mc-integrations-title">Integrations</h2>
          <div class="mc__card mc__card--tight">
            <div class="mc__hs" data-el="hubspot"><p class="mc__loading">Checking HubSpot…</p></div>
          </div>
        </section>

        <section class="mc__resources" aria-labelledby="mc-resources-title" data-el="resources">
          <h2 class="mc__h2" id="mc-resources-title">Your Saved Resources</h2>
          <p class="mc__subdek">Everything Mktforge’s agents read when they research for you. Your imported files are
            treated as the most accurate source, and when two files disagree, the newer one wins.</p>

          <div class="mc__group">
            <h3 class="mc__h3">Generated Materials</h3>
            <div data-el="files-generated"><p class="mc__loading">Loading…</p></div>
          </div>

          <div class="mc__group mc__group--import" data-el="import-zone">
            <div class="mc__group-head">
              <h3 class="mc__h3">Imported Materials</h3>
              <button type="button" class="mc__btn mc__btn--sm" data-el="import-btn">Import Files</button>
              <input type="file" multiple hidden data-el="import-input" accept="${window.MktforgeExtract ? window.MktforgeExtract.ACCEPT : ''}">
            </div>
            <div class="mc__drop" data-el="drop">
              <p class="mc__drop-main"><strong>Drag and drop files here</strong> or
                <button type="button" class="mc__link" data-el="import-link">browse your computer</button></p>
              <p class="mc__drop-sub">PDF, Word, PowerPoint, Excel, CSV, text, Markdown, JSON or HTML · up to 15 MB each</p>
            </div>
            <ul class="mc__uploads" data-el="uploads" aria-live="polite"></ul>
            <div data-el="files-imported"><p class="mc__loading">Loading…</p></div>
          </div>
        </section>
      </div>`;
  }

  function rowEditing(f) {
    const saved = state.profile ? state.profile[f.key] : (isArrayField(f) ? [] : '');
    return !hasValue(f, saved) || state.editing.has(f.key);
  }

  function draftFor(f) {
    if (f.key in state.drafts) return state.drafts[f.key];
    const saved = state.profile ? state.profile[f.key] : null;
    return isArrayField(f) ? { tags: [...(saved || [])], text: '' } : (saved || '');
  }

  function labelHtml(f, forId) {
    return `<label class="mc__label" for="${forId}">${esc(f.label)}${
      f.hint ? ` <span class="mc__hint">(${esc(f.hint)})</span>` : ''}</label>`;
  }

  function savedHtml(f) {
    const v = state.profile[f.key];
    let body;
    if (isArrayField(f)) {
      body = `<ul class="mc__chips" role="list">${v.map((t) => `<li class="mc__chip">${
        f.url ? `<a href="${esc(hrefFor(t))}" target="_blank" rel="noopener noreferrer">${esc(t)}</a>` : esc(t)
      }</li>`).join('')}</ul>`;
    } else if (f.kind === 'url') {
      body = `<a class="mc__value" href="${esc(hrefFor(v))}" target="_blank" rel="noopener noreferrer">${esc(v)}</a>`;
    } else {
      body = `<span class="mc__value">${esc(v)}</span>`;
    }
    return `
      <div class="mc__row is-saved" data-key="${f.key}">
        <span class="mc__label">${esc(f.label)}${f.hint ? ` <span class="mc__hint">(${esc(f.hint)})</span>` : ''}</span>
        <div class="mc__saved">
          ${body}
          <button type="button" class="mc__edit" data-edit="${f.key}" aria-label="Edit ${esc(f.label)}">Edit</button>
        </div>
      </div>`;
  }

  function editHtml(f) {
    const id = `mc-${f.key}`;
    const d = draftFor(f);
    const listId = `${id}-list`;
    const combo = f.kind === 'industry' || f.suggest;
    const comboAttrs = combo
      ? `role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${listId}"` : '';
    const listbox = combo ? `<ul class="mc__suggest" id="${listId}" role="listbox" hidden></ul>` : '';

    let control;
    if (isArrayField(f)) {
      control = `
        <div class="mc__tagbox" data-tagbox="${f.key}">
          ${d.tags.map((t, i) => `
            <span class="mc__tag">${esc(t)}<button type="button" class="mc__tag-x" data-remove="${i}" aria-label="Remove ${esc(t)}">×</button></span>`).join('')}
          <input type="text" id="${id}" data-input="${f.key}" value="${esc(d.text)}"
                 placeholder="${d.tags.length ? '' : esc(f.placeholder)}" autocomplete="off" ${comboAttrs}>
        </div>`;
    } else {
      control = `<input type="text" id="${id}" data-input="${f.key}" value="${esc(d)}"
                        placeholder="${esc(f.placeholder)}" autocomplete="off"
                        ${f.kind === 'url' ? 'inputmode="url" spellcheck="false"' : ''} ${comboAttrs}>`;
    }

    return `
      <div class="mc__row is-editing" data-key="${f.key}">
        ${labelHtml(f, id)}
        <div class="mc__control">
          ${control}
          ${listbox}
          <p class="mc__field-error" data-field-error="${f.key}" hidden></p>
        </div>
      </div>`;
  }

  /* ---------- rendering ---------- */

  const q = (sel) => root.querySelector(sel);

  function renderRows({ flash = false } = {}) {
    comboCleanup.forEach((fn) => fn());
    comboCleanup = [];

    const rows = q('[data-el="rows"]');
    if (!state.loaded) {
      rows.innerHTML = state.loadError
        ? `<p class="mc__error">${esc(state.loadError)} <button type="button" class="mc__link" data-el="retry">Try again</button></p>`
        : '<p class="mc__loading">Loading your profile…</p>';
      q('[data-el="save"]').hidden = true;
      const retry = q('[data-el="retry"]');
      if (retry) retry.addEventListener('click', load);
      return;
    }

    rows.innerHTML = FIELDS.map((f) => (rowEditing(f) ? editHtml(f) : savedHtml(f))).join('');
    q('[data-el="save"]').hidden = !FIELDS.some(rowEditing);

    FIELDS.forEach((f) => { if (rowEditing(f)) wireRow(f); });

    rows.classList.remove('is-refreshed');
    if (flash) {
      void rows.offsetWidth;                  // restart the animation
      rows.classList.add('is-refreshed');
    }
  }

  const extFor = (f) => (f.source === 'imported' ? (f.ext || '') : '.pdf');
  const kindLabel = (f) => (window.MktforgeExtract && window.MktforgeExtract.LABELS[f.kind]) || (f.ext ? f.ext.slice(1).toUpperCase() : 'File');

  function renderFiles() {
    const boxes = { generated: q('[data-el="files-generated"]'), imported: q('[data-el="files-imported"]') };
    if (state.filesError) {
      Object.values(boxes).forEach((box) => {
        box.innerHTML = `<p class="mc__error">${esc(state.filesError)} <button type="button" class="mc__link" data-files-retry>Try again</button></p>`;
      });
      return;
    }
    if (!state.files) {
      Object.values(boxes).forEach((box) => { box.innerHTML = '<p class="mc__loading">Loading…</p>'; });
      return;
    }
    // Newest first in both lists.
    const sorted = [...state.files].sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    const generated = sorted.filter((f) => f.source !== 'imported');
    const imported = sorted.filter((f) => f.source === 'imported');

    boxes.generated.innerHTML = generated.length ? `
      <div class="mc__table-wrap">
        <table class="mc__table">
          <thead><tr><th scope="col">File</th><th scope="col">Module</th><th scope="col">Created</th><th scope="col"><span class="mc__sr">Actions</span></th></tr></thead>
          <tbody>${generated.map((f) => fileRowHtml(f)).join('')}</tbody>
        </table>
      </div>` : '<p class="mc__empty">No generated materials yet. Every PDF you create in another module is saved here automatically.</p>';

    boxes.imported.innerHTML = imported.length ? `
      <div class="mc__table-wrap">
        <table class="mc__table">
          <thead><tr><th scope="col">File</th><th scope="col">Type</th><th scope="col">Imported</th><th scope="col"><span class="mc__sr">Actions</span></th></tr></thead>
          <tbody>${imported.map((f) => fileRowHtml(f)).join('')}</tbody>
        </table>
      </div>` : '<p class="mc__empty">No imported files yet. Add customer research, call notes, sales decks or anything else you want Mktforge’s agents to use.</p>';

    const r = state.renaming;
    if (r) {
      const input = q('[data-rename-input]');
      if (!input) { state.renaming = null; return; }   // file was deleted elsewhere
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function fileNote(f) {
    if (f.source !== 'imported') return '';
    if (f.textStatus === 'empty') return '<span class="mc__flag" title="Agents can’t read this file, e.g. a scanned PDF with no text layer.">No readable text</span>';
    if (f.truncated) return '<span class="mc__flag" title="The file was very long, so only the first part was read.">Partly read</span>';
    return '';
  }

  function fileRowHtml(f) {
    const r = state.renaming && state.renaming.id === f.id ? state.renaming : null;
    const ext = extFor(f);
    const nameCell = r
      ? `<div class="mc__rename">
           <input type="text" class="mc__rename-input" data-rename-input="${esc(f.id)}"
                  value="${esc(r.value)}" maxlength="200" aria-label="New name for ${esc(f.name)}"
                  aria-invalid="${r.error ? 'true' : 'false'}" ${r.saving ? 'disabled' : ''}
                  aria-describedby="mc-rename-error">
           <span class="mc__meta">${esc(ext)}</span>
         </div>
         <p class="mc__field-error" id="mc-rename-error" data-rename-error ${r.error ? '' : 'hidden'}>${esc(r.error || '')}</p>`
      : `<button type="button" class="mc__file" data-open="${esc(f.id)}"
                 title="${Data().isViewable(f.mimeType) ? 'Open' : 'Download'}">${esc(f.name)}${esc(ext)}</button>
         <span class="mc__meta">${esc(formatSize(f.size))}</span>${fileNote(f)}`;
    const renameBtn = r
      ? `<button type="button" class="mc__rename-btn is-saving" data-rename-save="${esc(f.id)}"
                 ${r.error || r.saving ? 'disabled' : ''}>${r.saving ? 'Saving…' : 'Save'}</button>`
      : `<button type="button" class="mc__rename-btn" data-rename="${esc(f.id)}">Rename</button>`;
    return `
      <tr data-file="${esc(f.id)}"${r ? ' class="is-renaming"' : ''}>
        <td class="mc__cell-name">${nameCell}</td>
        <td>${esc(f.source === 'imported' ? kindLabel(f) : (f.moduleName || ''))}</td>
        <td>${esc(formatDate(f.createdAt))}</td>
        <td class="mc__cell-action">${renameBtn}<button type="button" class="mc__delete" data-delete="${esc(f.id)}">Delete</button></td>
      </tr>`;
  }

  /* ---------- import ----------
     Files are processed one at a time: read the text, then save bytes and
     text to the account. Each gets a status line; finished ones fade out,
     problems stay until dismissed. */

  let uploadSeq = 0;

  function renderUploads() {
    if (!mounted) return;
    const ul = q('[data-el="uploads"]');
    const words = { queued: 'Waiting…', reading: 'Reading…', saving: 'Saving…', done: 'Imported' };
    ul.innerHTML = state.uploads.map((u) => `
      <li class="mc__upload is-${u.status}">
        <span class="mc__upload-name">${esc(u.name)}</span>
        <span class="mc__upload-status">${esc(u.status === 'error' ? u.message : (u.note || words[u.status]))}</span>
        ${u.status === 'error' ? `<button type="button" class="mc__upload-x" data-dismiss="${u.id}" aria-label="Dismiss">×</button>` : ''}
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

  /* Imports belong to the company they were dropped into, and keep going
     into it even if the person switches company part-way (plan D3). */
  async function pump(st) {
    if (st.pumping) return;
    st.pumping = true;
    const D = Data().company(st._cid);
    const paint = () => { if (onScreen(st)) renderUploads(); };
    try {
      for (;;) {
        const u = st.uploads.find((x) => x.status === 'queued');
        if (!u) break;
        try {
          const res = await D.importFile(u.file, {
            onStage: (stage) => { u.status = stage; paint(); }
          });
          u.status = 'done';
          u.note = res.empty ? 'Imported — no readable text found' : res.truncated ? 'Imported — only the first part could be read' : 'Imported';
          if (res.name !== u.name.replace(/\.[^.]+$/, '')) u.note += ` as “${res.name}${res.ext}”`;
          const id = u.id;
          setTimeout(() => {
            st.uploads = st.uploads.filter((x) => x.id !== id);
            paint();
          }, 5000);
        } catch (err) {
          console.error('[My Company] import failed', err);
          u.status = 'error';
          u.message = err && err.code ? err.message : 'Couldn’t import this file. Check your connection and try again.';
        }
        u.file = null;
        paint();
      }
    } finally {
      st.pumping = false;
    }
  }

  function wireImport() {
    const zone = q('[data-el="import-zone"]');
    const input = q('[data-el="import-input"]');
    const browse = () => input.click();
    q('[data-el="import-btn"]').addEventListener('click', browse);
    q('[data-el="import-link"]').addEventListener('click', browse);
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
    q('[data-el="uploads"]').addEventListener('click', (e) => {
      const x = e.target.closest('[data-dismiss]');
      if (!x) return;
      state.uploads = state.uploads.filter((u) => String(u.id) !== x.dataset.dismiss);
      renderUploads();
    });
  }

  /* ---------- rename ---------- */

  const RENAME_DUPLICATE = 'File name already exists. Choose another.';

  function cleanFileName(v, id) {
    const f = (state.files || []).find((x) => x.id === id);
    const ext = f ? extFor(f) : '.pdf';
    const t = String(v || '').trim();
    return (ext && t.toLowerCase().endsWith(ext.toLowerCase()) ? t.slice(0, -ext.length) : t).trim();
  }

  function renameProblem(id, value) {
    const name = cleanFileName(value, id);
    if (!name) return 'Enter a file name.';
    const lower = name.toLowerCase();
    if ((state.files || []).some((f) => f.id !== id && f.name.trim().toLowerCase() === lower)) {
      return RENAME_DUPLICATE;
    }
    return '';
  }

  // Updates the error line and the Save button without redrawing the row,
  // so typing never loses focus.
  function syncRenameUi() {
    const r = state.renaming;
    if (!r) return;
    const input = q('[data-rename-input]');
    const err = q('[data-rename-error]');
    const save = q('[data-rename-save]');
    if (input) input.setAttribute('aria-invalid', r.error ? 'true' : 'false');
    if (err) { err.textContent = r.error || ''; err.hidden = !r.error; }
    if (save) save.disabled = !!r.error || !!r.saving;
  }

  function startRename(id) {
    const f = (state.files || []).find((x) => x.id === id);
    if (!f) return;
    state.renaming = { id, value: f.name, error: '', saving: false };
    renderFiles();
    const input = q('[data-rename-input]');
    if (input) input.select();
  }

  function cancelRename() {
    if (!state.renaming || state.renaming.saving) return;
    state.renaming = null;
    renderFiles();
  }

  async function saveRename() {
    const r = state.renaming;
    if (!r || r.saving) return;
    const f = (state.files || []).find((x) => x.id === r.id);
    const name = cleanFileName(r.value, r.id);
    r.error = renameProblem(r.id, r.value);
    if (r.error) { syncRenameUi(); return; }

    if (f && f.name === name) {              // unchanged: just close the editor
      state.renaming = null;
      renderFiles();
      return;
    }

    r.saving = true;
    renderFiles();
    const st = state;
    try {
      await Data().company(st._cid).renameFile(r.id, name);
      if (f) f.name = name;
      r.saving = false;
      if (st.renaming === r) st.renaming = null;
    } catch (ex) {
      console.error('[My Company] rename failed', ex);
      r.saving = false;
      r.error = ex && ex.code === 'duplicate' ? RENAME_DUPLICATE
              : (ex && ex.code ? ex.message : 'Couldn’t rename that file. Please try again.');
    }
    if (onScreen(st)) renderFiles();
  }

  function handleFilesInput(e) {
    const input = e.target.closest('[data-rename-input]');
    if (!input || !state.renaming) return;
    state.renaming.value = input.value;
    state.renaming.error = renameProblem(state.renaming.id, input.value);
    syncRenameUi();
  }

  function handleFilesKeydown(e) {
    if (!e.target.closest('[data-rename-input]')) return;
    if (e.key === 'Enter') { e.preventDefault(); saveRename(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
  }

  /* ---------- row behaviour ---------- */

  function setFieldError(key, msg) {
    const p = q(`[data-field-error="${key}"]`);
    if (!p) return;
    p.textContent = msg || '';
    p.hidden = !msg;
    const input = q(`[data-input="${key}"]`);
    if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }

  function addTag(f, raw) {
    const d = draftFor(f);
    const value = String(raw || '').trim().replace(/,+$/, '').trim();
    if (!value) return true;
    if (f.url && !Data().util.isValidUrl(value)) {
      setFieldError(f.key, `“${value}” isn’t a valid website address.`);
      return false;
    }
    const clean = f.url ? Data().util.normalizeUrl(value) : value;
    if (!d.tags.some((t) => t.toLowerCase() === clean.toLowerCase())) d.tags.push(clean);
    state.drafts[f.key] = { tags: d.tags, text: '' };
    return true;
  }

  function rerenderRow(f, { focus = true } = {}) {
    const row = q(`[data-key="${f.key}"]`);
    if (!row) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = editHtml(f);
    row.replaceWith(tmp.firstElementChild);
    wireRow(f);
    if (focus) {
      const input = q(`[data-input="${f.key}"]`);
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
  }

  function wireRow(f) {
    const input = q(`[data-input="${f.key}"]`);
    if (!input) return;

    // The suggestion list listens first so it can claim Enter/arrow keys.
    if (f.kind === 'industry' || f.suggest) wireCombobox(f, input);

    // keep drafts in sync so navigating away doesn't lose typing
    input.addEventListener('input', () => {
      setFieldError(f.key, '');
      if (isArrayField(f)) state.drafts[f.key] = { tags: draftFor(f).tags, text: input.value };
      else state.drafts[f.key] = input.value;
    });

    if (isArrayField(f)) {
      const box = q(`[data-tagbox="${f.key}"]`);
      box.addEventListener('click', (e) => {
        const x = e.target.closest('[data-remove]');
        if (x) {
          const d = draftFor(f);
          d.tags.splice(Number(x.dataset.remove), 1);
          state.drafts[f.key] = { tags: d.tags, text: input.value };
          rerenderRow(f);
          return;
        }
        if (e.target === box) input.focus();
      });

      input.addEventListener('keydown', (e) => {
        if (e.defaultPrevented) return;          // the suggestion list took it
        if (e.key === 'Enter' || (e.key === ',' && !f.suggest)) {
          e.preventDefault();
          if (addTag(f, input.value)) rerenderRow(f);
        } else if (e.key === 'Backspace' && !input.value) {
          const d = draftFor(f);
          if (d.tags.length) {
            d.tags.pop();
            state.drafts[f.key] = { tags: d.tags, text: '' };
            rerenderRow(f);
          }
        }
      });
    } else if (f.kind === 'url') {
      input.addEventListener('blur', () => {
        const v = input.value.trim();
        setFieldError(f.key, v && !Data().util.isValidUrl(v) ? 'Enter a valid website address, like google.com.' : '');
      });
    }
    // Enter in a plain field submits the form natively, unless the
    // suggestion list claimed the key first (it is wired before this point).
  }

  /* Suggestion list: recommends from two letters on, updates as letters are
     added or removed. Arrow keys move, Enter/click picks, Escape closes. */
  function wireCombobox(f, input) {
    const list = q(`#mc-${f.key}-list`);
    let items = [];
    let active = -1;

    const close = () => {
      list.hidden = true;
      list.innerHTML = '';
      items = [];
      active = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    };

    const paint = () => {
      list.innerHTML = items.map((name, i) => `
        <li role="option" id="mc-${f.key}-opt-${i}" class="mc__option${i === active ? ' is-active' : ''}"
            aria-selected="${i === active}" data-pick="${i}">${esc(name)}</li>`).join('');
      list.hidden = !items.length;
      input.setAttribute('aria-expanded', String(!!items.length));
      if (active >= 0) input.setAttribute('aria-activedescendant', `mc-${f.key}-opt-${active}`);
      else input.removeAttribute('aria-activedescendant');
    };

    const update = () => {
      const exclude = isArrayField(f) ? draftFor(f).tags : [];
      items = suggestIndustries(input.value, exclude);
      active = -1;
      paint();
    };

    const pick = (i) => {
      const name = items[i];
      if (name == null) return;
      if (isArrayField(f)) {
        addTag(f, name);
        close();
        rerenderRow(f);
      } else {
        input.value = name;
        state.drafts[f.key] = name;
        close();
        input.focus();
      }
    };

    input.addEventListener('input', update);
    input.addEventListener('focus', () => { if (input.value.trim().length >= MIN_CHARS) update(); });
    input.addEventListener('keydown', (e) => {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        active = (active + 1) % items.length; paint();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        active = active <= 0 ? items.length - 1 : active - 1; paint();
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        pick(active);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
    // mousedown so the pick lands before the input's blur closes the list
    list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('[data-pick]');
      if (!li) return;
      e.preventDefault();
      pick(Number(li.dataset.pick));
    });
    const onBlur = () => setTimeout(() => { if (mounted && document.activeElement !== input) close(); }, 0);
    input.addEventListener('blur', onBlur);
    comboCleanup.push(close);
  }

  /* ---------- save ---------- */

  function collect() {
    const next = { ...state.profile };
    let firstError = null;

    FIELDS.forEach((f) => {
      if (!rowEditing(f)) return;
      const input = q(`[data-input="${f.key}"]`);
      if (isArrayField(f)) {
        // a typed-but-not-entered value still counts
        if (input && input.value.trim()) {
          if (!addTag(f, input.value)) { firstError = firstError || f.key; return; }
        }
        next[f.key] = [...draftFor(f).tags];
      } else {
        const v = (input ? input.value : '').trim();
        if (f.kind === 'url' && v && !Data().util.isValidUrl(v)) {
          setFieldError(f.key, 'Enter a valid website address, like google.com.');
          firstError = firstError || f.key;
          return;
        }
        next[f.key] = f.kind === 'url' ? Data().util.normalizeUrl(v) : v;
      }
    });

    return { next, firstError };
  }

  async function handleSave(e) {
    e.preventDefault();
    if (!state.loaded) return;
    const err = q('[data-el="error"]');
    err.hidden = true;

    const { next, firstError } = collect();
    if (firstError) {
      const input = q(`[data-input="${firstError}"]`);
      if (input) input.focus();
      return;
    }

    const btn = q('[data-el="save"]');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    const st = state;
    try {
      st.profile = await Data().company(st._cid).saveProfile(next);
      st.editing.clear();
      st.drafts = {};
      pc.hold(st);
      if (onScreen(st)) renderRows({ flash: true });
    } catch (ex) {
      console.error('[My Company] save failed', ex);
      if (onScreen(st)) {
        // A duplicate company name, or a company deleted in another tab,
        // says so; anything else is most likely the connection.
        err.textContent = ex && (ex.code === 'duplicate-company' || ex.code === 'company-gone')
          ? ex.message : 'Couldn’t save — check your connection and try again.';
        err.hidden = false;
      }
    } finally {
      if (mounted) {
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    }
  }

  /* ---------- files ---------- */

  const pendingDelete = new Map();

  async function loadFiles() {
    const st = state;
    st.filesError = '';
    if (onScreen(st) && st.files === null) renderFiles();
    try {
      st.files = await Data().company(st._cid).listFiles();
    } catch (ex) {
      console.error('[My Company] could not list files', ex);
      st.filesError = 'Couldn’t load your saved resources.';
    }
    if (onScreen(st)) renderFiles();
  }

  async function handleFilesClick(e) {
    if (e.target.closest('[data-files-retry]')) { loadFiles(); return; }
    const renameBtn = e.target.closest('[data-rename]');
    if (renameBtn) { startRename(renameBtn.dataset.rename); return; }
    if (e.target.closest('[data-rename-save]')) { saveRename(); return; }

    const open = e.target.closest('[data-open]');
    if (open) {
      open.disabled = true;
      try {
        const f = (state.files || []).find((x) => x.id === open.dataset.open);
        await here().openFile(open.dataset.open, { viewable: !f || Data().isViewable(f.mimeType) });
      } catch (ex) {
        console.error('[My Company] open failed', ex);
        document.dispatchEvent(new CustomEvent('mktforge:notify',
          { detail: { message: ex.message || 'Couldn’t open that file.', tone: 'error' } }));
      } finally {
        open.disabled = false;
      }
      return;
    }

    const del = e.target.closest('[data-delete]');
    if (!del) return;
    const id = del.dataset.delete;

    // Two-step: first click arms, second click (within 4s) deletes.
    if (!pendingDelete.has(id)) {
      del.textContent = 'Confirm delete';
      del.classList.add('is-armed');
      pendingDelete.set(id, setTimeout(() => {
        pendingDelete.delete(id);
        if (del.isConnected) { del.textContent = 'Delete'; del.classList.remove('is-armed'); }
      }, 4000));
      return;
    }

    clearTimeout(pendingDelete.get(id));
    pendingDelete.delete(id);
    del.disabled = true;
    del.textContent = 'Deleting…';
    try {
      await here().deleteFile(id);          // onFiles listener refreshes the table
    } catch (ex) {
      console.error('[My Company] delete failed', ex);
      document.dispatchEvent(new CustomEvent('mktforge:notify',
        { detail: { message: 'Couldn’t delete that file. Please try again.', tone: 'error' } }));
      if (del.isConnected) { del.disabled = false; del.textContent = 'Delete'; del.classList.remove('is-armed'); }
    }
  }

  /* ---------- load ---------- */

  async function load() {
    const st = state;
    st.loadError = '';
    if (onScreen(st)) renderRows();
    try {
      st.profile = await Data().company(st._cid).getProfile();
      st.loaded = true;
    } catch (ex) {
      console.error('[My Company] could not load profile', ex);
      st.loadError = 'Couldn’t load your profile.';
    }
    if (onScreen(st)) renderRows();
  }

  /* ---------- HubSpot (read-only) ----------
     One connection per company. The Worker (hubspot-connect) holds the
     tokens; this screen only shows status and starts/stops the connection.
     Coming back from HubSpot's approval screen lands on
     ?hubspot=<result>&company=<id>#/my-company — read once, then the query
     is removed from the address bar so a refresh doesn't repeat the notice. */

  const HS_RETURN = (() => {
    try {
      const p = new URLSearchParams(window.location.search);
      const result = p.get('hubspot');
      if (!result) return null;
      p.delete('hubspot');
      const company = p.get('company');
      p.delete('company');
      const rest = p.toString();
      history.replaceState(history.state, '',
        `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
      return { result, company };
    } catch (e) { return null; }
  })();

  const HS_NOTICES = {
    connected: { message: 'HubSpot connected. Mktforge has read-only access.' },
    denied:    { message: 'HubSpot wasn’t connected — the approval was cancelled.' },
    expired:   { message: 'That HubSpot approval took too long. Click Connect HubSpot to try again.', tone: 'error' },
    error:     { message: 'HubSpot didn’t finish connecting. Try again, and if it keeps failing, check you’re a Super Admin in that HubSpot account.', tone: 'error' }
  };

  if (HS_RETURN) {
    document.addEventListener('mktforge:company-ready', () => {
      const n = HS_NOTICES[HS_RETURN.result] || HS_NOTICES.error;
      let message = n.message;
      const active = Data() && Data().activeCompanyId;
      if (HS_RETURN.result === 'connected' && HS_RETURN.company && active && HS_RETURN.company !== active) {
        message = 'HubSpot connected to the company you started from. Switch back to it to see the connection.';
      }
      document.dispatchEvent(new CustomEvent('mktforge:notify', { detail: { message, tone: n.tone } }));
    }, { once: true });
  }

  function hsTime(iso) {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? formatDate(t) : '';
  }

  function renderHubSpot() {
    const box = root && q('[data-el="hubspot"]');
    if (!box) return;
    const st = state;
    const s = st.hs;
    const busy = st.hsBusy;
    const err = st.hsError ? `<p class="mc__error mc__hs-error" role="alert">${esc(st.hsError)}</p>` : '';

    const head = (statusHtml) => `
      <div class="mc__hs-main">
        <div class="mc__hs-name">
          <span class="mc__hs-logo" aria-hidden="true">HS</span>
          <div>
            <h3 class="mc__h3 mc__hs-title">HubSpot</h3>
            ${statusHtml}
          </div>
        </div>`;

    if (!s) {
      box.innerHTML = st.hsError
        ? `${head('<p class="mc__hs-status">Status unavailable</p>')}
             <button type="button" class="mc__btn mc__btn--sm mc__btn--ghost" data-hs="retry">Try again</button>
           </div>${err}`
        : '<p class="mc__loading">Checking HubSpot…</p>';
      return;
    }

    if (!s.connected) {
      box.innerHTML = `${head(`<p class="mc__hs-status">Not connected</p>`)}
          <button type="button" class="mc__btn mc__btn--sm" data-hs="connect" ${busy ? 'disabled' : ''}>
            ${busy === 'connect' ? 'Opening HubSpot…' : 'Connect HubSpot'}</button>
        </div>
        <p class="mc__hs-note">Lets Mktforge read this company’s HubSpot contacts, companies, deals and notes
          to help draft emails. Read-only: Mktforge can’t create, edit or delete anything in HubSpot.
          You’ll need to be a Super Admin (or have App Marketplace access) in the HubSpot account.</p>
        ${err}`;
      return;
    }

    const portal = s.portalDomain || (s.portalId ? `HubSpot account ${s.portalId}` : 'your HubSpot account');
    const since = hsTime(s.connectedAt);

    if (s.needsReconnect) {
      box.innerHTML = `${head(`<p class="mc__hs-status is-warn">Needs reconnecting · ${esc(portal)}</p>`)}
          <div class="mc__hs-actions">
            <button type="button" class="mc__btn mc__btn--sm" data-hs="connect" ${busy ? 'disabled' : ''}>
              ${busy === 'connect' ? 'Opening HubSpot…' : 'Reconnect HubSpot'}</button>
            <button type="button" class="mc__delete" data-hs="disconnect" ${busy ? 'disabled' : ''}>
              ${busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</button>
          </div>
        </div>
        <p class="mc__hs-note">The connection expired or the app was removed in HubSpot. Reconnect to keep using HubSpot data.</p>
        ${err}`;
      return;
    }

    box.innerHTML = `${head(`<p class="mc__hs-status is-ok"><span class="mc__hs-dot" aria-hidden="true"></span>
            Connected to <strong>${esc(portal)}</strong> · read-only access</p>`)}
        <button type="button" class="mc__delete" data-hs="disconnect" ${busy ? 'disabled' : ''}>
          ${busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</button>
      </div>
      <p class="mc__hs-note">${since ? `Connected ${esc(since)}. ` : ''}Mktforge currently has read-only access to this company’s HubSpot account.</p>
      ${err}`;
  }

  async function loadHubSpot() {
    const st = state;
    st.hsError = '';
    if (onScreen(st) && !st.hs) renderHubSpot();
    try {
      st.hs = await window.MktforgeKit.hubspot(st._cid).status();
    } catch (ex) {
      console.warn('[My Company] HubSpot status unavailable', ex);
      if (!st.hs) st.hsError = ex.message || 'Couldn’t check the HubSpot connection.';
    }
    if (onScreen(st)) renderHubSpot();
  }

  async function handleHubSpotClick(e) {
    const btn = e.target.closest('[data-hs]');
    if (!btn || state.hsBusy) return;
    const st = state;
    const action = btn.dataset.hs;

    if (action === 'retry') { st.hs = null; loadHubSpot(); return; }

    if (action === 'connect') {
      st.hsBusy = 'connect';
      st.hsError = '';
      renderHubSpot();
      try {
        await window.MktforgeKit.hubspot(st._cid).connect();   // leaves the page on success
      } catch (ex) {
        console.error('[My Company] HubSpot connect failed', ex);
        st.hsError = ex.message || 'Couldn’t start the HubSpot connection.';
        st.hsBusy = '';
        if (onScreen(st)) renderHubSpot();
      }
      return;
    }

    if (action === 'disconnect') {
      const ok = await Mktforge.confirm({
        message: 'Disconnect HubSpot from this company? Mktforge will stop reading its HubSpot data and forget the connection. '
          + 'To remove Mktforge from HubSpot completely, also uninstall it under Connected Apps in your HubSpot settings.',
        cancelLabel: 'Keep Connected',
        confirmLabel: 'Disconnect',
        danger: true
      });
      if (!ok) return;
      st.hsBusy = 'disconnect';
      st.hsError = '';
      if (onScreen(st)) renderHubSpot();
      try {
        await window.MktforgeKit.hubspot(st._cid).disconnect();
        st.hs = { connected: false };
        document.dispatchEvent(new CustomEvent('mktforge:notify', { detail: { message: 'HubSpot disconnected.' } }));
      } catch (ex) {
        console.error('[My Company] HubSpot disconnect failed', ex);
        st.hsError = ex.message || 'Couldn’t disconnect HubSpot. Try again.';
      }
      st.hsBusy = '';
      if (onScreen(st)) renderHubSpot();
    }
  }

  /* ---------- Delete This Company ---------- */

  async function handleDeleteCompany() {
    const ok = await Mktforge.confirm({
      message: DELETE_WARNING,
      cancelLabel: 'No, Don’t Delete',
      confirmLabel: 'Yes, Delete',
      danger: true
    });
    if (!ok) return;
    const btn = q('[data-el="delete-company"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    const done = await Mktforge.deleteActiveCompany();
    if (!done && btn && btn.isConnected) { btn.disabled = false; btn.textContent = 'Delete This Company'; }
  }

  /* ---------- module ---------- */

  Mktforge.register({
    id:     'my-company',
    label:  'My Company',
    icon:   'factory',
    styles: 'modules/my-company/my-company.css',
    companyAware: true,

    mount(container) {
      mounted = true;
      container.innerHTML = shell();
      root = container.firstElementChild;

      q('[data-el="form"]').addEventListener('submit', handleSave);
      q('[data-el="form"]').addEventListener('input', () => pc.hold());
      q('[data-el="rows"]').addEventListener('click', () => setTimeout(() => pc.hold(), 0));
      const delBtn = q('[data-el="delete-company"]');
      delBtn.addEventListener('click', handleDeleteCompany);
      // Only when the account has another company to move to.
      unsubCompanies = Data().onCompanies((list) => { delBtn.hidden = list.length <= 1; });
      q('[data-el="rows"]').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-edit]');
        if (!btn) return;
        const f = FIELDS.find((x) => x.key === btn.dataset.edit);
        state.editing.add(f.key);
        delete state.drafts[f.key];
        renderRows();
        const input = q(`[data-input="${f.key}"]`);
        if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
      });
      const resources = q('[data-el="resources"]');
      resources.addEventListener('click', handleFilesClick);
      resources.addEventListener('input', handleFilesInput);
      resources.addEventListener('keydown', handleFilesKeydown);
      wireImport();
      renderUploads();

      q('[data-el="hubspot"]').addEventListener('click', handleHubSpotClick);
      state.hsBusy = '';                             // a Connect that left the page is over
      renderHubSpot();
      loadHubSpot();                                 // always refresh on open

      if (state.loaded) {
        // Another module may have changed the profile (e.g. Find My Customer
        // tracking a title); the data layer's copy is the current one.
        const st = state;
        Data().company(st._cid).getProfile().then((p) => {
          st.profile = p;
          if (onScreen(st)) renderRows();
        }).catch(() => { if (onScreen(st)) renderRows(); });
        renderRows();
      } else {
        load();
      }
      unsubProfile = Data().onProfile((p) => { state.profile = p; });
      renderFiles();
      loadFiles();                                   // always refresh on open
      unsubFiles = Data().onFiles(() => { if (mounted) loadFiles(); });
    },

    unmount() {
      mounted = false;
      comboCleanup.forEach((fn) => fn());
      comboCleanup = [];
      pendingDelete.forEach((t) => clearTimeout(t));
      pendingDelete.clear();
      if (unsubFiles) { unsubFiles(); unsubFiles = null; }
      if (unsubProfile) { unsubProfile(); unsubProfile = null; }
      if (unsubCompanies) { unsubCompanies(); unsubCompanies = null; }
      pc.hold(state);
      root = null;
    }
  });
})();

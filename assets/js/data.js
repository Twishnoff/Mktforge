/* ==========================================================================
   Mktforge — account data
   Per-account storage for everything that should survive signing out:
   the My Company profile and the PDFs every module generates.

   Backed by Cloud Firestore on Firebase's free Spark plan. There is no
   Firebase Storage bucket on purpose — Storage now requires the paid Blaze
   plan — so PDF bytes are split into chunks and kept as Firestore Blobs.

   LAYOUT (everything keyed on uid, never on email)
     users/{uid}                        { profile: {...}, pdfCounters: { moduleId: n },
                                          buildPositioning: { answers: { key: text } } }
     users/{uid}/files/{fileId}         { name, moduleId, moduleName, size, chunks, createdAt,
                                          source ('generated' | 'imported'), ext, mimeType,
                                          textChunks, textChars, textStatus,
                                          digest? (JSON string, short summary for agents) }
     users/{uid}/files/{fileId}/chunks/{i}   { data: Blob }       original bytes
     users/{uid}/files/{fileId}/text/{i}     { data: string }     extracted text

   Security rules that make this private live in firestore.rules.

   PREVIEW MODE
   When Firebase isn't configured (the PASTE_ placeholders are in config.js)
   the same API is backed by this browser's localStorage so the UI still
   works. Nothing leaves the browser in that mode.

   PUBLIC API (window.MktforgeData)
     getProfile()                    -> Promise<profile>
     saveProfile(profile)            -> Promise<profile>
     onProfile(fn)                   -> unsubscribe; fn(profile) on every save
     savePdfDoc(jsPdfDoc, { moduleId, moduleName, fallbackName })
                                     -> downloads as "<Module Name> N.pdf" and
                                        saves a copy to the account
     listFiles()                     -> Promise<[{ id, name, moduleId, moduleName, source, ext,
                                                  mimeType, size, createdAt, textStatus }]>
     importFile(file, { onStage })   -> Promise<{ id, name }>; reads the file's text, then
                                        saves bytes + text as an Imported Material
     getFileText(id)                 -> Promise<string>; stored text, or extracted and
                                        stored on first use (generated PDFs)
     openFile(id)                    -> opens the PDF in a new tab
     deleteFile(id)                  -> Promise
     renameFile(id, name)            -> Promise; rejects with code 'duplicate'
     nameTaken(name, exceptId)       -> Promise<boolean> (case-insensitive)
     onFiles(fn)                     -> unsubscribe; fn() whenever the list changes
     readFile(id)                    -> Promise<{ name, blob }>
     getFileDigest(id)               -> Promise<object|null> cached summary of a PDF
     setFileDigest(id, digest)       -> Promise; stores that summary on the file
     getPositioningAnswers()         -> Promise<{ key: text }> (Build Positioning)
     savePositioningAnswers(changes) -> Promise; { key: text } sets, { key: null } clears
     prefill(pairs)                  -> fills EMPTY inputs from the profile
     util.normalizeUrl / util.isValidUrl
   ========================================================================== */

window.MktforgeData = (() => {

  const CHUNK_BYTES = 700 * 1024;          // Firestore docs cap at 1 MiB
  const MAX_FILE_BYTES = 15 * 1024 * 1024; // sanity cap per PDF
  const TIMEOUT_MS = 12000;
  const TEXT_CHUNK_CHARS = 300000;          // ≤ ~900 KB UTF-8 per document
  const MAX_TEXT_CHUNKS = 5;

  const EMPTY_PROFILE = Object.freeze({
    companyName: '', companyUrl: '', industry: '',
    targetTitles: [], targetIndustries: [], competitors: []
  });

  const profileListeners = new Set();
  const fileListeners = new Set();
  let db = null;
  let dbPromise = null;
  let profileCache = null;

  const auth = () => window.MktforgeAuth;
  const isLocal = () => !auth() || !auth().isConfigured();

  /* ---------- helpers ---------- */

  function withTimeout(promise, ms = TIMEOUT_MS, label = 'request') {
    let t;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      })
    ]).finally(() => clearTimeout(t));
  }

  function cleanProfile(p) {
    const out = { ...EMPTY_PROFILE };
    if (!p) return out;
    ['companyName', 'companyUrl', 'industry'].forEach((k) => {
      out[k] = typeof p[k] === 'string' ? p[k].trim() : '';
    });
    ['targetTitles', 'targetIndustries', 'competitors'].forEach((k) => {
      const seen = new Set();
      out[k] = (Array.isArray(p[k]) ? p[k] : [])
        .map((v) => String(v).trim())
        .filter((v) => v && !seen.has(v.toLowerCase()) && seen.add(v.toLowerCase()));
    });
    return out;
  }

  function uid() {
    const u = auth() && auth().getUser();
    if (!u) throw new Error('Not signed in.');
    return u.uid;
  }

  function notify(message, tone = 'info') {
    document.dispatchEvent(new CustomEvent('mktforge:notify', { detail: { message, tone } }));
  }

  /* ---------- URL rules (shared with My Company) ----------
     "google.com", "www.google.com" and "https://google.com/about" are all
     fine. A bare word, spaces, or a made-up scheme are not. */

  function normalizeUrl(raw) {
    const v = String(raw || '').trim();
    if (!v) return '';
    return v.replace(/\/+$/, '');
  }

  function isValidUrl(raw) {
    const v = String(raw || '').trim();
    if (!v || /\s/.test(v)) return false;
    let u;
    try {
      u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
    } catch (e) { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    const host = u.hostname;
    if (!/^[a-z0-9.-]+$/i.test(host)) return false;
    const labels = host.split('.');
    if (labels.length < 2) return false;
    if (!labels.every((l) => l && l.length <= 63 && !/^-|-$/.test(l))) return false;
    return /^[a-z]{2,}$/i.test(labels[labels.length - 1]);
  }

  /* ---------- Firestore (lazy) ---------- */

  function getDb() {
    if (db) return Promise.resolve(db);
    if (dbPromise) return dbPromise;
    dbPromise = (async () => {
      await auth().init();
      const v = auth().sdkVersion;
      await window.Mktforge.loadScript(
        `https://www.gstatic.com/firebasejs/${v}/firebase-firestore-compat.js`);
      db = window.firebase.firestore();
      return db;
    })().catch((err) => { dbPromise = null; throw err; });
    return dbPromise;
  }

  const userRef = (d) => d.collection('users').doc(uid());
  const filesRef = (d) => userRef(d).collection('files');

  /* ---------- local (preview) store ---------- */

  const LOCAL_KEY = () => `mktforge.local.${(auth() && auth().getUser() && auth().getUser().uid) || 'anon'}`;

  function localRead() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY())) || {}; }
    catch (e) { return {}; }
  }
  function localWrite(data) {
    try { localStorage.setItem(LOCAL_KEY(), JSON.stringify(data)); }
    catch (e) { throw new Error('This browser is out of local storage space.'); }
  }
  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  /* ---------- profile ---------- */

  async function getProfile({ fresh = false } = {}) {
    if (profileCache && !fresh) return { ...profileCache };
    if (isLocal()) {
      profileCache = cleanProfile(localRead().profile);
    } else {
      const d = await getDb();
      const snap = await withTimeout(userRef(d).get(), TIMEOUT_MS, 'Loading your profile');
      profileCache = cleanProfile(snap.exists ? snap.data().profile : null);
    }
    return { ...profileCache };
  }

  async function saveProfile(profile) {
    const clean = cleanProfile(profile);
    if (isLocal()) {
      const data = localRead();
      data.profile = clean;
      localWrite(data);
    } else {
      const d = await getDb();
      const u = auth().getUser();
      await withTimeout(userRef(d).set({
        profile: { ...clean, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
        email: u.email || ''
      }, { merge: true }), TIMEOUT_MS, 'Saving your profile');
    }
    profileCache = clean;
    profileListeners.forEach((fn) => { try { fn({ ...clean }); } catch (e) { console.error(e); } });
    return { ...clean };
  }

  function onProfile(fn) { profileListeners.add(fn); return () => profileListeners.delete(fn); }

  /* ---------- files ---------- */

  const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

  async function nameTaken(name, exceptId) {
    const files = await listFiles();
    return files.some((f) => f.id !== exceptId && sameName(f.name, name));
  }

  /* "<Module Name> N", where N is the account's per-module counter. If a
     renamed file already uses that name, the counter keeps going. */
  async function reserveName(moduleId, moduleName) {
    let taken = new Set();
    try { taken = new Set((await listFiles()).map((f) => f.name.trim().toLowerCase())); }
    catch (err) { console.warn('[Mktforge] could not check existing file names', err); }
    for (let guard = 0; guard < 50; guard += 1) {
      const name = await nextCounterName(moduleId, moduleName);
      if (!taken.has(name.toLowerCase())) return name;
    }
    throw new Error('Could not find a free file name.');
  }

  async function nextCounterName(moduleId, moduleName) {
    if (isLocal()) {
      const data = localRead();
      data.pdfCounters = data.pdfCounters || {};
      const n = (data.pdfCounters[moduleId] || 0) + 1;
      data.pdfCounters[moduleId] = n;
      localWrite(data);
      return `${moduleName} ${n}`;
    }
    const d = await getDb();
    const ref = userRef(d);
    const n = await withTimeout(d.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const counters = (snap.exists && snap.data().pdfCounters) || {};
      const next = (Number(counters[moduleId]) || 0) + 1;
      tx.set(ref, { pdfCounters: { [moduleId]: next } }, { merge: true });
      return next;
    }), TIMEOUT_MS, 'Naming the PDF');
    return `${moduleName} ${n}`;
  }

  function textParts(text) {
    const t = String(text || '');
    const parts = [];
    for (let i = 0; i < t.length && parts.length < MAX_TEXT_CHUNKS; i += TEXT_CHUNK_CHARS) {
      parts.push(t.slice(i, i + TEXT_CHUNK_CHARS));
    }
    return parts;
  }

  /* extra: { source, ext, mimeType, textStatus } — text: string or null */
  async function storeFile({ name, moduleId, moduleName, blob, extra = {}, text = null }) {
    if (blob.size > MAX_FILE_BYTES) {
      throw Object.assign(new Error(`This file is larger than ${MAX_FILE_BYTES / (1024 * 1024)} MB.`), { code: 'too-large' });
    }
    const parts = text == null ? null : textParts(text);
    const textFields = parts == null ? {} : {
      textChunks: parts.length,
      textChars: parts.reduce((n, x) => n + x.length, 0),
      textStatus: parts.length ? 'ok' : 'empty'
    };
    const fields = { name, moduleId, moduleName, size: blob.size, ...extra, ...textFields };

    if (isLocal()) {
      const data = localRead();
      data.files = data.files || [];
      const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      data.files.push({ id, ...fields, createdAt: Date.now(),
                        text: parts == null ? undefined : parts.join(''),
                        dataUrl: await blobToDataUrl(blob) });
      localWrite(data);
      return id;
    }

    const d = await getDb();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunkCount = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
    const meta = filesRef(d).doc();

    // Chunks first, metadata last: a file only appears in the list once all
    // of its bytes are there. Two chunks per batch keeps each request small.
    try {
      for (let i = 0; i < chunkCount; i += 2) {
        const batch = d.batch();
        for (let j = i; j < Math.min(i + 2, chunkCount); j += 1) {
          const part = bytes.subarray(j * CHUNK_BYTES, (j + 1) * CHUNK_BYTES);
          batch.set(meta.collection('chunks').doc(String(j)),
                    { data: firebase.firestore.Blob.fromUint8Array(part) });
        }
        await withTimeout(batch.commit(), 30000, 'Uploading the file');
      }
      for (let j = 0; parts && j < parts.length; j += 1) {
        await withTimeout(meta.collection('text').doc(String(j)).set({ data: parts[j] }),
                          30000, 'Saving the file’s text');
      }
      await withTimeout(meta.set({
        ...fields, chunks: chunkCount,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }), TIMEOUT_MS, 'Saving the file');
    } catch (err) {
      deleteChunks(d, meta, chunkCount, (parts && parts.length) || 0).catch(() => {});
      throw err;
    }
    return meta.id;
  }

  /* ---------- imported materials ---------- */

  const MIME_BY_KIND = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv', text: 'text/plain', markdown: 'text/markdown',
    json: 'application/json', html: 'text/html'
  };

  function splitName(fileName) {
    const raw = String(fileName || 'Untitled').trim();
    const m = /^(.*?)(\.[a-z0-9]{1,8})?$/i.exec(raw);
    const base = (m[1] || 'Untitled').trim().slice(0, 180) || 'Untitled';
    return { base, ext: (m[2] || '').toLowerCase() };
  }

  async function uniqueName(base) {
    let taken;
    try { taken = new Set((await listFiles()).map((f) => f.name.trim().toLowerCase())); }
    catch (e) { taken = new Set(); }
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${base} (${n})`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${base} (${Date.now()})`;
  }

  /* onStage('reading' | 'saving') lets the page show progress. */
  async function importFile(file, { onStage = () => {} } = {}) {
    const X = window.MktforgeExtract;
    if (!X) throw new Error('The file reader isn’t loaded.');
    const kind = X.supported(file.name, file.type);
    if (!kind) throw Object.assign(new Error(X.unsupportedReason(file.name)), { code: 'unsupported' });
    if (file.size > MAX_FILE_BYTES) {
      throw Object.assign(new Error(`This file is larger than ${MAX_FILE_BYTES / (1024 * 1024)} MB.`), { code: 'too-large' });
    }
    if (!file.size) throw Object.assign(new Error('This file is empty.'), { code: 'empty' });

    onStage('reading');
    const { text, truncated } = await X.text(file, { name: file.name, type: file.type });

    onStage('saving');
    const { base, ext } = splitName(file.name);
    const name = await uniqueName(base);
    const id = await storeFile({
      name, moduleId: 'imported', moduleName: 'Imported', blob: file, text,
      extra: { source: 'imported', ext, mimeType: file.type || MIME_BY_KIND[kind] || 'application/octet-stream',
               kind, truncated: !!truncated }
    });
    fileListeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    return { id, name, ext, empty: !text, truncated: !!truncated };
  }

  /* Stored text for any saved file. Generated PDFs have none until an agent
     first needs it; it's extracted then and kept. */
  async function getFileText(id) {
    if (isLocal()) {
      const f = (localRead().files || []).find((x) => x.id === id);
      if (!f) throw new Error('That file no longer exists.');
      if (typeof f.text === 'string') return f.text;
    } else {
      const d = await getDb();
      const meta = filesRef(d).doc(id);
      const snap = await withTimeout(meta.get(), TIMEOUT_MS, 'Reading a saved file');
      if (!snap.exists) throw new Error('That file no longer exists.');
      const m = snap.data();
      if (m.textStatus === 'empty') return '';
      if (m.textChunks > 0) {
        const parts = await withTimeout(Promise.all(
          Array.from({ length: m.textChunks }, (_, i) => meta.collection('text').doc(String(i)).get())
        ), 30000, 'Reading a saved file');
        return parts.map((p) => (p.exists ? p.data().data : '')).join('');
      }
    }

    const { name, blob, ext } = await readFile(id);
    const { text } = await window.MktforgeExtract.text(blob, { name: `${name}${ext || '.pdf'}`, type: blob.type });
    setFileText(id, text).catch((err) => console.warn('[Mktforge] could not store extracted text', err));
    return text;
  }

  async function setFileText(id, text) {
    const parts = textParts(text);
    const fields = { textChunks: parts.length, textChars: parts.reduce((n, x) => n + x.length, 0),
                     textStatus: parts.length ? 'ok' : 'empty' };
    if (isLocal()) {
      const data = localRead();
      const f = (data.files || []).find((x) => x.id === id);
      if (!f) return;
      Object.assign(f, fields, { text: parts.join('') });
      localWrite(data);
      return;
    }
    const d = await getDb();
    const meta = filesRef(d).doc(id);
    for (let j = 0; j < parts.length; j += 1) {
      await withTimeout(meta.collection('text').doc(String(j)).set({ data: parts[j] }), 30000, 'Saving text');
    }
    await withTimeout(meta.set(fields, { merge: true }), TIMEOUT_MS, 'Saving text');
  }

  async function savePdfDoc(doc, { moduleId, moduleName, fallbackName }) {
    let name = null;
    try {
      name = await reserveName(moduleId, moduleName);
    } catch (err) {
      console.error('[Mktforge] could not name the PDF', err);
    }

    // The download never waits on, or fails because of, the account copy.
    doc.save(`${name || fallbackName.replace(/\.pdf$/i, '')}.pdf`);
    if (!name) {
      notify("Downloaded, but couldn't save a copy to My Company.", 'error');
      return null;
    }

    try {
      const id = await storeFile({ name, moduleId, moduleName, blob: doc.output('blob'),
                                   extra: { source: 'generated', ext: '.pdf', mimeType: 'application/pdf', kind: 'pdf' } });
      fileListeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
      notify(`Saved to My Company as “${name}”.`);
      return { id, name };
    } catch (err) {
      console.error('[Mktforge] could not save the PDF to the account', err);
      notify(`Downloaded, but couldn't save “${name}” to My Company.`, 'error');
      return null;
    }
  }

  function toMillis(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    return 0;
  }

  async function listFiles() {
    if (isLocal()) {
      return (localRead().files || [])
        .map(({ dataUrl, digest, text, ...rest }) => ({ source: 'generated', ext: '', ...rest }))
        .sort((a, b) => b.createdAt - a.createdAt);
    }
    const d = await getDb();
    const snap = await withTimeout(filesRef(d).orderBy('createdAt', 'desc').get(),
                                   TIMEOUT_MS, 'Loading your saved resources');
    return snap.docs.map((doc) => {
      const f = doc.data({ serverTimestamps: 'estimate' });
      return { id: doc.id, name: f.name, moduleId: f.moduleId, moduleName: f.moduleName,
               source: f.source === 'imported' ? 'imported' : 'generated',
               ext: f.ext || '', mimeType: f.mimeType || 'application/pdf', kind: f.kind || 'pdf',
               textStatus: f.textStatus || '', truncated: !!f.truncated,
               size: f.size || 0, createdAt: toMillis(f.createdAt) };
    });
  }

  async function readFile(id) {
    if (isLocal()) {
      const f = (localRead().files || []).find((x) => x.id === id);
      if (!f) throw new Error('That file no longer exists.');
      const blob = await (await fetch(f.dataUrl)).blob();
      return { name: f.name, ext: f.ext || '', mimeType: f.mimeType || 'application/pdf', blob };
    }
    const d = await getDb();
    const meta = filesRef(d).doc(id);
    const snap = await withTimeout(meta.get(), TIMEOUT_MS, 'Opening the file');
    if (!snap.exists) throw new Error('That file no longer exists.');
    const { name, chunks, ext = '', mimeType = 'application/pdf' } = snap.data();
    const parts = await withTimeout(Promise.all(
      Array.from({ length: chunks }, (_, i) => meta.collection('chunks').doc(String(i)).get())
    ), 30000, 'Downloading the PDF');
    const bytes = parts.map((p) => {
      if (!p.exists) throw new Error('Part of this file is missing.');
      return p.data().data.toUint8Array();
    });
    return { name, ext, mimeType, blob: new Blob(bytes, { type: mimeType }) };
  }

  /* PDFs and text open in a new tab; Office files download. The tab is
     opened synchronously (inside the click) so popup blockers allow it,
     then pointed at the file once the bytes arrive. */
  const VIEWABLE = /^(application\/pdf|text\/plain|text\/csv|text\/markdown|application\/json)$/;

  async function openFile(id, { viewable = true } = {}) {
    const win = viewable ? window.open('', '_blank') : null;
    if (win) {
      try {
        win.document.title = 'Loading…';
        win.document.body.style.cssText = 'font:14px system-ui,sans-serif;padding:32px;color:#555';
        win.document.body.textContent = 'Loading…';
      } catch (e) { /* cross-origin in some browsers; harmless */ }
    }
    try {
      const { name, ext, mimeType, blob } = await readFile(id);
      const fileName = `${name}${ext || '.pdf'}`;
      const typed = /^text\//.test(mimeType) ? new Blob([blob], { type: `${mimeType};charset=utf-8` }) : blob;
      const url = URL.createObjectURL(typed);
      if (win && !win.closed && VIEWABLE.test(mimeType)) {
        win.location.href = url;
      } else {
        if (win && !win.closed) win.close();
        const a = document.createElement('a');
        a.href = url; a.download = fileName;
        document.body.appendChild(a); a.click(); a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
    } catch (err) {
      if (win && !win.closed) win.close();
      throw err;
    }
  }

  const isViewable = (mimeType) => VIEWABLE.test(mimeType || 'application/pdf');

  async function deleteChunks(d, meta, count, textCount = 0) {
    for (let i = 0; i < count; i += 20) {
      const batch = d.batch();
      for (let j = i; j < Math.min(i + 20, count); j += 1) {
        batch.delete(meta.collection('chunks').doc(String(j)));
      }
      await batch.commit();
    }
    if (textCount) {
      const batch = d.batch();
      for (let j = 0; j < textCount; j += 1) batch.delete(meta.collection('text').doc(String(j)));
      await batch.commit();
    }
  }

  async function deleteFile(id) {
    if (isLocal()) {
      const data = localRead();
      data.files = (data.files || []).filter((f) => f.id !== id);
      localWrite(data);
    } else {
      const d = await getDb();
      const meta = filesRef(d).doc(id);
      const snap = await withTimeout(meta.get(), TIMEOUT_MS, 'Deleting the file');
      if (snap.exists) {
        // Metadata first so the row disappears even if a chunk delete fails.
        await withTimeout(meta.delete(), TIMEOUT_MS, 'Deleting the file');
        await withTimeout(deleteChunks(d, meta, snap.data().chunks || 1, snap.data().textChunks || 0),
                          30000, 'Deleting the file');
      }
    }
    fileListeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  }

  async function renameFile(id, rawName) {
    const name = String(rawName || '').trim();
    if (!name) throw Object.assign(new Error('Enter a file name.'), { code: 'empty' });
    if (name.length > 200) throw Object.assign(new Error('That name is too long.'), { code: 'long' });
    if (await nameTaken(name, id)) {
      throw Object.assign(new Error('File name already exists. Choose another.'), { code: 'duplicate' });
    }
    if (isLocal()) {
      const data = localRead();
      const f = (data.files || []).find((x) => x.id === id);
      if (!f) throw new Error('That file no longer exists.');
      f.name = name;
      localWrite(data);
    } else {
      const d = await getDb();
      await withTimeout(filesRef(d).doc(id).update({ name }), TIMEOUT_MS, 'Renaming the file');
    }
    fileListeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    return name;
  }

  function onFiles(fn) { fileListeners.add(fn); return () => fileListeners.delete(fn); }

  /* ---------- PDF digests (Build Positioning) ----------
     A short machine summary of a saved PDF, made once and kept on the
     file's own record so later runs don't pay to summarize it again.
     Stored as a JSON string (≤ 20 KB, see firestore.rules). */

  const DIGEST_MAX = 20000;

  async function getFileDigest(id) {
    let raw = null;
    if (isLocal()) {
      const f = (localRead().files || []).find((x) => x.id === id);
      raw = f ? f.digest : null;
    } else {
      const d = await getDb();
      const snap = await withTimeout(filesRef(d).doc(id).get(), TIMEOUT_MS, 'Reading a saved resource');
      raw = snap.exists ? snap.data().digest : null;
    }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  async function setFileDigest(id, digest) {
    const raw = JSON.stringify(digest || null);
    if (raw.length > DIGEST_MAX) throw new Error('Summary is too large to store.');
    if (isLocal()) {
      const data = localRead();
      const f = (data.files || []).find((x) => x.id === id);
      if (!f) return;
      f.digest = raw;
      localWrite(data);
      return;
    }
    const d = await getDb();
    await withTimeout(filesRef(d).doc(id).set({ digest: raw }, { merge: true }),
                      TIMEOUT_MS, 'Saving a summary');
  }

  /* ---------- Build Positioning answers ----------
     One flat map on the account record. Keys carry their own scope:
       company__<question>
       competitor__<competitor slug>__<question>
       champion__<title slug>__<question>
     so switching the Primary Champion or Closest Competitor simply reads
     different keys. */

  const KEY_RE = /^[a-z0-9_-]{1,200}$/;
  let answersCache = null;

  async function getPositioningAnswers({ fresh = false } = {}) {
    if (answersCache && !fresh) return { ...answersCache };
    let raw;
    if (isLocal()) {
      raw = localRead().positioningAnswers;
    } else {
      const d = await getDb();
      const snap = await withTimeout(userRef(d).get(), TIMEOUT_MS, 'Loading your answers');
      raw = snap.exists && snap.data().buildPositioning ? snap.data().buildPositioning.answers : null;
    }
    answersCache = {};
    Object.entries(raw || {}).forEach(([k, v]) => {
      if (KEY_RE.test(k) && typeof v === 'string' && v.trim()) answersCache[k] = v;
    });
    return { ...answersCache };
  }

  async function savePositioningAnswers(changes) {
    const entries = Object.entries(changes || {}).filter(([k]) => KEY_RE.test(k));
    if (!entries.length) return getPositioningAnswers();
    const clean = entries.map(([k, v]) => [k, typeof v === 'string' && v.trim() ? v.trim() : null]);

    if (isLocal()) {
      const data = localRead();
      data.positioningAnswers = data.positioningAnswers || {};
      clean.forEach(([k, v]) => { if (v === null) delete data.positioningAnswers[k]; else data.positioningAnswers[k] = v; });
      localWrite(data);
    } else {
      const d = await getDb();
      const del = firebase.firestore.FieldValue.delete();
      const answers = {};
      clean.forEach(([k, v]) => { answers[k] = v === null ? del : v; });
      await withTimeout(userRef(d).set({ buildPositioning: { answers } }, { merge: true }),
                        TIMEOUT_MS, 'Saving your answers');
    }
    const next = answersCache ? { ...answersCache } : await getPositioningAnswers({ fresh: true });
    clean.forEach(([k, v]) => { if (v === null) delete next[k]; else next[k] = v; });
    answersCache = next;
    return { ...next };
  }

  /* ---------- autofill for other modules ----------
     prefill([[inputEl, 'companyUrl'], [inputEl, p => p.targetTitles[0]]])
     Only fills inputs that are still empty when the profile arrives, and
     fires an `input` event so the module's own validation re-runs. */

  async function prefill(pairs) {
    let profile;
    try { profile = await getProfile(); }
    catch (err) { console.warn('[Mktforge] profile unavailable for autofill', err); return; }
    pairs.forEach(([input, pick]) => {
      if (!input || !input.isConnected || String(input.value || '').trim()) return;
      const value = typeof pick === 'function' ? pick(profile) : profile[pick];
      if (!value) return;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  return {
    getProfile, saveProfile, onProfile,
    savePdfDoc, listFiles, openFile, deleteFile, renameFile, nameTaken, onFiles,
    readFile, getFileDigest, setFileDigest, importFile, getFileText, isViewable,
    MAX_FILE_BYTES,
    getPositioningAnswers, savePositioningAnswers,
    prefill,
    get isLocal() { return isLocal(); },
    util: { normalizeUrl, isValidUrl }
  };
})();

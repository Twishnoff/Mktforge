/* ==========================================================================
   Mktforge — account data
   Per-account storage for everything that should survive signing out:
   the My Company profile and the PDFs every module generates.

   Backed by Cloud Firestore on Firebase's free Spark plan. There is no
   Firebase Storage bucket on purpose — Storage now requires the paid Blaze
   plan — so PDF bytes are split into chunks and kept as Firestore Blobs.

   LAYOUT (everything keyed on uid, never on email)
     users/{uid}                        { profile: {...}, pdfCounters: { moduleId: n } }
     users/{uid}/files/{fileId}         { name, moduleId, moduleName, size, chunks, createdAt }
     users/{uid}/files/{fileId}/chunks/{i}   { data: Blob }

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
     listFiles()                     -> Promise<[{ id, name, moduleName, size, createdAt }]>
     openFile(id)                    -> opens the PDF in a new tab
     deleteFile(id)                  -> Promise
     onFiles(fn)                     -> unsubscribe; fn() whenever the list changes
     prefill(pairs)                  -> fills EMPTY inputs from the profile
     util.normalizeUrl / util.isValidUrl
   ========================================================================== */

window.MktforgeData = (() => {

  const CHUNK_BYTES = 700 * 1024;          // Firestore docs cap at 1 MiB
  const MAX_FILE_BYTES = 15 * 1024 * 1024; // sanity cap per PDF
  const TIMEOUT_MS = 12000;

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

  async function reserveName(moduleId, moduleName) {
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

  async function storeFile({ name, moduleId, moduleName, blob }) {
    if (blob.size > MAX_FILE_BYTES) throw new Error('PDF is too large to save to your account.');

    if (isLocal()) {
      const data = localRead();
      data.files = data.files || [];
      const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      data.files.push({ id, name, moduleId, moduleName, size: blob.size,
                        createdAt: Date.now(), dataUrl: await blobToDataUrl(blob) });
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
        await withTimeout(batch.commit(), 30000, 'Uploading the PDF');
      }
      await withTimeout(meta.set({
        name, moduleId, moduleName, size: bytes.length, chunks: chunkCount,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }), TIMEOUT_MS, 'Saving the PDF');
    } catch (err) {
      deleteChunks(d, meta, chunkCount).catch(() => {});
      throw err;
    }
    return meta.id;
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
      const id = await storeFile({ name, moduleId, moduleName, blob: doc.output('blob') });
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
        .map(({ dataUrl, ...rest }) => rest)
        .sort((a, b) => b.createdAt - a.createdAt);
    }
    const d = await getDb();
    const snap = await withTimeout(filesRef(d).orderBy('createdAt', 'desc').get(),
                                   TIMEOUT_MS, 'Loading your saved resources');
    return snap.docs.map((doc) => {
      const f = doc.data({ serverTimestamps: 'estimate' });
      return { id: doc.id, name: f.name, moduleId: f.moduleId, moduleName: f.moduleName,
               size: f.size || 0, createdAt: toMillis(f.createdAt) };
    });
  }

  async function readFile(id) {
    if (isLocal()) {
      const f = (localRead().files || []).find((x) => x.id === id);
      if (!f) throw new Error('That file no longer exists.');
      const blob = await (await fetch(f.dataUrl)).blob();
      return { name: f.name, blob };
    }
    const d = await getDb();
    const meta = filesRef(d).doc(id);
    const snap = await withTimeout(meta.get(), TIMEOUT_MS, 'Opening the PDF');
    if (!snap.exists) throw new Error('That file no longer exists.');
    const { name, chunks } = snap.data();
    const parts = await withTimeout(Promise.all(
      Array.from({ length: chunks }, (_, i) => meta.collection('chunks').doc(String(i)).get())
    ), 30000, 'Downloading the PDF');
    const bytes = parts.map((p) => {
      if (!p.exists) throw new Error('Part of this file is missing.');
      return p.data().data.toUint8Array();
    });
    return { name, blob: new Blob(bytes, { type: 'application/pdf' }) };
  }

  /* Opens the tab synchronously (inside the click) so popup blockers allow
     it, then points it at the PDF once the bytes arrive. */
  async function openFile(id) {
    const win = window.open('', '_blank');
    if (win) {
      try {
        win.document.title = 'Loading PDF…';
        win.document.body.style.cssText = 'font:14px system-ui,sans-serif;padding:32px;color:#555';
        win.document.body.textContent = 'Loading PDF…';
      } catch (e) { /* cross-origin in some browsers; harmless */ }
    }
    try {
      const { name, blob } = await readFile(id);
      const url = URL.createObjectURL(blob);
      if (win && !win.closed) {
        win.location.href = url;
      } else {
        const a = document.createElement('a');
        a.href = url; a.download = `${name}.pdf`;
        document.body.appendChild(a); a.click(); a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
    } catch (err) {
      if (win && !win.closed) win.close();
      throw err;
    }
  }

  async function deleteChunks(d, meta, count) {
    for (let i = 0; i < count; i += 20) {
      const batch = d.batch();
      for (let j = i; j < Math.min(i + 20, count); j += 1) {
        batch.delete(meta.collection('chunks').doc(String(j)));
      }
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
      const snap = await withTimeout(meta.get(), TIMEOUT_MS, 'Deleting the PDF');
      if (snap.exists) {
        // Metadata first so the row disappears even if a chunk delete fails.
        await withTimeout(meta.delete(), TIMEOUT_MS, 'Deleting the PDF');
        await withTimeout(deleteChunks(d, meta, snap.data().chunks || 1), 30000, 'Deleting the PDF');
      }
    }
    fileListeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  }

  function onFiles(fn) { fileListeners.add(fn); return () => fileListeners.delete(fn); }

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
    savePdfDoc, listFiles, openFile, deleteFile, onFiles,
    prefill,
    get isLocal() { return isLocal(); },
    util: { normalizeUrl, isValidUrl }
  };
})();

/* ==========================================================================
   Mktforge — account data
   Everything that should survive signing out: the account itself, and one
   container of data per company the account holds (up to 10).

   Backed by Cloud Firestore on Firebase's free Spark plan. There is no
   Firebase Storage bucket on purpose — Storage now requires the paid Blaze
   plan — so PDF bytes are split into chunks and kept as Firestore Blobs.

   LAYOUT (everything keyed on uid, never on email)
     users/{uid}                        the ACCOUNT
       { email, account: { photo, photoUpdatedAt },
         lastCompanyId,                 the company to open on the next sign-in
         companyIds:   { companyId: code },       active companies (limit check)
         companyNames: { nameKey: companyId } }   taken names (unique-name check)

     users/{uid}/companies/{companyId}  one COMPANY
       { status: 'active' | 'deleting', code: 'A1V3', name, createdAt,
         profile: {...}, pdfCounters: { moduleId: n },
         buildPositioning: { answers: { key: text } },
         targetMessaging: { email, landingPage, updatedAt } }   (editor HTML)
     .../files/{fileId}                 { name, moduleId, moduleName, size, chunks, createdAt,
                                          source ('generated' | 'imported'), ext, mimeType,
                                          textChunks, textChars, textStatus,
                                          digest? (JSON string, short summary for agents) }
     .../files/{fileId}/chunks/{i}      { data: Blob }       original bytes
     .../files/{fileId}/text/{i}        { data: string }     extracted text
     .../competitorLedger/{id}          Market Tracker: what the agent has already seen
     .../tracker/{boxId}                Market Tracker: { title, kind, rows: [...], ... }

   Security rules that make this private live in firestore.rules. They also
   refuse writes into a company that is not 'active', so a tab still working
   on a company that another tab deleted cannot quietly bring it back.

   ACTIVE COMPANY
   Each browser tab has its own active company (kept in sessionStorage, so a
   refresh stays put and two tabs don't pull each other around). The first
   data call in a tab picks it: this tab's last company, else the account's
   last company, else the oldest one.

   RULE FOR CALLERS
   Anything that runs for a while (a module run, an import, a save) takes a
   handle when it starts and uses that handle to the end:
       const D = MktforgeData.scope();       // the active company, fixed now
       ... await D.saveTrackerBox(box) ...   // still that company after a switch
   The top-level functions below (getProfile, listFiles, ...) always act on
   whatever company is active at the moment they are called. They are right
   for painting the screen, wrong for finishing a job.

   PREVIEW MODE
   When Firebase isn't configured (the PASTE_ placeholders are in config.js)
   the same API is backed by this browser's localStorage so the UI still
   works. Nothing leaves the browser in that mode.

   PUBLIC API (window.MktforgeData)
     Companies
       start()                         -> Promise<companyId>; picks this tab's company (idempotent)
       activeCompanyId                 the active company's id (null before start())
       scope()                         -> Promise<handle> for the active company, fixed now
       company(id)                     -> handle for that company
       listCompanies()                 -> Promise<[{ id, name, code, displayName, createdAt }]>
                                          named A-Z, then unnamed "Company X" oldest first
       onCompanies(fn)                 -> unsubscribe; fn(list) now and on every change, any tab
       createCompany()                 -> Promise<companyId>; rejects code 'company-limit'
       switchCompany(id)               -> Promise; makes it active in this tab
       retireCompany(id)               -> Promise; marks it deleting (hidden, no more saves)
       purgeDeleted()                  -> Promise; removes the data of companies marked deleting
       deleteCompany(id)               -> Promise; retireCompany, then removes its data.
                                          Rejects code 'last-company'. Does NOT switch away:
                                          the caller moves the tab first (see oldestCompanyId).
       oldestCompanyId(exceptId)       -> Promise<companyId|null>
       settle(ms)                      -> Promise<boolean>; waits for saves already in flight
       busy                            true while any save is in flight
       MAX_COMPANIES, companyDisplayName(c)
     Events on document
       mktforge:company-switched   { from, to }   this tab changed company. NOT a profile change.
       mktforge:company-gone       { id }         this tab's company was deleted in another tab

     Per company (on a handle, or top-level for the active company)
       getProfile()                    -> Promise<profile>
       saveProfile(profile)            -> Promise<profile>; rejects code 'duplicate-company'
       savePdfDoc(jsPdfDoc, { moduleId, moduleName, fallbackName })
                                       -> downloads as "<Module Name> N.pdf" and
                                          saves a copy to the company
       listFiles()                     -> Promise<[{ id, name, moduleId, moduleName, source, ext,
                                                  mimeType, size, createdAt, textStatus }]>
       importFile(file, { onStage })   -> Promise<{ id, name }>
       getFileText(id, { withLinks })  -> Promise<string>
       openFile(id)                    -> opens the file in a new tab
       deleteFile(id) / renameFile(id, name) / nameTaken(name, exceptId)
       readFile(id) / getFileDigest(id) / setFileDigest(id, digest)
       getPositioningAnswers() / savePositioningAnswers(changes)
       getTargetMessaging() / saveTargetMessaging({ email?, landingPage? })
       listTrackerBoxes() / saveTrackerBox(box) / deleteTrackerBox(id)
       getTitleLedger(title) / saveTitleLedger(title, l) / deleteTitleLedger(title)
       getCompetitorLedger(url) / saveCompetitorLedger(url, l) / deleteCompetitorLedger(url)
       prefill(pairs)                  -> fills EMPTY inputs from the profile
       companyId                       (handles only) which company this is

     Listeners (fire only for the company active in this tab)
       onProfile(fn)                   -> unsubscribe; fn(profile, companyId) on every save
       onFiles(fn)                     -> unsubscribe; fn(companyId) whenever the list changes

     Account
       getAvatar() / saveAvatar(dataUrl) / onAvatar(fn)
       util.imageToAvatarDataUrl(file), util.normalizeUrl, util.isValidUrl
       trackerId(title), trackerTitleId(title), trackerCompetitorId(url), competitorKey(url)
   ========================================================================== */

window.MktforgeData = (() => {

  const CHUNK_BYTES = 700 * 1024;          // Firestore docs cap at 1 MiB
  const MAX_FILE_BYTES = 15 * 1024 * 1024; // sanity cap per PDF
  const TIMEOUT_MS = 12000;
  /* Bumped when extraction starts capturing something it used to miss. v1
     added a PDF's link annotations, without which a Marketing Opportunities
     or Persona Builder report carries no addresses at all. A file stored
     before that is re-read once, on demand. */
  const LINKS_V = 1;

  const TEXT_CHUNK_CHARS = 300000;          // ≤ ~900 KB UTF-8 per document
  const MAX_TEXT_CHUNKS = 5;

  const MAX_COMPANIES = 10;
  const ACTIVE_KEY = 'mktforge.company';    // sessionStorage: this tab's company

  /* Avatars ride along in the users/{uid} document rather than getting a
     chunked file of their own, so they have to stay comfortably inside the
     1 MiB document cap. A 256px square is more than the 30px management-bar
     circle can show, and lands around 20-40 KB as JPEG. */
  const AVATAR_PX = 256;
  const AVATAR_QUALITY = 0.85;
  const MAX_AVATAR_BYTES = 400 * 1024;      // the stored data URL
  const MAX_AVATAR_UPLOAD_BYTES = 12 * 1024 * 1024;   // the file someone picks

  const EMPTY_PROFILE = Object.freeze({
    companyName: '', companyUrl: '', industry: '',
    targetTitles: [], targetIndustries: [], competitors: []
  });

  const MESSAGES = {
    duplicate: 'A company with this name already exists in your account. Choose a different name.',
    limit: `${MAX_COMPANIES} Company Limit Reached`,
    last: 'This is your only company, so it can’t be deleted.',
    gone: 'This company has been deleted.',
    upgrade: 'Your account is being upgraded to hold several companies. Please try again in a few minutes.'
  };

  const profileListeners = new Set();
  const fileListeners = new Set();
  const avatarListeners = new Set();
  const companyListeners = new Set();
  let db = null;
  let dbPromise = null;
  let avatarCache = null;         // null = not read yet; '' = none set

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

  const fail = (code, message) => Object.assign(new Error(message), { code });

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

  function emit(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function toMillis(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    return 0;
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
  const companiesRef = (d) => userRef(d).collection('companies');

  /* ---------- local (preview) store ----------
     Same shape as Firestore: { account fields..., companies: { id: {...} } } */

  const ROOT_KEY = () => `mktforge.local.${(auth() && auth().getUser() && auth().getUser().uid) || 'anon'}`;

  function rootRead() {
    try { return JSON.parse(localStorage.getItem(ROOT_KEY())) || {}; }
    catch (e) { return {}; }
  }
  function rootWrite(data) {
    try { localStorage.setItem(ROOT_KEY(), JSON.stringify(data)); }
    catch (e) { throw new Error('This browser is out of local storage space.'); }
  }
  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  /* ---------- account profile picture ----------
     The image the management bar shows beside the account name. Stored as a
     data URL on the user document, not as a chunked file: it is small by the
     time imageToAvatarDataUrl() is done with it, and keeping it on the one
     document the shell already reads means the circle can be painted without
     a second round trip. It belongs to the account, not to any company.

     Firebase Auth's own photoURL is deliberately NOT used. It takes a URL,
     not image bytes, and long values are rejected — with no Storage bucket on
     the Spark plan there is nowhere to point it at. */

  /** Square-crops the centre of an image file and shrinks it to AVATAR_PX. */
  function imageToAvatarDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (!file) { reject(new Error('No image selected.')); return; }
      if (!/^image\//.test(file.type || '')) {
        reject(new Error('That file isn’t an image. Pick a PNG, JPEG, WebP or GIF.'));
        return;
      }
      if (file.size > MAX_AVATAR_UPLOAD_BYTES) {
        reject(new Error(`That image is too large — keep it under ${
          Math.round(MAX_AVATAR_UPLOAD_BYTES / (1024 * 1024))} MB.`));
        return;
      }

      const url = URL.createObjectURL(file);
      const img = new Image();

      img.onload = () => {
        URL.revokeObjectURL(url);
        try {
          const side = Math.min(img.naturalWidth, img.naturalHeight);
          if (!side) throw new Error('That image couldn’t be read.');
          const sx = (img.naturalWidth - side) / 2;
          const sy = (img.naturalHeight - side) / 2;

          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = AVATAR_PX;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          // A transparent PNG would otherwise flatten to black on JPEG.
          ctx.fillStyle = '#FFFDF7';
          ctx.fillRect(0, 0, AVATAR_PX, AVATAR_PX);
          ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_PX, AVATAR_PX);

          let dataUrl = canvas.toDataURL('image/jpeg', AVATAR_QUALITY);
          // Belt and braces: a pathological image could still come back big.
          if (dataUrl.length > MAX_AVATAR_BYTES) dataUrl = canvas.toDataURL('image/jpeg', 0.6);
          if (dataUrl.length > MAX_AVATAR_BYTES) {
            reject(new Error('That image couldn’t be shrunk enough to save. Try a different one.'));
            return;
          }
          resolve(dataUrl);
        } catch (err) { reject(err); }
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('That image couldn’t be read. Try a different file.'));
      };

      img.src = url;
    });
  }

  /* The account document as the server holds it, never with this tab's
     own pending writes laid over it (see getAvatar). Falls back to a plain
     read if the transaction can't run, e.g. offline. */
  async function readAccountDoc(d, label) {
    const ref = userRef(d);
    try {
      return await withTimeout(d.runTransaction((tx) => tx.get(ref)), TIMEOUT_MS, label);
    } catch (err) {
      console.warn('[Mktforge] account read fell back to a plain get', err);
      return withTimeout(ref.get(), TIMEOUT_MS, label);
    }
  }

  async function getAvatar({ fresh = false } = {}) {
    if (avatarCache !== null && !fresh) return avatarCache;
    if (isLocal()) {
      avatarCache = String(rootRead().avatar || '');
    } else {
      const d = await getDb();
      /* Read inside a transaction. On a refresh, start() has already queued
         the "last company" write to this same document, and any get() —
         even { source: 'server' } — comes back with that pending write laid
         over it, which on a fresh page is just { lastCompanyId }: no
         account, so no picture. A transaction read goes straight to the
         server and ignores pending local writes. */
      const snap = await readAccountDoc(d, 'Loading your profile picture');
      const account = (snap.exists && snap.data().account) || null;
      avatarCache = String((account && account.photo) || '');
    }
    return avatarCache;
  }

  /** Pass '' or null to remove the picture. */
  async function saveAvatar(dataUrl) {
    const photo = String(dataUrl || '');
    if (photo && !/^data:image\//.test(photo)) throw new Error('That isn’t an image.');
    if (photo.length > MAX_AVATAR_BYTES) throw new Error('That image is too large to save.');

    if (isLocal()) {
      const data = rootRead();
      if (photo) data.avatar = photo; else delete data.avatar;
      rootWrite(data);
    } else {
      const d = await getDb();
      const account = photo
        ? { photo, photoUpdatedAt: firebase.firestore.FieldValue.serverTimestamp() }
        : { photo: firebase.firestore.FieldValue.delete(),
            photoUpdatedAt: firebase.firestore.FieldValue.delete() };
      await withTimeout(userRef(d).set({ account }, { merge: true }),
                        TIMEOUT_MS, 'Saving your profile picture');
    }

    avatarCache = photo;
    avatarListeners.forEach((fn) => { try { fn(photo); } catch (e) { console.error(e); } });
    document.dispatchEvent(new CustomEvent('mktforge:avatar-changed', { detail: photo }));
    return photo;
  }

  function onAvatar(fn) { avatarListeners.add(fn); return () => avatarListeners.delete(fn); }

  /* ---------- Market Tracker ids (pure; the same in every company) ---------- */

  /* Two spellings of the same competitor have to land on one box and one
     ledger, so everything is keyed on the bare host: "https://www.Acme.com/",
     "acme.com" and "http://acme.com/pricing" are all `acme.com`. */
  function competitorKey(raw) {
    const v = String(raw || '').trim().toLowerCase();
    if (!v) return '';
    return v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  }

  /* Job titles get a ledger too, in the same collection. The collection is
     called competitorLedger because that is what it held first — the same
     reason the Worker is still deployed as "customer-tracker". Renaming it
     would orphan every history already saved, so the name stays and the
     document id says which kind it is. */
  function trackerTitleId(title) {
    const key = String(title || '').trim().toLowerCase();
    let h = 5381;
    for (let i = 0; i < key.length; i += 1) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
    const slug = key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'title';
    return `t-${slug}-${h.toString(36)}`;
  }

  function trackerCompetitorId(url) {
    const key = competitorKey(url);
    let h = 5381;
    for (let i = 0; i < key.length; i += 1) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
    const slug = key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'competitor';
    return `c-${slug}-${h.toString(36)}`;
  }

  function trackerId(title) {
    const key = String(title || '').trim().toLowerCase();
    let h = 5381;
    for (let i = 0; i < key.length; i += 1) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
    const slug = key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'title';
    return `${slug}-${h.toString(36)}`;
  }

  /* ---------- company names ---------- */

  /* "Acme", "acme" and " ACME " are one name. Map keys in Firestore can't be
     just anything (dots and "__x__" are special), so the key is escaped and
     prefixed. */
  const nameKey = (name) => {
    const n = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return n ? `n_${encodeURIComponent(n).replace(/\./g, '%2E').replace(/[*~!'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}` : '';
  };

  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I: easy to misread
  function newCode(taken) {
    for (let guard = 0; guard < 200; guard += 1) {
      let c = '';
      const bytes = new Uint8Array(4);
      (window.crypto || {}).getRandomValues ? window.crypto.getRandomValues(bytes)
        : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); });
      bytes.forEach((b) => { c += CODE_CHARS[b % CODE_CHARS.length]; });
      if (!taken.has(c)) return c;
    }
    throw new Error('Could not make a company code.');
  }

  const companyDisplayName = (c) => (c && c.name ? c.name : `Company ${(c && c.code) || ''}`.trim());

  /* Named companies A-Z, then unnamed ones oldest first (spec 3.1, Q10). */
  function sortCompanies(list) {
    const named = list.filter((c) => c.name)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.createdAt - b.createdAt);
    const unnamed = list.filter((c) => !c.name).sort((a, b) => a.createdAt - b.createdAt);
    return [...named, ...unnamed];
  }

  const shapeCompany = (id, c) => {
    const out = { id, name: String((c && c.name) || '').trim(), code: String((c && c.code) || ''),
                  status: (c && c.status) === 'deleting' ? 'deleting' : 'active',
                  createdAt: toMillis(c && c.createdAt) };
    out.displayName = companyDisplayName(out);
    return out;
  };

  /* ======================================================================
     ONE COMPANY
     Everything below reads and writes a single company's container. A handle
     never changes which company it points at.
     ====================================================================== */

  const handles = new Map();      // companyId -> handle

  /* Saves still in flight, whichever company they belong to. The shell waits
     for them before reloading the page on a company switch, so an import or
     a save that has started always finishes into the company that started
     it (plan D3) rather than being cut off half-written. */
  const inflight = new Set();
  const WRITES = ['saveProfile', 'savePdfDoc', 'importFile', 'deleteFile', 'renameFile', 'setFileDigest',
    'savePositioningAnswers', 'saveTrackerBox', 'deleteTrackerBox', 'saveTitleLedger', 'deleteTitleLedger',
    'saveCompetitorLedger', 'deleteCompetitorLedger', 'saveTargetMessaging'];
  function tracked(fn) {
    return (...args) => {
      const p = fn(...args);
      inflight.add(p);
      const done = () => inflight.delete(p);
      p.then(done, done);
      return p;
    };
  }
  /* Resolves once every save started before this call has finished (or
     after `ms`, so a hung request can't trap the person on this company). */
  function settle(ms = 60000) {
    const pending = [...inflight];
    if (!pending.length) return Promise.resolve(true);
    let t;
    return Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise((r) => { t = setTimeout(() => r(false), ms); })
    ]).finally(() => clearTimeout(t));
  }
  const busy = () => inflight.size > 0;

  function company(cid) {
    if (!cid || /\//.test(cid)) throw new Error('Unknown company.');
    if (!handles.has(cid)) {
      const h = makeHandle(cid);
      WRITES.forEach((k) => { h[k] = tracked(h[k]); });
      handles.set(cid, h);
    }
    return handles.get(cid);
  }

  function makeHandle(cid) {

    let profileCache = null;
    let answersCache = null;

    const baseRef = (d) => companiesRef(d).doc(cid);
    const filesRef = (d) => baseRef(d).collection('files');

    /* The company's slice of the local store, read and written whole. */
    function localRead() {
      const r = rootRead();
      return (r.companies && r.companies[cid]) || {};
    }
    function localWrite(data) {
      const r = rootRead();
      r.companies = r.companies || {};
      r.companies[cid] = data;
      rootWrite(r);
    }

    /* Listeners only hear about the company this tab is showing. A save that
       lands in another company — a run started before a switch, finishing
       after it — must not look like a change to the one on screen. */
    const isActive = () => cid === activeId;
    const tellFiles = () => {
      if (!isActive()) return;
      fileListeners.forEach((fn) => { try { fn(cid); } catch (e) { console.error(e); } });
    };
    const tellProfile = (p) => {
      if (!isActive()) return;
      profileListeners.forEach((fn) => { try { fn({ ...p }, cid); } catch (e) { console.error(e); } });
    };

    /* ---------- profile ---------- */

    async function getProfile({ fresh = false } = {}) {
      if (profileCache && !fresh) return { ...profileCache };
      if (isLocal()) {
        profileCache = cleanProfile(localRead().profile);
      } else {
        const d = await getDb();
        const snap = await withTimeout(baseRef(d).get(), TIMEOUT_MS, 'Loading your profile');
        profileCache = cleanProfile(snap.exists ? snap.data().profile : null);
      }
      return { ...profileCache };
    }

    /* The name check and the save are one transaction, so two tabs can't
       both take the same name, and the dropdown's name moves with it. */
    async function saveProfile(profile) {
      const clean = cleanProfile(profile);
      const newKey = nameKey(clean.companyName);

      if (isLocal()) {
        const r = rootRead();
        const names = r.companyNames || {};
        if (newKey && names[newKey] && names[newKey] !== cid) throw fail('duplicate-company', MESSAGES.duplicate);
        const c = (r.companies && r.companies[cid]) || null;
        if (!c || c.status === 'deleting') throw fail('company-gone', MESSAGES.gone);
        const oldKey = nameKey((c.profile && c.profile.companyName) || '');
        if (oldKey && oldKey !== newKey && names[oldKey] === cid) delete names[oldKey];
        if (newKey) names[newKey] = cid;
        r.companyNames = names;
        c.profile = clean;
        c.name = clean.companyName;
        rootWrite(r);
      } else {
        const d = await getDb();
        const u = auth().getUser();
        const uRef = userRef(d);
        const cRef = baseRef(d);
        const FV = firebase.firestore.FieldValue;
        await withTimeout(d.runTransaction(async (tx) => {
          const [us, cs] = [await tx.get(uRef), await tx.get(cRef)];
          if (!cs.exists || cs.data().status !== 'active') throw fail('company-gone', MESSAGES.gone);
          const names = (us.exists && us.data().companyNames) || {};
          if (newKey && names[newKey] && names[newKey] !== cid) throw fail('duplicate-company', MESSAGES.duplicate);
          const oldKey = nameKey(((cs.data().profile) || {}).companyName || '');
          const nameChanges = {};
          if (oldKey && oldKey !== newKey && names[oldKey] === cid) nameChanges[oldKey] = FV.delete();
          if (newKey) nameChanges[newKey] = cid;
          // Only send companyNames when something in it changes: in a merge
          // set, an empty map REPLACES the whole field and would drop every
          // other company's name.
          const acct = { email: u.email || '' };
          if (Object.keys(nameChanges).length) acct.companyNames = nameChanges;
          tx.set(uRef, acct, { merge: true });
          tx.set(cRef, { profile: { ...clean, updatedAt: FV.serverTimestamp() }, name: clean.companyName },
                 { merge: true });
        }), TIMEOUT_MS, 'Saving your profile');
      }
      profileCache = clean;
      tellProfile(clean);
      notifyCompanies();
      return { ...clean };
    }

    /* ---------- files ---------- */

    const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

    async function nameTaken(name, exceptId) {
      const files = await listFiles();
      return files.some((f) => f.id !== exceptId && sameName(f.name, name));
    }

    /* "<Module Name> N", where N is the company's per-module counter. If a
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
      const ref = baseRef(d);
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
      tellFiles();
      return { id, name, ext, empty: !text, truncated: !!truncated };
    }

    /* Stored text for any saved file. Generated PDFs have none until an agent
       first needs it; it's extracted then and kept. withLinks: re-read the
       file if its stored text predates link extraction. */
    async function getFileText(id, { withLinks = false } = {}) {
      if (isLocal()) {
        const f = (localRead().files || []).find((x) => x.id === id);
        if (!f) throw new Error('That file no longer exists.');
        if (typeof f.text === 'string' && (!withLinks || (Number(f.linksV) || 0) >= LINKS_V)) return f.text;
      } else {
        const d = await getDb();
        const meta = filesRef(d).doc(id);
        const snap = await withTimeout(meta.get(), TIMEOUT_MS, 'Reading a saved file');
        if (!snap.exists) throw new Error('That file no longer exists.');
        const m = snap.data();
        const stale = withLinks && (Number(m.linksV) || 0) < LINKS_V;
        if (m.textStatus === 'empty' && !stale) return '';
        if (m.textChunks > 0 && !stale) {
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
                       textStatus: parts.length ? 'ok' : 'empty', linksV: LINKS_V };
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

      // The download never waits on, or fails because of, the saved copy.
      doc.save(`${name || fallbackName.replace(/\.pdf$/i, '')}.pdf`);
      if (!name) {
        notify("Downloaded, but couldn't save a copy to My Company.", 'error');
        return null;
      }

      try {
        const id = await storeFile({ name, moduleId, moduleName, blob: doc.output('blob'),
                                     extra: { source: 'generated', ext: '.pdf', mimeType: 'application/pdf', kind: 'pdf' } });
        tellFiles();
        notify(`Saved to My Company as “${name}”.`);
        return { id, name };
      } catch (err) {
        console.error('[Mktforge] could not save the PDF to the company', err);
        notify(`Downloaded, but couldn't save “${name}” to My Company.`, 'error');
        return null;
      }
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
      tellFiles();
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
      tellFiles();
      return name;
    }

    /* ---------- PDF digests (Build Positioning) ----------
       A short machine summary of a saved PDF, made once and kept on the
       file's own record so later runs don't pay to summarize it again.
       Stored as a JSON string (≤ 20 KB, see firestore.rules). */

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
       One flat map on the company record. Keys carry their own scope:
         company__<question>
         competitor__<competitor slug>__<question>
         champion__<title slug>__<question>
       so switching the Primary Champion or Closest Competitor simply reads
       different keys. */

    async function getPositioningAnswers({ fresh = false } = {}) {
      if (answersCache && !fresh) return { ...answersCache };
      let raw;
      if (isLocal()) {
        raw = localRead().positioningAnswers;
      } else {
        const d = await getDb();
        const snap = await withTimeout(baseRef(d).get(), TIMEOUT_MS, 'Loading your answers');
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
        await withTimeout(baseRef(d).set({ buildPositioning: { answers } }, { merge: true }),
                          TIMEOUT_MS, 'Saving your answers');
      }
      const next = answersCache ? { ...answersCache } : await getPositioningAnswers({ fresh: true });
      clean.forEach(([k, v]) => { if (v === null) delete next[k]; else next[k] = v; });
      answersCache = next;
      return { ...next };
    }

    /* ---------- Target Messaging editors ----------
       The two editors' contents (sanitized HTML), kept on the company record
       so they survive a refresh or signing out until they're edited or a new
       run overwrites them. Read fresh each time: another tab may have saved. */

    const TM_MAX = 200000;          // characters per editor; well inside the 1 MiB doc cap
    const cleanTm = (raw) => ({
      email: typeof (raw && raw.email) === 'string' ? raw.email.slice(0, TM_MAX) : '',
      landingPage: typeof (raw && raw.landingPage) === 'string' ? raw.landingPage.slice(0, TM_MAX) : '',
      updatedAt: toMillis(raw && raw.updatedAt) || (raw && typeof raw.updatedAt === 'number' ? raw.updatedAt : 0)
    });

    async function getTargetMessaging() {
      if (isLocal()) return cleanTm(localRead().targetMessaging);
      const d = await getDb();
      const snap = await withTimeout(baseRef(d).get(), TIMEOUT_MS, 'Loading your drafts');
      return cleanTm(snap.exists ? snap.data().targetMessaging : null);
    }

    /* changes: { email?, landingPage? } — only the keys given are replaced. */
    async function saveTargetMessaging(changes) {
      const out = {};
      ['email', 'landingPage'].forEach((k) => {
        if (typeof (changes && changes[k]) !== 'string') return;
        if (changes[k].length > TM_MAX) throw fail('too-long', 'This draft is too long to save. Shorten it and try again.');
        out[k] = changes[k];
      });
      if (!Object.keys(out).length) return;
      if (isLocal()) {
        const data = localRead();
        data.targetMessaging = { ...(data.targetMessaging || {}), ...out, updatedAt: Date.now() };
        localWrite(data);
        return;
      }
      const d = await getDb();
      await withTimeout(
        baseRef(d).set({ targetMessaging: { ...out, updatedAt: firebase.firestore.FieldValue.serverTimestamp() } }, { merge: true }),
        TIMEOUT_MS, 'Saving your drafts');
    }

    /* ---------- Market Tracker boxes ----------
       One document per tracked job title, so a box's results can be written or
       deleted on their own and never bloat the company record the rest of
       the app reads. The id comes from the title (case-insensitive), so a
       title can only ever have one box. */

    const trackerRef = (d) => baseRef(d).collection('tracker');
    const ledgerRef  = (d) => baseRef(d).collection('competitorLedger');

    async function listTrackerBoxes() {
      if (isLocal()) {
        return Object.entries(localRead().tracker || {}).map(([id, b]) => ({ id, ...cleanTrackerBox(b) }));
      }
      const d = await getDb();
      const snap = await withTimeout(trackerRef(d).get(), TIMEOUT_MS, 'Loading your tracked titles');
      return snap.docs.map((doc) => ({ id: doc.id, ...cleanTrackerBox(doc.data()) }));
    }

    async function saveTrackerBox(box) {
      const clean = cleanTrackerBox(box || {});
      if (!clean.title) throw new Error('A tracked box needs a name.');
      /* A competitor box is filed under its URL, not its name — the agent may
         rename it once it works out whose site it is, and the box has to stay
         the same document when it does. */
      const id = String((box && box.id) || '').trim()
        || (clean.kind === 'competitor' ? trackerCompetitorId(clean.competitorUrl) : trackerId(clean.title));
      if (!id || /\//.test(id)) throw new Error('Unknown tracked box.');
      if (isLocal()) {
        const data = localRead();
        data.tracker = data.tracker || {};
        data.tracker[id] = { ...clean, updatedAt: Date.now() };
        localWrite(data);
      } else {
        const d = await getDb();
        await withTimeout(trackerRef(d).doc(id).set({ ...clean, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }),
                          TIMEOUT_MS, 'Saving tracked results');
      }
      return { id, ...clean };
    }

    async function deleteTrackerBox(id) {
      if (!id || /\//.test(id)) throw new Error('Unknown tracked title.');
      if (isLocal()) {
        const data = localRead();
        if (data.tracker) delete data.tracker[id];
        localWrite(data);
        return;
      }
      const d = await getDb();
      await withTimeout(trackerRef(d).doc(id).delete(), TIMEOUT_MS, 'Removing a tracked title');
    }

    /* ---------- competitor and title ledgers ----------
       What the agent has already seen and already shown the user, so a
       refresh only reports what is new. Keyed on the competitor's host (or
       the title) rather than on the box, because it has to outlive Stop
       Tracking. It dies only when the URL or title leaves My Company. */

    async function getLedgerById(id, label) {
      if (isLocal()) return cleanLedger((localRead().competitorLedger || {})[id], label);
      const d = await getDb();
      const snap = await withTimeout(ledgerRef(d).doc(id).get(), TIMEOUT_MS, 'Loading history');
      return cleanLedger(snap.exists ? snap.data() : null, label);
    }

    async function saveLedgerById(id, label, ledger) {
      const clean = cleanLedger(ledger, label);
      if (isLocal()) {
        const data = localRead();
        data.competitorLedger = data.competitorLedger || {};
        data.competitorLedger[id] = { ...clean, updatedAt: Date.now() };
        localWrite(data);
        return clean;
      }
      const d = await getDb();
      await withTimeout(ledgerRef(d).doc(id).set({ ...clean, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }),
                        TIMEOUT_MS, 'Saving history');
      return clean;
    }

    async function deleteLedgerById(id) {
      if (isLocal()) {
        const data = localRead();
        if (data.competitorLedger) delete data.competitorLedger[id];
        localWrite(data);
        return;
      }
      const d = await getDb();
      await withTimeout(ledgerRef(d).doc(id).delete(), TIMEOUT_MS, 'Removing history');
    }

    const getTitleLedger    = (title) => getLedgerById(trackerTitleId(title), title);
    const saveTitleLedger   = (title, l) => saveLedgerById(trackerTitleId(title), title, l);
    const deleteTitleLedger = (title) => deleteLedgerById(trackerTitleId(title));
    const getCompetitorLedger    = (url) => getLedgerById(trackerCompetitorId(url), url);
    const saveCompetitorLedger   = (url, l) => saveLedgerById(trackerCompetitorId(url), url, l);
    const deleteCompetitorLedger = (url) => deleteLedgerById(trackerCompetitorId(url));

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

    /* ---------- removing the whole company (see deleteCompany) ---------- */

    async function purge() {
      if (isLocal()) {
        const r = rootRead();
        if (r.companies) delete r.companies[cid];
        rootWrite(r);
        return;
      }
      const d = await getDb();
      // Files: chunks and text first, the file's record last. If this is
      // interrupted, the record is still there, so the next pass finds the
      // file again and finishes it — nothing is left behind unreachable.
      for (;;) {
        const snap = await withTimeout(filesRef(d).limit(20).get(), TIMEOUT_MS, 'Removing company files');
        if (snap.empty) break;
        for (const doc of snap.docs) {
          const m = doc.data();
          await withTimeout(deleteChunks(d, doc.ref, m.chunks || 1, Math.max(m.textChunks || 0, MAX_TEXT_CHUNKS)),
                            30000, 'Removing a company file');
          await withTimeout(doc.ref.delete(), TIMEOUT_MS, 'Removing a company file');
        }
      }
      for (const ref of [trackerRef(d), ledgerRef(d)]) {
        for (;;) {
          const snap = await withTimeout(ref.limit(200).get(), TIMEOUT_MS, 'Removing company data');
          if (snap.empty) break;
          const batch = d.batch();
          snap.docs.forEach((doc) => batch.delete(doc.ref));
          await withTimeout(batch.commit(), 30000, 'Removing company data');
        }
      }
      await withTimeout(baseRef(d).delete(), TIMEOUT_MS, 'Removing the company');
    }

    return {
      companyId: cid,
      getProfile, saveProfile, prefill,
      savePdfDoc, listFiles, openFile, deleteFile, renameFile, nameTaken,
      readFile, getFileDigest, setFileDigest, importFile, getFileText,
      getPositioningAnswers, savePositioningAnswers,
      getTargetMessaging, saveTargetMessaging,
      listTrackerBoxes, saveTrackerBox, deleteTrackerBox,
      getCompetitorLedger, saveCompetitorLedger, deleteCompetitorLedger,
      getTitleLedger, saveTitleLedger, deleteTitleLedger,
      _purge: purge
    };
  }

  /* ---------- shared by every company ---------- */

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

  const VIEWABLE = /^(application\/pdf|text\/plain|text\/csv|text\/markdown|application\/json)$/;
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

  const DIGEST_MAX = 20000;
  const KEY_RE = /^[a-z0-9_-]{1,200}$/;

  const TRACKER_FIELDS = ['title', 'kind', 'competitorUrl', 'rows', 'lastRefreshed', 'status', 'note',
    'companyName', 'stats', 'runs', 'createdAt'];

  function cleanTrackerBox(raw) {
    const out = {};
    TRACKER_FIELDS.forEach((k) => { if (raw[k] !== undefined) out[k] = raw[k]; });
    out.title = String(out.title || '').trim().slice(0, 200);
    out.kind = out.kind === 'competitor' ? 'competitor' : 'title';
    out.competitorUrl = String(out.competitorUrl || '').trim().slice(0, 500);
    out.rows = Array.isArray(out.rows) ? out.rows.slice(0, 50) : [];
    out.runs = Number(out.runs) || 0;
    out.createdAt = Number(out.createdAt) || Date.now();
    out.lastRefreshed = Number(out.lastRefreshed) || 0;
    out.status = String(out.status || 'pending');
    out.note = String(out.note || '');
    out.companyName = String(out.companyName || '');
    out.stats = out.stats && typeof out.stats === 'object' ? out.stats : null;
    return out;
  }

  /*   { v, url, companyName,
         homepage:  { heading, copy, cta, checkedAt },
         inventory: [ { u, k, d } ]   every page seen on the site (k = kind,
                                      d = publish date or '')
         surfaced:  [ { u, d, t } ] } every URL shown to the user
                                      (t = when it was first shown) */
  const LEDGER_CAP = 2000;

  function cleanLedger(raw, url) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const hp = r.homepage && typeof r.homepage === 'object' ? r.homepage : {};
    const list = (v, keys) => (Array.isArray(v) ? v : []).slice(0, LEDGER_CAP)
      .map((e) => {
        if (!e || typeof e !== 'object' || !e.u) return null;
        const out = { u: String(e.u).slice(0, 500) };
        keys.forEach((k) => { if (e[k] !== undefined && e[k] !== null && e[k] !== '') out[k] = e[k]; });
        return out;
      })
      .filter(Boolean);
    return {
      /* Set by the Worker. Bumped when something changes the meaning of what
         is stored, so the next run knows to re-read it. Never invent one. */
      v: Number(r.v) || 1,
      url: String(r.url || url || '').slice(0, 500),
      companyName: String(r.companyName || '').slice(0, 200),
      homepage: {
        heading: String(hp.heading || '').slice(0, 2000),
        copy: String(hp.copy || '').slice(0, 4000),
        cta: String(hp.cta || '').slice(0, 500),
        checkedAt: Number(hp.checkedAt) || 0
      },
      inventory: list(r.inventory, ['k', 'd']),
      surfaced: list(r.surfaced, ['d', 't'])
    };
  }

  /* ======================================================================
     COMPANIES
     ====================================================================== */

  let activeId = null;
  let startPromise = null;
  let lastList = null;            // the most recent company list, for onCompanies
  let snapshotUnsub = null;

  function readTabCompany() {
    try { return sessionStorage.getItem(ACTIVE_KEY) || ''; } catch (e) { return ''; }
  }
  function writeTabCompany(id) {
    try { sessionStorage.setItem(ACTIVE_KEY, id); } catch (e) { /* private mode; refresh falls back */ }
  }

  /* Reads from the server, not the local cache. While the dropdown's live
     listener is running, a plain get() answers from that listener's view,
     and a company just made in a transaction isn't in it until the server
     echoes it back — so the new company would look like it doesn't exist.
     Falls back to a normal read if the server can't be reached. */
  async function serverGet(ref, label) {
    try { return await withTimeout(ref.get({ source: 'server' }), TIMEOUT_MS, label); }
    catch (err) { return withTimeout(ref.get(), TIMEOUT_MS, label); }
  }

  /* Every company, active and deleting. */
  async function readCompanies() {
    if (isLocal()) {
      const r = rootRead();
      return Object.entries(r.companies || {}).map(([id, c]) => shapeCompany(id, c));
    }
    const d = await getDb();
    const snap = await serverGet(companiesRef(d), 'Loading your companies');
    return snap.docs.map((doc) => shapeCompany(doc.id, doc.data({ serverTimestamps: 'estimate' })));
  }

  /* One company's record, straight from the server. */
  async function companyIsActive(id) {
    if (isLocal()) {
      const c = (rootRead().companies || {})[id];
      return !!c && c.status !== 'deleting';
    }
    const d = await getDb();
    const snap = await serverGet(companiesRef(d).doc(id), 'Opening the company');
    return snap.exists && snap.data().status === 'active';
  }

  async function listCompanies() {
    return sortCompanies((await readCompanies()).filter((c) => c.status === 'active'));
  }

  async function oldestCompanyId(exceptId) {
    const list = (await listCompanies()).filter((c) => c.id !== exceptId)
      .sort((a, b) => a.createdAt - b.createdAt);
    return list.length ? list[0].id : null;
  }

  function publishCompanies(list) {
    lastList = list;
    companyListeners.forEach((fn) => { try { fn(list.slice()); } catch (e) { console.error(e); } });
    // Deleted somewhere else while this tab was on it. The live list can lag
    // behind a change this tab just made, so ask the server before acting.
    const id = activeId;
    if (id && !list.some((c) => c.id === id)) {
      companyIsActive(id).then((alive) => {
        if (!alive && activeId === id) emit('mktforge:company-gone', { id });
      }).catch(() => {});
    }
  }

  /* Local saves (a rename here) repaint the dropdown straight away; in
     Firestore mode the live listener would too, a moment later. */
  function notifyCompanies() {
    if (!companyListeners.size) return;
    listCompanies().then(publishCompanies).catch((err) => console.warn('[Mktforge] company list', err));
  }

  /* Live across tabs: a rename, add or delete in another tab shows here. */
  function onCompanies(fn) {
    companyListeners.add(fn);
    if (lastList) { try { fn(lastList.slice()); } catch (e) { console.error(e); } }
    if (!snapshotUnsub) {
      if (isLocal()) {
        snapshotUnsub = () => {};
        notifyCompanies();
      } else {
        snapshotUnsub = () => {};    // placeholder while the db loads
        getDb().then((d) => {
          snapshotUnsub = companiesRef(d).onSnapshot((snap) => {
            const list = snap.docs.map((doc) => shapeCompany(doc.id, doc.data({ serverTimestamps: 'estimate' })))
              .filter((c) => c.status === 'active');
            publishCompanies(sortCompanies(list));
          }, (err) => console.warn('[Mktforge] company list listener', err));
        }).catch((err) => console.warn('[Mktforge] company list listener', err));
      }
    }
    return () => {
      companyListeners.delete(fn);
      if (!companyListeners.size && snapshotUnsub) { snapshotUnsub(); snapshotUnsub = null; }
    };
  }

  /* The limit check and the create are one transaction on the account
     record, so two tabs can't both add the tenth company. */
  /* onlyIfNone: the first company of a brand-new account. Two tabs opened
     at once would otherwise each make one; the second finds the first and
     returns it instead. */
  async function createCompany({ onlyIfNone = false } = {}) {
    if (isLocal()) {
      const r = rootRead();
      const ids = r.companyIds || {};
      if (onlyIfNone && Object.keys(ids).length) return Object.keys(ids)[0];
      if (Object.keys(ids).length >= MAX_COMPANIES) throw fail('company-limit', MESSAGES.limit);
      const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const code = newCode(new Set(Object.values(ids)));
      r.companies = r.companies || {};
      r.companies[id] = { status: 'active', code, name: '', createdAt: Date.now(), profile: { ...EMPTY_PROFILE } };
      r.companyIds = { ...ids, [id]: code };
      rootWrite(r);
      notifyCompanies();
      return id;
    }
    const d = await getDb();
    const uRef = userRef(d);
    const cRef = companiesRef(d).doc();
    const u = auth().getUser();
    let existing = null;
    let orphans = {};
    await withTimeout(d.runTransaction(async (tx) => {
      existing = null;
      orphans = {};
      const us = await tx.get(uRef);
      const ids = (us.exists && us.data().companyIds) || {};
      if (onlyIfNone && Object.keys(ids).length) {
        // Normally the other tab's first company. If the account lists
        // companies that no longer exist (removed by hand in the console),
        // drop them from the list rather than locking the person out.
        for (const id of Object.keys(ids)) {
          const cs = await tx.get(companiesRef(d).doc(id));
          if (cs.exists && cs.data().status === 'active') { existing = id; return; }
        }
        Object.keys(ids).forEach((id) => { orphans[id] = firebase.firestore.FieldValue.delete(); delete ids[id]; });
      }
      if (Object.keys(ids).length >= MAX_COMPANIES) throw fail('company-limit', MESSAGES.limit);
      const code = newCode(new Set(Object.values(ids)));
      tx.set(cRef, { status: 'active', code, name: '', profile: { ...EMPTY_PROFILE },
                     createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      tx.set(uRef, { email: (u && u.email) || '', companyIds: { ...orphans, [cRef.id]: code } }, { merge: true });
    }), TIMEOUT_MS, 'Adding a company');
    return existing || cRef.id;
  }

  async function recordLastCompany(id) {
    if (!id) return;
    try {
      if (isLocal()) {
        const r = rootRead(); r.lastCompanyId = id; rootWrite(r);
      } else {
        const d = await getDb();
        await withTimeout(userRef(d).set({ lastCompanyId: id }, { merge: true }), TIMEOUT_MS, 'Remembering your company');
      }
    } catch (err) {
      console.warn('[Mktforge] could not record the last company', err);
    }
  }

  /* Returns the "last company" write, so a caller about to reload the page
     can wait for it; start() doesn't, so it never holds up opening the app. */
  let lastWrite = Promise.resolve();
  function setActive(id) {
    const from = activeId;
    activeId = id;
    writeTabCompany(id);
    lastWrite = recordLastCompany(id);
    if (from !== id) emit('mktforge:company-switched', { from, to: id });
    return lastWrite;
  }

  /* The switch itself never waits on the "last company" write. A caller
     about to reload the page waits for it here, so the next sign-in still
     opens the right company (at most `ms`). */
  function whenRecorded(ms = 3000) {
    let t;
    return Promise.race([lastWrite, new Promise((r) => { t = setTimeout(r, ms); })]).finally(() => clearTimeout(t));
  }

  async function switchCompany(id) {
    await start();
    if (id === activeId) return;
    if (!(await companyIsActive(id))) throw fail('company-gone', MESSAGES.gone);
    setActive(id);
  }

  /* Marks the company deleting and takes it off the account's lists in one
     transaction, then removes its data. The caller moves this tab to another
     company first. If the tab closes part-way, start() finishes the job at
     the next sign-in. */
  async function deleteCompany(id) {
    await retireCompany(id);
    await company(id)._purge();
    handles.delete(id);
  }

  /* Step one of a delete, the only part that must finish before the tab
     moves on: hidden, off the account's lists, and closed to further saves. */
  async function retireCompany(id) {
    if (isLocal()) {
      const r = rootRead();
      const ids = r.companyIds || {};
      if (!ids[id]) throw fail('company-gone', MESSAGES.gone);
      if (Object.keys(ids).length <= 1) throw fail('last-company', MESSAGES.last);
      delete ids[id];
      Object.keys(r.companyNames || {}).forEach((k) => { if (r.companyNames[k] === id) delete r.companyNames[k]; });
      if (r.companies && r.companies[id]) r.companies[id].status = 'deleting';
      if (r.lastCompanyId === id) delete r.lastCompanyId;
      rootWrite(r);
    } else {
      const d = await getDb();
      const uRef = userRef(d);
      const cRef = companiesRef(d).doc(id);
      const FV = firebase.firestore.FieldValue;
      await withTimeout(d.runTransaction(async (tx) => {
        const [us, cs] = [await tx.get(uRef), await tx.get(cRef)];
        const data = (us.exists && us.data()) || {};
        const ids = data.companyIds || {};
        if (!cs.exists || cs.data().status !== 'active' || !ids[id]) throw fail('company-gone', MESSAGES.gone);
        if (Object.keys(ids).length <= 1) throw fail('last-company', MESSAGES.last);
        const names = {};
        Object.entries(data.companyNames || {}).forEach(([k, v]) => { if (v === id) names[k] = FV.delete(); });
        const acct = { companyIds: { [id]: FV.delete() } };
        if (Object.keys(names).length) acct.companyNames = names;   // never an empty map (see saveProfile)
        if (data.lastCompanyId === id) acct.lastCompanyId = FV.delete();
        tx.set(uRef, acct, { merge: true });
        tx.update(cRef, { status: 'deleting', deletingAt: FV.serverTimestamp() });
      }), TIMEOUT_MS, 'Deleting the company');
    }
    handles.delete(id);
    notifyCompanies();
  }

  function purgeDeleted() { return resumeDeletes(); }

  async function resumeDeletes() {
    try {
      const pending = (await readCompanies()).filter((c) => c.status === 'deleting');
      for (const c of pending) {
        try { await company(c.id)._purge(); handles.delete(c.id); }
        catch (err) { console.warn('[Mktforge] could not finish removing a deleted company', err); }
      }
    } catch (err) {
      console.warn('[Mktforge] could not check for unfinished deletes', err);
    }
  }

  /* An account from before companies existed keeps its data on users/{uid}
     until the one-time migration moves it. Never paper over that with a new,
     empty company: the person would think their work was gone. */
  async function hasLegacyData() {
    if (isLocal()) return false;       // local legacy data is moved in place, below
    const d = await getDb();
    const snap = await withTimeout(userRef(d).get(), TIMEOUT_MS, 'Loading your account');
    const u = snap.exists ? snap.data() : {};
    if (u.profile || u.buildPositioning || u.pdfCounters) return true;
    const files = await withTimeout(userRef(d).collection('files').limit(1).get(), TIMEOUT_MS, 'Loading your account');
    if (!files.empty) return true;
    for (const sub of ['tracker', 'competitorLedger']) {
      const snap = await withTimeout(userRef(d).collection(sub).limit(1).get(), TIMEOUT_MS, 'Loading your account');
      if (!snap.empty) return true;
    }
    return false;
  }

  /* Preview mode only: fold a pre-companies local store into a first company. */
  function upgradeLocalStore() {
    const r = rootRead();
    if (r.companies && Object.keys(r.companies).length) return;
    const legacyKeys = ['profile', 'files', 'pdfCounters', 'positioningAnswers', 'tracker', 'competitorLedger'];
    if (!legacyKeys.some((k) => r[k] !== undefined)) return;
    const id = `c${Date.now().toString(36)}legacy`;
    const code = newCode(new Set());
    const c = { status: 'active', code, createdAt: Date.now() };
    legacyKeys.forEach((k) => { if (r[k] !== undefined) { c[k] = r[k]; delete r[k]; } });
    c.profile = cleanProfile(c.profile);
    c.name = c.profile.companyName;
    r.companies = { [id]: c };
    r.companyIds = { [id]: code };
    const key = nameKey(c.name);
    r.companyNames = key ? { [key]: id } : {};
    r.lastCompanyId = id;
    rootWrite(r);
  }

  async function lastCompanyOnAccount() {
    if (isLocal()) return rootRead().lastCompanyId || '';
    const d = await getDb();
    const snap = await readAccountDoc(d, 'Loading your account');   // see getAvatar
    return (snap.exists && snap.data().lastCompanyId) || '';
  }

  /* Picks this tab's company: the one it was on (a refresh), else the one the
     account used last, else the oldest. Creates the first company for a new
     account. Safe to call any number of times. */
  function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      if (isLocal()) upgradeLocalStore();
      let list = await listCompanies();
      if (!list.length) {
        if (await hasLegacyData()) throw fail('upgrade-pending', MESSAGES.upgrade);
        await createCompany({ onlyIfNone: true });
        list = await listCompanies();
        if (!list.length) throw new Error('Couldn’t set up your company. Refresh the page to try again.');
      }
      const ok = (id) => id && list.some((c) => c.id === id);
      let pick = readTabCompany();
      if (!ok(pick)) pick = await lastCompanyOnAccount().catch(() => '');
      if (!ok(pick)) pick = list.slice().sort((a, b) => a.createdAt - b.createdAt)[0].id;
      setActive(pick);
      resumeDeletes();                 // background: finishes any interrupted delete
      return pick;
    })().catch((err) => { startPromise = null; throw err; });
    return startPromise;
  }

  /* The account's last company is whichever tab was used most recently, so
     coming back to a tab counts, not just switching in it. (Writing on tab
     close isn't reliable.) */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && activeId) recordLastCompany(activeId);
  });

  /* A fixed handle for the company active right now. */
  async function scope() {
    await start();
    return company(activeId);
  }

  /* Top-level shortcuts: act on the active company at the moment of the
     call. Right for painting the screen; for anything that finishes later,
     take scope() at the start instead. */
  const onActive = (name) => async (...args) => (await scope())[name](...args);

  /* Listeners: modules subscribe once; they only hear about this tab's
     active company (see tellProfile / tellFiles). */
  function onProfile(fn) { profileListeners.add(fn); return () => profileListeners.delete(fn); }
  function onFiles(fn) { fileListeners.add(fn); return () => fileListeners.delete(fn); }

  /* Held text and anything else a tab keeps per company must not outlive a
     sign-out on a shared computer. auth.js calls this before leaving. */
  function clearTabState() {
    // Runs this tab had going are cut off by signing out: mark them so the
    // module says "This run was interrupted" on the way back in.
    try {
      const tab = sessionStorage.getItem('mktforge.tab');
      Object.keys(localStorage).filter((k) => k.startsWith('mktforge.run.')).forEach((k) => {
        const f = JSON.parse(localStorage.getItem(k) || 'null');
        if (f && tab && f.tab === tab) localStorage.setItem(k, JSON.stringify({ ...f, beat: 0 }));
      });
    } catch (e) { /* nothing to mark */ }
    try {
      Object.keys(sessionStorage).filter((k) => k.startsWith('mktforge.')).forEach((k) => sessionStorage.removeItem(k));
    } catch (e) { /* nothing to clear */ }
  }

  return {
    // companies
    start, scope, company, listCompanies, onCompanies, createCompany, switchCompany,
    deleteCompany, retireCompany, purgeDeleted, oldestCompanyId, whenRecorded, companyDisplayName, clearTabState, settle,
    get busy() { return busy(); },
    get activeCompanyId() { return activeId; },
    MAX_COMPANIES,
    // active company
    getProfile: onActive('getProfile'), saveProfile: onActive('saveProfile'), prefill: onActive('prefill'),
    savePdfDoc: onActive('savePdfDoc'), listFiles: onActive('listFiles'), openFile: onActive('openFile'),
    deleteFile: onActive('deleteFile'), renameFile: onActive('renameFile'), nameTaken: onActive('nameTaken'),
    readFile: onActive('readFile'), getFileDigest: onActive('getFileDigest'), setFileDigest: onActive('setFileDigest'),
    importFile: onActive('importFile'), getFileText: onActive('getFileText'),
    getPositioningAnswers: onActive('getPositioningAnswers'), savePositioningAnswers: onActive('savePositioningAnswers'),
    getTargetMessaging: onActive('getTargetMessaging'), saveTargetMessaging: onActive('saveTargetMessaging'),
    listTrackerBoxes: onActive('listTrackerBoxes'), saveTrackerBox: onActive('saveTrackerBox'),
    deleteTrackerBox: onActive('deleteTrackerBox'),
    getCompetitorLedger: onActive('getCompetitorLedger'), saveCompetitorLedger: onActive('saveCompetitorLedger'),
    deleteCompetitorLedger: onActive('deleteCompetitorLedger'),
    getTitleLedger: onActive('getTitleLedger'), saveTitleLedger: onActive('saveTitleLedger'),
    deleteTitleLedger: onActive('deleteTitleLedger'),
    onProfile, onFiles,
    // account
    getAvatar, saveAvatar, onAvatar,
    // pure helpers
    trackerId, trackerCompetitorId, trackerTitleId, competitorKey, isViewable,
    MAX_FILE_BYTES,
    get isLocal() { return isLocal(); },
    util: { normalizeUrl, isValidUrl, imageToAvatarDataUrl }
  };
})();

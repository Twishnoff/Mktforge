/* ==========================================================================
   Mktforge — research context
   Gathers the account's Imported Materials and Generated Materials into
   one payload every agent-backed module sends to its Worker:

     context: {
       imported:  [{ name, type, date, text? | digest?, match? }],   newest first
       generated: [{ name, moduleName, date, text? | digest?, match? }] newest first
     }

   Trust order the Workers apply (see research-context.js in each Worker):
     1. Imported Materials — the user's own files. Newer beats older.
     2. Generated Materials — earlier Mktforge reports. Newer beats older.
     3. Websites and web research.

   Budgets keep prompts (and Anthropic rate limits) in check. Files that
   mention the run's job title / competitor / company are sent in full
   first; everything else goes as a short summary made once per file by the
   Build Positioning Worker (/api/digest) and stored on the file.

   MktforgeResearch.build({ jobTitles, competitorHost, budget, data }, { onProgress })
     data: the company to read (MktforgeData.company(id)); defaults to the
     one active when build() is called, and stays that company throughout
     -> Promise<{ context, meta }>
   MktforgeResearch.summary(meta, { jobTitles })  -> one-line note for the page
   MktforgeResearch.BUDGETS.small | .large
   ========================================================================== */

window.MktforgeResearch = (() => {

  const BUDGETS = {
    // Worker calls that already run many web searches.
    small: { importedChars: 24000, importedFileChars: 12000, generatedChars: 16000,
             generatedFileChars: 8000, maxGeneratedFull: 3, digestChars: 1400, maxDigests: 24 },
    // Build Positioning, whose whole job is to reason over these.
    large: { importedChars: 48000, importedFileChars: 20000, generatedChars: 40000,
             generatedFileChars: 14000, maxGeneratedFull: 5, digestChars: 2200, maxDigests: 30 }
  };

  const Data = () => window.MktforgeData;

  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  // Second precision (UTC) so same-day files still sort; the Workers read it.
  const day = (ms) => (ms ? `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC` : 'unknown date');

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

  /* ---------- matching ---------- */

  function mentionsTitle(text, title) {
    const t = norm(title);
    return t.length > 1 && norm(text).includes(t);
  }

  function mentionsHost(text, host) {
    if (!host) return false;
    if (String(text).toLowerCase().includes(host)) return true;
    const root = host.split('.')[0];
    if (root.length < 4) return false;
    return new RegExp(`\\b${root.replace(/[-]/g, '[- ]?')}\\b`, 'i').test(text);
  }

  function digestMentions(d, titles, host) {
    const jt = ((d && d.job_titles) || []).map(norm);
    const comps = ((d && d.competitors) || []).map((c) => String(c).toLowerCase());
    const root = host ? host.split('.')[0].replace(/[^a-z0-9]/g, '') : '';
    return {
      title: titles.some((t) => jt.some((x) => x === t || x.includes(t) || t.includes(x))),
      competitor: !!host && comps.some((c) => c.includes(host) || (root.length >= 4 && c.replace(/[^a-z0-9]/g, '').includes(root)))
    };
  }

  /* ---------- summaries ---------- */

  const digestMem = new Map();    // fileId -> { digest, digestText }

  function digestUrl() {
    const c = window.MKTFORGE_CONFIG || {};
    return (c.research && c.research.DIGEST_URL)
      || (c.buildPositioning && c.buildPositioning.API_BASE_URL && `${c.buildPositioning.API_BASE_URL}/api/digest`) || '';
  }

  async function makeDigest(file, text) {
    const url = digestUrl();
    if (!url) throw new Error('No summary service configured.');
    const Kit = window.MktforgeKit;
    const noAccess = Kit.accessProblem();
    if (noAccess) throw Object.assign(new Error(noAccess), { code: 'access' });
    const token = window.MktforgeAuth && window.MktforgeAuth.getIdToken ? await window.MktforgeAuth.getIdToken() : null;
    if (!token) throw Object.assign(new Error(Kit.NO_ACCESS), { code: 'access' });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        fileName: `${file.name}${file.ext || ''}`,
        moduleName: file.source === 'imported' ? 'Imported by the user' : file.moduleName,
        text: text.slice(0, 60000)
      })
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload || payload.status === 'error') {
      const msg = payload && payload.message;
      const access = Kit.accessError(res.status, msg);
      throw Object.assign(new Error(access || msg || `Summary failed (${res.status}).`), { code: access ? 'access' : 'failed' });
    }
    return { v: 1, digest: payload.digest || {}, digestText: payload.digestText || '' };
  }

  async function digestFor(D, file, text) {
    if (digestMem.has(file.id)) return digestMem.get(file.id);
    let stored = null;
    try { stored = await D.getFileDigest(file.id); } catch (e) { /* make one */ }
    if (stored && stored.digestText) { digestMem.set(file.id, stored); return stored; }
    const value = await makeDigest(file, text);
    digestMem.set(file.id, value);
    D.setFileDigest(file.id, value).catch((err) => console.warn('[Mktforge] could not store summary', err));
    return value;
  }

  /* ---------- text cache ---------- */

  const textMem = new Map();      // fileId -> text

  async function textFor(D, file) {
    if (textMem.has(file.id)) return textMem.get(file.id);
    const t = await D.getFileText(file.id);
    textMem.set(file.id, t || '');
    return t || '';
  }

  if (window.MktforgeData) {
    window.MktforgeData.onFiles(() => { cache = null; });
  }

  /* ---------- build ---------- */

  let cache = null;               // { sig, value }

  async function build({ jobTitles = [], competitorHost = '', budget = BUDGETS.small, data = null } = {}, { onProgress = () => {} } = {}) {
    const D = data || await Data().scope();
    const titles = jobTitles.map(norm).filter(Boolean);
    const host = String(competitorHost || '').toLowerCase().replace(/^www\./, '');
    const files = await D.listFiles();
    const sig = JSON.stringify([D.companyId, files.map((f) => `${f.id}:${f.name}`), titles, host, budget]);
    if (cache && cache.sig === sig) return cache.value;

    if (!files.length) {
      const empty = { context: { imported: [], generated: [] }, meta: { total: 0, imported: 0, generated: 0, full: [], unreadable: [], titleReport: () => false } };
      cache = { sig, value: empty };
      return empty;
    }

    let done = 0;
    const say = (what) => onProgress(`${what} (${done} of ${files.length})…`);
    say('Reading your saved materials');
    const rows = await pool(files, 3, async (f) => {
      let text = '';
      let failed = false;
      try { text = await textFor(D, f); } catch (err) { failed = true; console.warn('[Mktforge] could not read', f.name, err); }
      done += 1;
      say('Reading your saved materials');
      return { f, text, failed,
               title: titles.some((t) => mentionsTitle(text, t)),
               competitor: mentionsHost(text, host) };
    });
    const readable = rows.filter((r) => r.text);

    // Decide who goes in full. Imported: relevant first, then newest.
    const byNewest = (a, b) => b.f.createdAt - a.f.createdAt;
    const relevance = (r) => Number(r.title) + Number(r.competitor);
    const imported = readable.filter((r) => r.f.source === 'imported')
      .sort((a, b) => relevance(b) - relevance(a) || byNewest(a, b));
    const generated = readable.filter((r) => r.f.source !== 'imported')
      .sort((a, b) => relevance(b) - relevance(a) || byNewest(a, b));

    // Long files go as summaries rather than being cut off part-way.
    let room = budget.importedChars;
    imported.forEach((r) => {
      if (r.text.length <= budget.importedFileChars && r.text.length <= room) {
        r.full = true; room -= r.text.length;
      }
    });
    room = budget.generatedChars;
    let fullCount = 0;
    generated.forEach((r) => {
      if (!relevance(r) || fullCount >= budget.maxGeneratedFull) return;
      const size = Math.min(r.text.length, budget.generatedFileChars);
      if (size <= room) { r.full = true; room -= size; fullCount += 1; }
    });

    // Summaries for the rest (imported first, then newest generated).
    const needDigest = [...imported, ...generated.sort(byNewest)].filter((r) => !r.full).slice(0, budget.maxDigests);
    done = 0;
    let accessError = null;
    if (needDigest.length) say('Summarizing saved materials');
    await pool(needDigest, 3, async (r) => {
      if (accessError) return;
      try {
        r.digest = await digestFor(D, r.f, r.text);
        if (!r.title && !r.competitor) {
          const m = digestMentions(r.digest.digest, titles, host);
          r.title = m.title; r.competitor = m.competitor;
        }
      } catch (err) {
        if (err.code === 'access') accessError = err;
        console.warn('[Mktforge] could not summarize', r.f.name, err);
      }
      done += 1;
      say('Summarizing saved materials');
    });
    if (accessError) throw accessError;

    const entry = (r) => {
      const e = {
        name: `${r.f.name}${r.f.ext || (r.f.source === 'imported' ? '' : '.pdf')}`,
        date: day(r.f.createdAt),
        match: [r.title && 'job title', r.competitor && 'competitor'].filter(Boolean).join(' and ')
      };
      if (r.f.source === 'imported') e.type = (window.MktforgeExtract && window.MktforgeExtract.LABELS[r.f.kind]) || 'File';
      else e.moduleName = r.f.moduleName || '';
      if (r.full) e.text = r.text.slice(0, r.f.source === 'imported' ? budget.importedFileChars : budget.generatedFileChars);
      else if (r.digest && r.digest.digestText) e.digest = r.digest.digestText.slice(0, budget.digestChars);
      return (e.text || e.digest) ? e : null;
    };

    const context = {
      imported: imported.sort(byNewest).map(entry).filter(Boolean),
      generated: generated.sort(byNewest).map(entry).filter(Boolean)
    };
    const meta = {
      total: files.length,
      imported: context.imported.length,
      generated: context.generated.length,
      full: [...imported, ...generated].filter((r) => r.full).map((r) => r.f.name),
      titleReport: (moduleId) => generated.some((r) => r.title && r.f.moduleId === moduleId),
      unreadable: rows.filter((r) => !r.text).map((r) => r.f.name)
    };
    const value = { context, meta };
    cache = { sig, value };
    return value;
  }

  function summary(meta) {
    if (!meta.total) return 'No saved materials yet — using websites and web research only.';
    const parts = [];
    if (meta.imported) parts.push(`${meta.imported} imported file${meta.imported === 1 ? '' : 's'} (trusted first)`);
    if (meta.generated) parts.push(`${meta.generated} generated report${meta.generated === 1 ? '' : 's'}`);
    let s = parts.length ? `Using ${parts.join(' and ')}.` : 'None of your saved materials had readable text.';
    if (meta.unreadable.length) s += ` ${meta.unreadable.length} couldn’t be read.`;
    return s;
  }

  return { build, summary, BUDGETS };
})();

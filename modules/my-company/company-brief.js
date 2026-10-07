/* ==========================================================================
   Mktforge — Company Brief (My Company)
   The "Generate Company Brief" button: gathers the company's generated
   Mktforge PDFs, asks the company-brief Worker to apply the brief rules, then
   renders and saves the PDF in the browser.

     MktforgeCompanyBrief.generate({ cid, button, say }) -> Promise<{id,name}|null>

   Only the modules the brief reads from are sent. The text of each PDF comes
   from Firestore (files/{id}/text) via getFileText(), which extracts and
   caches it the first time a generated PDF is read. The Worker never touches
   Firestore itself — same pattern as every other module.
   ========================================================================== */
window.MktforgeCompanyBrief = (() => {

  const MODULES = ['find-my-customer', 'battle-card-generator', 'marketing-opportunities', 'build-positioning', 'draft-messaging'];
  const JSPDF_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  const PDF_SRC = 'modules/my-company/company-brief-pdf.js';

  const cfg = () => (window.MKTFORGE_CONFIG && window.MKTFORGE_CONFIG.companyBrief) || {};
  const Data = () => window.MktforgeData;

  function today() {
    const d = new Date();
    return `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}.${d.getFullYear()}`;
  }

  /** Read the text of every relevant generated PDF, a few at a time. */
  async function gatherFiles(D, say) {
    const all = await D.listFiles();
    const wanted = all.filter((f) => f.source !== 'imported' && MODULES.includes(f.moduleId));
    const out = [];
    let done = 0;
    const queue = wanted.slice();
    async function worker() {
      while (queue.length) {
        const f = queue.shift();
        try {
          const text = await D.getFileText(f.id);
          if (text && text.trim()) out.push({ id: f.id, name: f.name, moduleId: f.moduleId, createdAt: f.createdAt || 0, text });
        } catch (err) {
          console.warn('[company-brief] could not read', f.name, err);
        }
        done += 1;
        say(`Reading your Mktforge files… (${done}/${wanted.length})`);
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    return out;
  }

  async function callWorker({ profile, files, signal }) {
    const base = (cfg().API_BASE_URL || '').replace(/\/+$/, '');
    if (!base) throw new Error('The Company Brief service is not configured.');
    const headers = { 'Content-Type': 'application/json' };
    const token = await window.MktforgeAuth.getIdToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}/api/brief`, {
      method: 'POST', headers, signal,
      body: JSON.stringify({ profile, files, today: today() }),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload || payload.status === 'error') {
      const message = payload && payload.message;
      throw new Error(window.MktforgeKit.accessError(res.status, message) || message || 'Something went wrong. Please try again.');
    }
    return payload;
  }

  /**
   * Run the whole flow for company `cid`. `say(text)` reports progress;
   * resolves to savePdfDoc's result. Throws with a user-facing message.
   */
  async function generate({ cid, say = () => {}, signal } = {}) {
    const problem = window.MktforgeKit.accessProblem();
    if (problem) throw new Error(problem);
    const D = Data().company(cid);                     // pinned: a company switch mid-run must not save into the new one
    const profile = await D.getProfile();
    if (!profile.companyUrl) throw new Error('Add a Company URL before generating a brief.');

    say('Reading your Mktforge files…');
    const files = await gatherFiles(D, say);
    if (!files.some((f) => f.moduleId === 'find-my-customer')) {
      throw new Error('Run Find My Customer first — the Company Brief is built from its latest results.');
    }

    say('Assembling the brief…');
    const { brief, notes } = await callWorker({ profile, files, signal });
    if (notes && notes.length) console.info('[company-brief] notes:', notes);

    say('Building the PDF…');
    await Mktforge.loadScript(JSPDF_SRC);
    await Mktforge.loadScript(PDF_SRC);
    if (Data().activeCompanyId !== cid) {
      // The user switched companies while we worked; the PDF belongs to the
      // original company, so save there quietly instead of downloading.
      return window.MktforgeCompanyBriefPdf.build(brief, { data: D });
    }
    return window.MktforgeCompanyBriefPdf.build(brief, { data: D });
  }

  return { generate, MODULES };
})();

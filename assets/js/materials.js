/* ==========================================================================
   Mktforge — saved materials: names, inputs, the document model and stamps

   Shared by data.js (naming and storing), every module's PDF export (which
   also hands over a document model so the file can be re-rendered as Word)
   and My Company (which shows all of it).

   INPUTS
   Every generated file carries the inputs it was made from, in the same
   normalized shape MktBOT writes for Slack-made files (mktforge-slack
   src/reuse.js inputsFor()), so Slack's "reuse before regenerate" matches
   app-made files exactly instead of parsing the PDF header. The `display`
   sub-object keeps the user's own spelling for the file name and the table.

     battle-card-generator  { jobTitle, competitorHost, industry,
                              display: { jobTitle, competitor, industry } }
     persona-builder        { jobTitle, industry, companySize,
                              display: { jobTitle, industry } }
     marketing-opportunities{ jobTitles[], industry, display: { jobTitles[], industry } }
     find-my-customer       { display: { company } }
     build-positioning      { display: { champion, competitor, industry } }
     draft-messaging        { display: { champion, competitor, industry } }
     company-brief          { display: { company } }

   DOCUMENT MODEL  (stored as JSON on the file as `result`, version 1)
   A layout-free description of what the PDF shows, rendered to Word by
   docx-export.js and, later, editable in the app.

     { v: 1, moduleId, title, subtitle?, meta: [{ label, value }], note?,
       style: 'cards' | 'report', orientation: 'landscape' | 'portrait',
       sections: [ Section | { row: [Section, ...] } ],
       footer?: string }
     Section = { title, stage?, blocks: [Block] }
     Block   = { t: 'p', text, bold?, url?, color?: 'accent'|'soft'|'red', size?: 'sm'|'lg', indent? }
             | { t: 'label', text }
             | { t: 'list', items: [string | { text, url? }], style?: 'bullet'|'number'|'letter' }
             | { t: 'table', head: [string], rows: [[string | { text, url? }]] }
             | { t: 'qa', q, a }

   STAMP
   A Word export carries custom document properties naming the Mktforge
   file it came from, plus a one-line footer "Mktforge ref MF-…" that
   survives any text-based round trip (Google Docs drops the properties).
   extract.js reads both on import so the edited copy can be tied back to
   its original (derivedFrom).
   ========================================================================== */

window.MktforgeMaterials = (() => {

  const MODULE_NAMES = {
    'battle-card-generator': 'Battle Card Generator',
    'persona-builder': 'Persona Builder',
    'marketing-opportunities': 'Marketing Opportunities',
    'find-my-customer': 'Find My Customer',
    'build-positioning': 'Build Positioning',
    'draft-messaging': 'Draft Messaging',
    'company-brief': 'Company Brief',
    'target-messaging': 'Target Messaging',
    'market-tracker': 'Market Tracker'
  };

  /* Short labels for file names and the module filter chips. */
  const SHORT_NAMES = {
    'battle-card-generator': 'Battle Card',
    'persona-builder': 'Persona',
    'marketing-opportunities': 'Marketing Opps',
    'find-my-customer': 'Find My Customer',
    'build-positioning': 'Positioning',
    'draft-messaging': 'Messaging',
    'company-brief': 'Company Brief',
    'target-messaging': 'Target Messaging'
  };

  const normTitle = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const normIndustry = (s) => {
    const v = normTitle(s);
    return ['', 'unspecified', 'n/a', 'not specified', 'none', 'no preference', 'any'].includes(v) ? '' : v;
  };
  function hostOf(url) {
    let s = String(url || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    try { return new URL(s).hostname.replace(/^www\./, '').toLowerCase(); }
    catch (e) { return String(url || '').toLowerCase(); }
  }
  const clean = (s) => String(s == null ? '' : s).trim();

  /* Builds the stored `inputs` for a module from what the page knows. Pass
     the user's own values; normalization happens here. */
  function inputsFor(moduleId, raw = {}) {
    const r = raw || {};
    switch (moduleId) {
      case 'battle-card-generator':
        return {
          jobTitle: normTitle(r.jobTitle), competitorHost: hostOf(r.competitorUrl), industry: normIndustry(r.industry),
          display: { jobTitle: clean(r.jobTitle), competitor: clean(r.competitorName) || hostOf(r.competitorUrl), industry: clean(r.industry) }
        };
      case 'persona-builder':
        return {
          jobTitle: normTitle(r.jobTitle), industry: normIndustry(r.industry), companySize: normTitle(r.companySize || 'No Preference'),
          display: { jobTitle: clean(r.jobTitle), industry: clean(r.industry), companySize: clean(r.companySize) }
        };
      case 'marketing-opportunities': {
        const titles = (r.jobTitles || []).map(clean).filter(Boolean);
        return {
          jobTitles: titles.map(normTitle).filter(Boolean).sort(), industry: normIndustry(r.industry),
          display: { jobTitles: titles, industry: clean(r.industry) }
        };
      }
      case 'find-my-customer':
        return { display: { company: clean(r.companyName) || hostOf(r.companyUrl), companyHost: hostOf(r.companyUrl) } };
      case 'build-positioning':
      case 'draft-messaging':
        return {
          display: { champion: clean(r.champion), competitor: clean(r.competitorName) || hostOf(r.competitorUrl),
                     competitorHost: hostOf(r.competitorUrl), industry: clean(r.industry) }
        };
      case 'company-brief':
        return { display: { company: clean(r.companyName) || hostOf(r.companyUrl) } };
      default:
        return { display: {} };
    }
  }

  /* The file name a generated document gets. Same rules as mktforge-slack's
     nameFor() so files look alike whichever side made them. */
  function nameFor(moduleId, inputs) {
    const d = (inputs && inputs.display) || {};
    const short = SHORT_NAMES[moduleId] || MODULE_NAMES[moduleId] || 'Document';
    const dash = ' — ';
    let tail = '';
    switch (moduleId) {
      case 'battle-card-generator':
        tail = [d.jobTitle, d.competitor].filter(Boolean).join(' vs ');
        break;
      case 'persona-builder':
        tail = [d.jobTitle, d.industry].filter(Boolean).join(' · ');
        break;
      case 'marketing-opportunities': {
        const t = d.jobTitles || [];
        tail = t.length <= 2 ? t.join(', ') : `${t.slice(0, 2).join(', ')} +${t.length - 2} more`;
        if (d.industry) tail = tail ? `${tail} · ${d.industry}` : d.industry;
        break;
      }
      case 'find-my-customer':
      case 'company-brief':
        tail = d.company || '';
        break;
      case 'build-positioning':
      case 'draft-messaging':
        tail = [d.champion, d.competitor].filter(Boolean).join(' vs ');
        break;
      default:
        tail = '';
    }
    const name = tail ? `${short}${dash}${tail}` : short;
    return name.replace(/[\\/:*?"<>|]/g, '').slice(0, 200);
  }

  /* One line describing a file's inputs for the Saved Resources table. */
  function inputsSummary(moduleId, inputs) {
    const d = (inputs && inputs.display) || {};
    switch (moduleId) {
      case 'battle-card-generator': return [d.jobTitle, d.competitor, d.industry].filter(Boolean).join(' · ');
      case 'persona-builder': return [d.jobTitle, d.industry, d.companySize && d.companySize !== 'No Preference' ? d.companySize : ''].filter(Boolean).join(' · ');
      case 'marketing-opportunities': {
        const t = d.jobTitles || [];
        const titles = t.length > 2 ? `${t.length} titles` : t.join(', ');
        return [titles, d.industry].filter(Boolean).join(' · ');
      }
      case 'find-my-customer':
      case 'company-brief': return d.company || '';
      case 'build-positioning':
      case 'draft-messaging': return [d.champion, d.competitor, d.industry].filter(Boolean).join(' · ');
      default: return '';
    }
  }

  /* ---------- stamp ---------- */

  const STAMP_PREFIX = 'mktforge.';
  const REF_RE = /Mktforge ref (MF-[A-Z0-9]{4,8})/i;

  /* Short, human-readable reference printed in the Word footer: the first
     characters of the file id, upper-cased. Unique enough per company. */
  function refFor(fileId) {
    return `MF-${String(fileId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase()}`;
  }

  /* The custom document properties a Word export carries. */
  function stampProperties({ fileId, companyId, moduleId, inputs, createdAt }) {
    const props = [
      ['fileId', fileId], ['companyId', companyId], ['moduleId', moduleId],
      ['ref', refFor(fileId)], ['exportedAt', new Date().toISOString()],
      ['createdAt', createdAt ? new Date(createdAt).toISOString() : '']
    ];
    if (inputs) {
      try { props.push(['inputs', JSON.stringify(inputs).slice(0, 2000)]); } catch (e) { /* skip */ }
    }
    return props.filter(([, v]) => v != null && v !== '').map(([k, v]) => ({ name: `${STAMP_PREFIX}${k}`, value: String(v) }));
  }

  /* Turns the properties read back from a docx (name -> value) into a
     stamp object, or null when the file wasn't exported from Mktforge. */
  function stampFromProperties(map) {
    if (!map) return null;
    const get = (k) => map[`${STAMP_PREFIX}${k}`];
    if (!get('fileId')) return null;
    let inputs = null;
    try { inputs = get('inputs') ? JSON.parse(get('inputs')) : null; } catch (e) { inputs = null; }
    return { fileId: get('fileId'), companyId: get('companyId') || '', moduleId: get('moduleId') || '',
             ref: get('ref') || refFor(get('fileId')), inputs, via: 'properties' };
  }

  /* Fallback when the properties were lost: the footer line in the text. */
  function stampFromText(text) {
    const m = REF_RE.exec(String(text || ''));
    return m ? { fileId: null, companyId: '', moduleId: '', ref: m[1].toUpperCase(), inputs: null, via: 'text' } : null;
  }

  /* ---------- building a document model ---------- */

  /* Starts a model. The PDF builders call this and feed it the same
     content they draw, so the Word export always matches the PDF. */
  function model({ moduleId, title, subtitle = '', meta = [], note = '', style = 'cards', orientation = 'landscape', footer = '' }) {
    return { v: 1, moduleId, title: clean(title), subtitle: clean(subtitle), meta: meta.filter((m) => m && m.label),
             note: clean(note), style, orientation, footer: footer || MODULE_NAMES[moduleId] || 'Mktforge', sections: [] };
  }

  /* The box-style PDFs (Battle Card, Persona) draw from line lists of
     { text, bold, url, colorRgb }. Bold lines are labels; the rest are
     paragraphs, keeping links and the red "Where We Compete" tag. */
  function blocksFromLines(lines) {
    const out = [];
    (lines || []).forEach((ln) => {
      const text = clean(ln.text);
      if (!text) return;
      const red = Array.isArray(ln.colorRgb) && ln.colorRgb[0] > 180 && ln.colorRgb[1] < 100;
      if (ln.bold && !ln.url && !red) out.push({ t: 'label', text });
      else if (red) out.push({ t: 'p', text, bold: true, color: 'red' });
      else out.push({ t: 'p', text, url: ln.url || undefined });
    });
    return out;
  }

  /* A recorder for the report-style PDFs (Build Positioning, Draft
     Messaging): the builder's heading/label/text/bullets primitives call
     these as they draw. Blocks drawn before the first heading (the title
     block) are not recorded — the Word header carries title and meta. */
  function recorder(base) {
    const m = model(base);
    let cur = null;
    const push = (b) => { if (cur) cur.blocks.push(b); };
    const sizeOf = (n) => (n >= 15 ? 'lg' : n <= 9 ? 'sm' : undefined);
    return {
      heading(title, stage) { cur = { title: clean(title), stage: clean(stage), blocks: [] }; m.sections.push(cur); },
      subheading(text) { if (clean(text)) push({ t: 'p', text: clean(text), bold: true, size: 'lg' }); },
      label(text) { if (clean(text)) push({ t: 'label', text: clean(text) }); },
      text(text, { bold = false, color, size, indent = 0 } = {}) {
        const s = clean(text);
        if (!s) return;
        const b = { t: 'p', text: s };
        if (bold) b.bold = true;
        if (color) b.color = color;
        if (sizeOf(size)) b.size = sizeOf(size);
        if (indent) b.indent = true;
        push(b);
      },
      bullets(items, { numbered = false, prefix = '' } = {}) {
        const it = (items || []).filter(Boolean).map((x) => `${prefix}${x}`);
        if (it.length) push({ t: 'list', items: it, style: numbered ? 'number' : 'bullet' });
      },
      list(items, style = 'bullet') { if ((items || []).length) push({ t: 'list', items, style }); },
      table(head, rows) { push({ t: 'table', head, rows }); },
      qa(q, a) { push({ t: 'qa', q: clean(q), a: clean(a) }); },
      model: () => m
    };
  }

  return { MODULE_NAMES, SHORT_NAMES, normTitle, normIndustry, hostOf, inputsFor, nameFor, inputsSummary,
           refFor, stampProperties, stampFromProperties, stampFromText, STAMP_PREFIX,
           model, blocksFromLines, recorder };
})();

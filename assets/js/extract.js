/* ==========================================================================
   Mktforge — text extraction
   Turns a file into plain text in the browser, so agents can read it.
   Libraries load from cdnjs on first use only.

     MktforgeExtract.supported(name, type)  -> kind or null
     MktforgeExtract.text(blob, { name, type }) -> Promise<{ text, kind, pages?, truncated }>
     MktforgeExtract.ACCEPT                 -> value for <input accept>
     MktforgeExtract.LABELS[kind]           -> "Word", "PowerPoint", …

   Supported: PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), CSV/TSV,
   plain text, Markdown, JSON, HTML/XML. Old binary Office files (.doc,
   .ppt, .xls) are refused with a message saying to re-save them.
   Office files are zip archives of XML, so JSZip + DOMParser is enough —
   no Office-specific library.
   ========================================================================== */

window.MktforgeExtract = (() => {

  const PDFJS_VERSION = '3.11.174';
  const PDFJS_SRC = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`;
  const PDFJS_WORKER_SRC = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;
  const JSZIP_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

  const MAX_PDF_PAGES = 150;
  const MAX_TEXT_CHARS = 1500000;

  const EXT_KIND = {
    pdf: 'pdf',
    docx: 'docx', docm: 'docx',
    pptx: 'pptx', pptm: 'pptx',
    xlsx: 'xlsx', xlsm: 'xlsx',
    csv: 'csv', tsv: 'csv',
    txt: 'text', text: 'text', log: 'text', rtf: 'text',
    md: 'markdown', markdown: 'markdown',
    json: 'json',
    html: 'html', htm: 'html', xml: 'html'
  };

  const LEGACY = { doc: 'Word', ppt: 'PowerPoint', xls: 'Excel' };

  const LABELS = {
    pdf: 'PDF', docx: 'Word', pptx: 'PowerPoint', xlsx: 'Excel',
    csv: 'CSV', text: 'Text', markdown: 'Markdown', json: 'JSON', html: 'HTML'
  };

  const ACCEPT = Object.keys(EXT_KIND).map((e) => `.${e}`).join(',');

  const extOf = (name) => {
    const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  };

  function supported(name, type) {
    const ext = extOf(name);
    if (EXT_KIND[ext]) return EXT_KIND[ext];
    if (type === 'application/pdf') return 'pdf';
    if (/^text\//.test(type || '')) return 'text';
    return null;
  }

  function unsupportedReason(name) {
    const ext = extOf(name);
    if (LEGACY[ext]) return `Old .${ext} files can’t be read. Open it in ${LEGACY[ext]} and save it as .${ext}x, then import that.`;
    return `.${ext || 'unknown'} files aren’t supported. Use PDF, Word, PowerPoint, Excel, CSV or text files.`;
  }

  const tidy = (s) => String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \u00A0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  /* ---------- PDF ---------- */

  let pdfjs = null;
  function loadPdfJs() {
    if (pdfjs) return pdfjs;
    pdfjs = Mktforge.loadScript(PDFJS_SRC).then(() => {
      const lib = window.pdfjsLib;
      if (!lib) throw new Error('The PDF reader failed to load.');
      // pdf.js wraps a cross-origin worker URL itself and falls back to the
      // main thread if the worker can't start.
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
      return lib;
    }).catch((err) => { pdfjs = null; throw err; });
    return pdfjs;
  }

  /* A PDF's links are annotations, not text, so getTextContent() never sees
     them. Mktforge's own reports lean on that: Marketing Opportunities prints
     "Visit Site" in its link column and Persona Builder prints "Name (type)",
     with the actual address attached as a clickable rectangle. Extract them
     here and write them out beside the row they belong to, or a report's
     entire list of sites is invisible to anything reading the file. */
  async function pageLinks(page, content) {
    let annots = [];
    try { annots = await page.getAnnotations(); } catch (err) { return []; }
    const items = content.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({
        str: it.str.trim(),
        x: it.transform[4],
        y: it.transform[5],
        h: it.height || 10,
      }));
    const seen = new Set();
    const out = [];
    annots.forEach((a) => {
      const url = a && (a.url || a.unsafeUrl);
      if (!url || !/^https?:\/\//i.test(url) || !Array.isArray(a.rect)) return;
      if (seen.has(url)) return;
      seen.add(url);
      const top = Math.max(a.rect[1], a.rect[3]);
      const bottom = Math.min(a.rect[1], a.rect[3]);
      /* Whatever sits on the same line as the link is its label — for a table
         that is the whole row, which is what makes "The New Stack" and its
         address land together. */
      const label = items
        .filter((it) => it.y + it.h >= bottom - 2 && it.y <= top + 2)
        .sort((p1, p2) => p1.x - p2.x)
        .map((it) => it.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .replace(/\s*(Visit Site|N\/A)\s*/gi, ' ')
        .trim();
      out.push(label ? `${label} — ${url}` : url);
    });
    return out;
  }

  async function fromPdf(blob) {
    const lib = await loadPdfJs();
    const pdf = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    const pages = [];
    try {
      const n = Math.min(pdf.numPages, MAX_PDF_PAGES);
      for (let i = 1; i <= n; i += 1) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const text = content.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('');
        const links = await pageLinks(page, content);
        pages.push(links.length ? `${text}\n\nLINKS ON THIS PAGE\n${links.join('\n')}` : text);
      }
      return { text: pages.join('\n\n'), pages: pdf.numPages, truncated: pdf.numPages > MAX_PDF_PAGES };
    } finally {
      pdf.destroy();
    }
  }

  /* ---------- Office (zip + XML) ---------- */

  let jszip = null;
  function loadZip() {
    if (jszip) return jszip;
    jszip = Mktforge.loadScript(JSZIP_SRC).then(() => {
      if (!window.JSZip) throw new Error('The Office file reader failed to load.');
      return window.JSZip;
    }).catch((err) => { jszip = null; throw err; });
    return jszip;
  }

  const parseXml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const byLocal = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
  const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true });

  // Paragraph-aware text from WordprocessingML / DrawingML.
  function paragraphs(doc, pTag, tTag, extra = {}) {
    return byLocal(doc, pTag).map((p) => {
      let out = '';
      const walk = (node) => {
        node.childNodes.forEach((c) => {
          if (c.nodeType !== 1) return;
          const ln = c.localName;
          if (ln === tTag) out += c.textContent;
          else if (ln === 'tab') out += '\t';
          else if (ln === 'br' || ln === 'cr') out += '\n';
          else if (ln === pTag) return;          // nested paragraphs are handled on their own
          else if (!extra.skip || !extra.skip.includes(ln)) walk(c);
        });
      };
      walk(p);
      return out;
    }).filter((t) => t.trim()).join('\n');
  }

  async function fromDocx(blob) {
    const JSZip = await loadZip();
    const zip = await JSZip.loadAsync(blob);
    const parts = ['word/document.xml'];
    Object.keys(zip.files).filter((f) => /^word\/(header|footer|footnotes|endnotes)\d*\.xml$/.test(f)).sort(naturalSort)
      .forEach((f) => parts.push(f));
    const texts = [];
    for (const f of parts) {
      const file = zip.file(f);
      if (!file) continue;
      const t = paragraphs(parseXml(await file.async('string')), 'p', 't', { skip: ['instrText', 'delText'] });
      if (t) texts.push(t);
    }
    if (!zip.file('word/document.xml')) throw new Error('This doesn’t look like a Word document.');
    return { text: texts.join('\n\n') };
  }

  async function fromPptx(blob) {
    const JSZip = await loadZip();
    const zip = await JSZip.loadAsync(blob);
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort(naturalSort);
    if (!slides.length) throw new Error('No slides found in this presentation.');
    const out = [];
    for (let i = 0; i < slides.length; i += 1) {
      const body = paragraphs(parseXml(await zip.file(slides[i]).async('string')), 'p', 't');
      const noteName = slides[i].replace('slides/slide', 'notesSlides/notesSlide');
      const noteFile = zip.file(noteName);
      const notes = noteFile ? paragraphs(parseXml(await noteFile.async('string')), 'p', 't') : '';
      const cleanNotes = notes.replace(/^\d+$/gm, '').trim();   // notes pages repeat the slide number
      out.push(`Slide ${i + 1}\n${body}${cleanNotes ? `\nSpeaker notes: ${cleanNotes}` : ''}`);
    }
    return { text: out.join('\n\n'), pages: slides.length };
  }

  function colIndex(ref) {
    const letters = (/^[A-Z]+/.exec(ref || '') || [''])[0];
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  async function fromXlsx(blob) {
    const JSZip = await loadZip();
    const zip = await JSZip.loadAsync(blob);
    const shared = [];
    const ss = zip.file('xl/sharedStrings.xml');
    if (ss) {
      byLocal(parseXml(await ss.async('string')), 'si').forEach((si) => {
        shared.push(byLocal(si, 't').map((t) => t.textContent).join(''));
      });
    }
    // Sheet names, in workbook order.
    const names = {};
    const wb = zip.file('xl/workbook.xml');
    const rels = zip.file('xl/_rels/workbook.xml.rels');
    if (wb && rels) {
      const relMap = {};
      byLocal(parseXml(await rels.async('string')), 'Relationship').forEach((r) => {
        relMap[r.getAttribute('Id')] = `xl/${r.getAttribute('Target').replace(/^\/?xl\//, '')}`;
      });
      byLocal(parseXml(await wb.async('string')), 'sheet').forEach((s) => {
        const rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
        if (relMap[rid]) names[relMap[rid]] = s.getAttribute('name');
      });
    }
    const sheets = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort(naturalSort);
    const out = [];
    for (const f of sheets) {
      const doc = parseXml(await zip.file(f).async('string'));
      const rows = byLocal(doc, 'row').map((row) => {
        const cells = [];
        byLocal(row, 'c').forEach((c) => {
          const t = c.getAttribute('t');
          const v = byLocal(c, 'v')[0];
          let val = '';
          if (t === 's' && v) val = shared[Number(v.textContent)] || '';
          else if (t === 'inlineStr') val = byLocal(c, 't').map((x) => x.textContent).join('');
          else if (v) val = v.textContent;
          const idx = colIndex(c.getAttribute('r'));
          cells[idx >= 0 ? idx : cells.length] = val.replace(/\s+/g, ' ').trim();
        });
        return Array.from(cells, (x) => x || '').join('\t').replace(/\t+$/, '');
      }).filter((r) => r.trim());
      if (rows.length) out.push(`Sheet: ${names[f] || f.replace(/^.*\//, '').replace('.xml', '')}\n${rows.join('\n')}`);
    }
    return { text: out.join('\n\n'), pages: sheets.length };
  }

  /* ---------- text-like ---------- */

  async function fromText(blob, kind) {
    let s = await blob.text();
    if (kind === 'html') {
      const doc = new DOMParser().parseFromString(s, /\.xml$/i.test(blob.name || '') ? 'application/xml' : 'text/html');
      doc.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
      s = (doc.body || doc.documentElement).textContent;
    } else if (kind === 'text' && /^\{\\rtf/.test(s)) {
      s = s.replace(/\\par[d]?/g, '\n').replace(/\{\*?\\[^{}]+}|[{}]|\\\S+\s?/g, '');
    }
    return { text: s };
  }

  /* ---------- entry point ---------- */

  async function text(blob, { name = '', type = '' } = {}) {
    const kind = supported(name, type || blob.type);
    if (!kind) throw Object.assign(new Error(unsupportedReason(name)), { code: 'unsupported' });
    let res;
    try {
      if (kind === 'pdf') res = await fromPdf(blob);
      else if (kind === 'docx') res = await fromDocx(blob);
      else if (kind === 'pptx') res = await fromPptx(blob);
      else if (kind === 'xlsx') res = await fromXlsx(blob);
      else res = await fromText(blob, kind);
    } catch (err) {
      if (err && err.code) throw err;
      console.warn('[Mktforge] could not read', name, err);
      throw Object.assign(new Error(err && /reader failed|look like|No slides/.test(err.message)
        ? err.message : `Couldn’t read this ${LABELS[kind]} file. It may be damaged or password-protected.`), { code: 'unreadable' });
    }
    let t = tidy(res.text);
    let truncated = !!res.truncated;
    if (t.length > MAX_TEXT_CHARS) { t = t.slice(0, MAX_TEXT_CHARS); truncated = true; }
    return { text: t, kind, pages: res.pages || null, truncated };
  }

  return { text, supported, unsupportedReason, ACCEPT, LABELS, extOf };
})();

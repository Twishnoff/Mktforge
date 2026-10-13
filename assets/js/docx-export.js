/* ==========================================================================
   Mktforge — Word (.docx) export
   Renders a saved file's document model (materials.js) as an editable Word
   document: every section is a bordered table cell, so text reflows inside
   its box as the reader edits. Loaded on demand from My Company's Download
   menu; the docx library (assets/vendor, MIT) loads with it.

     await MktforgeDocx.download(docModel, { fileId, companyId, moduleId, inputs, createdAt, fileName })

   The file is stamped (custom document properties + a "Mktforge ref MF-…"
   footer line) so that, imported back, it is tied to the file it came from.
   ========================================================================== */

window.MktforgeDocx = (() => {

  const LIB_SRC = 'assets/vendor/docx-9.7.1.iife.js';
  const FONT = 'Arial';

  const COLORS = { ink: '1E1E1E', soft: '6B665C', accent: '2F6F4E', red: 'B23A2E', line: 'BFBFBF', shade: 'F7F9FC', rule: '1F3A5F' };
  const LETTER = { w: 12240, h: 15840 };           // DXA; 1440 = 1 inch
  const MARGIN = 720;

  let lib = null;
  function loadLib() {
    if (window.docx && window.docx.Document) return Promise.resolve(window.docx);
    if (lib) return lib;
    lib = window.Mktforge.loadScript(LIB_SRC).then(() => {
      if (!window.docx || !window.docx.Document) throw new Error('The Word export library failed to load.');
      return window.docx;
    }).catch((err) => { lib = null; throw err; });
    return lib;
  }

  const str = (v) => String(v == null ? '' : v);
  const cellText = (c) => (c && typeof c === 'object' ? str(c.text) : str(c));
  const cellUrl = (c) => (c && typeof c === 'object' && c.url ? String(c.url) : null);

  /* ---------- paragraph builders ---------- */

  function runs(D, text, { bold = false, italics = false, color = COLORS.ink, size = 18, url = null } = {}) {
    const t = str(text);
    if (url) {
      return [new D.ExternalHyperlink({
        link: url,
        children: [new D.TextRun({ text: t, font: FONT, size, bold, italics, color: COLORS.accent, underline: {} })]
      })];
    }
    return [new D.TextRun({ text: t, font: FONT, size, bold, italics, color })];
  }

  function para(D, text, opts = {}) {
    return new D.Paragraph({
      spacing: { after: opts.after == null ? 80 : opts.after, line: 264 },
      indent: opts.indent ? { left: opts.indent } : undefined,
      keepNext: !!opts.keepNext,
      children: runs(D, text, opts)
    });
  }

  function sectionTitle(D, text, stage) {
    const out = [];
    if (stage) out.push(para(D, String(stage).toUpperCase(), { size: 15, bold: true, color: COLORS.accent, after: 20, keepNext: true }));
    out.push(new D.Paragraph({
      spacing: { before: stage ? 0 : 60, after: 100 },
      keepNext: true,
      border: { bottom: { style: D.BorderStyle.SINGLE, size: 8, color: COLORS.rule, space: 2 } },
      children: [new D.TextRun({ text: str(text), font: FONT, size: 24, bold: true, color: COLORS.rule })]
    }));
    return out;
  }

  function blockToParagraphs(D, b, numbering) {
    const out = [];
    if (!b || typeof b !== 'object') return out;
    switch (b.t) {
      case 'label':
        out.push(para(D, b.text, { bold: true, size: 18, after: 40, keepNext: true }));
        break;
      case 'p': {
        const color = b.color === 'soft' ? COLORS.soft : b.color === 'red' ? COLORS.red : b.color === 'accent' ? COLORS.accent : COLORS.ink;
        const size = b.size === 'sm' ? 15 : b.size === 'lg' ? 22 : 17;
        out.push(para(D, b.text, { bold: !!b.bold, italics: !!b.italic, color, size, url: b.url || null,
                                   indent: b.indent ? 240 : 0, after: b.after == null ? 100 : b.after }));
        break;
      }
      case 'list': {
        const style = b.style === 'number' ? 'numbers' : b.style === 'letter' ? 'letters' : 'bullets';
        const ref = numbering.use(style);
        (b.items || []).forEach((it) => {
          out.push(new D.Paragraph({
            numbering: { reference: ref, level: 0 },
            spacing: { after: 60, line: 264 },
            children: runs(D, cellText(it), { size: 17, url: cellUrl(it) })
          }));
        });
        out.push(new D.Paragraph({ spacing: { after: 40 }, children: [] }));
        break;
      }
      case 'qa':
        out.push(new D.Paragraph({
          spacing: { after: 40 }, keepNext: true,
          children: [...runs(D, 'Q: ', { bold: true, size: 18, color: COLORS.rule }), ...runs(D, b.q, { bold: true, size: 18 })]
        }));
        out.push(new D.Paragraph({
          spacing: { after: 160, line: 264 },
          children: [...runs(D, 'A: ', { bold: true, size: 17 }), ...runs(D, b.a, { size: 17 })]
        }));
        break;
      case 'table':
        out.push(dataTable(D, b));
        out.push(new D.Paragraph({ spacing: { after: 60 }, children: [] }));
        break;
      default:
        if (b.text) out.push(para(D, b.text));
    }
    return out;
  }

  /* A real table (Find My Customer, Marketing Opportunities). Widths are
     equal shares of the box; Word lets the reader resize them. */
  function dataTable(D, b, totalWidth = 9600) {
    const head = Array.isArray(b.head) ? b.head : [];
    const rows = Array.isArray(b.rows) ? b.rows : [];
    const cols = Math.max(1, head.length || (rows[0] ? rows[0].length : 1));
    const colW = Math.floor(totalWidth / cols);
    const thin = { style: D.BorderStyle.SINGLE, size: 4, color: COLORS.line };
    const borders = { top: thin, bottom: thin, left: thin, right: thin };
    const cell = (c, { header = false } = {}) => new D.TableCell({
      width: { size: colW, type: D.WidthType.DXA },
      borders,
      shading: header ? { type: D.ShadingType.CLEAR, fill: COLORS.accent, color: 'auto' } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new D.Paragraph({
        spacing: { after: 0, line: 252 },
        children: runs(D, cellText(c), { bold: header, size: 16, color: header ? 'FFFFFF' : COLORS.ink, url: header ? null : cellUrl(c) })
      })]
    });
    const trs = [];
    if (head.length) trs.push(new D.TableRow({ tableHeader: true, children: head.map((h) => cell(h, { header: true })) }));
    rows.forEach((r) => {
      const cells = Array.from({ length: cols }, (_, i) => cell((r || [])[i]));
      trs.push(new D.TableRow({ children: cells, cantSplit: true }));
    });
    return new D.Table({
      width: { size: colW * cols, type: D.WidthType.DXA },
      columnWidths: Array.from({ length: cols }, () => colW),
      rows: trs
    });
  }

  /* ---------- numbering (one definition per list style) ---------- */

  function makeNumbering(D) {
    const used = new Set();
    const configs = [];
    const defs = {
      bullets: { format: D.LevelFormat.BULLET, text: '•' },
      numbers: { format: D.LevelFormat.DECIMAL, text: '%1.' },
      letters: { format: D.LevelFormat.UPPER_LETTER, text: '%1.' }
    };
    let seq = 0;
    return {
      // A fresh reference each call so every list restarts at 1 / A.
      use(style) {
        const ref = `${style}-${++seq}`;
        configs.push({ reference: ref, levels: [{ level: 0, format: defs[style].format, text: defs[style].text,
          alignment: D.AlignmentType.LEFT, style: { paragraph: { indent: { left: 420, hanging: 280 } } } }] });
        used.add(style);
        return ref;
      },
      config() { return { config: configs }; }
    };
  }

  /* ---------- sections as boxes ---------- */

  function boxCell(D, children, width) {
    const thin = { style: D.BorderStyle.SINGLE, size: 6, color: COLORS.line };
    return new D.TableCell({
      width: { size: width, type: D.WidthType.DXA },
      borders: { top: thin, bottom: thin, left: thin, right: thin },
      shading: { type: D.ShadingType.CLEAR, fill: COLORS.shade, color: 'auto' },
      margins: { top: 120, bottom: 120, left: 160, right: 160 },
      verticalAlign: D.VerticalAlign.TOP,
      children: children.length ? children : [new D.Paragraph({ children: [] })]
    });
  }

  function sectionChildren(D, s, numbering, innerWidth) {
    const out = [...sectionTitle(D, s.title, s.stage)];
    (s.blocks || []).forEach((b) => {
      if (b && b.t === 'table') { out.push(dataTable(D, b, innerWidth - 320)); out.push(new D.Paragraph({ spacing: { after: 60 }, children: [] })); }
      else out.push(...blockToParagraphs(D, b, numbering));
    });
    return out;
  }

  function cardsRow(D, sections, numbering, contentWidth) {
    const gap = 160;
    const n = Math.max(1, sections.length);
    const colW = Math.floor((contentWidth - gap * (n - 1)) / n);
    const none = { style: D.BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const noBorders = { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
    const widths = [];
    const cells = [];
    sections.forEach((s, i) => {
      widths.push(colW);
      cells.push(boxCell(D, sectionChildren(D, s, numbering, colW), colW));
      if (i < n - 1) {
        widths.push(gap);
        cells.push(new D.TableCell({ width: { size: gap, type: D.WidthType.DXA }, borders: noBorders, children: [new D.Paragraph({ children: [] })] }));
      }
    });
    return new D.Table({
      width: { size: widths.reduce((a, b) => a + b, 0), type: D.WidthType.DXA },
      columnWidths: widths,
      borders: noBorders,
      rows: [new D.TableRow({ children: cells })]
    });
  }

  /* ---------- the document ---------- */

  function build(D, model, stamp) {
    const landscape = model.orientation === 'landscape';
    const pageW = landscape ? LETTER.h : LETTER.w;
    const contentWidth = pageW - MARGIN * 2;
    const numbering = makeNumbering(D);
    const cards = model.style !== 'report';

    const children = [];
    if (model.subtitle) children.push(para(D, model.subtitle, { size: 20, color: COLORS.soft, after: 60 }));
    if (model.note) children.push(para(D, model.note, { size: 15, italics: true, color: COLORS.soft, after: 160 }));

    const items = Array.isArray(model.sections) ? model.sections : [];
    items.forEach((item, idx) => {
      if (!item) return;
      const row = Array.isArray(item.row) ? item.row : [item];
      if (cards) {
        children.push(cardsRow(D, row, numbering, contentWidth));
        if (idx < items.length - 1) children.push(new D.Paragraph({ spacing: { after: 160 }, children: [] }));
      } else {
        row.forEach((s) => { children.push(...sectionChildren(D, s, numbering, contentWidth)); });
      }
    });

    const metaLine = (model.meta || []).map((m) => `${m.label}: ${m.value}`).join('   |   ');
    const header = new D.Header({ children: [
      new D.Paragraph({
        alignment: D.AlignmentType.CENTER, spacing: { after: 60 },
        border: { bottom: { style: D.BorderStyle.SINGLE, size: 12, color: '000000', space: 4 } },
        children: [new D.TextRun({ text: str(model.title), font: FONT, size: 28, bold: true })]
      }),
      ...(metaLine ? [new D.Paragraph({ spacing: { after: 0 }, children: [new D.TextRun({ text: metaLine, font: FONT, size: 15, color: '555555' })] })] : [])
    ] });

    const footer = new D.Footer({ children: [new D.Paragraph({
      alignment: D.AlignmentType.RIGHT,
      children: [
        new D.TextRun({ text: `${model.footer || 'Mktforge'} · Mktforge ref ${stamp.ref} · Keep the section headings so Mktforge can read this back · Page `, font: FONT, size: 14, color: '888888' }),
        new D.TextRun({ children: [D.PageNumber.CURRENT], font: FONT, size: 14, color: '888888' }),
        new D.TextRun({ text: ' of ', font: FONT, size: 14, color: '888888' }),
        new D.TextRun({ children: [D.PageNumber.TOTAL_PAGES], font: FONT, size: 14, color: '888888' })
      ]
    })] });

    return new D.Document({
      creator: 'Mktforge',
      title: str(model.title),
      description: `Exported from Mktforge (${stamp.ref})`,
      customProperties: stamp.properties,
      numbering: numbering.config(),
      styles: { default: { document: { run: { font: FONT, size: 18 } } } },
      sections: [{
        properties: {
          page: {
            size: landscape ? { width: LETTER.w, height: LETTER.h, orientation: D.PageOrientation.LANDSCAPE } : { width: LETTER.w, height: LETTER.h },
            margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, header: 400, footer: 400 }
          }
        },
        headers: { default: header },
        footers: { default: footer },
        children
      }]
    });
  }

  function safeFileName(name) {
    return String(name || 'Mktforge document').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 150) || 'Mktforge document';
  }

  /* Builds the Word file and hands it to the browser as a download. */
  async function download(model, { fileId, companyId, moduleId, inputs, createdAt, fileName }) {
    if (!model || !Array.isArray(model.sections)) throw new Error('This file has no document model to export.');
    const D = await loadLib();
    const M = window.MktforgeMaterials;
    const stamp = { ref: M.refFor(fileId), properties: M.stampProperties({ fileId, companyId, moduleId: moduleId || model.moduleId, inputs, createdAt }) };
    const doc = build(D, model, stamp);
    const blob = await D.Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${safeFileName(fileName || model.title)}.docx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
    return blob;
  }

  return { download, build, loadLib };
})();

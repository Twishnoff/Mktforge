/* ==========================================================================
   Mktforge — Company Brief PDF
   Renders the brief model returned by the company-brief Worker with jsPDF.

     window.MktforgeCompanyBriefPdf.build(model, { data })  -> savePdfDoc result

   Layout rules come from the "Specification Document - Company Brief":
     • cover / back cover: the Diagonal Ribbon grid in the brand colour only
     • interior: readability-first palette; brand colour as hairline accents
     • boxes are never cut off — "(Continued on next page)" and a new page
     • side-by-side boxes share one title-row height and one body height
     • a subsection title never ends a page alone
     • bullet lists get a quarter line between bullets
     • footnotes list the Mktforge source documents used on that page
   ========================================================================== */
window.MktforgeCompanyBriefPdf = (() => {

  const INK = [14, 31, 18], SUBTX = [58, 63, 69], GREY = [107, 111, 108];
  const HEAD_BG = [233, 236, 239], ZEBRA = [250, 251, 252], RULE = [213, 217, 222], HILITE = [238, 246, 241], WHITE = [255, 255, 255];
  const LETTER = { w: 612, h: 792 };
  const M = 58;                       // 0.8in side margins
  const TOP = 58, FOOT = 90;          // bottom margin leaves room for footnotes + footer
  const CW = LETTER.w - 2 * M;

  const WIN1252_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
  const safe = (s) => String(s == null ? '' : s)
    .replace(/[→⇒]/g, '->').replace(/[←]/g, '<-').replace(/[≥]/g, '>=').replace(/[≤]/g, '<=')
    .replace(/[‐‑‒]/g, '-').replace(/[   ]/g, ' ')
    .split('').filter((ch) => ch.charCodeAt(0) < 256 || WIN1252_EXTRA.includes(ch)).join('');

  const hexToRgb = (hex) => {
    let h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return /^[0-9a-f]{6}$/i.test(h) ? [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] : [47, 111, 78];
  };
  const darken = ([r, g, b], f = 0.75) => [Math.round(r * f), Math.round(g * f), Math.round(b * f)];

  /* ------------------------------------------------------------------ *
   * Text measurement — every block is measured before it is placed so a
   * box can be moved whole to the next page.
   * ------------------------------------------------------------------ */
  function makeDoc() {
    const { jsPDF } = window.jspdf;
    return new jsPDF({ unit: 'pt', format: 'letter', compress: true });
  }

  function render(model, learned) {
    const doc = makeDoc();
    const BR = hexToRgb(model.brand && model.brand.color);
    const BRD = darken(BR);
    const CO = model.company;
    const T1 = model.topTitles[0], T2 = model.topTitles[1];
    const srcLabels = (model.sources || []).map((s) => s.label);

    /* ---------- per-page state ---------- */
    let y = TOP;
    const pageSources = {};             // pageNo -> Set(index)
    const sectionPage = {};             // section title -> page
    const page = () => doc.internal.getCurrentPageInfo().pageNumber;
    const useSource = (n) => { if (!n) return; (pageSources[page()] = pageSources[page()] || new Set()).add(n); };
    const useSources = (arr) => (arr || []).forEach(useSource);

    function setFont(size, bold, color) {
      doc.setFont('helvetica', bold ? 'bold' : 'normal');
      doc.setFontSize(size);
      doc.setTextColor(...(color || INK));
    }
    function wrap(str, width, size, bold) {
      setFont(size, bold);
      return doc.splitTextToSize(safe(str), width);
    }
    const lh = (size) => size * 1.3;
    function textHeight(str, width, size, bold) { return wrap(str, width, size, bold).length * lh(size); }

    function newPage() { doc.addPage(); y = TOP; }
    const room = () => LETTER.h - FOOT - y;

    /** Move to a new page if `h` won't fit, leaving the "(Continued on next page)" note behind. */
    function ensureBox(h) {
      if (h <= room()) return;
      if (room() > 14) {
        setFont(9, false, GREY); doc.setFont('helvetica', 'italic');
        doc.text('(Continued on next page)', LETTER.w / 2, y + 10, { align: 'center' });
      }
      newPage();
    }

    /* ---------- primitives ---------- */
    function para(str, { size = 10, bold = false, color = INK, gapAfter = 6, width = CW, x = M, align = 'left' } = {}) {
      const lines = wrap(str, width, size, bold);
      const step = lh(size);
      lines.forEach((ln) => {
        if (room() < step) newPage();
        setFont(size, bold, color);
        doc.text(ln, align === 'center' ? x + width / 2 : x, y + size, { align });
        y += step;
      });
      y += gapAfter;
    }
    /** Paragraph with a bold lead-in ("Helps:" …) rendered inline. */
    function leadPara(lead, str, { size = 9.2, width = CW, x = M, gapAfter = 4 } = {}) {
      const s = safe(str);
      setFont(size, true);
      const leadW = doc.getTextWidth(lead + ' ');
      const first = doc.splitTextToSize(s, width - leadW);
      setFont(size, false);
      const rest = first.length > 1 ? doc.splitTextToSize(first.slice(1).join(' '), width) : [];
      const step = lh(size);
      if (room() < step) newPage();
      setFont(size, true); doc.text(lead, x, y + size);
      setFont(size, false); doc.text(first[0] || '', x + leadW, y + size);
      y += step;
      rest.forEach((ln) => { if (room() < step) newPage(); doc.text(ln, x, y + size); y += step; });
      y += gapAfter;
    }
    const leadParaHeight = (lead, str, size = 9.2, width = CW) => {
      setFont(size, true); const leadW = doc.getTextWidth(lead + ' ');
      const first = doc.splitTextToSize(safe(str), width - leadW);
      setFont(size, false);
      const rest = first.length > 1 ? doc.splitTextToSize(first.slice(1).join(' '), width) : [];
      return (1 + rest.length) * lh(size);
    };

    /** Bullets with a quarter line of air between items. */
    function bulletsHeight(items, width, size = 9.2) {
      return items.reduce((h, it, i) => h + textHeight('• ' + it, width - 9, size) + (i ? size * 0.25 : 0), 0);
    }
    function drawBullets(items, x, top, width, size = 9.2) {
      let yy = top;
      items.forEach((it, i) => {
        if (i) yy += size * 0.25;
        const lines = wrap('• ' + it, width - 9, size);
        lines.forEach((ln, k) => { setFont(size); doc.text(ln, x + (k ? 9 : 0), yy + size); yy += lh(size); });
      });
      return yy;
    }

    function h1(str) { para(str, { size: 22, bold: true, color: INK, gapAfter: 10 }); }

    /** Subsection title + first content, kept together: either the first box or ≥2 sentences. */
    function subsection(title, firstHeight) {
      const need = 18 + lh(12) + 10 + firstHeight;
      if (need > room()) {
        if (room() > 14) { setFont(9, false, GREY); doc.setFont('helvetica', 'italic'); doc.text('(Continued on next page)', LETTER.w / 2, y + 10, { align: 'center' }); }
        newPage();
      } else y += 18;
      setFont(12, true, SUBTX); doc.text(safe(title), M, y + 12); y += lh(12) + 10;
    }
    const twoSentences = (s) => (String(s).match(/[^.?!]+[.?!]+(\s|$)/g) || [s]).slice(0, 2).join(' ');
    function subsectionPara(title, text, opts) {
      subsection(title, textHeight(twoSentences(text), CW, 10) + 6);
      para(text, opts);
    }

    /* ---------- boxes ---------- */
    const TITLE_H = (title, width) => textHeight(title, width - 16, 10.5, true) + 12;

    function titleBar(x, top, width, title, { badge, badgeFilled = true } = {}) {
      const h = TITLE_H(title, width - (badge ? 70 : 0));
      doc.setFillColor(...HEAD_BG); doc.rect(x, top, width, h, 'F');
      doc.setDrawColor(...RULE); doc.setLineWidth(0.75); doc.rect(x, top, width, h);
      doc.setDrawColor(...BR); doc.setLineWidth(1.5); doc.line(x, top + h, x + width, top + h);
      setFont(10.5, true, INK);
      wrap(title, width - 16 - (badge ? 70 : 0), 10.5, true).forEach((ln, i) => doc.text(ln, x + 8, top + 6 + 10.5 + i * lh(10.5)));
      if (badge) drawBadge(x + width - 8 - 62, top + h / 2 - 6, 62, badge, badgeFilled);
      return h;
    }
    function drawBadge(x, top, w, label, filled = true) {
      doc.setDrawColor(...BR); doc.setLineWidth(0.75);
      if (filled) { doc.setFillColor(...BR); doc.roundedRect(x, top, w, 12, 3, 3, 'F'); setFont(7, true, WHITE); }
      else { doc.roundedRect(x, top, w, 12, 3, 3); setFont(7, true, BRD); }
      doc.text(safe(label).toUpperCase(), x + w / 2, top + 8.5, { align: 'center' });
    }
    function bodyFrame(x, top, width, h, fill = WHITE) {
      doc.setFillColor(...fill); doc.rect(x, top, width, h, 'F');
      doc.setDrawColor(...RULE); doc.setLineWidth(0.75); doc.rect(x, top, width, h);
    }

    /** Up to two "title + bullets" boxes side by side with aligned title bars and bottoms. */
    function boxPair(pair, x = M, totalW = CW, gap = 12) {
      const w = pair.length === 2 ? (totalW - gap) / 2 : totalW;
      const th = Math.max(...pair.map((b) => TITLE_H(b.title, w)));
      const bh = Math.max(...pair.map((b) => bulletsHeight(b.items, w - 16))) + 18;
      ensureBox(th + bh);
      pair.forEach((b, i) => {
        const bx = x + i * (w + gap);
        doc.setFillColor(...HEAD_BG); doc.rect(bx, y, w, th, 'F');
        doc.setDrawColor(...RULE); doc.setLineWidth(0.75); doc.rect(bx, y, w, th);
        doc.setDrawColor(...BR); doc.setLineWidth(1.5); doc.line(bx, y + th, bx + w, y + th);
        setFont(10.5, true, INK);
        wrap(b.title, w - 16, 10.5, true).forEach((ln, k) => doc.text(ln, bx + 8, y + 6 + 10.5 + k * lh(10.5)));
        bodyFrame(bx, y + th, w, bh);
        drawBullets(b.items, bx + 8, y + th + 9, w - 16);
      });
      y += th + bh;
    }

    /** "Top Targets" frame around a box pair. */
    function topTargets(pair) {
      const pad = 12, inner = CW - 2 * pad;
      const w = (inner - 12) / 2;
      const th = Math.max(...pair.map((b) => TITLE_H(b.title, w)));
      const bh = Math.max(...pair.map((b) => bulletsHeight(b.items, w - 16))) + 18;
      const total = 26 + th + bh + pad;
      ensureBox(total);
      doc.setFillColor(246, 247, 248); doc.rect(M, y, CW, total, 'F');
      doc.setDrawColor(...RULE); doc.setLineWidth(1); doc.rect(M, y, CW, total);
      setFont(11, true, SUBTX); doc.text('Top Targets', LETTER.w / 2, y + 17, { align: 'center' });
      y += 26;
      boxPair(pair, M + pad, inner, 12);
      y += pad;
    }

    /** Two-column table; rows are atomic; the whole table is atomic unless `splittable`. */
    function table(cols, rows, { widths, splittable = false, firstBold = false, link = false, rowBg, badge } = {}) {
      const size = 9;
      const rowH = (cells, r) => Math.max(...cells.map((c, i) => Array.isArray(c) ? bulletsHeight(c, widths[i] - 14, size) : textHeight(c, widths[i] - 14, size, firstBold && i === 0))) + 10 + (badge && badge(r) ? 18 : 0);
      const headH = Math.max(...cols.map((c, i) => textHeight(c, widths[i] - 14, size, true))) + 10;
      const heights = rows.map((r, i) => rowH(r, i));
      const total = headH + heights.reduce((a, b) => a + b, 0);
      const drawHead = () => {
        let x = M;
        doc.setFillColor(...HEAD_BG); doc.rect(M, y, CW, headH, 'F');
        cols.forEach((c, i) => { setFont(size, true, INK); doc.text(safe(c), x + 7, y + 5 + size); doc.setDrawColor(...RULE); doc.setLineWidth(0.5); doc.rect(x, y, widths[i], headH); x += widths[i]; });
        y += headH;
      };
      const drawRow = (cells, h, r) => {
        let x = M;
        const bg = rowBg && rowBg(r);
        doc.setFillColor(...(bg || (r % 2 ? ZEBRA : WHITE))); doc.rect(M, y, CW, h, 'F');
        if (bg) { doc.setDrawColor(...BR); doc.setLineWidth(3); doc.line(M + 1.5, y, M + 1.5, y + h); }
        cells.forEach((c, i) => {
          doc.setDrawColor(...RULE); doc.setLineWidth(0.5); doc.rect(x, y, widths[i], h);
          if (Array.isArray(c)) drawBullets(c, x + 7, y + 5, widths[i] - 14, size);
          else {
            const isLink = link && i === link.col;
            setFont(size, firstBold && i === 0, isLink ? BRD : INK);
            wrap(c, widths[i] - 14, size, firstBold && i === 0).forEach((ln, k) => {
              const ty = y + 5 + size + k * lh(size);
              if (isLink && k === 0) doc.textWithLink(ln, x + 7, ty, { url: link.href(r) }); else doc.text(ln, x + 7, ty);
            });
            if (i === 0 && badge && badge(r)) drawBadge(x + 7, y + 5 + lh(size) * wrap(c, widths[i] - 14, size).length + 3, 52, 'Priority');
          }
          x += widths[i];
        });
        y += h;
      };
      if (!splittable || total <= room()) { ensureBox(total); drawHead(); rows.forEach((r, i) => drawRow(r, heights[i], i)); return; }
      // split across pages with the spec's two notes
      let first = true;
      rows.forEach((r, i) => {
        if (first || heights[i] + 24 > room()) {
          if (!first) { setFont(9, false, GREY); doc.setFont('helvetica', 'italic'); doc.text('(Table continues on next page)', LETTER.w / 2, y + 12, { align: 'center' }); newPage();
            setFont(9, false, GREY); doc.setFont('helvetica', 'italic'); doc.text('(Table continued from previous page)', LETTER.w / 2, y + 8, { align: 'center' }); y += 16; }
          drawHead(); first = false;
        }
        drawRow(r, heights[i], i);
      });
    }

    /** Full-width titled box whose body is a list of pre-measured draw callbacks. */
    function titledBox(title, blocks, opts = {}) {
      const bodyH = blocks.reduce((h, b) => h + b.h, 0) + 18;
      const th = TITLE_H(title, CW - (opts.badge ? 70 : 0));
      ensureBox(th + bodyH);
      titleBar(M, y, CW, title, opts);
      bodyFrame(M, y + th, CW, bodyH);
      let yy = y + th + 9;
      blocks.forEach((b) => { b.draw(M + 10, yy, CW - 20); yy += b.h; });
      y += th + bodyH;
    }
    const blockPara = (str, size = 9.2, gap = 4) => ({ h: textHeight(str, CW - 20, size) + gap, draw: (x, top, w) => { wrap(str, w, size).forEach((ln, k) => { setFont(size); doc.text(ln, x, top + size + k * lh(size)); }); } });
    const blockLead = (lead, str, gap = 4) => ({ h: leadParaHeight(lead, str, 9.2, CW - 20) + gap, draw: (x, top, w) => { const saveY = y; y = top; leadPara(lead, str, { width: w, x, gapAfter: 0 }); y = saveY; } });
    const blockBullets = (items, gap = 4) => ({ h: bulletsHeight(items, CW - 20) + gap, draw: (x, top, w) => drawBullets(items, x, top, w) });
    const blockGap = (h) => ({ h, draw: () => {} });
    const blockHighlight = (str, size = 9.5) => { const h = textHeight(str, CW - 40, size) + 16; return { h: h + 6, draw: (x, top, w) => { doc.setFillColor(...HILITE); doc.rect(x, top, w, h, 'F'); doc.setDrawColor(...BR); doc.setLineWidth(2); doc.line(x, top, x, top + h); wrap(str, w - 20, size).forEach((ln, k) => { setFont(size); doc.text(ln, x + 10, top + 8 + size + k * lh(size)); }); } }; };
    const blockBoldLead = (lead, str, size = 9.5) => ({ h: leadParaHeight(lead, str, size, CW - 40) + 16 + 6, draw: (x, top, w) => { const h = leadParaHeight(lead, str, size, w - 20) + 16; doc.setFillColor(...HILITE); doc.rect(x, top, w, h, 'F'); doc.setDrawColor(...BR); doc.setLineWidth(2); doc.line(x, top, x, top + h); const saveY = y; y = top + 8; leadPara(lead, str, { size, width: w - 20, x: x + 10, gapAfter: 0 }); y = saveY; } });

    /** Proof-point cards, ≤3 per row, one title height and one body height across all cards. */
    function proofCards(cards) {
      const gap = 12, pw = (CW - 2 * gap) / 3;
      const th = Math.max(...cards.map((c) => textHeight(c.title, pw - 14, 9, true))) + 12;
      const bh = Math.max(...cards.map((c) => textHeight(c.copy, pw - 14, 8.3))) + 16;
      for (let i = 0; i < cards.length; i += 3) {
        const row = cards.slice(i, i + 3);
        if (i === 0) subsection('Proof Points to Consider', th + bh); else { y += gap; ensureBox(th + bh); }
        row.forEach((c, k) => {
          const x = M + k * (pw + gap);
          doc.setFillColor(...HEAD_BG); doc.rect(x, y, pw, th, 'F');
          doc.setDrawColor(...RULE); doc.setLineWidth(0.75); doc.rect(x, y, pw, th + bh);
          doc.setDrawColor(...BR); doc.setLineWidth(1.5); doc.line(x, y + th, x + pw, y + th);
          setFont(9, true, INK); wrap(c.title, pw - 14, 9, true).forEach((ln, j) => doc.text(ln, x + 7, y + 6 + 9 + j * lh(9)));
          setFont(8.3); wrap(c.copy, pw - 14, 8.3).forEach((ln, j) => doc.text(ln, x + 7, y + th + 7 + 8.3 + j * lh(8.3)));
        });
        y += th + bh;
      }
    }

    /* ---------- cover & back ---------- */
    function ribbon() {
      const W = LETTER.w, H = LETTER.h;
      const surf = (u, v) => {
        const t = v;
        const cx = W * (1.05 - 1.25 * t) + 0.12 * W * Math.sin(Math.PI * t);
        const cy = H * (1.05 - 1.15 * Math.pow(t, 0.9)) + 0.06 * H * Math.sin(2 * Math.PI * t);
        const width = W * (0.45 + 0.55 * t);
        const s = (u - 0.5) * width;
        const bulge = 0.08 * H * Math.cos(Math.PI * (u - 0.5)) * (1 - t);
        return [cx + s * 0.72, H - (cy - s * 0.69 + bulge)];     // jsPDF y grows downward
      };
      const fade = (x, yPdf, v) => {
        const yUp = H - yPdf;
        const t = Math.max(0, Math.min(1, (x / W + (1 - yUp / H)) / 2));
        return Math.max(0, Math.min(1, 0.55 * (0.08 + 0.92 * Math.pow(1 - t, 1.3)) * (0.4 + 0.6 * v)));
      };
      const nu = 18, nv = 44, steps = 48;
      // group segments by quantised opacity so the PDF carries ~12 graphics states, not thousands
      const buckets = new Map();
      const add = (p, q, v) => {
        const a = fade((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, v);
        if (a < 0.02) return;
        const key = Math.round(a * 12);
        (buckets.get(key) || buckets.set(key, []).get(key)).push([p, q, 0.6 + 2.2 * v]);
      };
      for (let i = 0; i <= nu; i += 1) { const u = i / nu; const pts = []; for (let k = 0; k <= steps; k += 1) pts.push(surf(u, k / steps)); for (let k = 0; k < steps; k += 1) add(pts[k], pts[k + 1], k / steps); }
      for (let j = 0; j <= nv; j += 1) { const v = j / nv; const pts = []; for (let k = 0; k <= steps; k += 1) pts.push(surf(k / steps, v)); for (let k = 0; k < steps; k += 1) add(pts[k], pts[k + 1], v); }
      doc.setDrawColor(...BR); doc.setLineCap(1);
      buckets.forEach((segs, key) => {
        doc.setGState(new doc.GState({ 'stroke-opacity': key / 12 }));
        segs.forEach(([p, q, w]) => { doc.setLineWidth(w); doc.line(p[0], p[1], q[0], q[1]); });
      });
      doc.setGState(new doc.GState({ 'stroke-opacity': 1 }));
    }
    function cover() {
      ribbon();
      const ts = 40, L = ts * 1.6, pad = 40;
      if (model.brand && model.brand.logoDataUri) {
        try { doc.addImage(model.brand.logoDataUri, 'PNG', LETTER.w - pad - L, pad, L, L, undefined, 'FAST'); }
        catch (e) { try { doc.addImage(model.brand.logoDataUri, 'JPEG', LETTER.w - pad - L, pad, L, L); } catch (e2) { /* unsupported image: no logo */ } }
      }
      setFont(ts, true, INK); doc.text('Company Marketing Brief', LETTER.w / 2, LETTER.h / 2 - 20, { align: 'center' });
      setFont(24, false, INK); doc.text(safe(CO), LETTER.w / 2, LETTER.h / 2 + 22, { align: 'center' });
      doc.setFont('helvetica', 'italic'); doc.setFontSize(13); doc.setTextColor(...GREY);
      doc.text(`Generated ${model.generated}`, LETTER.w / 2, LETTER.h / 2 + 50, { align: 'center' });
    }
    function mktLogo(cx, cy, width) {
      const img = window.MktforgeCompanyBriefPdf._logo;      // { dataUri, width, height }
      if (!img) return;
      const h = width * (img.height / img.width);
      doc.addImage(img.dataUri, 'PNG', cx - width / 2, cy - h / 2, width, h, undefined, 'FAST');
    }
    function back() {
      ribbon();
      const third = LETTER.h * 2 / 3;      // bottom third starts here (jsPDF y downward)
      setFont(20, true, INK); doc.text('Want more briefs like this?', LETTER.w / 2, third + 10, { align: 'center' });
      setFont(12, false, GREY); doc.text('Mktforge turns your company’s research into ready-to-share marketing foundations.', LETTER.w / 2, third + 34, { align: 'center' });
      const bw = 190, bh = 40, bx = (LETTER.w - bw) / 2, by = third + 54;
      doc.setFillColor(...BR); doc.roundedRect(bx, by, bw, bh, 10, 10, 'F');
      setFont(14, true, WHITE); doc.text('Learn more at Mktforge.io', LETTER.w / 2, by + 26, { align: 'center' });
      doc.link(bx, by, bw, bh, { url: 'https://mktforge.io' });
      mktLogo(LETTER.w / 2, by + bh + 40, 120);
    }
    function intro() {
      mktLogo(LETTER.w / 2, LETTER.h / 2 - 150, 170);
      setFont(22, true, INK); doc.text('What is this report?', LETTER.w / 2, LETTER.h / 2 - 100, { align: 'center' });
      const t1 = `This marketing brief for ${CO} is intended to serve as a high-level overview of ${CO}’s ideal customers, their careabouts, how ${CO} can reach these customers, craft messaging for them, and position against known competitors. It is meant to serve as a starting point for focusing ${CO}’s marketing discussions on the right frameworks and questions to quickly develop more refined and effective go-to-market strategies.`;
      const t2 = `While the information here is well-sourced and guided by decades of marketing experience, it should first and foremost be seen as an early draft of the final guiding marketing materials ${CO} will create. Most of the material found within this document are highlights of more extensive documents created with Mktforge. If you wish to delve deeper, ask the creator of this document for the source files.`;
      y = LETTER.h / 2 - 70;
      para(t1, { size: 11, width: CW - 40, x: M + 20, align: 'center', gapAfter: 12 });
      para(t2, { size: 11, width: CW - 40, x: M + 20, align: 'center' });
    }
    function toc() {
      setFont(26, true, INK); doc.text('Inside This Report', LETTER.w / 2, 190, { align: 'center' });
      doc.setDrawColor(...BR); doc.setLineWidth(1.5); doc.line(LETTER.w / 2 - 40, 200, LETTER.w / 2 + 40, 200);
      const bw = 300, x0 = (LETTER.w - bw) / 2; let yy = 260;
      ['Customer Overview', 'Competitive Analysis', 'Positioning and Messaging'].forEach((s) => {
        const pg = String((learned && learned.pages[s]) || sectionPage[s] || '?');
        setFont(13, true, INK); doc.text(s, x0, yy); const tw = doc.getTextWidth(s); const pw = doc.getTextWidth(pg);
        setFont(11, false, GREY); const dw = doc.getTextWidth('.');
        doc.text('.'.repeat(Math.max(0, Math.floor((bw - tw - pw - 12) / dw))), x0 + tw + 6, yy);
        setFont(13, true, INK); doc.text(pg, x0 + bw, yy, { align: 'right' });
        yy += 34;
      });
    }

    /* ================================================================ *
     * PASS: content pages 4..N (built twice: once to learn page numbers
     * for the TOC and footnotes, once for real)
     * ================================================================ */
    const sup = (nums) => (nums || []).filter(Boolean).map((n) => `[${n}]`).join('');

    function customerOverview() {
      const c = model.customerOverview;
      sectionPage['Customer Overview'] = page();
      h1('Customer Overview');
      useSource(c.cite);
      const intro = `Who are the best people to target to drive adoption of ${CO}? While the diversity of buyers is as myriad as the uses for ${CO}’s products and services, some buyers needs are better aligned with the features and value ${CO} offers, and so should be considered for prioritization. These include: ${sup([c.cite])}`;
      subsectionPara('INTRODUCTION', intro);
      topTargets(c.topBoxes);
      for (let i = 0; i < c.otherBoxes.length; i += 2) { y += 10; boxPair(c.otherBoxes.slice(i, i + 2)); }
      useSource(c.cite);
      subsectionPara('WHERE IS BUYER X/Y/Z?', `The buyers outlined above are simply the ones that best align with ${CO}’s current messaging and feature offerings, and there are always exceptions. This list is not to say other titles aren’t worth selling into or that ${CO} wouldn’t succeed targeting other titles, only that the titles above should receive additional consideration.`);
      const tb1 = `While any of the roles outlined above could be worth targeting (and should still be considered regardless), ${T1} and ${T2} should receive further consideration for targeted outreach and messaging refinement.`;
      subsection('TOP BUYERS - DEEPER INSIGHTS', textHeight(tb1, CW, 10) + 6);
      para(tb1);
      const bcCites = c.alignment.filter((a) => a.data).map((a) => a.data.cite);
      para(`These buyers are not only worth targeting because their needs align with ${CO}’s general value proposition, but because ${CO}’s specific features and services map best to their needs outlined below: ${sup(bcCites)}`);
      c.alignment.forEach((a) => {
        const title = `Where ${a.title}’s Needs Align with ${CO}’s Offerings`;
        if (!a.data) {
          const th = TITLE_H(title, CW); ensureBox(th + 80);
          titleBar(M, y, CW, title); bodyFrame(M, y + th, CW, 80);
          setFont(11, false, GREY); doc.text('Data still being collected for this title.', LETTER.w / 2, y + th + 44, { align: 'center' });
          y += th + 80 + 16; return;
        }
        useSource(a.data.cite);
        const th = TITLE_H(title, CW);
        // measure the table so title + table move as one box
        const widths = [CW / 2, CW / 2];
        const rowsH = a.data.rows.reduce((h, r) => h + Math.max(textHeight(r.need, widths[0] - 14, 9), bulletsHeight(r.wins, widths[1] - 14, 9)) + 10, 0) + (textHeight('Needs', 100, 9, true) + 10);
        ensureBox(th + rowsH);
        titleBar(M, y, CW, title);
        y += th;
        table(['Needs', `Where ${CO} Wins`], a.data.rows.map((r) => [r.need, r.wins]), { widths });
        useSource(a.data.cite);
        proofCards(a.data.proof);
        y += 16;
      });
      const w = c.where;
      if (w.rows.length) {
        useSources(w.cites);
        subsectionPara('WHERE TO FIND THESE BUYERS', `Many various channels and activities exist to reach these buyers, and some are likely already known. Below is a collection of some of the best matches based on the initiatives of ${T1}’s and ${T2}’s and where they’d be most receptive to hearing about ${CO}’s offerings: ${sup(w.cites)}`);
        useSources(w.cites);
        table(['Name', 'Channel', 'Link'], w.rows.map((r) => [r.name, r.channel, r.url]), { widths: [CW * 0.36, CW * 0.24, CW * 0.40], link: { col: 2, href: (i) => w.rows[i].url } });
      }
    }

    function competitiveAnalysis() {
      const c = model.competitiveAnalysis;
      newPage();
      sectionPage['Competitive Analysis'] = page();
      h1('Competitive Analysis');
      useSources(c.cites);
      subsectionPara('INTRODUCTION', `Determining ${CO}’s competitors requires a combination of looking at its target buyers, current offerings, and value proposition and the names and products that come up in common searches, job descriptions, and online conversations related to ${CO}’s target buyers. Based on the information presented above, the following competitors appear to surface the most: ${sup(c.cites)}`);
      useSources(c.cites);
      table(['Competitor', 'URL', 'Where They Compete'], c.competitors.map((r) => [r.name, r.url, r.why]), {
        widths: [CW * 0.21, CW * 0.24, CW * 0.55], splittable: true,
        link: { col: 1, href: (i) => `https://${c.competitors[i].url}` },
        rowBg: (i) => (c.competitors[i].priority ? HILITE : null),
        badge: (i) => c.competitors[i].priority,
      });
      if (c.competes.length) {
        useSources(c.competesCites);
        subsectionPara(`WHERE ${CO.toUpperCase()} COMPETES`, `A case can be made for any competitor under the right circumstances, however, when comparing the competitors above to the needs of ${T1}’s and ${T2}’s, there are particular areas where ${CO} stands out. These areas where ${CO} competes are highlighted below: ${sup(c.competesCites)}`);
        c.competes.forEach((t, i) => {
          if (i) y += 12;
          useSources(c.competesCites);
          const title = t.name;
          const widths = [CW * 0.34, CW * 0.66];
          const th = TITLE_H(title, CW - 70);
          const rowsH = t.rows.reduce((h, r) => h + Math.max(textHeight(r.claim, widths[0] - 14, 9), textHeight(r.copy, widths[1] - 14, 9)) + 10, 0) + (textHeight('x', 100, 9, true) + 10);
          ensureBox(th + rowsH);
          titleBar(M, y, CW, title, t.priority ? { badge: 'Priority' } : {});
          y += th;
          table(['Competitor Claim', `Where ${CO} Competes`], t.rows.map((r) => [r.claim, r.copy]), { widths });
        });
      }
    }

    function positioning() {
      const p = model.positioning;
      newPage();
      sectionPage['Positioning and Messaging'] = page();
      if (!p) {
        h1('Positioning and Messaging');
        setFont(22, true, GREY); doc.text('Positioning Still Being Developed', LETTER.w / 2, LETTER.h / 2, { align: 'center' });
        return;
      }
      h1('Positioning and Messaging');
      useSource(p.cite);
      subsectionPara('INTRODUCTION', `${p.intro} ${sup([p.cite])}`);
      // recommended: highlighted statement first, then Helps / Hurts
      const rec = p.recommended;
      titledBox(rec.title, [
        ...(rec.statement ? [blockBoldLead('Positioning statement:', rec.statement), blockGap(4)] : []),
        blockLead('Helps:', rec.helps), blockGap(5), blockLead('Hurts:', rec.hurts, 0),
      ], { badge: 'Recommended', badgeFilled: true });
      p.alternatives.forEach((a) => {
        y += 12; useSource(p.cite);
        titledBox(a.title, [blockLead('Helps:', a.helps), blockGap(5), blockLead('Hurts:', a.hurts, 0)], { badge: 'Alternative', badgeFilled: false });
      });
      useSource(p.cite);
      subsectionPara('HOW TO VALIDATE', 'The proposed positioning is simply a starting point, and it should be validated with real users or potential users through getting answers to the following questions:');
      p.validate.forEach((qText, i) => {
        const h = textHeight('• ' + qText, CW - 9, 9.2) + (i ? 9.2 * 0.25 : 0);
        if (h > room()) newPage();
        y = drawBullets([qText], M, y + (i ? 9.2 * 0.25 : 0), CW);
      });
      if (p.messaging) {
        const m = p.messaging;
        useSource(m.cite);
        subsectionPara('VALUE PROPOSITION AND MESSAGING DRAFT', `Consolidating the above insights and positioning, an initial value proposition, 30-second pitch, and proof pillars can be drafted. Note that this is just an initial draft. Further validation and adjustments should take place before finalization. This is simply a starting point: ${sup([m.cite])}`);
        useSource(m.cite);
        titledBox('Value Proposition', [blockHighlight(m.valueProp, 10)]);
        y += 12; useSource(m.cite);
        titledBox('30-Second Pitch', [blockPara(m.pitch, 9.2, 0)]);
        m.pillars.forEach((pl) => {
          y += 12; useSource(m.cite);
          titledBox(pl.title, [
            blockLead('Answers:', pl.answers, 0), blockGap(12),
            { h: lh(9.2), draw: (x, top) => { setFont(9.2, true); doc.text('Capabilities:', x, top + 9.2); } },
            blockBullets(pl.capabilities, 0), blockGap(12),
            blockLead('Proof:', pl.proof, 0),
          ]);
        });
      }
      subsectionPara('NEED MORE INFORMATION?', 'This brief was crafted using guided research and materials generated through the Mktforge platform. The information contained in this document is a high level abstraction of the resources it was sourced from. For more information and context, refer to the sources listed in the footers of this brief belonging to the Mktforge account used to generate them.');
    }

    /* ---------- footers (every interior page) ---------- */
    function footers(total) {
      for (let i = 2; i < total; i += 1) {
        doc.setPage(i);
        doc.setDrawColor(...RULE); doc.setLineWidth(0.5); doc.line(M, LETTER.h - 54, LETTER.w - M, LETTER.h - 54);
        setFont(8, false, GREY);
        doc.text(`${safe(CO)} — Company Marketing Brief`, M, LETTER.h - 40);
        doc.text(`Page ${i}`, LETTER.w - M, LETTER.h - 40, { align: 'right' });
        const src = (learned && learned.sources) || pageSources;
        const used = [...(src[i] || [])].sort((a, b) => a - b);
        let fy = LETTER.h - 62;
        used.slice().reverse().forEach((n) => {
          let line = `[${n}] Source: ${srcLabels[n - 1] || ''}`; let fs = 8;
          setFont(fs, false, GREY);
          while (doc.getTextWidth(safe(line)) > CW && fs > 6) { fs -= 0.5; setFont(fs, false, GREY); }
          doc.text(safe(line), M, fy); fy -= 10;
        });
      }
    }

    /* ---------- assemble ---------- */
    cover();
    newPage(); intro();
    newPage(); toc();
    newPage(); customerOverview();
    competitiveAnalysis();
    positioning();
    newPage(); back();
    footers(doc.internal.getNumberOfPages());
    return { doc, pages: sectionPage, sources: pageSources };
  }

  /**
   * Two passes: the first learns which page each section starts on and which
   * sources each page cites; the second draws the TOC and footnotes with that
   * knowledge. Content is identical both times, so pagination matches.
   */
  async function build(model, { data } = {}) {
    await loadLogo();
    const first = render(model, null);
    const { doc } = render(model, { pages: first.pages, sources: first.sources });
    const fallbackName = `Company Brief - ${(model.company || 'Company').replace(/[^\w\- ]+/g, '')}.pdf`;
    const D = data || window.MktforgeData;
    if (D && typeof D.savePdfDoc === 'function') {
      return D.savePdfDoc(doc, { moduleId: 'company-brief', moduleName: 'Company Brief', fallbackName });
    }
    doc.save(fallbackName);
    return null;
  }

  /* The Mktforge logo used on the intro page and back cover: the same asset as
     the site header, colours untouched. Loaded once as an HTMLImageElement so
     jsPDF can embed it. */
  async function loadLogo() {
    if (window.MktforgeCompanyBriefPdf._logo) return;
    try {
      const res = await fetch('assets/img/mktforge-logo.png');
      const blob = await res.blob();
      const dataUri = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(blob); });
      const dims = await new Promise((ok, no) => { const img = new Image(); img.onload = () => ok({ width: img.naturalWidth, height: img.naturalHeight }); img.onerror = no; img.src = dataUri; });
      window.MktforgeCompanyBriefPdf._logo = { dataUri, ...dims };
    } catch (e) { /* no logo is better than no PDF */ }
  }

  return { build };
})();

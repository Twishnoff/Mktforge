/* ==========================================================================
   Persona Builder — PDF export
   Ported from Persona Drafter's pdf.js. The drawing engine is unchanged:
   a templated landscape PDF drawn directly with jsPDF (title bar + info
   strip + a grid of boxes, each sized to its own content and paginated as
   needed) rather than a rasterized screenshot.

   What changed: it no longer binds its own button or reads a global. The
   module calls MktforgePersonaPdf.build(persona), and jsPDF is loaded on
   demand by the module rather than on every page load.
   ========================================================================== */

window.MktforgePersonaPdf = (function () {

  const BOX_TITLES = {
    overview: 'Overview',
    profiles: 'Sample Profiles',
    gather: 'Where They Gather',
    org: 'Organizational Structure',
    work: 'Their Immediate Work Priorities',
    development: 'Their Development Priorities'
  };

  // Mktforge forest green (--accent #2F6F4E).
  const ACCENT_RGB = [47, 111, 78];

  function slugify(str) {
    return (
      String(str || 'persona')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'persona'
    );
  }

  /* --- Each line is { text, bold, gapAfter, url }; a url makes it clickable --- */

  function buildPdfLines(boxKey, persona) {
    const lines = [];
    const push = (text, bold, gapAfter, url) =>
      lines.push({ text: String(text == null ? '' : text), bold: !!bold, gapAfter: gapAfter || 4, url: url || null });

    if (boxKey === 'overview') {
      const o = persona.overview || {};
      push('Primary Job Title:', true, 2);
      push(o.primary_job_title || '—', false, 6);
      push('Secondary Job Titles:', true, 2);
      push((o.secondary_job_titles || []).join(', ') || 'None found', false, 6);
      push('Job Level:', true, 2);
      push(o.job_level || '—', false, 6);
      push('Average Years of Experience:', true, 2);
      push(o.avg_years_experience || '—', false, 6);
      push('Company Size:', true, 2);
      push(o.company_size_label || '—', false, 6);
      push('Industry:', true, 2);
      push(o.industry_label || 'Not specified', false, 6);
      push('Common Tools:', true, 2);
      const tools = o.common_tools || [];
      if (tools.length === 0) push('None found', false, 4);
      else tools.forEach((t, i) => push(t.name, false, i === tools.length - 1 ? 4 : 3, t.url));

    } else if (boxKey === 'profiles') {
      const rows = persona.sample_profiles || [];
      if (rows.length === 0) push('No matching public profiles found.', false, 4);
      else rows.forEach((r, i) => push(`${r.job_title} — ${r.company}`, false, i === rows.length - 1 ? 4 : 6, r.url));

    } else if (boxKey === 'gather') {
      const rows = persona.where_they_gather || [];
      if (rows.length === 0) push('No channels found.', false, 4);
      else rows.forEach((r, i) => push(`${r.name} (${r.type})`, false, i === rows.length - 1 ? 4 : 6, r.url));

    } else if (boxKey === 'org') {
      const org = persona.org_structure || {};
      if (!org || (!org.reports_to && !org.this_role && !org.manages && !(org.stakeholders || []).length)) {
        push('No org structure data returned.', false, 4);
      } else {
        if (org.reports_to) { push('Reports To:', true, 2); push(org.reports_to, false, 6); }
        push('This Role:', true, 2);
        push(org.this_role || '—', false, 6);
        if (org.manages) { push('Manages:', true, 2); push(org.manages, false, 6); }
        const stakeholders = org.stakeholders || [];
        if (stakeholders.length > 0) {
          push('Stakeholders:', true, 2);
          stakeholders.forEach((s, i) => push(s.name, false, i === stakeholders.length - 1 ? 4 : 3, s.url));
        }
      }

    } else if (boxKey === 'work' || boxKey === 'development') {
      const items = persona[boxKey === 'work' ? 'work_priorities' : 'development_priorities'] || [];
      if (items.length === 0) push('No priorities found.', false, 4);
      else items.forEach((t, i) => push(`${i + 1}. ${t}`, false, i === items.length - 1 ? 4 : 6));
    }
    return lines;
  }

  /* --- Box measuring / pagination engine --- */

  const BOX_TITLE_BODY_GAP = 8;
  const BOX_CHROME_TOP = 35 + BOX_TITLE_BODY_GAP;
  const BOX_BOTTOM_PAD = 10;
  const BOX_PAD_X = 10;

  function measureContentHeight(doc, lines, maxWidth) {
    let h = 0;
    for (const line of lines) {
      doc.setFont('helvetica', line.bold ? 'bold' : 'normal');
      doc.setFontSize(8.5);
      h += doc.splitTextToSize(line.text, maxWidth).length * 10 + line.gapAfter;
    }
    return h;
  }

  function boxHeightForLines(doc, lines, boxWidth) {
    return BOX_CHROME_TOP + measureContentHeight(doc, lines, boxWidth - BOX_PAD_X * 2) + BOX_BOTTOM_PAD;
  }

  function splitLinesForHeight(doc, lines, maxWidth, availableHeight) {
    let consumedHeight = 0;
    let consumedCount = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      doc.setFont('helvetica', line.bold ? 'bold' : 'normal');
      doc.setFontSize(8.5);
      const lineHeight = doc.splitTextToSize(line.text, maxWidth).length * 10 + line.gapAfter;
      if (consumedCount > 0 && consumedHeight + lineHeight > availableHeight) break;
      consumedHeight += lineHeight;
      consumedCount += 1;
    }
    if (consumedCount === 0 && lines.length > 0) consumedCount = 1;
    return { chunk: lines.slice(0, consumedCount), remaining: lines.slice(consumedCount), consumedHeight };
  }

  function drawBox(doc, { x, y, w, h, title, lines, accentRgb }) {
    doc.setDrawColor(207, 198, 172);
    doc.setLineWidth(0.75);
    doc.roundedRect(x, y, w, h, 4, 4);

    doc.setFillColor(accentRgb[0], accentRgb[1], accentRgb[2]);
    doc.rect(x, y, w, 3, 'F');

    const pad = BOX_PAD_X;
    let cursorY = y + 3 + pad + 8;
    const maxWidth = w - pad * 2;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(32, 36, 43);
    doc.text(title, x + pad, cursorY);
    cursorY += 14;

    doc.setDrawColor(230, 230, 234);
    doc.line(x + pad, cursorY - 8, x + w - pad, cursorY - 8);
    cursorY += BOX_TITLE_BODY_GAP;

    const bottomLimit = y + h - 8;

    for (const line of lines) {
      if (cursorY > bottomLimit) {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(7.5);
        doc.setTextColor(150, 150, 155);
        doc.text('…', x + pad, cursorY);
        break;
      }
      doc.setFont('helvetica', line.bold ? 'bold' : 'normal');
      doc.setFontSize(8.5);
      if (line.url) doc.setTextColor(accentRgb[0], accentRgb[1], accentRgb[2]);
      else doc.setTextColor(line.bold ? 32 : 60, line.bold ? 36 : 65, line.bold ? 43 : 73);

      for (const wl of doc.splitTextToSize(line.text, maxWidth)) {
        if (cursorY > bottomLimit) break;
        if (line.url) doc.textWithLink(wl, x + pad, cursorY, { url: line.url });
        else doc.text(wl, x + pad, cursorY);
        cursorY += 10;
      }
      cursorY += line.gapAfter;
    }
  }

  function build(persona) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const MARGIN = 30;
    const GAP = 10;
    const accentRgb = ACCENT_RGB;

    const overview = persona.overview || {};
    const title = overview.primary_job_title || 'Persona';

    let y = MARGIN;

    function drawContinuationHeader() {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(32, 36, 43);
      doc.text(`Persona Draft: ${title} (continued)`, MARGIN, MARGIN + 10);
      doc.setDrawColor(accentRgb[0], accentRgb[1], accentRgb[2]);
      doc.setLineWidth(1.2);
      doc.line(MARGIN, MARGIN + 18, pageWidth - MARGIN, MARGIN + 18);
      return MARGIN + 32;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.setTextColor(32, 36, 43);
    doc.text(`Persona Draft: ${title}`, pageWidth / 2, y + 16, { align: 'center' });
    y += 26;

    doc.setDrawColor(accentRgb[0], accentRgb[1], accentRgb[2]);
    doc.setLineWidth(1.2);
    doc.line(MARGIN, y, pageWidth - MARGIN, y);
    y += 12;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(60, 65, 73);
    const infoLine = [
      `Generated: ${new Date().toLocaleString()}`,
      `Job Level: ${overview.job_level || '—'}`,
      `Company Size: ${overview.company_size_label || '—'}`,
      `Industry: ${overview.industry_label || 'Unspecified'}`
    ].join('    |    ');
    doc.text(doc.splitTextToSize(infoLine, pageWidth - MARGIN * 2), MARGIN, y);
    y += 12;

    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7.5);
    doc.setTextColor(122, 117, 101);
    doc.text('First draft only — validate with real customer conversations.', MARGIN, y);
    y += 14;

    function flowBoxLines(boxTitle, allLines) {
      const w = pageWidth - MARGIN * 2;
      let remaining = allLines.slice();
      let first = true;

      while (remaining.length > 0) {
        const availableOnPage = pageHeight - MARGIN - y;
        if (availableOnPage < BOX_CHROME_TOP + BOX_BOTTOM_PAD + 40) {
          doc.addPage();
          y = drawContinuationHeader();
          continue;
        }
        const usable = availableOnPage - BOX_CHROME_TOP - BOX_BOTTOM_PAD;
        const { chunk, remaining: rest, consumedHeight } =
          splitLinesForHeight(doc, remaining, w - BOX_PAD_X * 2, usable);
        remaining = rest;
        const boxH = BOX_CHROME_TOP + consumedHeight + BOX_BOTTOM_PAD;

        drawBox(doc, { x: MARGIN, y, w, h: boxH, title: first ? boxTitle : `${boxTitle} (Cont.)`, lines: chunk, accentRgb });
        y += boxH + GAP;
        first = false;

        if (remaining.length > 0) { doc.addPage(); y = drawContinuationHeader(); }
      }
    }

    function growRowHeightToFitPage(rowY, baselineHeight, idealHeight) {
      if (idealHeight <= baselineHeight) return baselineHeight;
      const availableOnPage = pageHeight - MARGIN - rowY - 2;
      return Math.min(idealHeight, Math.max(baselineHeight, availableOnPage));
    }

    function drawRow(keys) {
      const boxW = (pageWidth - MARGIN * 2 - GAP * (keys.length - 1)) / keys.length;
      const perBoxLines = keys.map((key) => buildPdfLines(key, persona));
      let idealHeight = 0;
      perBoxLines.forEach((lines) => {
        idealHeight = Math.max(idealHeight, boxHeightForLines(doc, lines, boxW));
      });
      const maxFreshPageHeight = pageHeight - MARGIN * 2 - 40;
      let rowHeight = Math.min(idealHeight, maxFreshPageHeight);

      if (y + rowHeight > pageHeight - MARGIN) { doc.addPage(); y = drawContinuationHeader(); }

      rowHeight = growRowHeightToFitPage(y, rowHeight, idealHeight);

      const availableContentHeight = rowHeight - BOX_CHROME_TOP - BOX_BOTTOM_PAD;
      const overflow = [];
      const chunks = keys.map((key, i) => {
        const { chunk, remaining } =
          splitLinesForHeight(doc, perBoxLines[i], boxW - BOX_PAD_X * 2, availableContentHeight);
        if (remaining.length > 0) overflow.push({ key, lines: remaining });
        return chunk;
      });

      keys.forEach((key, i) => {
        drawBox(doc, {
          x: MARGIN + i * (boxW + GAP), y, w: boxW, h: rowHeight,
          title: BOX_TITLES[key], lines: chunks[i], accentRgb
        });
      });
      y += rowHeight + GAP;

      overflow.forEach(({ key, lines }) => flowBoxLines(BOX_TITLES[key], lines));
    }

    // Mirrors the on-screen grid.
    drawRow(['overview', 'profiles', 'gather']);
    drawRow(['org', 'work', 'development']);

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i += 1) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(150, 150, 155);
      doc.text(`Mktforge · Persona Builder — Page ${i} of ${pageCount}`,
               pageWidth - MARGIN, pageHeight - 12, { align: 'right' });
    }

    const fileName = `persona-${slugify(title)}-${new Date().toISOString().slice(0, 10)}.pdf`;
    // Mktforge: download as "Persona Builder N.pdf" and keep a copy in My Company.
    if (window.MktforgeData) {
      return window.MktforgeData.savePdfDoc(doc, {
        moduleId: 'persona-builder', moduleName: 'Persona Builder', fallbackName: fileName
      });
    }
    doc.save(fileName);
  }

  return { build };
})();

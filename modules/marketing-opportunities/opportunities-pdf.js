/* ==========================================================================
   Marketing Opportunities — PDF export
   Ported from Syndication-And-Events-Finder's app.js. Same engine: a
   portrait report drawn with jsPDF + autoTable (summary table, All Results,
   then one table per category) with clickable "Visit Site" cells. Colors
   are remapped onto Mktforge's green.

   The module loads jsPDF and autoTable on demand, then calls
   MktforgeOpportunitiesPdf.build(run, { CATEGORY_LABELS, CATEGORY_ORDER, safeUrl }).
   ========================================================================== */

window.MktforgeOpportunitiesPdf = (function () {

  const MARGIN = 40;
  const INK    = [32, 36, 43];     // --ink
  const MUTED  = [122, 117, 101];  // --muted
  const LINE   = [207, 198, 172];  // --paper-line
  const ACCENT = [47, 111, 78];    // --accent
  const TINT   = [246, 241, 230];  // --paper

  function slugify(str) {
    return String(str || '')
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'results';
  }

  // autoTable draws the "Visit Site" text; this layers a real link on top.
  // Only the link column's raw value is an object with a `url`.
  function addLinkCell(doc, data) {
    if (data.cell.section !== 'body') return;
    const raw = data.cell.raw;
    const url = raw && typeof raw === 'object' ? raw.url : null;
    if (!url) return;
    doc.link(data.cell.x, data.cell.y, data.cell.width, data.cell.height, { url });
  }

  function addSectionTable(doc, { title, head, rows, startY }) {
    const pageWidth = doc.internal.pageSize.getWidth();
    const inner = pageWidth - MARGIN * 2;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...INK);
    doc.text(title, MARGIN, startY);

    if (rows.length === 0) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(10);
      doc.setTextColor(...MUTED);
      doc.text('No Relevant Results Found', MARGIN, startY + 16);
      return startY + 34;
    }

    doc.autoTable({
      startY: startY + 8,
      margin: { left: MARGIN, right: MARGIN },
      head: [head],
      body: rows,
      theme: 'grid',
      styles: { fontSize: 9, cellPadding: 5, overflow: 'linebreak', valign: 'middle', lineColor: LINE, textColor: INK },
      headStyles: { fillColor: ACCENT, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: TINT },
      columnStyles: head.length === 3
        ? { 0: { cellWidth: inner * 0.42 }, 1: { cellWidth: inner * 0.28 }, 2: { textColor: ACCENT } }
        : { 0: { cellWidth: inner * 0.65 }, 1: { textColor: ACCENT } },
      didDrawCell: (data) => addLinkCell(doc, data)
    });

    return doc.lastAutoTable.finalY + 24;
  }

  function build(run, { CATEGORY_LABELS, CATEGORY_ORDER, safeUrl }) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
    if (typeof doc.autoTable !== 'function') throw new Error('jsPDF autoTable plugin not loaded');

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    let y = 56;

    /* The address is printed, not hidden behind "Visit Site". A report that
       gets printed, emailed or read by an agent has to carry its links as
       text — a clickable rectangle is worth nothing to any of them. */
    const toRows = (items, withChannel) => items.map((i) => {
      const url = safeUrl(i.url);
      const link = { content: url || 'N/A', url };
      return withChannel
        ? [i.name || 'Untitled', i.channel || '', link]
        : [i.name || 'Untitled', link];
    });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(...INK);
    doc.text('Marketing Opportunities — Results', MARGIN, y);
    y += 22;

    doc.setDrawColor(...LINE);
    doc.line(MARGIN, y, pageWidth - MARGIN, y);
    y += 24;

    doc.autoTable({
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      body: [
        ['Company', run.companyName ? `${run.companyName} (${run.companyUrl})` : run.companyUrl],
        ['Job Titles Provided', run.jobTitles.join(', ') || 'N/A'],
        ['Industry Provided', run.industry || 'N/A'],
        ['Generated', new Date().toLocaleString()]
      ],
      theme: 'plain',
      styles: { fontSize: 10, cellPadding: 4 },
      columnStyles: {
        0: { fontStyle: 'bold', textColor: MUTED, cellWidth: 130 },
        1: { textColor: INK }
      }
    });
    y = doc.lastAutoTable.finalY + 28;

    y = addSectionTable(doc, {
      title: 'All Results',
      head: ['Name', 'Channel', 'Link'],
      rows: toRows(run.allResults || [], true),
      startY: y
    });

    CATEGORY_ORDER.forEach((key) => {
      if (y > pageHeight - 120) { doc.addPage(); y = 56; }
      y = addSectionTable(doc, {
        title: CATEGORY_LABELS[key],
        head: ['Name', 'Link'],
        rows: toRows((run.results && run.results[key]) || [], false),
        startY: y
      });
    });

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i += 1) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 155);
      doc.text(`Page ${i} of ${pageCount}`, pageWidth - MARGIN, pageHeight - 20, { align: 'right' });
    }

    const fileName = `marketing-opportunities-${slugify(run.companyName || run.companyUrl)}.pdf`;
    // Mktforge: download as "Marketing Opportunities N.pdf" and keep a copy in My Company.
    if (window.MktforgeData) {
      return window.MktforgeData.savePdfDoc(doc, {
        moduleId: 'marketing-opportunities', moduleName: 'Marketing Opportunities', fallbackName: fileName
      });
    }
    doc.save(fileName);
  }

  return { build };
})();

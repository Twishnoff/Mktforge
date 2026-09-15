/* ==========================================================================
   Find My Customer — PDF export
   Ported from Customer-Intelligence's app.js. Same engine: a document drawn
   directly with jsPDF + autoTable (summary table, then one section per box)
   rather than a screenshot. Colors are remapped onto Mktforge's green.

   The module loads jsPDF and autoTable on demand, then calls
   MktforgeCustomerPdf.build({ companyUrl, customerList, jobTitles,
   painPoints, topNeeds }).
   ========================================================================== */

window.MktforgeCustomerPdf = (function () {

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
      .slice(0, 40) || 'company';
  }

  function heading(doc, title, y) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...INK);
    doc.text(title, MARGIN, y);
  }

  function emptyLine(doc, text, y) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    doc.setTextColor(...MUTED);
    doc.text(text, MARGIN, y);
  }

  function ensureRoom(doc, y, needed) {
    if (y > doc.internal.pageSize.getHeight() - needed) {
      doc.addPage();
      return 56;
    }
    return y;
  }

  function addTableSection(doc, { title, head, rows, emptyText, startY }) {
    heading(doc, title, startY);

    if (rows.length === 0) {
      emptyLine(doc, emptyText, startY + 16);
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
      alternateRowStyles: { fillColor: TINT }
    });

    return doc.lastAutoTable.finalY + 24;
  }

  // Grouped bullet lists — Pain Points / Initiatives and Top Needs are both
  // collections of { jobTitle, points } groups.
  function addBulletSection(doc, { title, groups, startY }) {
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const contentWidth = pageWidth - MARGIN * 2;
    let y = startY;

    heading(doc, title, y);
    y += 20;

    const valid = (groups || []).filter((g) => g && g.jobTitle);
    if (valid.length === 0) {
      emptyLine(doc, 'No Data', y);
      return y + 26;
    }

    valid.forEach((group) => {
      if (y > pageHeight - 100) { doc.addPage(); y = 56; }

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.setTextColor(...ACCENT);
      doc.text(String(group.jobTitle), MARGIN, y);
      y += 16;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(...INK);

      const points = group.points && group.points.length ? group.points : ['No Data'];
      points.forEach((point) => {
        doc.splitTextToSize(`•  ${point}`, contentWidth - 10).forEach((line) => {
          if (y > pageHeight - 60) { doc.addPage(); y = 56; }
          doc.text(line, MARGIN + 6, y);
          y += 13;
        });
      });
      y += 10;
    });

    return y + 10;
  }

  function build(run) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
    if (typeof doc.autoTable !== 'function') throw new Error('jsPDF autoTable plugin not loaded');

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    let y = 56;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(...INK);
    doc.text('Find My Customer — Results', MARGIN, y);
    y += 22;

    doc.setDrawColor(...LINE);
    doc.line(MARGIN, y, pageWidth - MARGIN, y);
    y += 24;

    doc.autoTable({
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      body: [
        ['Company URL', run.companyUrl],
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

    const list = run.customerList || {};
    const customers = list.found && list.customers ? list.customers : [];
    y = addTableSection(doc, {
      title: 'Customer List',
      head: ['Customer', 'Size', 'Industry'],
      rows: customers.map((c) => [c.name || 'Untitled', c.size || 'N/A', c.industry || 'N/A']),
      emptyText: 'No Customers Found',
      startY: y
    });

    y = ensureRoom(doc, y, 120);
    y = addTableSection(doc, {
      title: 'Job Titles',
      head: ['Job Title'],
      rows: (run.jobTitles || []).map((t) => [t]),
      emptyText: 'No Data',
      startY: y
    });

    y = ensureRoom(doc, y, 120);
    y = addBulletSection(doc, { title: 'Pain Points / Initiatives', groups: run.painPoints, startY: y });

    y = ensureRoom(doc, y, 120);
    addBulletSection(doc, { title: 'Top Needs', groups: run.topNeeds, startY: y });

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i += 1) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 155);
      doc.text(`Page ${i} of ${pageCount}`, pageWidth - MARGIN, pageHeight - 20, { align: 'right' });
    }

    doc.save(`find-my-customer-${slugify(run.companyUrl)}.pdf`);
  }

  return { build };
})();

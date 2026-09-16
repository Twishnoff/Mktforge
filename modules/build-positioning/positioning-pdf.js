/* ==========================================================================
   Build Positioning — PDF export
   A text-first portrait report drawn with jsPDF (loaded on the first click).
   Everything on the page is real text, so later modules can read it back
   out of Saved Resources.

   MktforgePositioningPdf.build(run, { questions, boxes, sourceLabels })
   ========================================================================== */

window.MktforgePositioningPdf = (function () {

  const ACCENT = [47, 111, 78];      // Mktforge green
  const INK = [32, 36, 43];
  const SOFT = [95, 99, 106];
  const LINE = [207, 198, 172];
  const MARGIN = 48;

  // The built-in Helvetica only covers Windows-1252; swap the usual
  // stragglers and drop anything else rather than print garbage.
  const WIN1252_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
  function pdfSafe(s) {
    return String(s)
      .replace(/[→⇒]/g, '->').replace(/[←]/g, '<-').replace(/[≥]/g, '>=').replace(/[≤]/g, '<=')
      .replace(/[\u2010\u2011\u2012]/g, '-').replace(/[\u00A0\u2009\u202F]/g, ' ')
      .replace(/[\u2032]/g, "'").replace(/[\u2033]/g, '"')
      .split('').filter((ch) => ch.charCodeAt(0) < 256 || WIN1252_EXTRA.includes(ch)).join('');
  }

  function build(run, { questions, boxes, sourceLabels }) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const width = W - MARGIN * 2;
    let y = MARGIN;

    const input = run.input || {};
    const company = input.companyName || input.companyUrl || 'Your company';
    const competitor = input.competitorName || input.competitorHost || 'Closest competitor';

    function ensure(h) {
      if (y + h <= H - MARGIN - 14) return;
      doc.addPage();
      y = MARGIN;
    }

    function text(str, { size = 10, bold = false, color = INK, indent = 0, gap = 4, lh = 1.35 } = {}) {
      const s = pdfSafe(str == null ? '' : str).trim();
      if (!s) return;
      doc.setFont('helvetica', bold ? 'bold' : 'normal');
      doc.setFontSize(size);
      doc.setTextColor(...color);
      const lines = doc.splitTextToSize(s, width - indent);
      const step = size * lh;
      lines.forEach((ln) => {
        ensure(step);
        doc.text(ln, MARGIN + indent, y + size);
        y += step;
      });
      y += gap;
    }

    function bullets(items, { numbered = false, prefix = '' } = {}) {
      (items || []).filter(Boolean).forEach((item, i) => {
        text(`${numbered ? `${i + 1}.` : '•'} ${prefix}${item}`, { indent: 10, gap: 2 });
      });
      y += 4;
    }

    function label(str) { text(str, { size: 9, bold: true, color: SOFT, gap: 2 }); }

    function heading(str, stage) {
      ensure(40);
      y += 8;
      doc.setDrawColor(...LINE);
      doc.setLineWidth(0.8);
      doc.line(MARGIN, y, W - MARGIN, y);
      y += 10;
      if (stage) text(stage.toUpperCase(), { size: 8, bold: true, color: ACCENT, gap: 0 });
      text(str, { size: 15, bold: true, gap: 6 });
    }

    /* --- title block --- */
    doc.setFillColor(...ACCENT);
    doc.rect(0, 0, W, 6, 'F');
    text('Build Positioning · Positioning (Stages 0–5)', { size: 9, bold: true, color: ACCENT, gap: 2 });
    text(`${company} vs. ${competitor}`, { size: 20, bold: true, gap: 6 });
    const date = new Date(run.generatedAt || Date.now()).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    text([
      `Primary Champion: ${input.champion || '—'}`,
      `Closest Competitor: ${input.competitorUrl || '—'}`,
      `Target Industry: ${input.industry || 'Any'}`,
      `Company URL: ${input.companyUrl || '—'}`,
      `Generated: ${date}`
    ].join('   ·   '), { size: 9, color: SOFT, gap: 4 });
    text('Draft positioning — a hypothesis to test with real buyers before writing copy.', { size: 9, color: SOFT, gap: 2 });
    if (run.contextNote) text(`Sources: ${run.contextNote}`, { size: 9, color: SOFT, gap: 2 });

    const st = run.stages || {};
    const titles = {};
    const stages = {};
    boxes.forEach((b) => { titles[b.key] = b.title; stages[b.key] = b.stage; });

    /* --- summary first, so a reader (or the next module) gets the answer --- */
    const cat = st.category || {};
    if (cat.positioning_summary) {
      heading('Positioning Summary');
      text(cat.positioning_summary, { size: 11 });
      if (cat.category_recommendation && cat.category_recommendation.name) {
        text(`Recommended category: ${cat.category_recommendation.name} (${cat.category_recommendation.type})`, { bold: true });
      }
    }

    /* --- Stage 0 --- */
    const a = st.audit;
    if (a) {
      heading(titles.audit, stages.audit);
      [['company_name', 'company_profile'], ['competitor_name', 'competitor_profile']].forEach(([n, p]) => {
        const prof = a[p] || {};
        text(a[n] || (p === 'company_profile' ? company : competitor), { size: 11, bold: true, gap: 2 });
        if (prof.what_it_is) text(`What it is: ${prof.what_it_is}`, { gap: 2 });
        if (prof.who_it_serves) text(`Who it serves: ${prof.who_it_serves}`, { gap: 2 });
        if ((prof.key_features || []).length) { label('Key features'); bullets(prof.key_features); }
        if ((prof.headline_claims || []).length) { label('Headline claims'); bullets(prof.headline_claims); }
        if (prof.tone) text(`Tone: ${prof.tone}`, { color: SOFT });
      });
      label(`Champion priorities (${a.title_priorities_source === 'saved_resource' ? 'from saved report' : 'researched'})`);
      bullets(a.title_priorities, { numbered: true });
      label(`Input gaps — overall confidence: ${a.overall_confidence}`);
      bullets((a.input_gaps || []).map((g) => `${g.input}${g.impact ? ` — ${g.impact}` : ''} [${g.confidence}]`));
      if (a.confidence_note) text(a.confidence_note, { color: SOFT });
    }

    /* --- Stage 1 --- */
    if (st.alternatives) {
      heading(titles.alternatives, stages.alternatives);
      (st.alternatives.alternatives || []).forEach((x) => {
        text(`${x.name} (${x.type === 'status_quo' ? 'status quo' : 'competitor'})`, { size: 11, bold: true, gap: 2 });
        if (x.why_chosen) text(x.why_chosen, { gap: 2 });
        if ((x.shortcomings || []).length) { label('Where it falls short'); bullets(x.shortcomings); }
      });
    }

    /* --- Stage 2 --- */
    const d = st.differentiators;
    if (d) {
      heading(titles.differentiators, stages.differentiators);
      if (d.differentiation_warning) text(`Weak differentiation: ${d.differentiation_warning}`, { bold: true });
      (d.differentiators || []).forEach((x) => {
        text(x.attribute, { size: 11, bold: true, gap: 2 });
        const meta = [(x.versus || []).length ? `vs. ${x.versus.join(', ')}` : '', `Source: ${sourceLabels[x.source] || x.source}`]
          .filter(Boolean).join('   ·   ');
        text(meta, { size: 9, color: SOFT, gap: 2 });
        if (x.evidence) text(x.evidence);
      });
      if ((d.roadmap_not_counted || []).length) { label('Not counted (not live yet)'); bullets(d.roadmap_not_counted); }
    }

    /* --- Stage 3 --- */
    const v = st.value;
    if (v) {
      heading(titles.value, stages.value);
      if ((v.value_themes || []).length) {
        label('Value themes');
        v.value_themes.forEach((t) => {
          text(`${t.theme}: ${t.summary}`, { bold: false, gap: 2 });
          bullets(t.benefits);
        });
      }
      label('Value ladder');
      (v.value_map || []).forEach((m) => {
        text(m.feature, { size: 11, bold: true, gap: 2 });
        text(`Lets them: ${m.capability}`, { indent: 10, gap: 1 });
        text(`So they get: ${m.benefit}`, { indent: 10, gap: 1 });
        text(`Matters because: ${m.priority}`, { indent: 10, gap: 6 });
      });
    }

    /* --- Stage 4 --- */
    const c = st.champion;
    if (c) {
      heading(titles.champion, stages.champion);
      const ch = c.champion || {};
      const seg = c.best_fit_segment || {};
      if (ch.title) text(`Champion: ${ch.title}`, { gap: 2 });
      if (ch.budget_holder) text(`Budget holder: ${ch.budget_holder}`, { gap: 2 });
      if (ch.company_type) text(`Company type: ${ch.company_type}`, { gap: 2 });
      if (seg.description) text(`Best-fit segment: ${seg.description}`, { gap: 2 });
      if (seg.why) text(seg.why, { color: SOFT });
      label('Triggers'); bullets(ch.triggers);
      label('Pains (most painful first)'); bullets(ch.pains, { numbered: true });
      label('Tasks it helps with'); bullets(ch.tasks);
      label('Tasks it doesn’t touch'); bullets(ch.tasks_excluded, { prefix: 'NOT: ' });
    }

    /* --- Stage 5 --- */
    if (st.category) {
      heading(titles.category, stages.category);
      if (cat.first_glance_comparison) text(cat.first_glance_comparison);
      (cat.category_options || []).forEach((o) => {
        const picked = cat.category_recommendation && cat.category_recommendation.name === o.name;
        text(`${o.name} — ${o.type}${picked ? ' (recommended)' : ''}`, { size: 11, bold: true, gap: 2 });
        if (o.helps) text(`Helps: ${o.helps}`, { indent: 10, gap: 1 });
        if (o.hurts) text(`Hurts: ${o.hurts}`, { indent: 10, gap: 6 });
      });
      if (cat.category_recommendation && cat.category_recommendation.rationale) {
        label('Why');
        text(cat.category_recommendation.rationale);
      }
      if ((cat.next_questions || []).length) { label('Check with real buyers'); bullets(cat.next_questions); }
    }

    /* --- the answers the run used --- */
    const answers = run.answers || {};
    const answered = questions.filter((x) => answers[x.id]);
    if (answered.length) {
      heading('Your Answers (inputs used)');
      answered.forEach((x) => {
        text(x.text, { bold: true, gap: 2 });
        text(answers[x.id], { gap: 8 });
      });
    }

    /* --- footer --- */
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i += 1) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...SOFT);
      doc.text(`Mktforge · Build Positioning — Page ${i} of ${pages}`, W - MARGIN, H - 24, { align: 'right' });
    }

    const fallbackName = `positioning-${String(input.champion || 'draft').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${new Date().toISOString().slice(0, 10)}.pdf`;
    if (window.MktforgeData) {
      return window.MktforgeData.savePdfDoc(doc, { moduleId: 'build-positioning', moduleName: 'Build Positioning', fallbackName });
    }
    doc.save(fallbackName);
    return null;
  }

  return { build };
})();

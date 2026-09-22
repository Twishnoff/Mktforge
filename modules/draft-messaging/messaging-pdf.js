/* ==========================================================================
   Draft Messaging — PDF export
   A text-first portrait report drawn with jsPDF (loaded on the first click),
   built the same way as the Build Positioning report so the two read as one
   set. Everything on the page is real text, so a later module can read it
   back out of Saved Resources.

   It prints what the page shows — the messaging hierarchy and the homepage
   draft. The strategic narrative (stage 6) and the quality scorecard
   (stage 9) are working material and stay out of it, as they do on screen.

   MktforgeMessagingPdf.build(run, { boxes })
   ========================================================================== */

window.MktforgeMessagingPdf = (function () {

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
      .replace(/[‐‑‒]/g, '-').replace(/[   ]/g, ' ')
      .replace(/[′]/g, "'").replace(/[″]/g, '"')
      .split('').filter((ch) => ch.charCodeAt(0) < 256 || WIN1252_EXTRA.includes(ch)).join('');
  }

  function build(run, { boxes } = {}) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const width = W - MARGIN * 2;
    let y = MARGIN;

    const input = run.input || {};
    const sources = run.sources || {};
    const st = run.stages || {};
    const titles = {};
    const stages = {};
    (boxes || []).forEach((b) => { titles[b.key] = b.title; stages[b.key] = b.stage; });

    const company = input.companyName || 'Your company';

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

    function subheading(str) { text(str, { size: 12, bold: true, gap: 4 }); }

    const proofTag = (status) => (status === 'real' ? '' : '[Placeholder — proof to collect] ');

    /* --- title block --- */
    doc.setFillColor(...ACCENT);
    doc.rect(0, 0, W, 6, 'F');
    text('Draft Messaging · Messaging & Homepage Copy (Stages 6–9)', { size: 9, bold: true, color: ACCENT, gap: 2 });
    text(company, { size: 20, bold: true, gap: 6 });
    const date = new Date(run.generatedAt || Date.now()).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    text([
      `Primary Champion: ${input.champion || '—'}`,
      `Category: ${input.category || '—'}`,
      `Closest Competitor: ${input.competitorName || '—'}`,
      `Generated: ${date}`
    ].join('   ·   '), { size: 9, color: SOFT, gap: 4 });
    text('First-draft copy — a hypothesis to test with real buyers, and a foundation to write from, not finished copy.',
      { size: 9, color: SOFT, gap: 2 });
    if (sources.positioning) {
      const from = [`Positioning: ${sources.positioning}`];
      if ((sources.files || []).length) from.push(`Your research: ${sources.files.join(', ')}`);
      text(`Built from — ${from.join('   ·   ')}`, { size: 9, color: SOFT, gap: 2 });
    }
    if (run.passed === false) {
      text(run.checked === false
        ? 'Note: the stage 9 quality check did not finish on this run, so this draft has not been checked. Read it closely before using it.'
        : 'Note: the stage 9 quality check still had notes after three passes. Read this closely before using it.',
        { size: 9, bold: true, color: SOFT, gap: 2 });
    }

    /* --- Stage 7 — messaging hierarchy --- */
    const h = st.hierarchy;
    if (h) {
      heading(titles.hierarchy || 'Messaging Hierarchy', stages.hierarchy || 'Stage 7');

      if (h.value_prop) {
        label('Value proposition');
        text(h.value_prop, { size: 12 });
      }
      if (h.positioning_statement) {
        label('Positioning statement (internal only — never ship as copy)');
        text(h.positioning_statement);
      }

      (h.pillars || []).forEach((p, i) => {
        subheading(`Pillar ${i + 1} — ${p.headline}`);
        if (p.pain) text(`Answers: ${p.pain}`, { gap: 2 });
        if ((p.capabilities || []).length) { label('Capabilities'); bullets(p.capabilities); }
        if (p.proof) text(`Proof: ${proofTag(p.proof_status)}${p.proof}`, { gap: 6 });
      });

      if (h.one_liner || h.elevator_pitch || h.boilerplate) {
        label('Short forms');
        if (h.one_liner) { text('One-liner', { bold: true, gap: 1 }); text(h.one_liner, { indent: 10 }); }
        if (h.elevator_pitch) { text('30-second pitch', { bold: true, gap: 1 }); text(h.elevator_pitch, { indent: 10 }); }
        if (h.boilerplate) { text('Boilerplate', { bold: true, gap: 1 }); text(h.boilerplate, { indent: 10 }); }
      }

      if ((h.competitive_talk_track || []).length) {
        label('Competitive talk track');
        h.competitive_talk_track.forEach((t) => {
          text(`${t.alternative}${t.type === 'status_quo' ? ' (status quo)' : ''}`, { size: 11, bold: true, gap: 2 });
          if (t.unlike_line) text(t.unlike_line, { indent: 10, gap: 1 });
          if (t.objection) text(`They'll say: ${t.objection}`, { indent: 10, gap: 1 });
          if (t.response) text(`You say: ${t.response}`, { indent: 10, gap: 6 });
        });
      }
    }

    /* --- Stage 8 — homepage copy --- */
    const p = st.homepage;
    if (p) {
      heading(titles.homepage || 'Drafted Homepage Copy', stages.homepage || 'Stage 8');
      const hero = p.hero || {};
      const problem = p.problem || {};
      const intro = p.solution_intro || {};
      const proof = p.proof || {};
      const close = p.closing_cta || {};

      if (hero.headline || hero.subhead) {
        label('Hero');
        text(hero.headline, { size: 16, bold: true, gap: 3 });
        if (hero.subhead) text(hero.subhead, { size: 11, gap: 3 });
        const ctas = [hero.cta, hero.cta_secondary].filter(Boolean);
        if (ctas.length) text(`Call to action: ${ctas.join('   ·   ')}`, { size: 9, color: SOFT, gap: 3 });
        if (hero.headline_variant_b) text(`Variant B to test: ${hero.headline_variant_b}`, { gap: 6 });
      }

      if (problem.heading || problem.body || (problem.bullets || []).length) {
        label('Problem');
        if (problem.heading) subheading(problem.heading);
        if (problem.body) text(problem.body);
        bullets(problem.bullets);
      }

      if (intro.heading || intro.body) {
        label('Solution intro');
        if (intro.heading) subheading(intro.heading);
        if (intro.body) text(intro.body);
      }

      if ((p.value_props || []).length) {
        label('Value props');
        p.value_props.forEach((v) => {
          if (v.heading) subheading(v.heading);
          if (v.body) text(v.body);
          bullets(v.bullets);
        });
      }

      if ((proof.items || []).length) {
        label('Proof');
        if (proof.heading) subheading(proof.heading);
        proof.items.forEach((i) => {
          text(`• ${proofTag(i.status)}${i.text}${i.source ? ` — ${i.source}` : ''}`, { indent: 10, gap: 2 });
        });
        y += 4;
      }

      if (close.heading || close.cta) {
        label('Closing call to action');
        if (close.heading) subheading(close.heading);
        if (close.body) text(close.body);
        if (close.cta) text(`Call to action: ${close.cta}`, { size: 9, color: SOFT });
      }

      if ((p.words_borrowed_from_customers || []).length) {
        label('Words borrowed from your customers');
        bullets(p.words_borrowed_from_customers);
      }
    }

    /* --- what the run was built from --- */
    if (sources.positioning || (sources.files || []).length) {
      heading('Inputs Used');
      text(`Positioning document: ${sources.positioning || '—'}`, { gap: 2 });
      if ((sources.files || []).length) {
        label('Your research');
        bullets(sources.files);
      } else {
        text('Additional research: none added for this run.', { color: SOFT });
      }
      if ((sources.unread || []).length) {
        label('Could not be read');
        bullets(sources.unread);
      }
    }

    /* --- footer --- */
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i += 1) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...SOFT);
      doc.text(`Mktforge · Draft Messaging — Page ${i} of ${pages}`, W - MARGIN, H - 24, { align: 'right' });
    }

    const fallbackName = `messaging-${String(input.champion || 'draft').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${new Date().toISOString().slice(0, 10)}.pdf`;
    if (window.MktforgeData) {
      return window.MktforgeData.savePdfDoc(doc, { moduleId: 'draft-messaging', moduleName: 'Draft Messaging', fallbackName });
    }
    doc.save(fallbackName);
    return null;
  }

  return { build };
})();

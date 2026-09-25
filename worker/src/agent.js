/**
 * agent.js — the By Job Title drafting agent for Target Messaging.
 *
 * Follows the "By Job Title" instructions, in order:
 *
 *   1. Personas   Persona Builder PDFs whose Primary or Secondary Job Titles
 *                 match the submitted title qualify. Whole document is read;
 *                 "Their Immediate Work Priorities" outranks "Their
 *                 Development Priorities". Their secondary titles become the
 *                 "relevant secondary job titles".
 *   2. Battle     Battle Card PDFs whose Target Job Title is the submitted
 *      cards      title or one of those secondary titles qualify. "Top
 *                 Prospect Initiatives", "Our Key Features" and "Where We
 *                 Win" (empty boxes ignored) rank above the persona's
 *                 Immediate Work Priorities. Points that show up in both a
 *                 battle card and a persona are marked most important.
 *   3. Chosen     Files the user chose or uploaded in the module are treated
 *      sources    as the newest, most accurate information.
 *   4. Rank       Up to 10 challenges/initiatives by how often they come up,
 *                 then re-ranked by how well the company's real products /
 *                 features solve them. At least 3 if at all possible.
 *                 Nothing invented: every solution must be backed by a
 *                 company document or the company website.
 *   5. Write      Top 3 → a bullet each, in the company's own voice (imported
 *                 files, Build Positioning / Draft Messaging files, website,
 *                 plus any testimonial from this title), then the cold email
 *                 and the landing page copy.
 *
 * Calls: one quick title-matching pass (Haiku), one research/ranking pass
 * and one writing pass (Sonnet).
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_FAST_MODEL = "claude-haiku-4-5-20251001";
const RETRYABLE = new Set([429, 500, 502, 503, 524, 529]);
const RETRY_DELAYS_MS = [2000, 5000, 10000];
const MAX_OUTPUT_TOKENS = 16000;

const HEAD_CHARS = 5000;          // what the title-matching pass sees of each PDF
const STYLE_CHARS = 60000;        // voice material for the writing pass
const STYLE_MODULES = new Set(["build-positioning", "draft-messaging"]);

export class AgentError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Claude
 * ------------------------------------------------------------------ */

async function post(env, body) {
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt < RETRY_DELAYS_MS.length) { await sleep(RETRY_DELAYS_MS[attempt]); continue; }
      throw new Error(`Anthropic request failed: ${err && err.message}`);
    }
    if (res.ok) return res.json();
    const detail = await res.text().catch(() => "");
    if (RETRYABLE.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
      console.warn(`Anthropic ${res.status}, retrying:`, detail.slice(0, 200));
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    throw new Error(`Anthropic API error ${res.status}: ${detail.slice(0, 500)}`);
  }
}

async function ask(env, { system, user, maxTokens = 4000, model }) {
  const data = await post(env, {
    model: model || env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  return { text, stop: data.stop_reason };
}

function extractJson(text) {
  const t = String(text || "");
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : t;
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

/* JSON out of Claude. A reply cut off at max_tokens is retried with more
   room; anything else unparseable gets one repair pass. */
async function askJson(env, opts) {
  let maxTokens = opts.maxTokens || 4000;
  let text = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const r = await ask(env, { ...opts, maxTokens });
    text = r.text;
    const parsed = extractJson(text);
    if (parsed) return parsed;
    console.warn(`askJson: unparseable reply (stop=${r.stop}, max_tokens=${maxTokens}, length=${text.length})`);
    if (r.stop !== "max_tokens" || maxTokens >= MAX_OUTPUT_TOKENS) break;
    maxTokens = Math.min(MAX_OUTPUT_TOKENS, maxTokens * 2);
  }
  const repaired = await ask(env, {
    system: "You repair malformed JSON. Reply with the corrected JSON object only, no commentary.",
    user: text.slice(0, 60000),
    maxTokens: MAX_OUTPUT_TOKENS,
    model: env.FAST_MODEL || DEFAULT_FAST_MODEL,
  });
  const again = extractJson(repaired.text);
  if (!again) throw new Error("Model did not return valid JSON");
  return again;
}

/* ------------------------------------------------------------------ *
 * Title matching
 * ------------------------------------------------------------------ */

const TITLE_WORDS = [
  [/\bvp\b/g, "vice president"], [/\bsvp\b/g, "senior vice president"], [/\bevp\b/g, "executive vice president"],
  [/\bsr\b/g, "senior"], [/\bjr\b/g, "junior"], [/\bmgr\b/g, "manager"], [/\bdir\b/g, "director"],
  [/\bmktg\b/g, "marketing"], [/\bops\b/g, "operations"], [/\beng\b/g, "engineering"],
  [/\bhr\b/g, "human resources"], [/\bit\b/g, "information technology"],
];

export function normTitle(t) {
  let s = String(t || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ");
  for (const [re, to] of TITLE_WORDS) s = s.replace(re, to);
  return s.replace(/\b(of|the|for|and)\b/g, " ").replace(/\s+/g, " ").trim();
}

const sameTitle = (a, b) => { const x = normTitle(a); return !!x && x === normTitle(b); };

/* One quick pass reads the top of every Persona Builder and Battle Card PDF
   and pulls out the titles each was written for. Matching is then done here,
   so it's the same every run. */
async function readTitles(env, personas, cards) {
  if (!personas.length && !cards.length) return { personas: [], cards: [] };
  const block = (f, i, kind) =>
    `<document kind="${kind}" index="${i}" name="${f.name}">\n${f.text.slice(0, HEAD_CHARS)}\n</document>`;
  const user = [
    ...personas.map((f, i) => block(f, i, "persona")),
    ...cards.map((f, i) => block(f, i, "battlecard")),
    "",
    "For every persona document: copy the Primary Job Title and the Secondary Job Titles exactly as written.",
    "For every battlecard document: copy the Target Job Title exactly as written (it follows \"Target Job Title:\").",
    "Text was extracted from PDFs, so columns may be interleaved; use the labels to find the values. Use \"\" or [] when a value isn't there.",
    'Reply with JSON only: {"personas":[{"index":0,"primary":"","secondary":[""]}],"battlecards":[{"index":0,"target":""}]}',
  ].join("\n\n");
  const out = await askJson(env, {
    system: "You extract labelled fields from documents precisely. You never guess a value that isn't in the text.",
    user,
    maxTokens: 3000,
    model: env.FAST_MODEL || DEFAULT_FAST_MODEL,
  });
  const p = Array.isArray(out.personas) ? out.personas : [];
  const c = Array.isArray(out.battlecards) ? out.battlecards : [];
  return {
    personas: personas.map((f, i) => {
      const hit = p.find((x) => Number(x.index) === i) || {};
      return {
        file: f,
        primary: String(hit.primary || "").trim(),
        secondary: (Array.isArray(hit.secondary) ? hit.secondary : []).map((s) => String(s || "").trim()).filter(Boolean),
      };
    }),
    cards: cards.map((f, i) => {
      const hit = c.find((x) => Number(x.index) === i) || {};
      return { file: f, target: String(hit.target || "").trim() };
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Prompt pieces
 * ------------------------------------------------------------------ */

const doc = (f, attrs = "") =>
  `<document name="${f.name}"${f.date ? ` date="${f.date}"` : ""}${attrs}>\n${f.text}\n</document>`;

function websiteBlock(site) {
  if (!site || !site.pages || !site.pages.length) return "";
  return site.pages.map((p) => `<webpage url="${p.url}"${p.title ? ` title="${p.title.replace(/"/g, "'")}"` : ""}>\n${p.text}\n</webpage>`).join("\n\n");
}

const RESEARCH_SYSTEM = `You are a B2B product-marketing researcher inside Mktforge. You work out what one job title cares about most and which of the user's company's real products, features and services address it.

Absolute rules:
- Never invent anything: not a challenge, not a feature, not a capability, not a customer, not a number. Every challenge must come from the documents provided. Every solution must be something the company's own documents or its website say the company offers.
- If the company's materials don't show a way to address a challenge, say so (fit "none") rather than stretching.
- Quotes you return must be copied exactly from the material.
- Reply with JSON only.`;

function researchPrompt({ jobTitle, companyName, related, personas, cards, selected, site }) {
  const parts = [];
  parts.push(`Company: ${companyName || "(unnamed — infer from the materials)"}`);
  parts.push(`Submitted Job Title: ${jobTitle}`);
  parts.push(`Relevant secondary job titles (from the qualifying personas): ${related.length ? related.join("; ") : "none"}`);

  parts.push(`## 1. Qualifying Persona Builder documents (${personas.length})
Each was written for the submitted job title (it is the Primary or a Secondary Job Title). Read each whole document, and completely review the "Their Immediate Work Priorities" box and the "Their Development Priorities" box. Immediate Work Priorities count for more than Development Priorities when judging what this title cares about.`);
  parts.push(personas.length ? personas.map((f) => doc(f, ' source="persona"')).join("\n\n") : "(none)");

  parts.push(`## 2. Qualifying Battle Card Generator documents (${cards.length})
Each has a Target Job Title equal to the submitted title or one of the relevant secondary titles. Use the "Top Prospect Initiatives", "Our Key Features" and "Where We Win" boxes. Ignore any of those boxes that has nothing in it beyond its title. This content ranks ABOVE the personas' Immediate Work Priorities. Compare it with the persona content: any points that talk about the same thing are marked most important ("corroborated": true). The text was extracted from a landscape PDF, so boxes may be interleaved; use the box titles to tell them apart.`);
  parts.push(cards.length ? cards.map((f) => doc(f, ' source="battlecard"')).join("\n\n") : "(none)");

  parts.push(`## 3. Sources the user chose for this run (${selected.length})
Treat these as the most recent and most accurate information available. Read each one for (a) what the submitted title (or relevant secondary titles) cares about — its most important pain points and workplace initiatives — and (b) the company's products, features and services that address them. Where they conflict with sections 1–2, these win.`);
  parts.push(selected.length ? selected.map((f) => doc(f, ` source="${f.origin === "imported" ? "imported" : `generated:${f.moduleId || "mktforge"}`}"`)).join("\n\n") : "(none)");

  parts.push(`## 4. Company website${site && site.pages && site.pages.length ? "" : " (not used for this run)"}
Use for what the company sells and how it describes it, and look for testimonials or case studies quoting someone with the submitted title or a relevant secondary title.`);
  const web = websiteBlock(site);
  if (web) parts.push(web);

  parts.push(`## Your task
1. Build a list of up to 10 work challenges / initiatives the submitted title (and relevant secondary titles) is likely to have, based on how often each comes up across the documents above, weighted by where it came from: user-chosen sources and battle-card content highest, corroborated points (battle card + persona agree) marked most important, then persona Immediate Work Priorities, then persona Development Priorities.
2. For each, find the company product / feature / service that addresses it, using only the company's documents or website, with an exact supporting quote and where it came from. Rate the fit: "strong", "partial" or "none".
3. Re-rank the list so the best items are the ones that are BOTH most important to this title AND best solved by the company. Items with fit "none" go last.
4. Try hard to find at least 3 items with fit "strong" or "partial" (1–2 is acceptable only if the materials truly don't support 3). Never make one up.
5. Collect any testimonial / case-study quotes from the website or documents by someone with the submitted title or a relevant secondary title (exact words, who said it, what challenge and feature it calls out).
6. Collect the company's own words: phrases from real copy (imported files, Build Positioning / Draft Messaging files, website) that describe these challenges or how the features help.

Reply with JSON only, in this shape:
{
  "challenges": [
    {
      "rank": 1,
      "challenge": "short name of the challenge / initiative",
      "detail": "one or two sentences on why it matters to this title",
      "frequency": "how many documents / places it came up in, and which kinds",
      "corroborated": true,
      "sources": ["document names or URLs"],
      "solution": {
        "fit": "strong | partial | none",
        "offering": "the product / feature / service, named as the company names it",
        "howItHelps": "how it addresses the challenge, strictly per the materials",
        "evidence": [{ "source": "document name or URL", "quote": "exact words" }]
      }
    }
  ],
  "testimonials": [{ "quote": "exact words", "person": "", "title": "", "company": "", "source": "", "callsOut": "challenge / feature it highlights" }],
  "companyPhrases": [{ "phrase": "exact words from real copy", "source": "", "about": "what it describes" }],
  "voiceNotes": "2–4 sentences on the company's tone, sentence length, vocabulary and how it talks to buyers",
  "gaps": "anything important you couldn't support from the materials"
}`);
  return parts.join("\n\n");
}

const WRITER_SYSTEM = `You are a B2B copywriter inside Mktforge, writing first-draft outreach for one job title on behalf of the user's company.

Absolute rules:
- Use only the challenges, offerings and proof given to you. Never add a feature, claim, statistic, customer or result that isn't in the brief.
- Write for the given job title as the reader.
- Match the company's voice: reuse its real words and phrases for challenges and for how features help wherever they fit; otherwise imitate its style, vocabulary and tone from the voice material. Let any testimonial from this title guide word choice so the copy sounds familiar to them — don't quote it unless it fits naturally.
- Plain, specific, human. No hype words, no emojis, no exclamation-mark enthusiasm.
- Output light Markdown only: paragraphs, "- " bullets, **bold** sparingly. No headings, no subject line, no sign-off, no placeholders other than [FIRST_NAME].
- Reply with JSON only.`;

function writerPrompt({ jobTitle, companyName, related, top, research, style }) {
  const brief = top.map((c, i) => ({
    number: i + 1,
    challenge: c.challenge,
    detail: c.detail,
    offering: c.solution && c.solution.offering,
    howItHelps: c.solution && c.solution.howItHelps,
    evidence: (c.solution && c.solution.evidence) || [],
  }));
  return `Company: ${companyName || "(see materials)"}
Reader's job title: ${jobTitle}${related.length ? ` (related titles: ${related.join("; ")})` : ""}

## Top challenges and how the company solves them (the ONLY claims you may make)
${JSON.stringify(brief, null, 2)}

## Testimonials from this title
${JSON.stringify(research.testimonials || [], null, 2)}

## The company's own phrases
${JSON.stringify(research.companyPhrases || [], null, 2)}

## Voice notes
${research.voiceNotes || "(none)"}

## Voice material (imported files, Build Positioning / Draft Messaging files, website)
${style || "(none — write in a clear, direct B2B voice)"}

## Write two things

### 1. "bullets": one bullet per challenge above (${top.length}), each naming the challenge and the offering that addresses it, written for the reader.

### 2. "email": a cold first-touch email to someone with this title, asking them to agree to learn more. Structure, exactly:
- "Hi [FIRST_NAME],"
- A short couple of sentences that grab attention by pulling from their top challenge(s): ask whether addressing it is a priority right now, and say the company can help.
- Up to 3 bullets (one per challenge above, ${top.length} here) explaining the challenge and how the company's offering addresses it.
- A short 1–2 sentences connecting with this job title, ending with an ask for a meeting.

### 3. "landingPage": landing-page copy that drives a visitor to fill out the form on the page (a demo request or booking a sales call). A foundation for the page copy: to the point, leaning hard on urgency around these challenges. Structure, exactly:
- An opening paragraph that pulls the reader in and shows the company understands their challenges / initiatives.
- Up to 3 bullets (${top.length} here) calling out the biggest challenges and how the company solves them.
- A closing paragraph, again leaning into urgency, driving the reader to fill out the form to start solving them.

Reply with JSON only: {"bullets":["..."],"email":"...","landingPage":"..."}
Use "\\n" line breaks inside the strings: a blank line between paragraphs, "- " at the start of each bullet line.`;
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function draftForJobTitle(env, { jobTitle, companyName, files, site }, say) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AgentError("The drafting agent isn't set up yet (the Worker has no ANTHROPIC_API_KEY).", "not_configured");
  }

  const personaFiles = files.filter((f) => f.role === "persona" && f.text);
  const cardFiles = files.filter((f) => f.role === "battlecard" && f.text);
  const selected = files.filter((f) => f.role === "selected");

  /* Steps 1–2: which personas and battle cards were written for this title. */
  let personas = [];
  let cards = [];
  let related = [];
  if (personaFiles.length || cardFiles.length) {
    await say(`Checking ${plural(personaFiles.length, "persona")} and ${plural(cardFiles.length, "battle card")} for “${jobTitle}”…`);
    const titles = await readTitles(env, personaFiles, cardFiles);
    const hits = titles.personas.filter((p) => sameTitle(p.primary, jobTitle) || p.secondary.some((s) => sameTitle(s, jobTitle)));
    personas = hits.map((p) => p.file);
    const seen = new Set([normTitle(jobTitle)]);
    for (const p of hits) {
      for (const t of [p.primary, ...p.secondary]) {
        const k = normTitle(t);
        if (k && !seen.has(k)) { seen.add(k); related.push(t); }
      }
    }
    const allowed = new Set([normTitle(jobTitle), ...related.map(normTitle)]);
    cards = titles.cards.filter((c) => allowed.has(normTitle(c.target))).map((c) => c.file);
  }
  await say(`Using ${plural(personas.length, "matching persona")} and ${plural(cards.length, "matching battle card")}, plus ${plural(selected.length, "chosen source")}${site && site.pages && site.pages.length ? ` and ${plural(site.pages.length, "website page")}` : ""}.`);

  const selectedWithText = selected.filter((f) => f.text);
  if (!personas.length && !cards.length && !selectedWithText.length && !(site && site.pages && site.pages.length)) {
    throw new AgentError(
      `Nothing to work from: no persona or battle card matches “${jobTitle}”, the chosen files had no readable text, and the website wasn't read. Add a source or tick “Use company website to supplement messaging.”`,
      "no_material"
    );
  }

  /* Steps 3–4: research and rank. */
  await say("Ranking what this title cares about against what your company solves… (this takes a minute or two)");
  const research = await askJson(env, {
    system: RESEARCH_SYSTEM,
    user: researchPrompt({ jobTitle, companyName, related, personas, cards, selected: selectedWithText, site }),
    maxTokens: 8000,
  });
  const list = (Array.isArray(research.challenges) ? research.challenges : [])
    .filter((c) => c && c.challenge)
    .sort((a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99));
  const top = list
    .filter((c) => c.solution && /^(strong|partial)$/i.test(String(c.solution.fit || "")) && c.solution.offering)
    .slice(0, 3);
  if (!top.length) {
    throw new AgentError(
      `Couldn't find a challenge for “${jobTitle}” that your company's documents or website show a way to solve, so nothing was drafted (the agent won't make one up). Add a source that describes your product, or tick “Use company website to supplement messaging.”`,
      "no_match"
    );
  }

  /* Step 5: write, in the company's voice. */
  await say(`Writing the email and landing page around the top ${plural(top.length, "challenge")}…`);
  let style = "";
  const styleFiles = selectedWithText.filter((f) => f.origin === "imported" || STYLE_MODULES.has(f.moduleId));
  let room = STYLE_CHARS;
  for (const f of styleFiles) {
    if (room <= 0) break;
    const t = f.text.slice(0, Math.min(room, 20000));
    style += `${doc({ ...f, text: t })}\n\n`;
    room -= t.length;
  }
  if (site && site.pages && room > 0) {
    for (const p of site.pages) {
      if (room <= 0) break;
      const t = p.text.slice(0, Math.min(room, 8000));
      style += `<webpage url="${p.url}">\n${t}\n</webpage>\n\n`;
      room -= t.length;
    }
  }

  const copy = await askJson(env, {
    system: WRITER_SYSTEM,
    user: writerPrompt({ jobTitle, companyName, related, top, research, style: style.trim() }),
    maxTokens: 4000,
  });
  const email = String(copy.email || "").trim();
  const landingPage = String(copy.landingPage || "").trim();
  if (!email || !landingPage) throw new Error("Writer returned empty copy");

  return {
    email,
    landingPage,
    research: {
      relatedTitles: related,
      personasUsed: personas.map((f) => f.name),
      battleCardsUsed: cards.map((f) => f.name),
      sourcesUsed: selectedWithText.map((f) => f.name),
      websitePages: site && site.pages ? site.pages.map((p) => p.url) : [],
      ranked: list.map((c) => ({
        rank: c.rank, challenge: c.challenge, corroborated: !!c.corroborated,
        fit: c.solution && c.solution.fit, offering: c.solution && c.solution.offering,
      })),
      top: top.map((c) => c.challenge),
      bullets: Array.isArray(copy.bullets) ? copy.bullets : [],
      testimonials: research.testimonials || [],
      gaps: research.gaps || "",
    },
  };
}

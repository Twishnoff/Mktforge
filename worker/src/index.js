/**
 * target-messaging — the Worker behind Mktforge's Target Messaging module.
 *
 * STATUS
 *   Job Title tab  — the drafting agent (src/agent.js): matching personas and
 *                    battle cards + the chosen sources + the company website
 *                    → a ranked list of what the title cares about that the
 *                    company can solve → a cold email and landing page copy.
 *   Individual tab — still a plumbing test: "Hello World" plus a summary of
 *                    what it received (HubSpot contact, notes, website).
 *
 * Endpoint
 *   POST /api/target   (Authorization: Bearer <Firebase ID token>)
 *     Job Title tab:
 *       { mode: "job-title", companyId, jobTitle,
 *         files: [{ name, origin: "generated"|"imported", moduleId,
 *                   role: "selected"|"persona"|"battlecard", type, date, text }],
 *         useWebsite, companyUrl, companyName, today }
 *       role "selected" = chosen/uploaded in the module; "persona" /
 *       "battlecard" = every Persona Builder / Battle Card PDF on the company,
 *       sent automatically (the agent keeps the ones for this title).
 *     Individual tab:
 *       { mode: "individual", companyId, contactId, contactLabel,
 *         companyUrl, companyName, today }
 *
 *   Answers as Server-Sent Events:
 *     event: status  { message }                 progress line for the page
 *     event: result  { email, landingPage, received, research? }
 *                    email / landingPage are light Markdown: paragraphs,
 *                    **bold**, *italic*, "- " and "1. " lists, [text](url)
 *     event: error   { message, code? }
 *
 * Bindings (wrangler.jsonc)
 *   ACCESS               KV  — shared Mktforge allowlist (mktforge-auth.js)
 *   FIREBASE_PROJECT_ID  var
 *   HUBSPOT_CONNECT      service binding to the hubspot-connect Worker
 *   HUBSPOT_CONNECT_URL  var — fallback when the service binding is absent
 *
 * Secrets
 *   ANTHROPIC_API_KEY    (npx wrangler secret put ANTHROPIC_API_KEY)
 * Optional vars
 *   ANTHROPIC_MODEL      research + writing model (default claude-sonnet-4-5-20250929)
 *   FAST_MODEL           title-matching model (default claude-haiku-4-5-20251001)
 */

import { requireAccess, handlePreflight, jsonResponse, corsHeaders } from "./mktforge-auth.js";
import { draftForJobTitle, AgentError } from "./agent.js";

// Chosen / uploaded files ("selected") and the automatic Persona Builder /
// Battle Card PDFs have separate budgets, so one can't crowd out the other.
const MAX_FILES = 50;
const LIMITS = {
  selected: { file: 60000, total: 250000, count: 20 },
  auto: { file: 40000, total: 320000, count: 30 },
};
const WEBSITE_TIMEOUT_MS = 8000;
const SITE_PAGES = 8;             // homepage + up to 7 relevant pages
const SITE_PAGE_CHARS = 12000;
const HEARTBEAT_MS = 15000;       // keeps the stream open through long model calls
const HUBSPOT_TIMEOUT_MS = 12000;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const str = (v, max = 500) => String(v == null ? "" : v).trim().slice(0, max);
const isCompanyId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const fmt = (n) => Number(n || 0).toLocaleString("en-US");

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

class RunError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/* SSE plumbing: run(send) does the work; the stream closes when it ends. */
function sse(request, run) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (event, data) =>
    writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => {});

  // An SSE comment every few seconds: the page ignores it, but it stops
  // anything in between from closing a quiet connection mid-run.
  const beat = setInterval(() => {
    writer.write(enc.encode(": ping\n\n")).catch(() => {});
  }, HEARTBEAT_MS);

  (async () => {
    try {
      await run(send);
    } catch (err) {
      console.error("run failed", String(err && err.stack ? err.stack : err));
      const known = err instanceof RunError || err instanceof AgentError;
      await send("error", {
        message: known ? err.message : "Something went wrong while drafting. Please try again.",
        code: known ? err.code : "server_error",
      });
    } finally {
      clearInterval(beat);
      try { await writer.close(); } catch { /* client went away */ }
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      ...corsHeaders(request),
    },
  });
}

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

function cleanFiles(raw) {
  const list = Array.isArray(raw) ? raw.slice(0, MAX_FILES) : [];
  const room = { selected: LIMITS.selected.total, auto: LIMITS.auto.total };
  const count = { selected: 0, auto: 0 };
  const seen = new Set();
  const out = [];
  for (const f of list) {
    const name = str(f && f.name, 200);
    if (!name) continue;
    // The same file chosen from the drop-down and dropped in the upload box
    // arrives once: duplicates are ignored.
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Older pages send no role: everything they send was chosen by the user.
    const role = f.role === "persona" || f.role === "battlecard" ? f.role : "selected";
    const pot = role === "selected" ? "selected" : "auto";
    if (count[pot] >= LIMITS[pot].count) continue;
    count[pot] += 1;
    let text = String((f && f.text) || "");
    const originalChars = text.length;
    text = text.slice(0, Math.min(LIMITS[pot].file, Math.max(0, room[pot])));
    room[pot] -= text.length;
    out.push({
      name,
      origin: f.origin === "generated" ? "generated" : "imported",
      moduleId: str(f.moduleId, 60),
      role,
      type: str(f.type, 40),
      date: str(f.date, 40),
      text,
      chars: text.length,
      cut: text.length < originalChars,
    });
  }
  return out;
}

function normalizeUrl(raw) {
  const v = str(raw, 500);
  if (!v) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

/* The company homepage plus the pages most likely to describe the product
   or quote customers (case studies, testimonials, product / feature /
   solution pages), as text. Best effort: failures are reported, not fatal. */
const SITE_LINK_RE = /(customer|case-?stud|stories|story|testimonial|review|success|product|feature|solution|platform|use-?case|how-it-works|why|benefit|integrat|pricing|about)/i;

async function readSite(url) {
  const home = await readWebsite(url, { withHtml: true });
  if (!home.ok) return { ...home, pages: [] };
  const origin = new URL(home.url).origin;
  const links = [];
  const seen = new Set([home.url.replace(/[#?].*$/, "").replace(/\/$/, "")]);
  for (const m of home.html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)) {
    let u;
    try { u = new URL(m[1], home.url); } catch { continue; }
    if (u.origin !== origin || !/^https?:$/.test(u.protocol)) continue;
    if (/\.(pdf|png|jpe?g|gif|svg|webp|zip|mp4|css|js)$/i.test(u.pathname)) continue;
    if (/(login|signin|sign-in|signup|careers|jobs|legal|privacy|terms|cookie)/i.test(u.pathname)) continue;
    const clean = `${u.origin}${u.pathname}`.replace(/\/$/, "");
    if (seen.has(clean) || !SITE_LINK_RE.test(u.pathname)) continue;
    seen.add(clean);
    // Customer proof first, then product pages.
    const score = /(customer|case-?stud|stor|testimonial|review|success)/i.test(u.pathname) ? 0 : 1;
    links.push({ url: clean, score });
  }
  links.sort((a, b) => a.score - b.score);
  const extra = await Promise.all(links.slice(0, SITE_PAGES - 1).map((l) => readWebsite(l.url)));
  const pages = [home, ...extra.filter((p) => p.ok && p.chars > 200)]
    .map((p) => ({ url: p.url, title: p.title, text: p.text.slice(0, SITE_PAGE_CHARS) }));
  return { ok: true, url: home.url, title: home.title, chars: pages.reduce((n, p) => n + p.text.length, 0), pages };
}

/* One page, as text. */
async function readWebsite(url, { withHtml = false } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), WEBSITE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Mktforge/1.0; +https://mktforge.io)" },
    });
    if (!res.ok) return { ok: false, url, reason: `the site answered ${res.status}` };
    const html = (await res.text()).slice(0, 600000);
    const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "")
      .replace(/\s+/g, " ").trim().slice(0, 160);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const page = { ok: true, url: res.url || url, title, chars: text.length, text: text.slice(0, 40000) };
    if (withHtml) page.html = html;
    return page;
  } catch (err) {
    return { ok: false, url, reason: err && err.name === "AbortError" ? "it took too long to respond" : "it couldn't be reached" };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * HubSpot, through the hubspot-connect Worker.
 * The user's own sign-in token goes with the call, so hubspot-connect runs
 * its usual checks and only ever returns that user's company's data.
 * ------------------------------------------------------------------ */

async function hubspot(env, authHeader, path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HUBSPOT_TIMEOUT_MS);
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
    signal: ctl.signal,
  };
  let res;
  try {
    res = env.HUBSPOT_CONNECT
      ? await env.HUBSPOT_CONNECT.fetch(new Request(`https://hubspot-connect${path}`, init))
      : await fetch(`${env.HUBSPOT_CONNECT_URL}${path}`, init);
  } catch (err) {
    throw new RunError("Couldn't reach the HubSpot connection. Try again in a minute.", "hubspot_unreachable");
  } finally {
    clearTimeout(timer);
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    throw new RunError(data.message || "The HubSpot connection returned an error.", data.error || `hubspot_${res.status}`);
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * Stub output — replaced by the agent later.
 * ------------------------------------------------------------------ */

function websiteLine(site, asked) {
  if (!asked) return "- **Company website:** not used";
  if (!site) return "- **Company website:** asked for, but My Company has no Company URL";
  if (!site.ok) return `- **Company website:** ${site.url} — not read (${site.reason})`;
  return `- **Company website:** ${site.url} — read${site.title ? ` “${site.title}”` : ""}, ${fmt(site.chars)} characters`;
}

function stubIndividual({ contact, contactLabel, notes, notesError, site, companyName }) {
  const lines = [
    "**Hello World - Individual**",
    "",
    "This is a test run: the drafting agent isn’t written yet. Here’s what the Worker received.",
    "",
    `- **Company:** ${companyName || "(no company name in My Company)"}`,
  ];
  if (!contact) {
    lines.push(`- **Targeted contact:** ${contactLabel || "(unknown)"} — not found in HubSpot any more`);
  } else {
    const pv = contact.pageViews || {};
    lines.push(
      `- **Targeted contact:** ${contact.name || "(no name)"}${contact.email ? ` <${contact.email}>` : ""}`,
      `- **From HubSpot:** ${[contact.jobTitle, contact.company].filter(Boolean).join(" at ") || "no job title or company on the record"}${contact.lifecycleStage ? ` · lifecycle stage ${contact.lifecycleStage}` : ""}`,
      `- **Page views:** ${pv.count == null ? "none recorded" : `${fmt(pv.count)} across ${fmt(pv.visits)} visit${pv.visits === 1 ? "" : "s"}`}${pv.lastUrl ? ` · last page ${pv.lastUrl}` : ""}`
    );
    if (notesError) lines.push(`- **Notes:** couldn’t be read (${notesError})`);
    else {
      const newest = notes[0] && notes[0].at ? ` · newest ${String(notes[0].at).slice(0, 10)}` : "";
      lines.push(`- **Notes on this contact:** ${notes.length}${notes.length === 20 ? "+" : ""}${newest}`);
    }
  }
  lines.push(websiteLine(site, !!site));
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

async function runJobTitle(body, send, env) {
  const jobTitle = str(body.jobTitle, 200);
  if (!jobTitle) throw new RunError("Choose a job title to target.", "bad_request");
  const files = cleanFiles(body.files);
  const useWebsite = body.useWebsite === true;
  const url = useWebsite ? normalizeUrl(body.companyUrl) : null;
  const selected = files.filter((f) => f.role === "selected");
  if (!selected.length && !url) {
    throw new RunError("Choose at least one source, or tick “Use company website to supplement messaging.”", "no_sources");
  }

  let site = null;
  if (url) {
    await send("status", { message: "Reading your company website (homepage, product and customer pages)…" });
    site = await readSite(url);
    if (!site.ok) {
      await send("status", { message: `Couldn't read your website (${site.reason}). Continuing with your files.` });
    }
  }

  const drafted = await draftForJobTitle(env, {
    jobTitle,
    companyName: str(body.companyName, 200),
    files,
    site: site && site.ok ? site : null,
  }, (message) => send("status", { message }));

  return {
    email: drafted.email,
    landingPage: drafted.landingPage,
    research: drafted.research,
    received: {
      mode: "job-title",
      jobTitle,
      files: files.map(({ name, origin, role, chars, cut }) => ({ name, origin, role, chars, cut })),
      website: site ? { ok: site.ok, url: site.url, pages: (site.pages || []).length, chars: site.chars || 0 } : null,
    },
  };
}

async function runIndividual(body, send, env, authHeader) {
  const contactId = str(body.contactId, 30);
  if (!/^\d{1,20}$/.test(contactId)) throw new RunError("Choose a contact to target.", "bad_request");
  const companyId = body.companyId;

  await send("status", { message: "Looking up the contact in HubSpot…" });
  const { contact } = await hubspot(env, authHeader, "/api/read/contact", { companyId, contactId });

  let notes = [];
  let notesError = "";
  if (contact) {
    await send("status", { message: "Reading HubSpot notes on this contact…" });
    try {
      const n = await hubspot(env, authHeader, "/api/read/notes", { companyId, contactId, limit: 20 });
      notes = n.notes || [];
    } catch (err) {
      notesError = err.message || "unknown error";
    }
  }

  const url = normalizeUrl(body.companyUrl);
  let site = null;
  if (url) {
    await send("status", { message: "Reading your company website…" });
    site = await readWebsite(url);
  }

  const summary = stubIndividual({
    contact, contactLabel: str(body.contactLabel, 300), notes, notesError, site,
    companyName: str(body.companyName, 200),
  });
  return {
    email: summary,
    landingPage: summary,
    received: {
      mode: "individual",
      contact: contact ? { id: contact.id, name: contact.name, email: contact.email } : null,
      notes: notes.length,
      website: site ? { ok: site.ok, url: site.url, chars: site.chars || 0 } : null,
    },
  };
}

async function handleTarget(request, env) {
  const gate = await requireAccess(request, env, { module: "target-messaging" });
  if (!gate.ok) return gate.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return jsonResponse(request, { error: "bad_request", message: "That request was missing something Mktforge needs." }, 400);
  }
  if (!isCompanyId(body.companyId)) {
    return jsonResponse(request, { error: "bad_company", message: "No active company was sent with this request." }, 400);
  }
  if (body.mode !== "job-title" && body.mode !== "individual") {
    return jsonResponse(request, { error: "bad_request", message: "Unknown targeting mode." }, 400);
  }

  const authHeader = request.headers.get("Authorization");
  return sse(request, async (send) => {
    await send("status", { message: "Signed in and approved. Checking your inputs…" });
    const result = body.mode === "job-title"
      ? await runJobTitle(body, send, env)
      : await runIndividual(body, send, env, authHeader);
    await send("result", result);
  });
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const preflight = handlePreflight(request);
    if (preflight) return preflight;

    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/api/target" && request.method === "POST") return await handleTarget(request, env);
      if (pathname === "/" && request.method === "GET") {
        return jsonResponse(request, { ok: true, service: "target-messaging" });
      }
      return jsonResponse(request, { error: "not_found" }, 404);
    } catch (err) {
      console.error("worker error", String(err && err.stack ? err.stack : err));
      return jsonResponse(request, { error: "server_error", message: "Something went wrong. Please try again." }, 500);
    }
  },
};

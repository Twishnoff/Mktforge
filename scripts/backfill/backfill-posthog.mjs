#!/usr/bin/env node
/* Backfill PostHog from Firebase, per docs/analytics-events.md ("Backfill").

   Rebuilds, with historical timestamps and `backfilled: true`:
     signup_completed  one per Firebase Auth user (creation time)
     email_verified    for verified users (creation time; the real time is unknown)
     company_created   one per company doc (createdAt; the user's first one is auto: true)
     pdf_saved         one per generated file (createdAt, moduleId, size)
   module_run_completed is not recoverable and is not sent.

   Every event gets a deterministic uuid (sha1 of uid + event + record id), so
   running this twice does not duplicate anything: PostHog drops a repeat uuid.

   Setup (once):
     cd scripts/backfill && npm install
     set GOOGLE_APPLICATION_CREDENTIALS=C:\Users\Tyler\.secrets\mktforge-sa.json   (PowerShell: $env:GOOGLE_APPLICATION_CREDENTIALS = "...")
   Run:
     npm run dry      prints what would be sent (and writes backfill-preview.json)
     npm run send     sends it
   Options: --exclude=a@x.com,b@y.com   skip these accounts (test accounts)
            --since=2026-01-01          only records created on/after this date */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import admin from "firebase-admin";

const POSTHOG_HOST = "https://us.i.posthog.com";
const POSTHOG_KEY = "phc_sJwT9rVz5GHRRmz29Lppw2niseaSunXgikT7AQRyAxNg";   // public project key

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v = true] = a.replace(/^--/, "").split("=");
  return [k, v];
}));
const DRY = !!args["dry-run"];
const EXCLUDE = new Set(String(args.exclude || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const SINCE = args.since ? Date.parse(args.since) : 0;

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS to the service-account key file first.");
  process.exit(2);
}
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "mktforge" });
const db = admin.firestore();

const uuidFor = (...parts) => {
  const h = createHash("sha1").update(parts.join("|")).digest("hex");
  // Shape it like a UUID (v5-ish); PostHog only needs it stable and unique.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const iso = (ms) => new Date(ms).toISOString();
const millis = (v) => (v && typeof v.toMillis === "function") ? v.toMillis() : (typeof v === "number" ? v : null);

const events = [];
function push(event, uid, atMs, props, idParts, set) {
  if (!atMs || atMs < SINCE) return;
  const e = {
    event, distinct_id: uid, timestamp: iso(atMs), uuid: uuidFor(uid, event, ...idParts),
    properties: { uid, backfilled: true, ...props },
  };
  if (set) e.properties.$set = set;
  events.push(e);
}

/* ---- Firebase Auth users ---- */
const users = [];
let pageToken;
do {
  const page = await admin.auth().listUsers(1000, pageToken);
  users.push(...page.users);
  pageToken = page.pageToken;
} while (pageToken);

const kept = users.filter((u) => u.email && !EXCLUDE.has(u.email.toLowerCase()));
console.log(`Auth users: ${users.length} (${users.length - kept.length} excluded)`);

for (const u of kept) {
  const created = Date.parse(u.metadata.creationTime);
  push("signup_completed", u.uid, created, { invite_code_present: null },
       [u.uid], { uid: u.uid, email: u.email, signed_up_at: iso(created) });
  if (u.emailVerified) {
    push("email_verified", u.uid, created, { verified_time_unknown: true }, [u.uid]);
  }
}

/* ---- Firestore companies + files ---- */
let companies = 0, files = 0;
for (const u of kept) {
  const snap = await db.collection("users").doc(u.uid).collection("companies").get();
  const docs = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((c) => c.status !== "deleting")
    .sort((a, b) => (millis(a.createdAt) || 0) - (millis(b.createdAt) || 0));
  docs.forEach((c, i) => {
    companies++;
    push("company_created", u.uid, millis(c.createdAt) || Date.parse(u.metadata.creationTime),
         { company_id: c.id, company_count: i + 1, auto: i === 0 }, [c.id]);
  });
  for (const c of docs) {
    const fs = await db.collection("users").doc(u.uid).collection("companies").doc(c.id).collection("files").get();
    for (const f of fs.docs) {
      const d = f.data();
      if (d.source === "imported") continue;
      files++;
      push("pdf_saved", u.uid, millis(d.createdAt),
           { company_id: c.id, module: d.moduleId || null, file_id: f.id,
             format: (d.ext || ".pdf").replace(/^\./, ""), size_bytes: d.size || null, inputs_summary: d.name || null },
           [c.id, f.id]);
    }
  }
}
console.log(`Companies: ${companies}   Generated files: ${files}   Events to send: ${events.length}`);

const byEvent = {};
for (const e of events) byEvent[e.event] = (byEvent[e.event] || 0) + 1;
console.table(byEvent);

if (DRY) {
  writeFileSync("backfill-preview.json", JSON.stringify(events, null, 1));
  console.log("Dry run: nothing sent. Preview written to backfill-preview.json");
  process.exit(0);
}

/* ---- send in batches; historical_migration keeps PostHog from treating old timestamps as clock skew ---- */
for (let i = 0; i < events.length; i += 500) {
  const batch = events.slice(i, i + 500);
  const res = await fetch(`${POSTHOG_HOST}/batch/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: POSTHOG_KEY, historical_migration: true, batch }),
  });
  if (!res.ok) { console.error(`Batch ${i / 500 + 1} failed: ${res.status} ${await res.text()}`); process.exit(1); }
  console.log(`Sent ${Math.min(i + 500, events.length)}/${events.length}`);
}
console.log("Done. Events with a historical timestamp can take a few minutes to appear in insights.");

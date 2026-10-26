#!/usr/bin/env node
/* Export every active My Company entry from Firestore as JSON, for
   mktforge-workers/scripts/hubspot/seed-companies.mjs (Day 15: companies
   created before the app reported them to the server are seeded into
   HubSpot once from this file).

   Output (companies.json next to this script, gitignored):
     [{ uid, id, name, url, industry, competitors, created_at }]

   Setup is the backfill's: cd scripts/backfill && npm install, and
   GOOGLE_APPLICATION_CREDENTIALS pointing at the service-account key.
   Run: node export-companies.mjs [--out=companies.json] */

import { writeFileSync } from "node:fs";
import admin from "firebase-admin";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v = true] = a.replace(/^--/, "").split("=");
  return [k, v];
}));
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS to the service-account key file first.");
  process.exit(2);
}
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "mktforge" });
const db = admin.firestore();
const millis = (v) => (v && typeof v.toMillis === "function") ? v.toMillis() : (typeof v === "number" ? v : null);

const users = [];
let pageToken;
do {
  const page = await admin.auth().listUsers(1000, pageToken);
  users.push(...page.users);
  pageToken = page.pageToken;
} while (pageToken);

const out = [];
for (const u of users) {
  const snap = await db.collection("users").doc(u.uid).collection("companies").get();
  for (const d of snap.docs) {
    const c = d.data();
    if (c.status === "deleting") continue;
    const p = c.profile || {};
    const at = millis(c.createdAt) || Date.parse(u.metadata.creationTime);
    out.push({
      uid: u.uid, id: d.id,
      name: p.companyName || c.name || "", url: p.companyUrl || "", industry: p.industry || "",
      competitors: Array.isArray(p.competitors) ? p.competitors : [],
      created_at: new Date(at).toISOString(),
    });
  }
}
out.sort((a, b) => a.uid.localeCompare(b.uid) || Date.parse(a.created_at) - Date.parse(b.created_at));
const file = String(args.out || "companies.json");
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`${out.length} companies for ${new Set(out.map((c) => c.uid)).size} users -> ${file}`);
for (const c of out) console.log(`  ${c.uid.slice(0, 8)}  ${c.name || "(no name)"}  ${c.url || "(no url)"}`);

# Market Tracker Worker — competitor mode

What the `customer-tracker` Worker has to add so the site files in this update work.
The Worker URL and the job-title path do not change.

`POST /api/track` now receives a `mode` field. `mode: "jobTitle"` is exactly what
the Worker already handles, with one field renamed (`jobTitle` was already the
name; nothing else moved). `mode: "competitor"` is new. Everything below is the
competitor path only.

---

## 1. Request

```jsonc
{
  "mode": "competitor",
  "competitorUrl": "https://www.acme.com/",   // as the user typed it in My Company
  "companyUrl": "https://mktforge.io",        // the user's own company
  "companyName": "Mktforge",
  "otherCompetitorUrls": ["https://beta.io"], // the user's other competitors
  "context": { "imported": [...], "generated": [...] },   // all saved materials,
                                              // ranked so files mentioning this
                                              // competitor come first
  "ledger": {                                 // null on the very first run
    "url": "https://www.acme.com/",
    "companyName": "Acme Corp",
    "homepage": { "heading": "...", "copy": "...", "cta": "...", "checkedAt": 1758… },
    "inventory": [ { "u": "https://acme.com/blog/x", "k": "blog", "d": "2026-08-02" } ],
    "surfaced":  [ { "u": "https://acme.com/blog/x", "d": "2026-08-02", "t": 1758… } ]
  },
  "firstRun": true,                           // no completed run for this box yet
  "today": "2026-09-20"
}
```

`inventory` is every page the agent has ever seen on the competitor's site.
`surfaced` is every URL it has ever shown the user. They are different lists and
both are needed: a page can be in `inventory` (seen, recorded) without ever
having been in `surfaced` (shown).

## 2. Response

Same SSE envelope as today — `status` events while working, then one `result`.

```jsonc
{
  "companyName": "Acme Corp",
  "rows": [ /* only what has NOT been shown before, max 25 */ ],
  "stats": { "searched": 0, "found": 0, "kept": 0, "threadsRead": 0, "datesRead": 0,
             "dropped": { "date": 0, "seen": 0, "notRelevant": 0, "other": 0 } },
  "ledger": { /* the updated ledger, written straight back to Firestore by the page */ }
}
```

Leave `note` empty in competitor mode. The page writes the "no new activity"
line itself, because only it knows whether carried-over rows are on screen.

### Row

```jsonc
{
  "group": "messaging" | "story" | "blog" | "news" | "product" | "offsite",
  "url": "https://acme.com/blog/x",
  "source": "acme.com",
  "kind": "page" | "article" | "post" | "comment" | "review",
  "date": "2026-09-15",        // "" when none could be read
  "approx": false,             // true when worked out from "2 weeks ago"
  "excerpt": "One or two sentences on what this is.",
  "mentions": ["Acme Corp", "Mktforge"],
  "companySite": true,         // on the competitor's own domain
  "threadTitle": "…",          // forum/social threads only
  "changed": ["heading", "CTA"] // messaging rows only, when it can be told
}
```

Do **not** set `opportunity` or `churn` in competitor mode. These rows carry no
sentiment colour — the box is a record of activity, not an opportunity list.

## 3. Freshness and de-duplication

**30 days** for competitor mode (the job-title path keeps its own window).

| Content | Test for "new" |
| --- | --- |
| The homepage | Its heading / heading copy / CTA differ from `ledger.homepage`. **Never filtered by URL** — it is the one URL that is expected to come back. |
| A page on the competitor's site **with** a publish date | Within 30 days **and** its URL is not in `surfaced`. |
| A page on the competitor's site **without** a publish date | Its URL is not in `inventory`. On `firstRun` it is recorded and never shown — there is no previous crawl to call it new against. |
| Anything off the competitor's site | Within 30 days (confirmed) **and** its URL is not in `surfaced`. Undated off-site content is dropped, not ledger-compared. |

So a first run against a static, undated site reports exactly one row: the
messaging baseline. That is intended; the page says so under the table.

## 4. What the agent does

### Phase A — the competitor's own site

1. **Homepage.** Read the hero heading, the hero sub-copy and the primary CTA
   label. Normalise before comparing — trim, collapse whitespace, casefold —
   so an A/B test or a punctuation tweak is not a "change". Compare against
   `ledger.homepage`; emit a `messaging` row when they differ or when there is
   no stored snapshot. Set `changed` to the parts that moved when it can tell.
   Always overwrite `ledger.homepage` with what it just read.
2. **Map the site** from the homepage links, the nav and `sitemap.xml` if it
   is reachable. Classify each section:
   - `blog` — URL contains `/blog`, or a nav link named "Blog" or with "Blog"
     in the title (Engineering Blog, and so on)
   - `story` — `/use-case`, `/case-stud`, `/customer`, `/testimonial`, `/stories`
   - `news` — `/news`, `/whats-new`, `/newsroom`, `/press`, `/announcement`
   - `product` — `/product`, `/solution`, `/platform`, `/features`
3. **For every page found**, try to read a publish or created date —
   `article:published_time`, JSON-LD `datePublished`, `<time datetime>`, a
   visible date. Then apply the table in §3.
4. **Record every page seen** in the new `inventory`, with its kind and date,
   whether or not it was shown.

### Phase B — off the competitor's site

5. **Substack and Medium.** Articles that name the competitor or link to its
   URL. Open the article page itself, not the summary card, to read the date.
   Both block automated fetches often; when a direct fetch fails, fall back to
   a domain-restricted search rather than dropping the source silently, and
   count the failures in `stats.dropped.other`.
6. **Reddit, Hacker News**, and any site, forum or platform named in the
   account's saved materials (Marketing Opportunities and Persona Builder
   reports name these explicitly; battle cards name competitor coverage).
   Posts whose title includes the competitor's name, verified within 30 days.
7. Everything from phase B is `group: "offsite"`, `companySite: false`.

### Filters that are OFF in competitor mode

These are job-title rules and they all fight competitor research. Skip them:

- the first-hand-experience test ("I / we / my") — a competitor's own marketing
  pages are the point here
- excluding content on a domain owned by a vendor in the same industry — that
  describes the competitor's own domain
- excluding content posted by the competitor or on a site it owns — likewise
- the research-paper filter — a paper naming the competitor is still activity
  *(assumed; this one was not decided explicitly)*

### Filters that stay ON

- the 30-day window, wherever a date can be confirmed
- the ledger (nothing already shown comes back)
- relevance: the item has to be about **this** competitor. Count it in
  `dropped.notRelevant` when it is not.

## 5. Company name

Resolve from the homepage: `og:site_name`, `<title>`, schema.org `Organization`
name, logo alt text. Fall back to the bare host. Return it as `companyName` —
the page renames the box to it and keeps the host as a subtitle. Cache it in
`ledger.companyName` and only re-resolve when that is empty, so it is not
re-researched on every refresh.

## 6. Writing the ledger back

```
newLedger = {
  url:         competitorUrl,
  companyName: resolved || ledger.companyName,
  homepage:    { heading, copy, cta, checkedAt: now },
  inventory:   union(ledger.inventory, everythingSeenThisRun),
  surfaced:    purge(ledger.surfaced) + everythingEmittedThisRun
}
```

`union`, not replace — a page the crawl happens to miss one run should not come
back as new the next.

`purge` drops entries whose `d` is a real date more than 30 days old; the date
filter would exclude them anyway. Entries with no `d` are **kept for the life of
the ledger** — a URL is the only handle there is on an undated page, and
dropping it would let the page resurface as new.

Both lists are capped at 2000 entries by the page and by the Firestore rules.
Trim oldest-first if a large site approaches that.

## 7. Firestore

One new collection, written by the page rather than the Worker:

```
users/{uid}/competitorLedger/{ledgerId}
```

`ledgerId` is derived from the competitor's **bare host**, so `acme.com`,
`www.acme.com` and `https://acme.com/pricing` all land on one document. The
ledger outlives Stop Tracking and is deleted only when the URL leaves My
Company. Rules are in `firestore.rules` in this update and need re-publishing.

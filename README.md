# Mktforge

Front-end shell: navigation bar, management bar, display field. No build step,
no dependencies, no framework. Push the folder to GitHub Pages and it runs.

```
index.html                  the frame (requires a signed-in user)
login.html                  sign in / create account / verify / reset
assets/css/app.css          shell styles + design tokens
assets/img/                 logo (SVG lockup + mark, traced from mktforge-logo.png), favicon
assets/js/config.js         public config for modules (no secrets)
assets/js/icons.js          inline SVG icon set
assets/js/auth.js           Firebase Authentication adapter
assets/js/data.js           per-account data (Firestore): profile, saved files, autofill
assets/js/extract.js        reads text out of PDF / Word / PowerPoint / Excel / text files
assets/js/research.js       packs Imported + Generated Materials for the agents
assets/data/industries.js   Crunchbase industry list (suggestions)
assets/js/login.js          login page logic
assets/css/login.css        login page styles
assets/js/app.js            shell logic + module registry + notices
firestore.rules             Firestore security rules (paste into the console)
modules/my-company/         My Company (profile + saved resources)
modules/find-my-customer/   Find My Customer (ported from Customer-Intelligence)
modules/build-positioning/  Build Positioning (positioning, framework stages 0–5)
modules/draft-messaging/    Draft Messaging (messaging + homepage copy, stages 6–9)
modules/persona-builder/    Persona Builder (ported from Persona Drafter)
modules/battle-card-generator/  Battle Card Generator (ported from Battlecard-Generator)
modules/marketing-opportunities/  Marketing Opportunities (ported from Syndication & Event Finder)
modules/customer-tracker/   Customer Tracker (what a job title is saying online)
```

## Running it locally

Double-click `index.html`. It works from `file://` because modules load as
plain `<script>` tags rather than being fetched at runtime.

If you'd rather serve it (closer to how GitHub Pages behaves):

```
cd mktforge
python3 -m http.server 8000
```

then open http://localhost:8000

## Adding a module

1. Create `modules/your-module/` with a JS and CSS file (any existing module is a template).
2. Change `id`, `label`, and `icon` at the top of the JS file.
3. Add one line to `index.html`:
   `<script src="modules/your-module/your-module.js"></script>`

That's it — the nav button, the route (`#/your-module`), and the CSS loading
are all handled by the shell.

The nav lists modules in the order their `<script>` tags appear in
`index.html`, which is the order a person works through them: My Company, Find
My Customer, Persona Builder, Build Positioning, Draft Messaging, Marketing
Opportunities, Customer Tracker, Battle Card Generator. Moving a module in the nav means moving
its one line.

### The contract

```js
Mktforge.register({
  id:     'your-module',                       // unique; becomes the URL hash
  label:  'Your Module',                       // nav button text
  icon:   'user',                              // key in assets/js/icons.js
  styles: 'modules/your-module/your-module.css',
  mount(container)   { /* build your UI inside container */ },
  unmount(container) { /* optional: timers, listeners, observers */ }
});
```

A module only ever touches the container it is handed. It never reads or
writes the shell's DOM or globals. Keeping that line clean is what makes a
later move to React (or anything else) a rewrite of the shell only.

### Background-run lights

A module that does slow work reports it to the shell:

```js
Mktforge.reportActivity('your-module', 'running');  // run started
Mktforge.reportActivity('your-module', 'idle');     // run finished successfully
Mktforge.reportActivity('your-module', 'error');    // run finished with an error
```

A running module gets a slowly blinking yellow dot next to it in the nav,
whether or not you're looking at that module. When the run finishes the dot
goes solid green, or solid red if it ended in an error, meaning "there's a
result here you haven't looked at". That clears when you open the module —
or, if you're already on it, on your next click, key press or scroll, since
by then you've seen it (`ackActive` in `app.js`, whose listeners only exist
while there's a light to clear). A finished light on a module you're *not*
on still waits for you to open it; clicking around elsewhere won't clear it.
Find My Customer, Persona Builder, Battle Card Generator, Marketing
Opportunities and Build Positioning all report their runs. When the nav is
minimized, the dot sits on the icon and the hover label says "Running…",
"Finished — results ready" or "Stopped with an error".

The browser tab carries the same light for the whole app, summed over every
module: yellow while anything is running, then green once everything has
finished (red if any of it failed), and back to the plain icon once every
finished result has been seen. Anything still running wins over a finished
result, so the tab only goes green when nothing is left in flight. It's drawn
by swapping the `<link rel="icon">` for a data-URI SVG in which the mark's
green square becomes the status dot — a corner badge is unreadable at the
16px a tab actually gets. No fetch and no canvas, so it works off disk too;
if you edit `assets/img/favicon.svg`, update `litFavicon` in `app.js` to
match.

## Deploying

Repo → Settings → Pages → Branch: `main`, folder: `/ (root)`.
Every path in the project is relative, so it works at any base URL —
`twishnoff.github.io/Mktforge/` or a subfolder of an existing repo.

## Known limits

- **Static host, public source.** Anything in this repo is readable by anyone.
  No API keys, no private user data in the client. When a module needs either,
  it needs a proxy (Cloudflare Worker / Vercel function) in front of it.
- **The login page gates data, not code.** Every file here is public and
  anyone can edit the JavaScript in their own browser to skip the redirect.
  See "Authentication" below for where the real boundary has to live.
- **Desktop-first.** Below 860px the nav forces itself to the icon rail so
  things stay usable, but mobile hasn't been designed.

## Frame geometry

The spec asked for ~15% nav / ~5% minimized / ~5% management bar. Those hold
on a normal desktop but break at the extremes, so each is expressed as its
ratio with a floor and a ceiling (`assets/css/app.css`, `:root`):

| Part            | Value                          | At 1440px wide |
|-----------------|--------------------------------|----------------|
| Nav, expanded   | `clamp(200px, 15vw, 260px)`    | 216px (15%)    |
| Nav, minimized  | `64px`                         | 4.4%           |
| Management bar  | `56px`                         | —              |


## My Company

The first nav button (factory icon). Replaced the old "Module 1" placeholder.
Clicking the Mktforge logo at the top of the nav also opens it.

- **Profile**: Company Name, Company URL, Your Industry, Target Job Titles,
  Target Industries, Competitors. Empty rows are inputs; saved rows show the
  value with an Edit button. Save writes the whole profile to the account.
- **Your Industry / Target Industries** suggest from the Crunchbase glossary
  (`assets/data/industries.js`) once two letters are typed. Anything can
  still be entered.
- **Tag fields**: Enter turns the text into a tag, × removes it, Backspace
  in an empty box removes the last one. Competitors must be valid website
  addresses (`rival.com` is fine; no `https://` needed). Text typed but not
  yet entered is kept when Save is pressed.
- **Your Saved Resources** has two lists, newest first:
  - **Generated Materials** — every PDF made in another module.
  - **Imported Materials** — files the person adds (see below).
  Click a name to open it (PDFs and text open in a tab; Word, PowerPoint and
  Excel files download). Rename turns the name into a text box and the
  button into Save (Enter also saves, Escape cancels); the extension stays
  as it was, and a name another file already uses (ignoring case) shows
  "File name already exists. Choose another." Delete asks for a second
  click, then removes the file (bytes, text and summary) from the account.

### Imported Materials

Drag files onto the Imported Materials area, or use **Import Files** /
"browse your computer". Several at once is fine; they're handled one at a
time, each with a status line (Waiting → Reading → Saving → Imported).
Problems stay on screen until dismissed with ×.

| Accepted | How the text is read (`assets/js/extract.js`) |
|---|---|
| PDF | pdf.js (first 150 pages) |
| Word .docx | body, tables, headers/footers, footnotes |
| PowerPoint .pptx | every slide in order, plus speaker notes |
| Excel .xlsx | every sheet, tab-separated rows, sheet names kept |
| CSV/TSV, TXT, Markdown, JSON, HTML/XML | as text |

- Old `.doc` / `.ppt` / `.xls` files are refused with a note to re-save them
  in the newer format. Other types (images, video…) are refused.
- Up to 15 MB each. A file with no text layer (e.g. a scanned PDF) is still
  saved but tagged **No readable text**; a very long one is tagged
  **Partly read** (text is capped at 1.5M characters).
- A name that's already taken gets " (2)", " (3)"… added.
- The text is extracted once, at import, and stored with the file, so
  agents never re-parse it. Office files are zips of XML, so only JSZip is
  loaded (from cdnjs, on first use) — no Office library.

### How agents use saved materials

`assets/js/research.js` builds the `context` each agent request carries:

1. **Imported Materials** — most trusted. Newer beats older.
2. **Generated Materials** — earlier Mktforge reports. Newer beats older.
3. Websites and web research.

The trust rules live in each Worker (`research-context.js`, identical copies
in the Build Positioning, Battle Card Generator and Marketing Opportunities
Workers), so the model applies them whatever the module. Each item carries
its import/creation time (to the second, UTC) and the lists are sent newest
first.

To keep prompts small, files that mention the run's job title or competitor
are sent in full first; long or unrelated files go as a short summary made
once by the Build Positioning Worker (`/api/digest`) and stored on the file
record. Budgets are in `MktforgeResearch.BUDGETS` (`small` for the tools that
already run many web searches, `large` for Build Positioning). If gathering
materials fails, the request goes out without them rather than failing.

| Module | Sends saved materials | Why |
|---|---|---|
| Build Positioning | yes | its Worker reads them |
| Battle Card Generator | yes (`USE_SAVED_MATERIALS: true`) | Worker updated |
| Marketing Opportunities | yes (`USE_SAVED_MATERIALS: true`) | Worker updated |
| Persona Builder | no (`false`) | its Worker's main file isn't in the Persona-Drafter repo yet |
| Find My Customer | no (`false`) | flip to `true` once the Competitors To Watch Worker update (`competitors.js`) is deployed — it reads `body.context` |

Flip a flag in `assets/js/config.js` once that module's Worker reads
`body.context` (drop in `research-context.js` and wrap its prompt with
`withResearch`, as the Battle Card Worker does).

### Storage layout for files

```
users/{uid}/files/{fileId}          name, source (generated|imported), ext, mimeType, kind,
                                    size, chunks, textChunks, textChars, textStatus,
                                    truncated, digest, createdAt
users/{uid}/files/{fileId}/chunks/n original bytes (≤700 KB each)
users/{uid}/files/{fileId}/text/n   extracted text (≤300k characters each, up to 5)
```

Generated PDFs get their text extracted the first time an agent needs it,
then stored the same way.

**Firestore rules must be re-published** for this release (Firestore →
Rules → paste `firestore.rules` → Publish): without the new `text` rule,
imports fail with a permissions error.

### Account email

None of the tool modules ask for an email any more. Each request sends the
signed-in account's address. If the account has no usable address, or a
Worker refuses it (HTTP 401/403, or an error message about the email), the
module shows: *Your account doesn't have access to this module. Request
access from your administrator.* Other Worker errors are shown as before.
The Workers' own allow-lists still decide who gets in, so the Mktforge
account's email has to be on them.

### Company URL default

When a module with a Company URL field is opened for the first time after
signing in, the field is filled with My Company's URL. From then on the field
is the person's: edits (including clearing it) are kept while moving between
modules. Signing out reloads the page, so the next sign-in starts from the My
Company URL again. If My Company had no URL yet, the first open after one is
saved fills it in.

### Drop-down choices

Clicking or tabbing into these fields opens a list of My Company values,
narrowed as you type. Click (or arrow + Enter) to use one, or type anything
else. Nothing is filled in automatically.

| Module | Field | Choices from |
|---|---|---|
| Persona Builder | Job Title | Target Job Titles |
| Persona Builder | Industry | Target Industries |
| Battle Card Generator | Competitor URL | Competitors |
| Battle Card Generator | Job Title | Target Job Titles |
| Battle Card Generator | Industry | Target Industries |
| Marketing Opportunities | all three Job Title fields | Target Job Titles |
| Marketing Opportunities | Industry | Target Industries |

Shared code: `assets/js/module-kit.js` (`MktforgeKit`).

### Saved PDFs and naming

Each module's PDF button now downloads the file as `<Module Name> N.pdf`
(for example `Persona Builder 3.pdf`) and saves a copy to the account. N is a
per-module counter stored on the account, so it keeps counting after a
delete, and it skips any number whose name a renamed file already uses. If the account can't be reached, the download still happens under the
module's old filename and a notice says the copy wasn't saved.

### Storage (free tier)

Everything is in **Cloud Firestore** on the free Spark plan:

```
users/{uid}                          profile, pdfCounters, email
users/{uid}/files/{fileId}           name, moduleId, moduleName, size, chunks, createdAt
users/{uid}/files/{fileId}/chunks/n  PDF bytes (≤700 KB per chunk)
```

Firebase Storage would be the usual home for files, but new buckets need the
paid Blaze plan, so PDF bytes are split into Firestore Blob chunks instead.
At a couple of users this sits well inside the free quotas (1 GiB stored,
50k reads / 20k writes a day). A PDF costs roughly one write per 700 KB plus
two. If PDFs ever get large or numerous, moving the bytes to Storage is a
change inside `assets/js/data.js` only.

In preview mode (Firebase not configured) the same API uses this browser's
localStorage so the UI can still be tried.

### One-time Firestore setup

1. Firebase console → **Build → Firestore Database → Create database** →
   Standard edition, any location near you → **Start in production mode**.
2. **Firestore → Rules** → replace everything with `firestore.rules` from
   this repo → **Publish**. The rules only let a signed-in, email-verified
   user read and write their own `users/{uid}` records.
3. No index is needed (the file list is a single-field sort).


## Find My Customer

A port of the standalone Customer Overview Dashboard
([Customer-Intelligence](https://github.com/Twishnoff/Customer-Intelligence))
into a Mktforge module, built the same way as Persona Builder. Same Cloudflare
Worker (`/api/dashboard`), same "already collected" guard, and the same jsPDF
+ autoTable report. The standalone site's five boxes are joined by a sixth,
**Competitors To Watch**, which is Mktforge-only.
Its nav button sits directly above Persona Builder, with a crosshairs icon.

What changed in the port:

- its page header is gone — the shell provides the frame
- palette and type come from Mktforge's tokens (the PDF's blue is now the
  Mktforge green)
- every DOM lookup is scoped to the container `mount()` hands it
- jsPDF and autoTable load on the first PDF click, not on page load
- results, form values and an in-flight run survive navigating to another
  module and back, the same way Persona Builder's do
- no email field; the signed-in account's address is sent (see My Company → Account email)

### Tracked titles

Each row in the Job Titles box has a button on the right. "Add To Tracked
Titles" adds that title to My Company's Target Job Titles and flips to
"Remove From Tracked Titles"; clicking that removes it again. Titles already
in Target Job Titles (ignoring case) start as "Remove". The buttons only
exist in the app — the PDF is built from the results data, so they never
appear in it. My Company picks up the change the next time it's opened.

### Competitors To Watch

A wide box under the two Top Needs boxes, twice the height of a standard box
and spanning the full grid the way Customer List does. It holds a two-column
table — Competitor Name, Competitor URL — with a tracking button at the end
of each row and the agent's one-line case for the company as the row's
tooltip.

The buttons work like the tracked titles above them, against My Company →
Competitors instead of Target Job Titles. "Add To Tracked Competitors" adds
that company's URL and flips to "Remove From Tracked Competitors"; clicking
that removes it. A company already in Competitors starts as "Remove",
matched on host, so `rival.com`, `www.rival.com` and
`https://rival.com/product` are all the same company. Tags are stored bare
(`rival.com`), which is the form My Company's field asks for.

How the agent builds the list (it runs in the Worker —
`competitors.js`, delivered with this change):

1. the account's Imported and Generated Materials, for competitors named
   alongside the job titles this run found
2. the web, searched on the pain points / initiatives found for those titles,
   for vendors marketing solutions against them
3. every URL already in My Company → Competitors, reviewed for relevance to
   those same pain points and titles
4. a similarity pass against the user's own site — products, features,
   marketing messaging, buyer titles — that keeps only companies close enough
   to be real alternatives, not every vendor touching the problem

The request carries `competitorUrls` (My Company → Competitors) for step 3.
The response field is `competitorsToWatch: [{ name, url, why }]`; a Worker
that doesn't send it leaves the box on *No Competitors Found* and nothing
else changes, so the site can ship before the Worker does.

### Config

`assets/js/config.js` → `findMyCustomer.API_URL` is the Worker endpoint
(public by design; the model API keys stay in the Worker).

`findMyCustomer.USE_SAVED_MATERIALS` is still `false`. **Set it to `true`
once the Worker update is deployed** — until then no `context` is sent and
the competitor agent has no saved materials to read (step 1 above), leaving
it with the web and the tracked competitors.

`findMyCustomer.SEND_AUTH_TOKEN` is `false`. Persona Builder sends
`Authorization: Bearer <firebase id token>`, but the Customer Intelligence
Worker has never received that header. If the Worker's
`Access-Control-Allow-Headers` doesn't list `Authorization`, the browser
blocks the request. Once the Worker verifies Firebase tokens (same
`require-user.js` approach as Persona Drafter) and allows the header, set it
to `true`. Until then, this endpoint is as open as the standalone site.

### Origins

`twishnoff.github.io/Mktforge` and the standalone dashboard share the origin
`https://twishnoff.github.io`, so if the Worker already allows that origin
nothing changes. A custom domain or `http://localhost:8000` needs adding to
the Worker's allowed origins. This module has no Turnstile widget.

### Drift

As with Persona Builder, the standalone site and this module are now two
copies of the same frontend. If you change one, port the change to the other.


## Build Positioning

Stages 0–5 of the Draft Messaging Framework: input audit, competitive
alternatives, differentiators, value ladder, champion & situation, and market
category. Nav button below Persona Builder (crane icon); **Draft
Messaging** (page icon) sits below it and holds stages 6–9. Backend: its own
Cloudflare Worker, `Draft-Messaging-Worker` (separate folder/repo, deployed as
`draft-messaging`), shared by both modules.

```
modules/build-positioning/
  build-positioning.js   page, question table, saved-resource reader, renderers
  positioning-pdf.js     text-first portrait PDF, loaded on the first PDF click
  build-positioning.css  (classes prefixed .bpos)
```

### Run inputs

| Field | Drop-down from My Company | Notes |
|---|---|---|
| Company URL | — | My Company's URL by default (same rule as other modules) |
| Primary Champion | Target Job Titles | any title can be typed |
| Closest Competitor | Competitors | any valid website address can be typed |
| Target Industry (optional) | Target Industries | a typed value that isn't a Target Industry or an exact list entry is matched to the closest entry in `assets/data/industries.js`, shown under the field ("Matched to “FinTech”.") and used for the run |

### Fill in the blanks

A three-column table: question, text box, buttons.

| Row state | Box | Buttons |
|---|---|---|
| locked (no champion / competitor chosen yet) | disabled | Draft Answer (disabled) |
| open (nothing saved) | editable | Draft Answer, with Save below it once the box has text |
| saved | read-only | Edit |
| editing (after Edit) | editable | Draft Answer above Save |

- **Draft Answer** writes a first pass from the company site, web search and
  saved reports into the box, overwriting what's there, and ends it with a
  "Sources:" line. Anything unconfirmed starts with "Assumption:".
- Any editable box with text in it has its own **Save** under **Draft
  Answer** — typed, pasted or just drafted, saved before or not. It appears
  and disappears as you type (`updateRowSave`, which flips the button rather
  than re-rendering the row, so focus and the caret survive); whitespace
  alone doesn't count as text. An editing row keeps its Save even when
  emptied, because that is how a single answer is cleared.
- A row's **Save** saves only that row. The **Save** at the bottom right saves
  every open or editing row that has text. Saving an emptied editing row
  deletes that answer and the row goes back to Draft Answer.
- Unsaved text is kept while switching modules (not across a reload).
- The two **Required** questions (product summary; live vs. roadmap
  features) must be saved before Generate Positioning is enabled. Only saved
  answers are sent; the hint says so when there's unsaved text.

Where answers are saved (`users/{uid}.buildPositioning.answers`, one flat map):

| Key | Questions |
|---|---|
| `company__<id>` | summary, live_features, hidden_strengths, best_customers, self_description, category_appetite, proof, customer_language |
| `competitor__<competitor host>__<id>` | alternatives, competitor_corrections |
| `champion__<title slug>__<id>` | trigger, excluded_tasks |

Switching the Primary Champion or Closest Competitor shows that selection's
answers. Question wording lives twice — `QUESTIONS` in the module and
`src/questions.js` in the Worker — keep the ids in step.

A saved answer collapses back to the height an unanswered box starts at, so
the table doesn't stretch as the answers get longer and editing a later
question doesn't mean scrolling past the earlier ones. When an answer is
longer than that, the box fades its last line and shows a **+** in its
top-right corner to read the whole thing (**−** puts it back); a short answer
that already fits gets no control. **Edit** always opens the full answer, and
saving collapses the row again. `fitAnswer` does the measuring, and
`state.expanded` holds the rows opened to read in full.

### Nav light

The dot next to Build Positioning stays yellow while a positioning run or
**any** Draft Answer is still in flight — including while you're on the
module. When the last one finishes it turns green, or red if any of them
failed, and clears when you open the module or, if you're already there, on
your next click, key press or scroll. See the shell's light rules above.

### Saved materials

Drafts and runs use the shared saved-materials pipeline (see My Company →
How agents use saved materials) with the `large` budget. The line under the
run inputs says what was used, and warns when there's no Persona Builder
report for the chosen champion (priorities then come from imported files or
web research). Your typed answers in the table rank above everything else,
then Imported Materials, then Generated Materials, then websites and web
research.

### Generate Positioning

Streams from the Worker (`/api/positioning`, Server-Sent Events), filling each
box as its stage finishes. Four model calls: stage 0 (with web search),
stages 1–2 (with web search), stages 3–4, stage 5. Takes about 1–3 minutes.
Results and an in-flight run survive switching modules; the nav light shows
progress. Once a run starts, a second **Create Positioning PDF** button
appears next to **Generate Positioning** so the PDF can be made without
scrolling to the bottom; the pair stays centred and both buttons do the same
thing.

### How results are laid out on screen

The screen and the PDF are deliberately different. The PDF is the full
record; the screen is organised for reading. `BOXES` in the module is the
stage list the Worker streams and the order the PDF prints — six stages, the
original titles. `DISPLAY_BOXES` is the on-screen layout only, and nothing in
it changes the data or the PDF:

| On screen | Comes from |
|---|---|
| **Draft — Initial Positioning Statement** | stage 5's `positioning_summary` and `next_questions`, which the PDF still prints under Market Category. "Check with real buyers" reads **What to Validate With Real Buyers** here. |
| **Stage 0 — Input Audit** | stage 0. Arrives minimized. |
| **Stage 1 — Competitive Alternatives** | stage 1, with the status-quo alternatives listed ahead of the competitors (each group in the order the stage returned). Sorted on a copy, so the PDF keeps the stage's own order. |
| **Stage 2 & 3 — Differentiators and Value** | stages 2 and 3 merged: the value themes read two-up at the top, then each differentiator, with its own feature/lets them/so they get rows folded into a minimized **Value & Benefits** box underneath. Rows that match no differentiator collect in **Additional Values & Benefits** at the bottom of the box. |
| **Stage 4 — Champion & Situation** | stage 4. "Tasks it doesn't touch" is plain text, not struck through. |
| **Stage 5 — Market Category** | stage 5, stopping after the recommendation. |

One full-width column, the same width as the "Fill in the blanks" card. Every
box minimizes to its title line from the button in its top-right corner.
Minimize state resets on each run: Input Audit minimized, the rest open, the
nested value boxes closed.

Stage 3 rows carry no id, so they are paired with stage 2 differentiators on
wording (`pairValueRows`): an outright containment wins, otherwise the share
of meaningful words the feature and the attribute have in common, and
anything below `MATCH_FLOOR` goes to Additional Values & Benefits.

**Create Positioning PDF** downloads `Build Positioning N.pdf` and saves it to
My Company. The PDF starts with the positioning summary and ends with the
answers the run used, all as real text, so the next module (stages 6–9) can
read it. Its layout is the original six-stage one and is not affected by any
of the above.

### Config and Worker

`assets/js/config.js` → `buildPositioning.API_BASE_URL`. Every request sends
`Authorization: Bearer <Firebase ID token>`; the Worker verifies it and then
checks the account's email against the shared approved-emails Google Doc.
Deploy steps are in the Worker's README.

### Firestore rules

`firestore.rules` now caps the stored summary at 20 KB. Re-publish the rules
(Firestore → Rules) to apply the cap; everything works without it.



## Draft Messaging

Stages 6–9 of the Draft Messaging Framework, picking up where Build Positioning
left off: strategic narrative, messaging hierarchy, homepage copy draft, and the
quality check that gates them. Nav button below Build Positioning (page icon).
Same Cloudflare Worker as Build Positioning, on a new route (`/api/messaging`).

```
modules/draft-messaging/
  draft-messaging.js     page, drop-downs, file picker, run, renderers
  messaging-pdf.js       text-first portrait PDF, loaded on the first PDF click
  draft-messaging.css    (classes prefixed .dmsg)
```

### Run inputs

Two columns, no form fields — everything comes out of the account.

| Column | What it is |
|---|---|
| **Select your positioning document** (left) | Every PDF the Build Positioning module has saved, newest first, each with its created date under the name. With none saved: *"No positioning documents found. Generate one in the Build Positioning module to continue."* and a **Build Positioning Document** button that opens that module. |
| **Provide additional research (optional)** (right) | The same drag-and-drop import as My Company — same file types, same 15 MB cap, same status lines — and anything dropped here is imported to My Company's Imported Materials as well as added to this run. Below it, **Select files** lists the account's imported files; choosing one moves it into the table and out of the drop-down, and the red **×** on its row puts it back. |

**Draft Messaging** stays disabled until a positioning document is chosen; the
extra files are always optional.

### What the agent is given

The positioning document is the spine of the run — it already carries the
champion, alternatives, differentiators, value themes and category the user
reviewed and saved, so stages 6–9 work from those decisions rather than
re-deciding them. Its text is read back out of Saved Resources with
`getFileText`, which extracts a generated PDF the first time anything needs it.

The chosen files go with it as the user's own research, in the same `context`
shape every other module sends, so the Worker's trust rules apply unchanged:
the user's files beat anything Mktforge generated, which beats web research,
and a file too long to send whole goes as the summary `research.js` stored for
it (see My Company → How agents use saved materials). Unlike the other modules,
this one sends **only what was picked** rather than everything in the account —
the point of the two columns is that the person curates the inputs.

Per-file cap 20k characters, 80k across all of them, 90k for the positioning
document; the Worker caps the payload again on arrival.

### The four stages

Only two of them are ever shown:

| Stage | Where it goes |
|---|---|
| 6 · Strategic narrative | Nowhere. Working material for 7 and 8 — kept on the run for the record, not shown and not printed. |
| 7 · Messaging hierarchy | The top box. Value proposition, the positioning statement (labelled **internal only** — it is never shipped as copy), three pillars with their pains, capabilities and proof, the short forms (one-liner, 30-second pitch, boilerplate), and a collapsible competitive talk track. |
| 8 · Homepage copy draft | The bottom box, in Pierri's order: hero (with a second headline variant to test), problem, solution intro, value props, proof, closing CTA, and any verbatim customer wording the files supplied. |
| 9 · Quality check | Nowhere. The gate, not a result — see below. |

Proof that doesn't exist yet is never invented: it comes back marked
**Placeholder — proof to collect**, on screen and in the PDF.

### The quality gate

Nothing reaches the page until it has been through stage 9. The Worker scores
the draft against Wynter's four layers plus the barbecue and traceability
checks, and the two boxes are scored and gated **separately** — they fail for
different reasons and cost different amounts to fix.

| Check | Messaging Hierarchy | Homepage Copy |
|---|---|---|
| Clarity, Relevance, Value | 4/5 | 4/5 |
| Differentiation | 3/5 | **4/5** |
| Barbecue, Traceability | 3/5 | 3/5 |

Clarity, relevance and value — the three a rewrite can actually repair — carry
the higher bar on both. Traceability and the barbecue test sit lower because
with early-stage inputs there is rarely a published metric to cite, and holding
traceability at 4/5 sent nearly every run to a third attempt over proof that
doesn't exist yet. Differentiation is the one that differs: the homepage is what
gets shipped, and a line a competitor could paste onto their own site is the
failure that matters there. The hierarchy's differentiation comes from the
positioning document, which the user already reviewed, so it isn't re-litigated
here.

**Invented proof is separate from all of that.** Any claim stage 9 flags as
fabricated fails the run outright however well it scores, can't win the
best-of-three comparison (a fabrication costs more than an attempt can make up),
and is removed rather than reworded by the revision.

**Revisions are targeted.** When only the homepage misses, only the homepage is
rewritten, against the hierarchy that just passed — about half the cost of a
retry, and the common case, since the homepage carries the higher bar. When the
hierarchy misses, both are rewritten together: the copy is written *from* the
hierarchy, so a new hierarchy invalidates the copy built on the old one. The
status line names what fell short and which half is being redone — *"Quality
check: homepage copy (differentiation 3/5) · revising the copy, attempt 2 of
3…"*.

Up to three attempts; if none passes, the best-scoring one is shown and the
status line says the check still had notes.

A run takes roughly 2–5 minutes, and longer when it revises. Results and an
in-flight run survive switching modules (not a page reload), and the nav light
follows the run the same way Build Positioning's does.

### Create Messaging PDF

Downloads `Draft Messaging N.pdf` and saves it to My Company. It prints what the
page shows — the hierarchy and the homepage draft — plus a header naming the
positioning document and files the run was built from. All real text, so the
next module can read it back.

### Config and Worker

`assets/js/config.js` → `draftMessaging.API_BASE_URL` (the same Worker as Build
Positioning). Every request sends `Authorization: Bearer <Firebase ID token>`.

In the Worker, stages 6–9 live in `src/messaging.js` rather than in the
positioning bundle; `src/index.js` imports it, hands it what it needs from the
bundle in one `MESSAGING_KIT` object, and routes `/api/messaging` to it. The
route has its own usage-counter label (`messaging`), so a day of messaging runs
doesn't eat the positioning allowance.

**Deploy order:** the Worker first (`wrangler deploy` from
`C:\Users\Tyler\draft-messaging`), then this site. Until the Worker has the
change, Draft Messaging requests 404.

## Persona Builder

A port of the standalone [Persona Drafter](https://twishnoff.github.io/Persona-Drafter/)
into a Mktforge module. Same Cloudflare Worker, same SSE contract, same six
result boxes and the same templated jsPDF export.

What changed in the port:

- its page header/footer are gone — the shell provides the frame
- the palette and type come from Mktforge's tokens; the dark-mode block was dropped
- every DOM lookup is scoped to the container `mount()` hands it, so nothing
  reaches outside the module
- **no Turnstile checkbox** (see below); jsPDF loads on the first PDF click
- the results grid and form use `auto-fit` grids rather than viewport media
  queries, because the display field changes width when the nav is minimized

### Config

`assets/js/config.js` → `personaBuilder.API_BASE_URL`. Public by design; the
model API keys stay in the Worker.

### No Turnstile in Mktforge

Every Persona Builder request carries `Authorization: Bearer <Firebase ID
token>`. The Worker verifies that token (`mktforge-auth.js`, applied
separately in the Persona Drafter Worker) and skips its Turnstile check when
it's valid. Requests without a valid token, including every request from the
standalone site, still have to pass Turnstile. If the account has no token,
or the Worker refuses it, the module shows the "doesn't have access" message.

**Deploy order:** update the Worker first, then this site. Until the Worker
has the change, Persona Builder requests from Mktforge are rejected.

### Origins

The Worker's CORS allowlist is keyed to the origin, and must list
`authorization` in `Access-Control-Allow-Headers`.
`twishnoff.github.io/Mktforge` and `twishnoff.github.io/Persona-Drafter` are
the **same origin** (`https://twishnoff.github.io`). A custom domain for
Mktforge, or `http://localhost:8000` for local testing, needs adding to the
Worker's allowed origins.

### State when you navigate away

Persona Builder keeps its results, its form values and any in-flight run when
you switch to another module and come back. The state lives in the module's
own closure, which outlives `mount()`/`unmount()` — so it survives navigation
but not a page reload, and it doesn't follow you to another device. Crossing
sessions or devices needs a real store (Firestore is already in the Firebase
project); this is the free half of that problem.

Two deliberate choices:

- **A run in flight is not cancelled** when you leave. The callbacks write into
  `state` and check `mounted` before touching any DOM, so research started
  before you navigated away finishes safely and is painted when you return.
- **Generate stays disabled while a run is in flight**, including after you
  come back to the module mid-run.

Any module can do the same thing: keep what matters in the closure, restore it
at the top of `mount()`. The shell doesn't need to know.

### Drift

The standalone site and this module are now two copies of the same frontend.
A change to one needs porting to the other — or retire the standalone site and
make Mktforge the only home.


## Battle Card Generator

A port of the standalone
[Competitive Battle Card Generator](https://github.com/Twishnoff/Battlecard-Generator)
into a Mktforge module, built the same way as Persona Builder and Find My
Customer. Same Cloudflare Worker, same JSON request and response, same nine
boxes, same copy-length rules, and the same landscape jsPDF battle card. Its
nav button sits last in the nav, below Marketing Opportunities, with a
crossed-swords icon.

```
modules/battle-card-generator/
  battle-card-generator.js    page, renderers, shared copy-length rules
  battle-card-pdf.js          PDF engine, loaded on the first PDF click
  battle-card-generator.css
```

What changed in the port:

- the page header (including the repo and request-access links) is gone
- palette and type come from Mktforge's tokens. The PDF still uses the
  researched company's brand color from the Worker, falling back to Mktforge
  green instead of blue.
- the copy caps (300 / 220 / 1100 / 130 / 1300 / 40 characters) live in one
  shared object, `MktforgeBattleCardText`, used by both the page and the PDF,
  so the two still can't drift apart
- the Generate button says which required fields are still missing
- reference links are only made clickable when they are `http(s)` URLs
- a run takes 30–90 seconds, so results, form values and an in-flight run
  survive switching modules (not a page reload)
- no email field; the signed-in account's address is sent (see My Company → Account email)

### Config

`assets/js/config.js` → `battleCardGenerator.API_URL` is the Worker URL.

The Worker checks the submitted email against its Google Doc allow-list, so
the signed-in Mktforge account's email must be on that list.

`SEND_AUTH_TOKEN` is `false`. The Worker's CORS response only allows the
`Content-Type` header, so an `Authorization` header would get the request
blocked by the browser. To lock this Worker to Mktforge accounts, add Firebase
token verification to it, add `Authorization` to `Access-Control-Allow-Headers`,
then set this to `true`.

### Origins

The Worker's `ALLOWED_ORIGIN` defaults to `*`. If it has been set to
`https://twishnoff.github.io`, Mktforge on GitHub Pages is covered. A custom
domain or `http://localhost:8000` would need adding.

### Drift

The standalone site and this module are now two copies of the same frontend.
If you change one, port the change to the other.


## Marketing Opportunities

A port of the standalone
[Syndication & Event Finder](https://github.com/Twishnoff/Syndication-And-Events-Finder)
into a Mktforge module, built the same way as the other ported tools. Same
Cloudflare Worker, same JSON request and response, same uncapped "All Results"
table plus seven category boxes (15 rows each), same "already collected"
guard, and the same jsPDF + autoTable report with clickable links. Its nav
button sits directly below Draft Messaging, with a megaphone icon.

What changed in the port:

- its page header is gone; palette and type come from Mktforge's tokens (the
  PDF's blue is now the Mktforge green)
- jsPDF, autoTable and `opportunities-pdf.js` load on the first PDF click
- All Results shows a count, and scrolls inside its box (with a sticky
  header) after about 520px so a long list doesn't push the category boxes
  far down the page
- the Search button says which required fields are still missing
- only `http(s)` result URLs become links, on the page and in the PDF
- results, form values and an in-flight run survive switching modules
  (not a page reload)
- no email field; the signed-in account's address is sent (see My Company → Account email)

### Config

`assets/js/config.js` → `marketingOpportunities.API_URL` is the Worker URL.

Like Battle Card Generator, this Worker checks the submitted email against a
Google Doc allow-list, so the signed-in account's email must be on it.

`SEND_AUTH_TOKEN` is `false` for the same reason as Battle Card Generator:
the Worker's CORS response only allows `Content-Type`, so an `Authorization`
header would get the request blocked by the browser.

### Origins

The Worker's `ALLOWED_ORIGIN` defaults to `*`. If it has been set to
`https://twishnoff.github.io`, Mktforge on GitHub Pages is covered.

### Drift

The standalone site and this module are now two copies of the same frontend.
If you change one, port the change to the other.


## Customer Tracker

Watches what one job title at a time is saying online about your company,
your competitors and the problems your product solves. Nav button directly
below Marketing Opportunities (radar icon). Spec: Google Doc
"Customer Tracker — Spec v2". Backend: its own Cloudflare Worker,
`customer-tracker` (`C:\Users\Tyler\customer-tracker`, deploy steps in its
README).

```
modules/customer-tracker/
  customer-tracker.js    page, runs, results table
  customer-tracker.css   (classes prefixed .ctrk)
```

### The page

- **Job Title** drop-down: My Company's Target Job Titles, minus the ones
  already being tracked. **Track Title** is disabled until one is picked, and
  greyed out with *"Company URL required…"* when My Company has no URL.
  No titles at all shows *"No job titles found…"*; no competitors shows a
  reminder, and the tool still runs (company and pain-point posts only).
- **Track Title** adds a full-width box for that title (same width as Build
  Positioning's stage boxes, one per row, alphabetical) and starts the agent.
- **Stop Tracking** (top right) asks for a second click, then cancels any run
  and deletes the box and its results. **Refresh Data** (bottom right) is
  disabled while that box is running and replaces the results when the new
  run finishes; if the run fails, the old results stay with the error above
  them.
- Removing or renaming a title in My Company removes its box (a rename is a
  remove plus an add). Adding or removing boxes never changes My Company.

### Results table

Date · Source · Excerpt / summary · Mentions · Link, newest first, up to 25
rows. The row colour is what the item means for **you**:

| About | Positive | Negative |
|---|---|---|
| your company | green | red |
| a competitor | red | green |
| a problem you solve | — | green (a complaint is an opening) |

Neutral and mixed rows have no colour. The Worker sets the colour from the
item's subject and sentiment, not the model's say-so, so it stays consistent.
Each row also says whether the author **stated** their role or the agent
**inferred** it, and why.

### What the agent does

1. Reads your homepage and each competitor's homepage, keeping each site's
   own name (so it searches "Rival", not "rival.com"; if a homepage blocks
   it, the brief looks the name up).
2. Takes only the saved materials that mention this job title
   (`MktforgeResearch.build` with the title, then entries whose `match`
   includes "job title"). Imported files still outrank generated reports.
3. **Brief**: what you do and the problems you solve, competitor names, the
   title's pain points and initiatives *from those materials*, and any
   platforms those materials name (a persona's "where they gather",
   Marketing Opportunities channels). LinkedIn/X/Facebook/Instagram are
   dropped — they can't be read.
4. **Gather** (web search): Reddit, G2, Capterra, TrustRadius, Hacker News,
   forums/blogs/news covering the title's topics, plus the platforms from
   step 3 — nothing else. It collects broadly and records each item's date
   and whatever the author shows about their role, but doesn't judge
   job-title fit. With competitors, a competitor run and a problems run go
   side by side (12 searches each).
5. **Classify** (no search) applies the job-title rule: a stated role
   first; otherwise inferred from the pain points / initiatives in your
   saved materials; otherwise dropped.
   **Persona title families:** before a run, the page reads the Overview of
   every Persona Builder PDF (and any imported file with "persona" in its
   name laid out the same way): "Primary Job Title:" and "Secondary Job
   Titles:". If the tracked title is the primary or one of the secondaries,
   every other title in that persona counts as the same role — an author
   showing any of them is a stated match. The box's note lists the extra
   titles and which file they came from. Titles containing a comma
   ("Senior Manager, Growth Marketing") are rejoined, and a bare level on
   its own ("Senior Manager") is never used. With no saved materials for the
   title, only stated roles count, and the box says so and suggests running
   Persona Builder or Find My Customer for it.
6. The Worker re-checks everything: last 120 days (a month-only date must be
   wholly inside the window; month-only and "x weeks ago" dates show with a
   ~; items with no date at all are kept, shown as "Undated" and listed
   last), nothing on your or a competitor's site, no vendor marketing, and
   the job-title rule again. **Vendor marketing** is a page on a company's
   own site where the company sells something that addresses the problem
   the page discusses — a data-warehouse vendor writing about
   data-warehouse pain is dropped. A company writing as a user or buyer is
   kept: an engineering blog on a problem it solved (e.g. an exchange on
   scaling its database), or a customer's own case study or testimonial.
   Those rows say "company's own site" under the source. Each source's
   root-domain homepage decides whether it's a vendor and what it sells;
   Reddit, review sites, Hacker News, Medium and the platforms your own
   files name aren't checked, since their authors aren't the site's owner.

Searching and judging used to happen in one step, which returned nothing:
with every rule applied mid-search, the model played safe. Each box now
ends with a line saying how many searches ran, how many items were found,
and how many were left out for which reason.

### Runs and the nav light

Runs behave like the other modules: they carry on while you're on other
modules, and several boxes can run at once, but a reload or sign-out ends
them (the Worker notices within 15 s and stops the model call). A box whose
first run was cut off says so and offers Refresh Data. The dot is yellow
while any box is researching, then green — including when nothing was
found — or red if a run failed or timed out (9 minutes on the page, 7½ in
the Worker).

### Storage

```
users/{uid}/tracker/{boxId}   title, rows, lastRefreshed, status, note,
                              companyName, stats, createdAt, updatedAt
```

One document per title (`MktforgeData.trackerId(title)`), so a box's results
never bloat the `users/{uid}` record every other module reads. Results are not
saved to Generated Materials yet, so other modules' agents don't read them.

**Firestore rules must be re-published** for this module (Firestore → Rules →
paste `firestore.rules` → Publish). Without the new `tracker` rule, boxes
can't be saved.

**Deploy order:** the Worker first, then publish the rules, then push this
site.


## Authentication

Firebase Authentication, email + password, with a verified email required
before the app opens. Loaded as compat scripts from Google's CDN, so there is
still no build step.

Passwords never touch this codebase. Firebase hashes and salts them (scrypt)
on Google's servers; Mktforge only ever hands the plaintext straight to the
Firebase SDK over TLS and forgets it.

### One-time setup

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add
   project**. Analytics is optional — off is fine. No credit card needed; this
   all runs on the free Spark plan (50,000 monthly active users).
2. **Build → Authentication → Get started → Sign-in method → Email/Password →
   Enable → Save.** Leave "Email link (passwordless)" off.
3. **Project settings (gear) → General → Your apps → Web (`</>`)**. Register
   the app, skip Firebase Hosting, and copy the `firebaseConfig` object.
4. Paste those six values into the `firebase` block in `assets/js/config.js`.
5. **Authentication → Settings → Authorized domains → Add domain** →
   `twishnoff.github.io`. Without this, sign-in fails with
   `auth/unauthorized-domain`. `localhost` is already on the list.
6. Optional: **Authentication → Templates** to change the sender name and
   wording of the verification and reset emails.

Until step 4 is done the login page says so and the app runs unauthenticated
so the UI can still be previewed. That self-disables the moment real
credentials are in place.

### Locking it down to just you

By default anyone who finds `login.html` can create an account. They would land
in an empty app, but it's worth closing:

- Delete unexpected accounts in **Authentication → Users**.
- Any per-user data must be protected by security rules keyed to the signed-in
  `uid`, so one account can never read another's.
- **The one that costs money:** the Persona Drafter Worker. Mktforge sends
  `Authorization: Bearer <firebase id token>` with every Persona Builder
  request (see `MktforgeAuth.getIdToken()`), and the Worker uses a valid token
  only to skip Turnstile. The standalone site stays open to anyone who passes
  Turnstile.

### Keying user data

Key records on `user.uid`, never on `user.email`. The uid is permanent; an
email address can be changed by its owner, and every record keyed to the old
address is orphaned the moment they do. Keep the email as a field on the
record for display and lookup.

### Emails

Verification and password-reset emails are sent by Firebase from
`noreply@<project-id>.firebaseapp.com`. No SMTP setup, no cost. They can land
in spam — the verify screen says to check there. A custom sending domain is
configurable later if it becomes a nuisance.

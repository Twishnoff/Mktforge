# Mktforge

Front-end shell: navigation bar, management bar, display field. No build step,
no dependencies, no framework. Push the folder to GitHub Pages and it runs.

```
index.html                  the frame (requires a signed-in user)
login.html                  sign in / create account / verify / reset
assets/css/app.css          shell styles + design tokens
assets/js/config.js         public config for modules (no secrets)
assets/js/icons.js          inline SVG icon set
assets/js/auth.js           Firebase Authentication adapter
assets/js/login.js          login page logic
assets/css/login.css        login page styles
assets/js/app.js            shell logic + module registry
modules/module-1/           example module (js + css)
modules/find-my-customer/   Find My Customer (ported from Customer-Intelligence)
modules/persona-builder/    Persona Builder (ported from Persona Drafter)
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

1. Copy `modules/module-1/` to `modules/your-module/` and rename the files.
2. Change `id`, `label`, and `icon` at the top of the JS file.
3. Add one line to `index.html`:
   `<script src="modules/your-module/your-module.js"></script>`

That's it — the nav button, the route (`#/your-module`), and the CSS loading
are all handled by the shell.

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


## Find My Customer

A port of the standalone Customer Overview Dashboard
([Customer-Intelligence](https://github.com/Twishnoff/Customer-Intelligence))
into a Mktforge module, built the same way as Persona Builder. Same Cloudflare
Worker (`/api/dashboard`), same JSON request and response, same five result
boxes, same "already collected" guard, and the same jsPDF + autoTable report.
Its nav button sits directly above Persona Builder, with a crosshairs icon.

What changed in the port:

- its page header is gone — the shell provides the frame
- palette and type come from Mktforge's tokens (the PDF's blue is now the
  Mktforge green)
- every DOM lookup is scoped to the container `mount()` hands it
- jsPDF and autoTable load on the first PDF click, not on page load
- results, form values and an in-flight run survive navigating to another
  module and back, the same way Persona Builder's do
- the email field is prefilled with the signed-in account's address

### Config

`assets/js/config.js` → `findMyCustomer.API_URL` is the Worker endpoint
(public by design; the model API keys stay in the Worker).

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


## Persona Builder

A port of the standalone [Persona Drafter](https://twishnoff.github.io/Persona-Drafter/)
into a Mktforge module. Same Cloudflare Worker, same Turnstile site key, same
SSE contract, same six result boxes and the same templated jsPDF export.

What changed in the port:

- its page header/footer are gone — the shell provides the frame
- the palette and type come from Mktforge's tokens; the dark-mode block was dropped
- every DOM lookup is scoped to the container `mount()` hands it, so nothing
  reaches outside the module
- Turnstile loads when the module opens; jsPDF loads on the first PDF click,
  not on every page load
- an in-flight run is aborted if you navigate to another module mid-research
- the results grid and form use `auto-fit` grids rather than viewport media
  queries, because the display field changes width when the nav is minimized

### Config

`assets/js/config.js` holds `API_BASE_URL` and `TURNSTILE_SITE_KEY`. Both are
public by design — the Turnstile *secret* and the model API keys stay in the
Worker. Nothing else is needed to run it.

### Origins

The Worker's CORS allowlist and the Turnstile widget's hostname list are both
keyed to the origin. `twishnoff.github.io/Mktforge` and
`twishnoff.github.io/Persona-Drafter` are the **same origin**
(`https://twishnoff.github.io`), so no changes are needed on either side.

Two cases that would need a change:

- **A custom domain for Mktforge.** Add it to the Worker's allowed origins and
  to the Turnstile widget's hostnames.
- **Local testing of this module.** Opening from disk sends `Origin: null` and
  Turnstile won't render at all. To test locally, serve over HTTP
  (`python3 -m http.server 8000`) and add `http://localhost:8000` to the
  Worker's allowed origins plus `localhost` to the Turnstile hostname list.
  Everything else in Mktforge previews fine straight off disk.

### Gotcha: Turnstile and dynamically loaded scripts

Turnstile inspects its own `<script>` tag and refuses to initialize if it
carries `async` or `defer` — `turnstile.ready()` throws
*"Remove async/defer from the Turnstile api.js script tag"*. Because the shell
injects the script at runtime, two rules apply:

- load it with `Mktforge.loadScript(src, { async: false })`
- don't call `turnstile.ready()` at all; the tag's `onload` has already fired,
  so `turnstile.render()` can be called directly

The widget slot shows its own status line and the Generate button says what is
still missing, so a failure here is visible rather than a permanently grey
button.

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
- **The Turnstile token is not kept.** Tokens are single-use and the widget is
  destroyed on unmount, so a fresh verification is always needed before the
  next run — while the previous results stay on screen.

Any module can do the same thing: keep what matters in the closure, restore it
at the top of `mount()`. The shell doesn't need to know.

### Drift

The standalone site and this module are now two copies of the same frontend.
A change to one needs porting to the other — or retire the standalone site and
make Mktforge the only home.


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
- **The one that costs money:** the Persona Drafter Worker. Mktforge now sends
  `Authorization: Bearer <firebase id token>` with every Persona Builder
  request (see `MktforgeAuth.getIdToken()`). The Worker side of that lock —
  `require-user.js` plus integration notes — ships separately into the
  Persona-Drafter repo. Until it's deployed the header is simply ignored and
  the endpoint stays open to anyone who finds it.

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

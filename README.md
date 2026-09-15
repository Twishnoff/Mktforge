# Mktforge

Front-end shell: navigation bar, management bar, display field. No build step,
no dependencies, no framework. Push the folder to GitHub Pages and it runs.

```
index.html                  the frame
assets/css/app.css          shell styles + design tokens
assets/js/config.js         public config for modules (no secrets)
assets/js/icons.js          inline SVG icon set
assets/js/auth.js           auth adapter  <- the only file real sign-in touches
assets/js/app.js            shell logic + module registry
modules/module-1/           example module (js + css)
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
- **Accounts are stubbed.** `assets/js/auth.js` returns a hardcoded user and
  Sign Out does nothing. Swap that file's two functions for a real provider
  and no UI code changes.
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

### Drift

The standalone site and this module are now two copies of the same frontend.
A change to one needs porting to the other — or retire the standalone site and
make Mktforge the only home.

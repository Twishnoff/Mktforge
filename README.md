# Mktforge

Front-end shell: navigation bar, management bar, display field. No build step,
no dependencies, no framework. Push the folder to GitHub Pages and it runs.

```
index.html                  the frame
assets/css/app.css          shell styles + design tokens
assets/js/icons.js          inline SVG icon set
assets/js/auth.js           auth adapter  <- the only file real sign-in touches
assets/js/app.js            shell logic + module registry
modules/module-1/           example module (js + css)
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

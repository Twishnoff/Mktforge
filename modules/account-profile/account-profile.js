/* ==========================================================================
   Manage Profile
   The signed-in account's own settings: the picture shown in the circle
   beside the account name in the management bar, and the account's own
   Anthropic API key (optional — module runs come out of it instead of
   Mktforge's key). Both belong to the account, not to a company.

   Reached from the account menu in the management bar, not from the nav —
   registered with `hidden: true`, so it has a #/account-profile route of its
   own but no nav button.

   Choosing an image only previews it. Nothing reaches the account, and the
   management bar doesn't change, until Save.
   ========================================================================== */

(() => {

  const Data = () => window.MktforgeData;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const notify = (message, tone = 'info') =>
    document.dispatchEvent(new CustomEvent('mktforge:notify', { detail: { message, tone } }));

  const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

  /* ---------- state that outlives mount/unmount ----------
     Someone can wander off to another module mid-edit and come back to the
     picture they picked, the same way My Company keeps its drafts. */

  const state = {
    loaded: false,
    loadError: '',
    saved: '',          // what the account currently holds
    draft: null,        // a picked image, not saved yet (null = no change)
    remove: false,      // Remove clicked, not saved yet
    saving: false,
    error: ''
  };

  let root = null;
  let unsubAvatar = null;

  const q = (sel) => root && root.querySelector(sel);

  /* What the preview circle should show right now. */
  function previewSrc() {
    if (state.draft) return state.draft;
    if (state.remove) return '';
    return state.saved;
  }

  const isDirty = () => !!state.draft || (state.remove && !!state.saved);

  /* ---------- markup ---------- */

  function shell() {
    return `
      <div class="ap">
        <header class="ap__head">
          <h1 class="ap__title">Manage Profile</h1>
          <p class="ap__dek">Settings for your account — the same whichever company you're working in.
            Your profile picture is what shows in the circle beside your account name at the top of the page.</p>
        </header>

        <section class="ap__card" aria-label="Profile picture">
          <h2 class="ap__h2">Profile Picture</h2>

          <div class="ap__body">
            <div class="ap__preview">
              <div class="ap__circle" data-el="circle" aria-hidden="true"></div>
              <p class="ap__preview-cap" data-el="caption">Preview</p>
            </div>

            <div class="ap__pick">
              <div class="ap__drop" data-el="drop">
                <p class="ap__drop-main"><strong>Drag and drop an image here</strong> or
                  <button type="button" class="ap__link" data-el="browse">browse your computer</button></p>
                <p class="ap__drop-sub">PNG, JPEG, WebP or GIF · square images look best, anything
                  else is cropped from the centre</p>
              </div>
              <!-- Outside the drop zone on purpose: the zone turns any click
                   into file.click(), and an input in there would bounce that
                   click straight back at itself. -->
              <input type="file" hidden data-el="file" accept="${ACCEPT}">
              <p class="ap__filename" data-el="filename" hidden></p>
            </div>
          </div>

          <p class="ap__error" data-el="error" role="alert" hidden></p>

          <div class="ap__actions">
            <button type="button" class="ap__remove" data-el="remove" hidden>Remove picture</button>
            <span class="ap__spacer"></span>
            <button type="button" class="ap__btn" data-el="save" disabled>Save</button>
          </div>
        </section>

        <section class="ap__card" aria-label="Your API key" data-el="key-card">
          <h2 class="ap__h2">Use Your Own API Key</h2>
          <p class="ap__dek ap__dek--card">Optional. Add your own Anthropic API key and every module you run
            is billed to your Anthropic account instead of Mktforge's. Remove it any time to go back.</p>

          <div class="ap__key" data-el="key-body">
            <p class="ap__key-loading" data-el="key-loading">Checking your account…</p>

            <!-- shown when a key is stored -->
            <div class="ap__key-have" data-el="key-have" hidden>
              <p class="ap__key-line">
                <span class="ap__key-dot" data-el="key-dot" aria-hidden="true"></span>
                <span data-el="key-summary"></span>
              </p>
              <p class="ap__key-sub" data-el="key-sub"></p>
              <div class="ap__actions">
                <button type="button" class="ap__remove" data-el="key-remove">Remove key</button>
                <span class="ap__spacer"></span>
                <button type="button" class="ap__btn ap__btn--ghost" data-el="key-replace">Replace key</button>
              </div>
            </div>

            <!-- shown when there is no key, or Replace was clicked -->
            <form class="ap__key-form" data-el="key-form" hidden autocomplete="off">
              <ol class="ap__key-steps">
                <li>Create a key <strong>just for Mktforge</strong> in the
                  <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">Anthropic Console</a>
                  — don't reuse one from another app.</li>
                <li>Set a <strong>monthly spend limit</strong> on your Anthropic account
                  (<a href="https://console.anthropic.com/settings/limits" target="_blank" rel="noopener">Console → Limits</a>),
                  so a key that leaked could never cost more than that.</li>
                <li>Paste the key below. It's checked with Anthropic, then stored encrypted on Mktforge's server.
                  It's never shown again, not even to you — only its last four characters.</li>
              </ol>
              <div class="ap__key-row">
                <label class="ap__key-label" for="ap-key-input">Anthropic API key</label>
                <input type="password" id="ap-key-input" data-el="key-input" placeholder="sk-ant-…"
                  spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off">
              </div>
              <p class="ap__key-fine">By saving a key you're choosing to run Mktforge on your own Anthropic
                account: usage, costs and any rate limits are between you and Anthropic. Keep the spend limit on.</p>
              <div class="ap__actions">
                <button type="button" class="ap__remove" data-el="key-cancel" hidden>Cancel</button>
                <span class="ap__spacer"></span>
                <button type="submit" class="ap__btn" data-el="key-save" disabled>Save key</button>
              </div>
            </form>

            <p class="ap__error" data-el="key-error" role="alert" hidden></p>
            <p class="ap__key-off" data-el="key-off" hidden></p>
          </div>
        </section>
      </div>`;
  }

  /* ---------- render ---------- */

  function render() {
    if (!root) return;

    const circle = q('[data-el="circle"]');
    const src = previewSrc();
    circle.innerHTML = src
      ? `<img src="${esc(src)}" alt="">`
      : (window.MktforgeIcons ? window.MktforgeIcons.user : '');
    circle.classList.toggle('is-empty', !src);

    const caption = q('[data-el="caption"]');
    if (!state.loaded) caption.textContent = 'Loading…';
    else if (state.draft) caption.textContent = 'Not saved yet';
    else if (state.remove && state.saved) caption.textContent = 'Will be removed';
    else if (state.saved) caption.textContent = 'Current picture';
    else caption.textContent = 'No picture set';

    const save = q('[data-el="save"]');
    save.disabled = state.saving || !state.loaded || !isDirty();
    save.textContent = state.saving ? 'Saving…' : 'Save';

    // Remove only makes sense once there is something to remove, and not
    // while a freshly picked image is sitting there unsaved.
    const remove = q('[data-el="remove"]');
    remove.hidden = !state.loaded || !state.saved || !!state.draft || state.remove;

    const err = q('[data-el="error"]');
    const message = state.error || state.loadError;
    err.textContent = message;
    err.hidden = !message;
  }

  function setError(message) {
    state.error = message || '';
    render();
  }

  /* ---------- picking an image ---------- */

  async function accept(file) {
    if (!file) return;
    setError('');

    const name = q('[data-el="filename"]');
    name.textContent = `Selected: ${file.name}`;
    name.hidden = false;

    try {
      state.draft = await Data().util.imageToAvatarDataUrl(file);
      state.remove = false;
      render();
    } catch (err) {
      state.draft = null;
      name.hidden = true;
      setError(err.message || 'That image couldn’t be read.');
    }
  }

  /* ---------- saving ---------- */

  async function save() {
    if (state.saving || !isDirty()) return;
    state.saving = true;
    setError('');

    const next = state.draft ? state.draft : '';

    try {
      await Data().saveAvatar(next);
      // saveAvatar fans out to the shell, so the management bar circle has
      // already changed by the time this line runs.
      state.saved = next;
      state.draft = null;
      state.remove = false;
      const name = q('[data-el="filename"]');
      if (name) name.hidden = true;
      notify(next ? 'Profile picture saved.' : 'Profile picture removed.');
    } catch (err) {
      console.error('[Mktforge] could not save the profile picture', err);
      setError(err.message || 'Couldn’t save your picture. Try again.');
    } finally {
      state.saving = false;
      render();
    }
  }

  /* ---------- your own API key ----------
     The key never touches this file's state beyond the input box: what's
     kept is the status the access Worker reports (has one / last four /
     rejected). MktforgeKit.byok does the talking. */

  const key = {
    status: null,        // { hasKey, last4, status, available, ... } or null while loading
    editing: false,      // the paste form is open even though a key exists (Replace)
    busy: false,
    error: ''
  };
  let unsubKey = null;

  function renderKey() {
    if (!root) return;
    const st = key.status;
    const loading = q('[data-el="key-loading"]');
    const have = q('[data-el="key-have"]');
    const form = q('[data-el="key-form"]');
    const off = q('[data-el="key-off"]');
    const err = q('[data-el="key-error"]');

    loading.hidden = !!st;
    if (!st) { have.hidden = true; form.hidden = true; off.hidden = true; return; }

    const available = (st.available !== false || st.hasKey) && !st.unavailable;
    off.hidden = available;
    off.textContent = st.unavailable
      ? 'Couldn’t reach the access service just now. Reload the page to try again.'
      : 'Bringing your own key isn’t switched on for Mktforge yet.';
    const showHave = st.hasKey && !key.editing;
    have.hidden = !showHave;
    form.hidden = showHave || !available;

    if (showHave) {
      const tail = st.last4 ? `···${esc(st.last4)}` : '';
      const dot = q('[data-el="key-dot"]');
      const summary = q('[data-el="key-summary"]');
      const sub = q('[data-el="key-sub"]');
      if (st.status === 'rejected') {
        dot.className = 'ap__key-dot is-warn';
        summary.innerHTML = `Your key ending in <strong>${tail}</strong> was rejected by Anthropic`;
        sub.textContent = 'Modules are running on the Mktforge key until you replace it. '
          + 'It was probably revoked — check it in the Anthropic Console, then paste a working key here.';
      } else {
        dot.className = 'ap__key-dot is-ok';
        summary.innerHTML = `Modules run on your key ending in <strong>${tail}</strong>`;
        sub.textContent = st.verifiedAt
          ? `Checked with Anthropic ${new Date(st.verifiedAt).toLocaleString()}.`
          : 'Checked with Anthropic when it was saved.';
      }
    }

    const input = q('[data-el="key-input"]');
    const save = q('[data-el="key-save"]');
    const cancel = q('[data-el="key-cancel"]');
    cancel.hidden = !(st.hasKey && key.editing);
    save.disabled = key.busy || !String(input.value || '').trim();
    save.textContent = key.busy ? 'Checking…' : 'Save key';
    input.disabled = key.busy;
    q('[data-el="key-remove"]').disabled = key.busy;
    q('[data-el="key-replace"]').disabled = key.busy;

    err.textContent = key.error;
    err.hidden = !key.error;
  }

  async function saveKey() {
    if (key.busy) return;
    const input = q('[data-el="key-input"]');
    const value = String(input.value || '').trim();
    if (!value) return;
    key.busy = true; key.error = '';
    renderKey();
    try {
      await window.MktforgeKit.byok.save(value);
      input.value = '';           // the plaintext is gone from the page the moment it's saved
      key.editing = false;
      notify('API key saved. Modules now run on your Anthropic account.');
    } catch (err) {
      key.error = err.message || 'Couldn’t save that key. Try again.';
    } finally {
      key.busy = false;
      renderKey();
    }
  }

  async function removeKey() {
    if (key.busy) return;
    if (!window.confirm('Remove your API key? Modules will go back to running on the Mktforge key.')) return;
    key.busy = true; key.error = '';
    renderKey();
    try {
      await window.MktforgeKit.byok.remove();
      key.editing = false;
      notify('API key removed.');
    } catch (err) {
      key.error = err.message || 'Couldn’t remove the key. Try again.';
    } finally {
      key.busy = false;
      renderKey();
    }
  }

  function bindKey() {
    const form = q('[data-el="key-form"]');
    const input = q('[data-el="key-input"]');
    form.addEventListener('submit', (e) => { e.preventDefault(); saveKey(); });
    input.addEventListener('input', () => { key.error = ''; renderKey(); });
    q('[data-el="key-remove"]').addEventListener('click', removeKey);
    q('[data-el="key-replace"]').addEventListener('click', () => {
      key.editing = true; key.error = '';
      renderKey();
      input.focus();
    });
    q('[data-el="key-cancel"]').addEventListener('click', () => {
      key.editing = false; key.error = '';
      input.value = '';
      renderKey();
    });
  }

  function loadKey() {
    const kit = window.MktforgeKit && window.MktforgeKit.byok;
    if (!kit) { key.status = { hasKey: false, available: false }; renderKey(); return; }
    if (unsubKey) unsubKey();
    unsubKey = kit.onChange((st) => { key.status = st; renderKey(); });
    kit.status({ refresh: true });
  }

  /* ---------- load ---------- */

  async function load() {
    if (state.loaded) { render(); return; }
    try {
      state.saved = await Data().getAvatar();
      state.loadError = '';
    } catch (err) {
      console.error('[Mktforge] could not load the profile picture', err);
      state.loadError = 'Couldn’t load your current picture. You can still upload a new one.';
    }
    state.loaded = true;
    render();
  }

  /* ---------- wiring ---------- */

  function bind() {
    const file = q('[data-el="file"]');
    const drop = q('[data-el="drop"]');

    q('[data-el="browse"]').addEventListener('click', () => file.click());
    drop.addEventListener('click', (e) => {
      // The whole panel is a target, except the link, which has its own handler.
      if (!e.target.closest('[data-el="browse"]')) file.click();
    });

    file.addEventListener('change', () => {
      accept(file.files && file.files[0]);
      file.value = '';            // so picking the same file twice still fires
    });

    ['dragenter', 'dragover'].forEach((type) =>
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.add('is-over');
      }));

    ['dragleave', 'drop'].forEach((type) =>
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        if (type === 'dragleave' && drop.contains(e.relatedTarget)) return;
        drop.classList.remove('is-over');
      }));

    drop.addEventListener('drop', (e) => {
      const dropped = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (dropped) accept(dropped);
    });

    q('[data-el="save"]').addEventListener('click', save);

    q('[data-el="remove"]').addEventListener('click', () => {
      state.remove = true;
      state.draft = null;
      const name = q('[data-el="filename"]');
      if (name) name.hidden = true;
      setError('');
    });
  }

  /* ---------- registration ---------- */

  Mktforge.register({
    id:     'account-profile',
    label:  'Manage Profile',
    icon:   'user',
    styles: 'modules/account-profile/account-profile.css',
    hidden: true,              // reached from the management bar's account menu
    companyAware: true,        // the account's own picture: the same in every company

    mount(container) {
      container.innerHTML = shell();
      root = container.firstElementChild;
      bind();
      bindKey();
      render();
      renderKey();
      load();
      loadKey();

      // Another tab — or a future second place to change it — stays in step.
      unsubAvatar = Data().onAvatar((photo) => {
        state.saved = photo || '';
        render();
      });
    },

    unmount() {
      if (unsubAvatar) { unsubAvatar(); unsubAvatar = null; }
      if (unsubKey) { unsubKey(); unsubKey = null; }
      key.editing = false; key.error = '';
      root = null;
    }
  });

})();

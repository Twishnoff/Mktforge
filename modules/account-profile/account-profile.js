/* ==========================================================================
   Manage Profile
   The signed-in account's own settings. Right now that is one thing: the
   picture shown in the circle beside the account name in the management bar.

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
          <p class="ap__dek">Your profile picture is what shows in the circle beside your account
            name at the top of the page.</p>
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
      render();
      load();

      // Another tab — or a future second place to change it — stays in step.
      unsubAvatar = Data().onAvatar((photo) => {
        state.saved = photo || '';
        render();
      });
    },

    unmount() {
      if (unsubAvatar) { unsubAvatar(); unsubAvatar = null; }
      root = null;
    }
  });

})();

/* ==========================================================================
   Mktforge — module kit
   Small shared behaviours the tool modules use, so each one stays a thin
   port of its standalone app:

     accountEmail()                 the signed-in account's email ('' if none)
     accessProblem()                NO_ACCESS when that email can't be used
     accessError(status, message)   NO_ACCESS when a Worker refused the account
     NO_ACCESS                      the message shown in both cases
     seedCompanyUrl(input, memo)    My Company's URL as the default, once per sign-in
     attachPicker(input, pick)      drop-down of My Company values under a text field

   Everything here only reads My Company data (through MktforgeData) and
   only touches the elements a module passes in.
   ========================================================================== */

window.MktforgeKit = (() => {

  const NO_ACCESS = "Your account doesn't have access to this module. Request access from your administrator.";
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /* ---------- account email ---------- */

  function accountEmail() {
    const a = window.MktforgeAuth;
    const u = a && a.getUser && a.getUser();
    return (u && u.uid !== 'local-preview' && u.email) || '';
  }

  function accessProblem() {
    return EMAIL_RE.test(accountEmail()) ? null : NO_ACCESS;
  }

  /* The Workers answer an unknown or malformed email with 400/403 and a
     message about the email ("not recognized", "approved list", "valid email
     address"). 401/403 also covers a rejected sign-in token. */
  function accessError(status, message) {
    if (status === 401 || status === 403) return NO_ACCESS;
    if (/e-?mail|approved list|not recognized|access/i.test(String(message || ''))) return NO_ACCESS;
    return null;
  }

  /* ---------- Company URL default ----------
     `memo` is an object the module keeps in its own closure (it survives
     switching modules but not a sign-out, which reloads the page).
     The first time the module opens with a My Company URL available, that
     URL is filled in. After that the field is the person's: whatever they
     leave in it, edited or cleared, is what they come back to. */

  function seedCompanyUrl(input, memo) {
    if (!input || memo.seeded) return;
    const markTouched = () => { memo.seeded = true; };
    input.addEventListener('input', (e) => { if (e.isTrusted) markTouched(); });
    if (String(input.value || '').trim()) { markTouched(); return; }
    if (!window.MktforgeData) return;
    window.MktforgeData.getProfile().then((p) => {
      if (memo.seeded || !input.isConnected || !p.companyUrl) return;
      if (String(input.value || '').trim()) { markTouched(); return; }
      input.value = p.companyUrl;
      memo.seeded = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }).catch((err) => console.warn('[Mktforge] profile unavailable for Company URL', err));
  }

  /* ---------- picker ----------
     attachPicker(input, (profile) => profile.targetTitles)
     Focusing or clicking the field opens a list of the My Company values,
     narrowed as the person types. Clicking one fills the field; typing
     anything else is still fine. Arrow keys / Enter / Escape work too. */

  let seq = 0;

  function attachPicker(input, pick) {
    if (!input || input.dataset.picker) return;
    const host = input.parentElement;
    const id = `mf-picker-${++seq}`;
    input.dataset.picker = id;
    host.classList.add('mf-picker-host');

    const list = document.createElement('ul');
    list.className = 'mf-picker';
    list.id = id;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    host.appendChild(list);

    input.setAttribute('autocomplete', 'off');   // no browser history list on top
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', id);

    let all = [];
    let items = [];
    let active = -1;
    let open = false;

    const place = () => {
      list.style.top = `${input.offsetTop + input.offsetHeight + 4}px`;
      list.style.left = `${input.offsetLeft}px`;
      list.style.width = `${input.offsetWidth}px`;
    };

    const paint = () => {
      list.innerHTML = '';
      items.forEach((value, i) => {
        const li = document.createElement('li');
        li.id = `${id}-${i}`;
        li.className = `mf-picker__option${i === active ? ' is-active' : ''}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === active));
        li.dataset.index = String(i);
        li.textContent = value;
        list.appendChild(li);
      });
      const show = open && items.length > 0;
      if (show) place();
      list.hidden = !show;
      input.setAttribute('aria-expanded', String(show));
      if (show && active >= 0) input.setAttribute('aria-activedescendant', `${id}-${active}`);
      else input.removeAttribute('aria-activedescendant');
    };

    const filter = () => {
      const q = input.value.trim().toLowerCase();
      // An exact match (e.g. just picked) still shows everything, so the
      // list stays useful for switching to a different value.
      const exact = all.some((v) => v.toLowerCase() === q);
      items = !q || exact ? all.slice() : all.filter((v) => v.toLowerCase().includes(q));
      active = -1;
      paint();
    };

    const show = async () => {
      open = true;
      try {
        const profile = window.MktforgeData ? await window.MktforgeData.getProfile() : null;
        all = profile ? (pick(profile) || []).filter(Boolean) : [];
      } catch (err) {
        console.warn('[Mktforge] profile unavailable for suggestions', err);
        all = [];
      }
      if (!open || !input.isConnected) return;
      filter();
    };

    const hide = () => { open = false; active = -1; paint(); };

    const choose = (i) => {
      const value = items[i];
      if (value == null) return;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      hide();
      input.focus();
    };

    input.addEventListener('focus', show);
    input.addEventListener('click', () => { if (!open) show(); });
    input.addEventListener('input', () => { if (open) filter(); else show(); });
    input.addEventListener('blur', () => setTimeout(() => {
      if (document.activeElement !== input) hide();
    }, 0));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && (!open || list.hidden)) { e.preventDefault(); show(); return; }
      if (list.hidden) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault(); active = (active + 1) % items.length; paint();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); active = active <= 0 ? items.length - 1 : active - 1; paint();
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault(); choose(active);
      } else if (e.key === 'Escape') {
        e.preventDefault(); hide();
      }
    });
    // mousedown so the choice lands before the field loses focus
    list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('[data-index]');
      if (!li) return;
      e.preventDefault();
      choose(Number(li.dataset.index));
    });
  }

  return { NO_ACCESS, accountEmail, accessProblem, accessError, seedCompanyUrl, attachPicker };
})();

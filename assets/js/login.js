/* ==========================================================================
   Mktforge — login page logic
   Four views in one page: sign in, create account, verify email, reset
   password. MktforgeAuth does all the talking to Firebase; this file only
   swaps views and reports what came back.
   ========================================================================== */

(function () {

  const APP_PAGE = 'index.html';
  const MIN_PASSWORD = 8;              // Firebase's own floor is 6

  const views = {
    signin: document.getElementById('view-signin'),
    create: document.getElementById('view-create'),
    verify: document.getElementById('view-verify'),
    reset:  document.getElementById('view-reset')
  };

  const $ = (id) => document.getElementById(id);

  function show(name) {
    Object.entries(views).forEach(([key, node]) => { node.hidden = key !== name; });
    const focusTarget = views[name].querySelector('input');
    if (focusTarget) focusTarget.focus();
  }

  function setMsg(id, text, ok) {
    const node = $(id);
    node.textContent = text || '';
    node.hidden = !text;
    node.classList.toggle('is-ok', !!ok);
  }

  function busy(btn, isBusy, busyLabel) {
    if (isBusy) {
      btn.dataset.label = btn.textContent;
      btn.textContent = busyLabel;
      btn.disabled = true;
    } else {
      btn.textContent = btn.dataset.label || btn.textContent;
      btn.disabled = false;
    }
  }

  /* ---------- boot ---------- */

  if (!MktforgeAuth.isConfigured()) {
    $('config-warning').hidden = false;
    ['signin-btn', 'create-btn', 'reset-btn'].forEach((id) => { $(id).disabled = true; });
    return;
  }

  if (new URLSearchParams(location.search).get('error') === 'sdk') {
    setMsg('signin-msg', 'Couldn\u2019t reach the sign-in service. Check your connection and try again.');
  }

  MktforgeAuth.init().catch((err) => {
    console.error(err);
    setMsg('signin-msg', 'Couldn\u2019t reach the sign-in service. Check your connection and try again.');
  });

  MktforgeAuth.ready.then((user) => {
    if (!user) return;                                  // signed out — stay here
    if (MktforgeAuth.config.requireVerifiedEmail && !user.verified) {
      $('verify-email').textContent = user.email;
      show('verify');
      return;
    }
    window.location.replace(APP_PAGE);                  // already signed in
  });

  /* ---------- sign in ---------- */

  $('form-signin').addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg('signin-msg', '');

    const email = $('signin-email').value.trim();
    const password = $('signin-password').value;

    if (!email || !password) {
      setMsg('signin-msg', 'Enter your email and password.');
      return;
    }

    busy($('signin-btn'), true, 'Signing in…');
    try {
      const user = await MktforgeAuth.signIn(email, password);
      if (MktforgeAuth.config.requireVerifiedEmail && !user.emailVerified) {
        $('verify-email').textContent = user.email;
        setMsg('verify-msg', 'This address hasn’t been verified yet.');
        show('verify');
        return;
      }
      window.location.replace(APP_PAGE);
    } catch (err) {
      setMsg('signin-msg', MktforgeAuth.messageFor(err));
    } finally {
      busy($('signin-btn'), false);
    }
  });

  /* ---------- create account ---------- */

  $('form-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg('create-msg', '');

    const email = $('create-email').value.trim();
    const p1 = $('create-password').value;
    const p2 = $('create-password2').value;
    const code = $('create-invite').value.trim();

    if (!email) { setMsg('create-msg', 'Enter an email address.'); return; }
    if (p1.length < MIN_PASSWORD) {
      setMsg('create-msg', `Use at least ${MIN_PASSWORD} characters for your password.`);
      return;
    }
    if (p1 !== p2) {
      setMsg('create-msg', 'The two passwords don’t match.');
      $('create-password2').setAttribute('aria-invalid', 'true');
      return;
    }
    $('create-password2').removeAttribute('aria-invalid');

    if (!code) { setMsg('create-msg', 'Enter your invite code.'); return; }

    busy($('create-btn'), true, 'Creating…');
    try {
      const user = await MktforgeAuth.signUp(email, p1);

      // The account exists and is signed in from here. Redeem the invite code
      // before letting them through, and remove the account if it is refused:
      // Firebase will not create a second account on an address that already
      // has one, so a bad code would otherwise strand their real email on a
      // permanently useless login that only the administrator can delete.
      try {
        await MktforgeInvite.redeem(code);
      } catch (redeemErr) {
        try {
          await user.delete();
        } catch (cleanupErr) {
          console.warn('[Mktforge] could not remove the unapproved account', cleanupErr);
          try { await MktforgeAuth.signOut(); } catch (e) { /* nothing further to do */ }
        }
        setMsg('create-msg', redeemErr.message || 'That invite code is not valid.');
        return;
      }

      $('verify-email').textContent = user.email;
      setMsg('verify-msg', '');
      show('verify');
    } catch (err) {
      setMsg('create-msg', MktforgeAuth.messageFor(err));
    } finally {
      busy($('create-btn'), false);
    }
  });

  /* ---------- verify email ---------- */

  $('verify-continue').addEventListener('click', async () => {
    setMsg('verify-msg', '');
    busy($('verify-continue'), true, 'Checking…');
    try {
      const user = await MktforgeAuth.refresh();
      if (user && user.verified) window.location.replace(APP_PAGE);
      else setMsg('verify-msg', 'Not verified yet — click the link in the email, then try again.');
    } catch (err) {
      setMsg('verify-msg', MktforgeAuth.messageFor(err));
    } finally {
      busy($('verify-continue'), false);
    }
  });

  $('verify-resend').addEventListener('click', async () => {
    setMsg('verify-msg', '');
    busy($('verify-resend'), true, 'Sending…');
    try {
      await MktforgeAuth.sendVerification();
      setMsg('verify-msg', 'Sent. Check your inbox — and your spam folder.', true);
    } catch (err) {
      setMsg('verify-msg', MktforgeAuth.messageFor(err));
    } finally {
      busy($('verify-resend'), false);
    }
  });

  $('verify-signout').addEventListener('click', async (e) => {
    e.preventDefault();
    try { await MktforgeAuth.signOut(); } catch (err) { /* it reloads anyway */ }
    show('signin');
  });

  /* ---------- reset password ---------- */

  $('form-reset').addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg('reset-msg', '');

    const email = $('reset-email').value.trim();
    if (!email) { setMsg('reset-msg', 'Enter your email address.'); return; }

    busy($('reset-btn'), true, 'Sending…');
    try {
      await MktforgeAuth.sendPasswordReset(email);
      // Deliberately the same message whether or not the account exists —
      // otherwise this form tells a stranger which emails are registered.
      setMsg('reset-msg', 'If an account exists for that address, a reset link is on its way.', true);
    } catch (err) {
      if (err && err.code === 'auth/user-not-found') {
        setMsg('reset-msg', 'If an account exists for that address, a reset link is on its way.', true);
      } else {
        setMsg('reset-msg', MktforgeAuth.messageFor(err));
      }
    } finally {
      busy($('reset-btn'), false);
    }
  });

  /* ---------- view switching ---------- */

  $('go-create').addEventListener('click', (e) => {
    e.preventDefault();
    setMsg('create-msg', '');
    $('create-email').value = $('signin-email').value.trim();
    show('create');
  });

  $('go-signin').addEventListener('click', (e) => {
    e.preventDefault();
    setMsg('signin-msg', '');
    show('signin');
  });

  $('go-reset').addEventListener('click', (e) => {
    e.preventDefault();
    setMsg('reset-msg', '');
    $('reset-email').value = $('signin-email').value.trim();
    show('reset');
  });

  $('reset-back').addEventListener('click', (e) => {
    e.preventDefault();
    show('signin');
  });

})();

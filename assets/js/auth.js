/* ==========================================================================
   Mktforge — authentication
   Firebase Authentication (email + password), loaded as compat scripts so
   the project still needs no build step.

   The shell only ever calls getUser() / getDisplayName() / signOut(), the
   same three it called when this file was a stub. Everything else here is
   used by login.html.

   WHAT THIS DOES AND DOESN'T PROTECT
   ----------------------------------
   This gates DATA, not CODE. Every file in this repo is public: anyone can
   read the module source, and anyone can edit the JavaScript in their own
   browser to skip the redirect below. That is true of every static site and
   is not a bug you can fix in the client.

   The real boundary is server-side. Firebase Security Rules decide who can
   read or write a given user's records, and any Worker this app calls should
   verify the caller's Firebase ID token before doing paid work. Treat the
   redirect as a convenience for the user, never as the lock.

   Passwords never touch this file. Firebase hashes and salts them with
   scrypt on Google's servers; Mktforge never sees, stores or transmits one
   anywhere except directly to Firebase over TLS.
   ========================================================================== */

window.MktforgeAuth = (() => {

  const SDK_VERSION = '12.19.0';
  const SDK = [
    `https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app-compat.js`,
    `https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-auth-compat.js`
  ];

  const cfg     = (window.MKTFORGE_CONFIG && window.MKTFORGE_CONFIG.firebase) || {};
  const authCfg = Object.assign(
    { requireVerifiedEmail: true, loginPage: 'login.html' },
    (window.MKTFORGE_CONFIG && window.MKTFORGE_CONFIG.auth) || {}
  );

  let app = null;
  let auth = null;
  let currentUser = null;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  const listeners = new Set();

  const isConfigured = () => !!cfg.apiKey && !cfg.apiKey.startsWith('PASTE_');

  /* ---------- script loading (works with or without the shell present) ---- */

  function loadScript(src) {
    if (window.Mktforge && typeof window.Mktforge.loadScript === 'function') {
      return window.Mktforge.loadScript(src);
    }
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve(src);
      el.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(el);
    });
  }

  /* ---------- init ---------- */

  async function init() {
    if (auth) return auth;

    if (!isConfigured()) {
      console.error('[Mktforge] Firebase is not configured — fill in assets/js/config.js');
      readyResolve(null);
      return null;
    }

    for (const src of SDK) await loadScript(src);   // order matters: app, then auth

    app  = firebase.apps.length ? firebase.app() : firebase.initializeApp(cfg);
    auth = firebase.auth();

    await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

    let first = true;
    auth.onAuthStateChanged((user) => {
      currentUser = user || null;
      listeners.forEach((fn) => { try { fn(publicUser()); } catch (e) { console.error(e); } });
      document.dispatchEvent(new CustomEvent('mktforge:user-changed', { detail: publicUser() }));
      if (first) { first = false; readyResolve(publicUser()); }
    });

    return auth;
  }

  /* ---------- shape the shell sees ---------- */

  function publicUser() {
    if (!currentUser) return null;
    return {
      uid:      currentUser.uid,          // the stable key — see note below
      email:    currentUser.email,
      name:     currentUser.displayName || '',
      avatar:   currentUser.photoURL || '',
      verified: !!currentUser.emailVerified
    };
  }

  /* ---------- error messages people can act on ---------- */

  const MESSAGES = {
    'auth/invalid-email':          'That doesn’t look like a valid email address.',
    'auth/user-disabled':          'That account has been disabled.',
    'auth/user-not-found':         'No account found for that email address.',
    'auth/wrong-password':         'Incorrect email or password.',
    'auth/invalid-credential':     'Incorrect email or password.',
    'auth/invalid-login-credentials': 'Incorrect email or password.',
    'auth/email-already-in-use':   'An account already exists for that email address.',
    'auth/weak-password':          'Password is too short — use at least 6 characters.',
    'auth/too-many-requests':      'Too many attempts. Wait a few minutes and try again.',
    'auth/network-request-failed': 'Network error — check your connection and try again.',
    'auth/operation-not-allowed':  'Email/password sign-in is switched off in the Firebase console.',
    'auth/unauthorized-domain':    'This domain isn’t in Firebase’s Authorized domains list.'
  };

  function messageFor(err) {
    if (!err) return 'Something went wrong. Please try again.';
    return MESSAGES[err.code] || err.message || 'Something went wrong. Please try again.';
  }

  /* ---------- public API ---------- */

  return {

    init,
    ready,
    isConfigured,
    config: authCfg,

    /** Current account, or null. Synchronous — await ready first. */
    getUser: publicUser,

    /** What the management bar prints: the name, or the email until one exists. */
    getDisplayName() {
      const u = publicUser();
      if (!u) return '';
      return (u.name && u.name.trim()) ? u.name.trim() : u.email;
    },

    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    async signIn(email, password) {
      await init();
      const cred = await auth.signInWithEmailAndPassword(email, password);
      return cred.user;
    },

    async signUp(email, password) {
      await init();
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      await cred.user.sendEmailVerification();
      return cred.user;
    },

    async sendVerification() {
      await init();
      if (!auth.currentUser) throw new Error('Not signed in.');
      await auth.currentUser.sendEmailVerification();
    },

    async sendPasswordReset(email) {
      await init();
      await auth.sendPasswordResetEmail(email);
    },

    /** Re-checks the server for a verification that happened in another tab. */
    async refresh() {
      await init();
      if (!auth.currentUser) return null;
      await auth.currentUser.reload();
      currentUser = auth.currentUser;
      return publicUser();
    },

    async signOut() {
      await init();
      if (auth) await auth.signOut();
      window.location.href = authCfg.loginPage;
    },

    /** Bounces to the login page unless there is a usable session. */
    async requireAuth() {
      // Before Firebase is configured, keep the shell usable so the UI can be
      // previewed. Remove nothing here — it self-disables the moment real
      // credentials are pasted into config.js.
      if (!isConfigured()) {
        console.warn('[Mktforge] Firebase not configured — running unauthenticated. ' +
                     'Fill in the firebase block in assets/js/config.js.');
        return { uid: 'local-preview', email: 'not-signed-in@localhost',
                 name: 'Preview mode', avatar: '', verified: true };
      }

      try {
        await init();
      } catch (err) {
        // Offline, CDN blocked, or Firebase down. Fail CLOSED — send them to
        // the login page with something to read, rather than leaving a dead
        // shell on screen or, worse, letting them through unauthenticated.
        console.error('[Mktforge] auth unavailable', err);
        window.location.replace(`${authCfg.loginPage}?error=sdk`);
        return null;
      }

      const user = await ready;
      const ok = user && (!authCfg.requireVerifiedEmail || user.verified);
      if (!ok) {
        window.location.replace(authCfg.loginPage);
        return null;
      }
      return user;
    },

    messageFor
  };
})();

/* NOTE ON KEYING USER DATA
   Key everything on user.uid, not user.email. The uid never changes; an
   email address can be changed by the account owner, and the moment it does,
   every record keyed on the old address is orphaned. Store the email as an
   attribute of the record if you want it for display or lookup. */

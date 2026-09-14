/* ==========================================================================
   Mktforge — auth adapter
   THIS IS THE ONLY FILE THAT CHANGES WHEN REAL SIGN-IN ARRIVES.
   The shell never asks where the user came from; it only calls getUser()
   and signOut(). Swap the body of these two functions for Firebase /
   Supabase / Auth0 / your own API later and the interface is untouched.
   ========================================================================== */

window.MktforgeAuth = (() => {

  /* Stubbed account. `name` empty on purpose so you can see the email
     fallback the spec asks for. Set STORE_LOCALLY to true to let the
     browser remember edits made via MktforgeAuth.setUser() while testing
     how a long name shifts the management bar. */
  const STORE_LOCALLY = true;
  const KEY = 'mktforge.user';

  const DEFAULT_USER = {
    name:   '',                            // '' -> the email is displayed instead
    email:  'tyler.wishnoff@gmail.com',
    avatar: ''                             // '' -> generic placeholder is drawn
  };

  function read() {
    if (!STORE_LOCALLY) return { ...DEFAULT_USER };
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      return saved ? { ...DEFAULT_USER, ...saved } : { ...DEFAULT_USER };
    } catch (e) {
      return { ...DEFAULT_USER };
    }
  }

  return {
    /** The signed-in account, or null once real auth can say "nobody". */
    getUser() {
      return read();
    },

    /** What the management bar prints: the name, or the email until one exists. */
    getDisplayName() {
      const u = read();
      return (u.name && u.name.trim()) ? u.name.trim() : u.email;
    },

    /** Test helper — overwrite the stub. Remove once real auth lands. */
    setUser(patch) {
      const next = { ...read(), ...patch };
      if (STORE_LOCALLY) {
        try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) {}
      }
      document.dispatchEvent(new CustomEvent('mktforge:user-changed', { detail: next }));
      return next;
    },

    /** No-op for now. Later: end the session and send them to the login page. */
    signOut() {
      console.info('[Mktforge] Sign Out clicked — no auth wired up yet.');
    }
  };
})();

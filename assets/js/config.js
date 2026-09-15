/* ==========================================================================
   Mktforge — public config
   Values here ship to the browser and are readable by anyone who opens the
   page. PUBLIC KEYS AND URLS ONLY. Never put an API secret in this file —
   a secret belongs in a Cloudflare Worker (or equivalent) that the browser
   calls, which is how Persona Builder is wired.

   The Firebase block below is SUPPOSED to be public. A Firebase web apiKey
   is an identifier, not a credential: it says which project to talk to, not
   who you are. What actually protects your data is Firebase Security Rules
   plus the Authorized domains list — both set in the Firebase console.
   ========================================================================== */

window.MKTFORGE_CONFIG = {

  /* --- Firebase Authentication -------------------------------------------
     Fill these in from: Firebase console → Project settings → General →
     "Your apps" → Web app → SDK setup and configuration → Config.
     README.md has the full click-by-click setup.
     ---------------------------------------------------------------------- */
  firebase: {
    apiKey:            'PASTE_API_KEY',
    authDomain:        'PASTE_PROJECT_ID.firebaseapp.com',
    projectId:         'PASTE_PROJECT_ID',
    storageBucket:     'PASTE_PROJECT_ID.firebasestorage.app',
    messagingSenderId: 'PASTE_SENDER_ID',
    appId:             'PASTE_APP_ID'
  },

  auth: {
    // Require a verified email address before the app will open.
    requireVerifiedEmail: true,

    // Where the shell sends people who aren't signed in.
    loginPage: 'login.html'
  },

  findMyCustomer: {
    API_URL: 'https://customer-overview-dashboard.tyler-wishnoff.workers.dev/api/dashboard',
    // Leave false until the Worker verifies Firebase ID tokens and lists
    // Authorization in Access-Control-Allow-Headers — see README.
    SEND_AUTH_TOKEN: false
  },

  personaBuilder: {
    API_BASE_URL: 'https://persona-drafter-api.tyler-wishnoff.workers.dev',
    TURNSTILE_SITE_KEY: '0x4AAAAAAEhj_UpeZip62a9o'
  }

};

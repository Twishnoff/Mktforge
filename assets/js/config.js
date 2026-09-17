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
    apiKey:            'AIzaSyDJreuKMDStRQtogE8kyWiGkbXa_WkW7hU',
    authDomain:        'mktforge.firebaseapp.com',
    projectId:         'mktforge',
    storageBucket:     'mktforge.firebasestorage.app',
    messagingSenderId: '756951502720',
    appId:             '1:756951502720:web:697675239c75d33c493b65'
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
    SEND_AUTH_TOKEN: false,
    // Imported/Generated Materials go with each request — the Worker reads
    // them in competitors.js (Competitors To Watch, step 1). See README.
    USE_SAVED_MATERIALS: true
  },

  personaBuilder: {
    // No Turnstile here: the Worker skips it for requests with a valid
    // Mktforge sign-in token. The standalone site keeps its checkbox.
    API_BASE_URL: 'https://persona-drafter-api.tyler-wishnoff.workers.dev',
    // Off until the Persona Drafter Worker passes `context` to its agent.
    USE_SAVED_MATERIALS: false
  },

    battleCardGenerator: {
    API_URL: 'https://battle-card-generator.tyler-wishnoff.workers.dev',
    // Worker verifies Firebase ID tokens against the shared KV allowlist and
    // allows Authorization in CORS (2026-09-17). Anonymous requests still
    // fall back to the Google Doc allow-list for the standalone site.
    SEND_AUTH_TOKEN: true,
    // Imported/Generated Materials go with each request (Worker updated).
    USE_SAVED_MATERIALS: true
  },

  research: {
    // Summarizes each saved material once for the agents (Build Positioning's Worker).
    DIGEST_URL: 'https://draft-messaging.tyler-wishnoff.workers.dev/api/digest'
  },

  buildPositioning: {
    // Its own Worker (Draft-Messaging-Worker, deployed as "draft-messaging").
    // Every request carries the
    // Firebase ID token, which the Worker verifies — see README.
    API_BASE_URL: 'https://draft-messaging.tyler-wishnoff.workers.dev'
  },

  marketingOpportunities: {
    API_URL: 'https://syndication-event-finder.tyler-wishnoff.workers.dev',
    // The Worker's CORS only allows Content-Type today — leave false until
    // it verifies Firebase ID tokens and allows Authorization. See README.
    SEND_AUTH_TOKEN: false,
    // Imported/Generated Materials go with each request (Worker updated).
    USE_SAVED_MATERIALS: true
  }

};

/* ==========================================================================
   Mktforge — public config
   Values here ship to the browser and are readable by anyone who opens the
   page. PUBLIC KEYS AND URLS ONLY. Never put an API secret in this file —
   a secret belongs in a Cloudflare Worker (or equivalent) that the browser
   calls, which is exactly how Persona Builder is wired.
   ========================================================================== */

window.MKTFORGE_CONFIG = {

  personaBuilder: {
    // Same Worker the standalone Persona Drafter calls.
    API_BASE_URL: 'https://persona-drafter-api.tyler-wishnoff.workers.dev',

    // Public counterpart to the TURNSTILE_SECRET_KEY that lives in the Worker.
    // The widget is bound to a hostname list in the Cloudflare dashboard —
    // twishnoff.github.io is already on it, so Mktforge works there as-is.
    TURNSTILE_SITE_KEY: '0x4AAAAAAEhj_UpeZip62a9o'
  }

};

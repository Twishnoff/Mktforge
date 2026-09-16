/* ==========================================================================
   Draft Messaging — placeholder
   Holds the nav slot (below Find My Customer) until the real module ships.
   ========================================================================== */

Mktforge.register({
  id:     'draft-messaging',
  label:  'Draft Messaging',
  icon:   'doc',
  styles: 'modules/draft-messaging/draft-messaging.css',

  mount(container) {
    container.innerHTML = `
      <div class="dm">
        <h1 class="dm__title">Module Coming Soon</h1>
        <p class="dm__dek">Check back for updates.</p>
      </div>`;
  }
});

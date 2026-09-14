/* ==========================================================================
   Mktforge — icon set
   Inline SVG, no CDN and no icon font: the shell keeps working offline and
   nothing renders as a blank square if a third party goes down.
   Add an icon here, then reference it by key from a module's `icon` field.
   ========================================================================== */

window.MktforgeIcons = {

  /* Generic user profile — the placeholder icon for Module 1 */
  user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <circle cx="12" cy="8" r="3.6"/>
           <path d="M4.5 20c0-3.6 3.4-5.8 7.5-5.8s7.5 2.2 7.5 5.8"/>
         </svg>`,

  /* A few spares so new modules have something to point at */
  grid: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <rect x="3.5" y="3.5" width="7" height="7" rx="1.2"/>
           <rect x="13.5" y="3.5" width="7" height="7" rx="1.2"/>
           <rect x="3.5" y="13.5" width="7" height="7" rx="1.2"/>
           <rect x="13.5" y="13.5" width="7" height="7" rx="1.2"/>
         </svg>`,

  doc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/>
          <path d="M14 3.5V8h4.5"/><path d="M8.8 12.5h6.4"/><path d="M8.8 16h4.4"/>
        </svg>`,

  chart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 20V4"/><path d="M4 20h16"/>
            <rect x="7.5" y="12" width="3" height="5" rx="1"/>
            <rect x="13" y="8" width="3" height="9" rx="1"/>
          </svg>`
};

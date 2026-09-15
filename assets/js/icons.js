/* ==========================================================================
   Mktforge — icon set
   Inline SVG, no CDN and no icon font: the shell keeps working offline and
   nothing renders as a blank square if a third party goes down.
   Add an icon here, then reference it by key from a module's `icon` field.
   ========================================================================== */

window.MktforgeIcons = {

  /* My Company — factory with a sawtooth roof and a smokestack */
  factory: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2.8 20.5h18.4"/>
              <path d="M3.8 20.5V9.2l4.6 3.1V9.2l4.6 3.1V9.2l3.4 2.3V3.5h3.8v17"/>
              <rect x="6.4" y="15.6" width="2.2" height="2.2" rx=".3"/>
              <rect x="10.9" y="15.6" width="2.2" height="2.2" rx=".3"/>
              <rect x="15.4" y="15.6" width="2.2" height="2.2" rx=".3"/>
            </svg>`,

  /* Generic user profile — account avatar fallback */
  user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <circle cx="12" cy="8" r="3.6"/>
           <path d="M4.5 20c0-3.6 3.4-5.8 7.5-5.8s7.5 2.2 7.5 5.8"/>
         </svg>`,

  /* Find My Customer — targeting crosshairs */
  crosshair: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="7.5"/>
                <circle cx="12" cy="12" r="2.2"/>
                <path d="M12 1.8v5"/><path d="M12 17.2v5"/>
                <path d="M1.8 12h5"/><path d="M17.2 12h5"/>
              </svg>`,

  /* Persona Builder — profile card with a magnifier */
  persona: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="2.6" y="4.5" width="18.8" height="15" rx="2"/>
              <circle cx="9" cy="10.4" r="2.2"/>
              <path d="M5.6 15.8c.5-1.7 1.8-2.6 3.4-2.6s2.9.9 3.4 2.6"/>
              <path d="M15.4 9.6h3.4"/><path d="M15.4 12.6h3.4"/>
            </svg>`,

  /* Battle Card Generator — two crossed swords */
  swords: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
             <path d="M14.5 17.5 3 6V3h3l11.5 11.5"/>
             <path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/>
             <path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/>
             <path d="m5 14 4 4"/><path d="m7 17-3 3"/><path d="m3 19 2 2"/>
           </svg>`,

  /* Marketing Opportunities — megaphone */
  megaphone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3.5 10v4a1 1 0 0 0 1 1H7l7.5 4.5V4.5L7 9H4.5a1 1 0 0 0-1 1z"/>
                <path d="M7 15l1.3 4.6a1 1 0 0 0 1 .7h1a1 1 0 0 0 .9-1.3L10 15.8"/>
                <path d="M18 9.2a4 4 0 0 1 0 5.6"/>
                <path d="M20.3 7a7 7 0 0 1 0 10"/>
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

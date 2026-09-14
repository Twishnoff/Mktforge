/* ==========================================================================
   Module 1 — placeholder
   A worked example of the module contract. Copy this folder, rename the id,
   add one <script> line to index.html, and you have a second module.
   ========================================================================== */

Mktforge.register({
  id:     'module-1',
  label:  'Module 1',
  icon:   'user',
  styles: 'modules/module-1/module-1.css',

  mount(container) {
    container.innerHTML = `
      <div class="m1">
        <header class="m1__head">
          <p class="m1__eyebrow">Module 1</p>
          <h1 class="m1__title">Placeholder module</h1>
          <p class="m1__lede">
            This is the display field. Whatever a module renders lives inside this
            container and nowhere else &mdash; that boundary is what keeps modules
            swappable and makes a later move to a framework a shell rewrite rather
            than a full one.
          </p>
        </header>

        <section class="m1__section">
          <h2>How this module is wired</h2>
          <ul class="m1__list">
            <li><code>modules/module-1/module-1.js</code> calls <code>Mktforge.register()</code></li>
            <li><code>modules/module-1/module-1.css</code> is loaded the first time the module opens</li>
            <li>The shell handed <code>mount()</code> a container and got out of the way</li>
            <li>The URL is <code>#/module-1</code>, so refreshing or sharing the link lands here</li>
          </ul>
        </section>

        <section class="m1__section">
          <h2>Scroll behaviour</h2>
          <p>
            Only this field scrolls. The navigation bar and the management bar stay
            put. Keep going &mdash; the blocks below exist to prove it.
          </p>
        </section>

        ${Array.from({ length: 6 }, (_, i) => `
          <section class="m1__card">
            <h3>Content block ${i + 1}</h3>
            <p>
              Filler standing in for whatever this module eventually does. The page
              scrolls under a fixed frame, and the scrollbar runs from the bottom of
              the management bar to the bottom of the browser window.
            </p>
          </section>`).join('')}

        <footer class="m1__foot">End of module &mdash; the frame never moved.</footer>
      </div>`;
  },

  unmount(container) {
    // Nothing to clean up yet. Remove timers, listeners and observers here.
  }
});

/* ==========================================================================
   Mktforge — invite codes
   Redeems a one-time invite code for the account that is signed in right now.
   The access Worker verifies the Firebase ID token, checks the code, and
   writes the account's uid into the shared KV allowlist that every module
   Worker reads. Nothing here decides access — it only asks.

     MktforgeInvite.redeem(code) -> Promise<{ ok, label?, plan, upgraded? }>
       with a code: join the allowlist on the hosted plan (may fall back to
       Mktforge's API key) — or upgrade an existing self-signup account to it
     MktforgeInvite.register()   -> Promise<{ ok, plan }>
       no code: join on the byok plan (the account's own API key only)

   Throws an Error whose .message is already written for the person.
   ========================================================================== */

window.MktforgeInvite = (() => {

  const API = 'https://mktforge-access.tyler-wishnoff.workers.dev';

  async function post(path, body, failVerb) {
    const token = (window.MktforgeAuth && window.MktforgeAuth.getIdToken)
      ? await window.MktforgeAuth.getIdToken(true)
      : null;

    if (!token) {
      throw new Error('Could not confirm your sign-in. Please try again.');
    }

    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(body || {})
      });
    } catch (err) {
      // Network failure, not a rejected code — say so, so nobody retypes a
      // perfectly good code five times.
      throw new Error('Could not reach the access service. Check your connection and try again.');
    }

    const payload = await res.json().catch(() => null);

    if (!res.ok || !payload || payload.ok !== true) {
      throw new Error(
        (payload && payload.message) || `Could not ${failVerb} (${res.status}).`
      );
    }

    return payload;
  }

  async function redeem(code) {
    const payload = await post('/redeem', { code }, 'redeem that code');
    // An existing byok account moved to hosted; a brand-new signup is not a change.
    if (payload.upgraded && window.MktforgeAnalytics) {
      window.MktforgeAnalytics.capture('plan_changed', {
        from: 'byok', to: payload.plan || 'hosted', via: 'invite_code', $set: { plan: payload.plan || 'hosted' }
      });
    }
    return payload;
  }
  const register = () => post('/register', {}, 'set up your account');

  return { redeem, register };
})();

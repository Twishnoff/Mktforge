/* ==========================================================================
   Mktforge — invite codes
   Redeems a one-time invite code for the account that is signed in right now.
   The access Worker verifies the Firebase ID token, checks the code, and
   writes the account's uid into the shared KV allowlist that every module
   Worker reads. Nothing here decides access — it only asks.

     MktforgeInvite.redeem(code) -> Promise<{ ok, label? }>

   Throws an Error whose .message is already written for the person.
   ========================================================================== */

window.MktforgeInvite = (() => {

  const API = 'https://mktforge-access.tyler-wishnoff.workers.dev';

  async function redeem(code) {
    const token = (window.MktforgeAuth && window.MktforgeAuth.getIdToken)
      ? await window.MktforgeAuth.getIdToken(true)
      : null;

    if (!token) {
      throw new Error('Could not confirm your sign-in. Please try again.');
    }

    let res;
    try {
      res = await fetch(`${API}/redeem`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ code })
      });
    } catch (err) {
      // Network failure, not a rejected code — say so, so nobody retypes a
      // perfectly good code five times.
      throw new Error('Could not reach the access service. Check your connection and try again.');
    }

    const payload = await res.json().catch(() => null);

    if (!res.ok || !payload || payload.ok !== true) {
      throw new Error(
        (payload && payload.message) || `Could not redeem that code (${res.status}).`
      );
    }

    return payload;
  }

  return { redeem };
})();

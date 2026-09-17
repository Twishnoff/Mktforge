/**
 * mktforge-api.js — frontend helper for authenticated Worker calls.
 *
 * Replaces the current pattern of putting the account email in the request
 * body. Every module now sends a Firebase ID token instead, which the Worker
 * verifies. The email the Worker sees is one it derived from a Google-signed
 * token, not a string the browser handed it.
 *
 * Works with either Firebase API style:
 *   - compat  (app calls firebase.initializeApp(...) / firebase.auth())
 *   - modular (app calls initializeApp() imported from firebase-app.js)
 *
 * It detects which is in use rather than assuming, because the two keep
 * separate app registries and mixing them yields "No Firebase App '[DEFAULT]'
 * has been created".
 *
 * Usage inside a module:
 *
 *   import { callModule } from "../mktforge-api.js";
 *
 *   const data = await callModule(
 *     "https://persona-drafter-api.tyler-wishnoff.workers.dev/generate",
 *     { companyUrl, jobTitle }
 *   );
 */

// Must match the version your app loads. Confirmed 2026-09-17 from the
// Network tab: https://www.gstatic.com/firebasejs/12.19.0/...
const FIREBASE_SDK_VERSION = "12.19.0";

export const ACCESS_API = "https://mktforge-access.tyler-wishnoff.workers.dev";

/** Thrown for any non-2xx Worker response. `code` is the machine-readable tag. */
export class ModuleAccessError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "ModuleAccessError";
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------------------------------------------ *
 * Auth resolution
 * ------------------------------------------------------------------ */

let authPromise = null;

/**
 * Resolve the Auth instance the app actually initialized.
 * Prefers the compat global when present, since that's what your app loads.
 */
function resolveAuth() {
  if (authPromise) return authPromise;

  authPromise = (async () => {
    const compat = globalThis.firebase;
    if (compat && typeof compat.auth === "function") {
      try {
        return compat.auth();
      } catch {
        // compat loaded but no app initialized — fall through to modular
      }
    }

    const { getAuth } = await import(
      `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth.js`
    );
    return getAuth();
  })();

  return authPromise;
}

/**
 * Auth state restores asynchronously after page load, so `currentUser` is null
 * for a moment even when the person is signed in. A module that fires a request
 * immediately would otherwise see a spurious "sign in" error.
 */
function waitForUser(auth, timeoutMs = 8000) {
  if (auth.currentUser) return Promise.resolve(auth.currentUser);

  return new Promise((resolve) => {
    let unsub = null;
    const timer = setTimeout(() => {
      if (unsub) unsub();
      resolve(auth.currentUser || null);
    }, timeoutMs);

    unsub = auth.onAuthStateChanged((user) => {
      clearTimeout(timer);
      if (unsub) unsub();
      resolve(user);
    });
  });
}

/**
 * Fetch an ID token for the signed-in user.
 * `forceRefresh` is used once on a 401 so an expired token self-heals.
 */
async function idToken(forceRefresh = false) {
  const auth = await resolveAuth();
  const user = await waitForUser(auth);

  if (!user) {
    throw new ModuleAccessError(
      "Sign in to use this module.",
      "unauthenticated",
      401
    );
  }
  return user.getIdToken(forceRefresh);
}

/* ------------------------------------------------------------------ *
 * Worker calls
 * ------------------------------------------------------------------ */

/**
 * POST JSON to a Worker with the ID token attached.
 * Retries once with a refreshed token if the first attempt 401s.
 */
export async function callModule(url, body = {}, options = {}) {
  const { method = "POST", retryOn401 = true, signal } = options;

  const send = async (forceRefresh) => {
    const token = await idToken(forceRefresh);
    return fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: method === "GET" ? undefined : JSON.stringify(body),
      signal,
    });
  };

  let res = await send(false);
  if (res.status === 401 && retryOn401) res = await send(true);

  if (!res.ok) {
    let payload = {};
    try {
      payload = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new ModuleAccessError(
      payload.message || `Request failed (${res.status}).`,
      payload.error || "request_failed",
      res.status
    );
  }

  return res.json();
}

/**
 * Same auth, but returns the raw Response so streaming modules can read the
 * SSE body themselves. Persona Builder and Build Positioning need this.
 */
export async function streamModule(url, body = {}, options = {}) {
  const { signal } = options;
  const token = await idToken(false);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let payload = {};
    try {
      payload = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new ModuleAccessError(
      payload.message || `Request failed (${res.status}).`,
      payload.error || "request_failed",
      res.status
    );
  }

  return res;
}

/* ------------------------------------------------------------------ *
 * Invite codes
 * ------------------------------------------------------------------ */

/** Redeem an invite code for the currently signed-in account. */
export async function redeemInviteCode(code) {
  return callModule(`${ACCESS_API}/redeem`, { code });
}

/**
 * Current account's access status:
 *   { uid, email, emailVerified, approved, label }
 */
export async function getAccessStatus() {
  return callModule(`${ACCESS_API}/me`, {}, { method: "GET" });
}

/**
 * Diagnostic — run from the devtools console to confirm the helper can see
 * your signed-in user:
 *
 *   const m = await import("/Mktforge/mktforge-api.js");
 *   await m.debugAuth();
 */
export async function debugAuth() {
  const auth = await resolveAuth();
  const user = await waitForUser(auth);
  const style = globalThis.firebase?.auth ? "compat" : "modular";
  if (!user) {
    console.log({ style, signedIn: false, sdk: FIREBASE_SDK_VERSION });
    return { style, signedIn: false };
  }
  const r = await user.getIdTokenResult(true);
  const out = {
    style,
    sdk: FIREBASE_SDK_VERSION,
    signedIn: true,
    email: r.claims.email,
    emailVerified: r.claims.email_verified,
    uid: r.claims.sub,
    project: r.claims.aud,
  };
  console.log(out);
  return out;
}

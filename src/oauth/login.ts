/**
 * Browser-based OAuth login flow.
 *
 * Mirrors the implicit-grant flow `WindsurfAuthProvider.getLoginUrl` builds in
 * `/Applications/Windsurf.app/.../extension.js`:
 *
 *   https://windsurf.com/windsurf/signin
 *     ?response_type=token
 *     &client_id=3GUryQ7ldAeKEuD2obYnppsnmj58eP5u
 *     &redirect_uri=<R>
 *     &state=<uuid>
 *     &prompt=login
 *     &redirect_parameters_type=<query|fragment>
 *
 * The desktop extension ships `redirect_uri=windsurf://codeium.windsurf` so the
 * OS routes the callback through the Windsurf protocol handler. We can't
 * register an OS-level scheme from a Node CLI, so we use two strategies:
 *
 *   1. **Loopback callback (preferred)**: bind a one-shot HTTP server on
 *      `127.0.0.1:<port>/auth` and pass that as `redirect_uri`. The Windsurf
 *      SPA hands the token off as a query string. This is the same trick the
 *      older Codeium VS plugin used (see `LanguageServer.cs:SignInAsync`).
 *
 *   2. **Manual paste fallback**: pass `redirect_uri=show-auth-token`. The
 *      Windsurf SPA renders the raw token in a `<code>` block for the user to
 *      copy. We prompt for it in the terminal.
 *
 * Whichever path produces the token, we hand it to `registerUser` to exchange
 * for the long-lived API key.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { registerUser, WindsurfRegistrationError } from './register-user.js';
import { saveCredentials } from './storage.js';
import { DEFAULT_REGION, type OAuthLoginResult, type WindsurfRegion } from './types.js';

/** How long to wait for the user to finish the browser flow. */
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface LoginOptions {
  region?: WindsurfRegion;
  /** Override the random callback port (mostly useful for tests). */
  callbackPort?: number;
  /** Force the manual-paste flow instead of attempting a loopback callback. */
  manualPaste?: boolean;
  /** Treat this as a new-user onboarding flow (uses /windsurf/signup). */
  signUp?: boolean;
  /** Pre-fill the email on the sign-in page. */
  loginHint?: string;
  /** Abort signal to cancel the in-flight login. */
  signal?: AbortSignal;
  /** Custom timeout. */
  timeoutMs?: number;
  /** Hook called once the URL is ready, before we open the browser. */
  onUrl?: (url: string) => void | Promise<void>;
  /** Custom token-paste prompt for the manual fallback. Defaults to readline on stdin. */
  promptForToken?: () => Promise<string>;
}

/**
 * Run the full browser sign-in flow and persist credentials. Returns the
 * resolved API key + account name + apiServerUrl for the caller to display.
 */
export async function login(opts: LoginOptions = {}): Promise<OAuthLoginResult> {
  const region = opts.region ?? DEFAULT_REGION;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;

  const token = opts.manualPaste
    ? await loginWithManualPaste(region, opts)
    : await loginWithLoopback(region, opts, timeoutMs);

  const result = await registerUser(token, region, opts.signal);

  // Preserve the existing `syncedViaOpencodeAuth` flag if a previous
  // login wrote one. Without this preservation, a user who did
  // `opencode auth login` (sets flag=true) and then later ran
  // `npx opencode-windsurf-auth login` (used to omit the flag) would
  // end up with flag=undefined — subsequent `opencode auth logout`
  // would no longer mirror-clear our credentials file, leaving a stale
  // api_key trusted by the proxy auth gate.
  let existingSynced: boolean | undefined;
  try {
    const existing = (await import('./storage.js')).loadCredentials();
    existingSynced = existing?.syncedViaOpencodeAuth;
  } catch { /* no prior creds */ }

  await saveCredentials({
    apiKey: result.apiKey,
    name: result.name,
    apiServerUrl: result.apiServerUrl,
    redirectUrl: result.redirectUrl,
    issuedAt: new Date().toISOString(),
    oauthClientId: region.oauthClientId,
    ...(existingSynced !== undefined ? { syncedViaOpencodeAuth: existingSynced } : {}),
  });

  return result;
}

/**
 * Two-stage version of {@link login} for the opencode `auth.methods[*].authorize`
 * flow.
 *
 * Why: opencode's `AuthOuathResult` requires us to return `{ url, callback }`
 * *synchronously*, and opencode immediately opens the URL in the browser. The
 * loopback callback's port must therefore be known BEFORE we return — we can't
 * bind it lazily in `callback()` like the standalone CLI does. This function:
 *
 *   1. Binds the loopback HTTP server NOW (real ephemeral port)
 *   2. Builds the sign-in URL with that real port
 *   3. Hands back `{ url, awaitToken }` — `awaitToken` is what opencode calls
 *      after the user finishes in the browser; it waits for the loopback to
 *      fire, exchanges the firebase_id_token via RegisterUser, and persists.
 */
export interface PreparedLogin {
  /** Fully-formed sign-in URL with the loopback redirect baked in. */
  url: string;
  /** Wait for browser callback, exchange token, persist credentials. */
  awaitToken: () => Promise<OAuthLoginResult>;
  /** Tear down the loopback if the caller bails out. */
  cancel: () => void;
}

export async function prepareLogin(opts: LoginOptions = {}): Promise<PreparedLogin> {
  const region = opts.region ?? DEFAULT_REGION;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const state = crypto.randomUUID();

  // Bind the loopback FIRST so we have a real port to put in the URL.
  const server = await startCallbackServer(opts.callbackPort);
  const callbackUrl = `http://127.0.0.1:${server.port}/auth`;
  const url = buildLoginUrl({
    region,
    redirectUri: callbackUrl,
    redirectParametersType: 'query',
    state,
    signUp: opts.signUp,
    loginHint: opts.loginHint,
  });

  // Pre-register the waiter BEFORE opening the browser. There's a real race
  // here: the user might already be signed in to windsurf.com, in which
  // case the Auth0 SPA round-trips in <50ms — fast enough that the loopback
  // callback can hit /auth before opencode gets back into our awaitToken()
  // and calls server.callback(state). The matchedWaiter check at the
  // request handler would then return "Unexpected callback" + leave
  // captured=null, deadlocking awaitToken until its 5-minute timeout.
  //
  // By starting the waiter promise here we ensure a matching waiter is
  // queued before any HTTP request can land. awaitToken just awaits the
  // already-running promise.
  //
  // Attach a `.catch` so that if the caller (opencode's `authorize()`
  // flow) prints the URL and then NEITHER calls `awaitToken()` NOR
  // `cancel()`, the unhandled rejection from the eventual timeout
  // doesn't surface as a process warning. Errors are still propagated
  // to `awaitToken`'s await — the no-op handler only runs when nobody's
  // listening.
  const callbackPromise = server.callback(state);
  callbackPromise.catch(() => { /* handled by awaitToken if called */ });

  // Open the system browser pointed at the sign-in URL. We do this in
  // prepareLogin (not awaitToken) because opencode invokes authorize()
  // synchronously, prints the URL, and only THEN polls callback(). If we
  // waited until awaitToken to call openBrowser, the user would never see
  // a browser tab pop — opencode would just hang printing the URL until the
  // user manually clicks it. (This is the regression that produced the "not
  // opening the auth tab" symptom after the first refactor.)
  //
  // If the user passes onUrl, give them a chance to handle the URL their own
  // way (logging, copy-to-clipboard, etc.) — that's fine in parallel. The
  // callback may be sync OR async; explicitly handle both via Promise.resolve
  // so a rejected promise doesn't become an unhandled-rejection warning.
  try {
    const r = opts.onUrl?.(url);
    if (r && typeof (r as Promise<void>).catch === 'function') {
      (r as Promise<void>).catch(() => { /* swallow — diagnostic-only callback */ });
    }
  } catch { /* sync throw — also swallow */ }
  // Don't await — openBrowser shells out and we don't need to block on it.
  // Errors are non-fatal: opencode also prints "Go to: <url>" so the user
  // can always click it manually.
  openBrowser(url).catch(() => { /* swallow — fallback URL is shown */ });

  let closed = false;
  const cancel = (): void => {
    if (closed) return;
    closed = true;
    if (idleAutoCloseTimer) clearTimeout(idleAutoCloseTimer);
    try { server.close(); } catch { /* ok */ }
  };

  // Auto-cancel if neither `awaitToken` nor `cancel` is invoked within
  // 2× timeoutMs. This catches the case where opencode (or a 3rd-party
  // consumer) prints the URL but then never polls — the loopback server
  // would otherwise stay bound until process exit. The hard timeout
  // matches the OAuth flow's own upper bound + headroom.
  const idleAutoCloseTimer = setTimeout(() => {
    if (closed) return;
    cancel();
  }, timeoutMs * 2);
  if (typeof idleAutoCloseTimer.unref === 'function') idleAutoCloseTimer.unref();

  return {
    url,
    cancel,
    awaitToken: async () => {
      try {
        // Await the waiter we already registered up top — NOT a fresh
        // server.callback() call. The pre-registration closes the race
        // window between openBrowser firing and the waiter being queued.
        const callback = await waitWithTimeout(
          callbackPromise,
          timeoutMs,
          opts.signal,
          'Sign-in timed out — try again and complete the browser flow within 5 minutes.',
        );
        // STRICT state check — required to match exactly. Previously the
        // condition was `callback.state && callback.state !== state`,
        // which short-circuited the mismatch error if the attacker sent
        // an EMPTY state. A forged loopback callback could then ride in
        // with any token and bind the user's session to it. (B2 fix.)
        if (callback.state !== state) {
          throw new Error(
            `OAuth state mismatch (expected ${state.slice(0, 8)}…, got ${(callback.state || '(empty)').slice(0, 8)}…). ` +
            'Possible CSRF — re-run sign-in.',
          );
        }
        if (!callback.token) {
          throw new Error('OAuth callback delivered an empty token. Re-run sign-in.');
        }
        const result = await registerUser(callback.token, region, opts.signal);
        // Preserve syncedViaOpencodeAuth if it already exists — see the
        // matching comment in login() above for why.
        let existingSynced: boolean | undefined;
        try {
          const existing = (await import('./storage.js')).loadCredentials();
          existingSynced = existing?.syncedViaOpencodeAuth;
        } catch { /* no prior creds */ }
        await saveCredentials({
          apiKey: result.apiKey,
          name: result.name,
          apiServerUrl: result.apiServerUrl,
          redirectUrl: result.redirectUrl,
          issuedAt: new Date().toISOString(),
          oauthClientId: region.oauthClientId,
          ...(existingSynced !== undefined ? { syncedViaOpencodeAuth: existingSynced } : {}),
        });
        return result;
      } finally {
        cancel();
      }
    },
  };
}

// ============================================================================
// Strategy 1 — loopback callback
// ============================================================================

interface CallbackResult {
  /** Either `access_token` (Auth0 native) or `firebase_id_token` (Windsurf-renamed). */
  token: string;
  state: string;
}

/**
 * Bind a one-shot HTTP server on a free port, open the browser, and wait for
 * the user to complete sign-in. Resolves with the firebase_id_token from the
 * callback URL's query string.
 */
async function loginWithLoopback(
  region: WindsurfRegion,
  opts: LoginOptions,
  timeoutMs: number,
): Promise<string> {
  const state = crypto.randomUUID();
  const server = await startCallbackServer(opts.callbackPort);
  const cleanup = () => server.close();

  try {
    const callbackUrl = `http://127.0.0.1:${server.port}/auth`;
    const loginUrl = buildLoginUrl({
      region,
      redirectUri: callbackUrl,
      redirectParametersType: 'query',
      state,
      signUp: opts.signUp,
      loginHint: opts.loginHint,
    });

    // Pre-register the waiter BEFORE opening the browser. Same race
    // window as prepareLogin's: a fast Auth0 round-trip (cached session)
    // can hit /auth before we get to `server.callback(state)`, and the
    // handler's "no matching waiter" branch would drop the callback.
    // Queueing the waiter promise here ensures one exists by the time
    // any HTTP request can land.
    const callbackPromise = server.callback(state);

    await opts.onUrl?.(loginUrl);
    // Don't `await` directly — if openBrowser rejects (headless SSH host
    // with no `xdg-open` / `open`, sandbox without GUI, etc.) we still
    // want to fall through to waitWithTimeout so the user can manually
    // click the URL we already emitted via `onUrl`. Previously the
    // unawaited rejection would crash login() before the callback could
    // arrive.
    await openBrowser(loginUrl).catch(() => { /* manual click fallback */ });

    const callback = await waitWithTimeout(
      callbackPromise,
      timeoutMs,
      opts.signal,
      'Sign-in timed out — re-run `login` and complete the browser flow within 5 minutes.',
    );

    if (callback.state !== state) {
      throw new Error(
        `OAuth state mismatch (expected ${state.slice(0, 8)}…, got ${callback.state.slice(0, 8)}…). ` +
        'Possible CSRF — re-run sign-in.',
      );
    }
    return callback.token;
  } finally {
    cleanup();
  }
}

interface CallbackServer {
  port: number;
  close: () => void;
  callback: (expectedState: string) => Promise<CallbackResult>;
}

/**
 * Bind a transient HTTP server on a free ephemeral port. Resolves the
 * `callback(state)` promise the first time `/auth` is hit with both a token
 * and a matching state, then keeps the server alive a beat longer so the
 * browser can render the "you can close this tab" page.
 *
 * Bind order: try the requested port first if any, then port 0 (let the OS
 * pick). Picking 0 is safer than hand-rolling a port-scan loop.
 */
function startCallbackServer(requestedPort?: number): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let captured: { token: string; state: string; error?: string } | null = null;
    const waiters: Array<{ state: string; resolve: (r: CallbackResult) => void; reject: (e: Error) => void }> = [];

    const server = http.createServer((req, res) => {
      // Defensive: ignore everything but /auth
      const url = new URL(req.url ?? '/', `http://127.0.0.1`);
      if (url.pathname !== '/auth') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const tokenParam =
        url.searchParams.get('firebase_id_token') ??
        url.searchParams.get('access_token') ??
        url.searchParams.get('token');
      const stateParam = url.searchParams.get('state') ?? '';
      const errorParam = url.searchParams.get('error') ?? url.searchParams.get('error_description');

      if (errorParam) {
        // State-validate the error callback the same way we do the
        // success callback (line ~316). Without this, ANY local process
        // can drop a GET to `127.0.0.1:<port>/auth?error=denied` and
        // abort the legitimate login attempt without ever needing to
        // know our state nonce. Only flush waiters whose state matches
        // — leave others queued.
        const errMatched = waiters.find((w) => w.state === stateParam);
        if (!errMatched) {
          renderResponse(
            res,
            false,
            'Unexpected error callback — does not match any active sign-in attempt. Close this tab.',
          );
          return;
        }
        captured = { token: '', state: stateParam, error: errorParam };
        renderResponse(res, false, `Sign-in failed: ${errorParam}`);
        flushWaiters();
        return;
      }
      if (!tokenParam) {
        // Some Auth0 configs deliver the token in the URL fragment. Render a
        // tiny HTML page that grabs the fragment client-side and re-POSTs it
        // back to /auth so we can capture it server-side.
        renderFragmentHarvester(res);
        return;
      }

      // Reject the callback immediately if the state doesn't match what
      // any of our waiters expect. A forged callback from a hostile local
      // tab can otherwise:
      //   - cause `flushWaiters` to resolve our legitimate waiter with
      //     attacker-controlled token (M5)
      //   - bind our session to the attacker's account when the OAuth
      //     state ends up empty (B2's second leg)
      // Now we ONLY accept callbacks whose state matches a live waiter.
      const matchedWaiter = waiters.find((w) => w.state === stateParam);
      if (!matchedWaiter) {
        // Don't kill the legitimate flow — just ignore the stray and tell
        // the requester to close the tab.
        renderResponse(
          res,
          false,
          'Unexpected callback — this loopback is bound to a different sign-in attempt. Close this tab and start over from the CLI.',
        );
        return;
      }
      captured = { token: tokenParam, state: stateParam };
      renderResponse(res, true, 'Sign-in complete — you can close this tab.');
      flushWaiters();
    });

    server.on('error', reject);

    function flushWaiters() {
      if (!captured) return;
      const c = captured;
      // Walk the queue and resolve only the waiter(s) whose state matches
      // the capture. Other waiters keep waiting (or time out on their own
      // schedule). Previously this resolved EVERY waiter with whatever was
      // captured even when states didn't line up.
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (c.error) {
          w.reject(new Error(c.error));
          waiters.splice(i, 1);
          continue;
        }
        if (w.state === c.state) {
          w.resolve({ token: c.token, state: c.state });
          waiters.splice(i, 1);
        }
        // else: skip — this waiter is for a different state, leave it
        // queued so a future matching callback (or its own timeout) can
        // handle it.
      }
    }

    server.listen(requestedPort ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind loopback server'));
        return;
      }
      resolve({
        port: address.port,
        close: () => server.close(),
        callback: (expectedState: string) =>
          new Promise((res, rej) => {
            if (captured) {
              const c = captured;
              if (c.error) rej(new Error(c.error));
              else res({ token: c.token, state: c.state });
            } else {
              waiters.push({ state: expectedState, resolve: res, reject: rej });
            }
          }),
      });
    });
  });
}

function renderResponse(res: http.ServerResponse, ok: boolean, message: string): void {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>opencode-windsurf-auth</title>
<style>
  body{font:14px -apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0d12;color:#e7e9ee}
  .card{max-width:520px;padding:28px 32px;border-radius:14px;background:#151823;border:1px solid #232838;text-align:center}
  h1{font-size:18px;margin:0 0 10px;color:${ok ? '#71d784' : '#ff8585'}}
  p{margin:6px 0;color:#9aa3b2}
</style></head>
<body><div class="card"><h1>${ok ? 'Signed in' : 'Sign-in failed'}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
  res.writeHead(ok ? 200 : 400, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function renderFragmentHarvester(res: http.ServerResponse): void {
  // The implicit-grant callback sometimes lands with the token in #fragment.
  // Browsers don't send fragments to the server, so we serve a 1-line JS shim
  // that re-issues the request with the fragment params as query params.
  const html = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body><script>
(function(){
  var h=window.location.hash.replace(/^#/,'');
  if(!h){document.body.innerText='No token in URL.';return}
  window.location.replace('/auth?'+h);
})();
</script></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

// ============================================================================
// Strategy 2 — manual paste
// ============================================================================

async function loginWithManualPaste(region: WindsurfRegion, opts: LoginOptions): Promise<string> {
  const state = crypto.randomUUID();
  const loginUrl = buildLoginUrl({
    region,
    redirectUri: 'show-auth-token',
    redirectParametersType: 'query',
    state,
    signUp: opts.signUp,
    loginHint: opts.loginHint,
  });

  await opts.onUrl?.(loginUrl);
  await openBrowser(loginUrl).catch(() => {
    // openBrowser failing is fine in manual mode — the user just opens it
    // themselves from the URL we already printed via onUrl.
  });

  const prompt = opts.promptForToken ?? defaultPromptForToken;
  const pasted = (await prompt()).trim();

  if (!pasted) {
    throw new Error('No token pasted — aborting.');
  }

  return pasted;
}

function defaultPromptForToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('Cannot prompt for token on a non-TTY stdin. Pipe the token in or run interactively.'));
      return;
    }
    process.stdout.write('\nPaste your Windsurf auth token (from the browser page) and press Enter:\n> ');
    let buf = '';
    const cleanup = (): void => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onErr);
      // We .resume()'d the stream; .pause() so the process can exit cleanly
      // afterward (otherwise the stdin handle keeps the event loop alive).
      try { process.stdin.pause(); } catch { /* ok */ }
    };
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString('utf8');
      buf += s;
      if (buf.includes('\n')) {
        cleanup();
        const idx = buf.indexOf('\n');
        resolve(buf.slice(0, idx).trim());
      }
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error('stdin closed before token was provided'));
    };
    const onErr = (err: Error): void => {
      cleanup();
      reject(err);
    };
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onErr);
    process.stdin.resume();
  });
}

// ============================================================================
// URL construction
// ============================================================================

interface BuildLoginUrlArgs {
  region: WindsurfRegion;
  redirectUri: string;
  redirectParametersType: 'query' | 'fragment';
  state: string;
  signUp?: boolean;
  loginHint?: string;
}

function buildLoginUrl(args: BuildLoginUrlArgs): string {
  const params = new URLSearchParams([
    ['response_type', 'token'],
    ['client_id', args.region.oauthClientId],
    ['redirect_uri', args.redirectUri],
    ['state', args.state],
    ['prompt', 'login'],
    ['redirect_parameters_type', args.redirectParametersType],
  ]);
  if (args.loginHint) params.append('login_hint', args.loginHint);
  const path = args.signUp ? 'windsurf/signup' : 'windsurf/signin';
  return `${args.region.website.replace(/\/$/, '')}/${path}?${params.toString()}`;
}

// ============================================================================
// Helpers
// ============================================================================

/** Cross-platform "open this URL in the user's default browser". */
/**
 * Escape a URL for `cmd /c start ""`. cmd's syntax requires escaping `&`,
 * `^`, `|`, `<`, `>` with `^`; `%` needs doubling. Previously we only handled
 * `&`, which silently dropped `%` (percent-encoded) bytes from OAuth state
 * parameters.
 */
function escapeCmdUrl(url: string): string {
  return url
    .replace(/\^/g, '^^')
    .replace(/&/g, '^&')
    .replace(/\|/g, '^|')
    .replace(/</g, '^<')
    .replace(/>/g, '^>')
    .replace(/%/g, '%%');
}

async function openBrowser(url: string): Promise<void> {
  // We deliberately avoid `import open from 'open'` to keep our dependency
  // surface tiny. The three OS commands below cover macOS / Linux / Windows.
  const cmds: Array<{ cmd: string; args: string[] }> =
    process.platform === 'darwin' ? [{ cmd: 'open', args: [url] }]
    : process.platform === 'win32' ? [{ cmd: 'cmd', args: ['/c', 'start', '""', escapeCmdUrl(url)] }]
    : [{ cmd: 'xdg-open', args: [url] }, { cmd: 'sensible-browser', args: [url] }];

  for (const c of cmds) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(c.cmd, c.args, { stdio: 'ignore', detached: true });
      child.on('error', () => resolve(false));
      child.on('spawn', () => {
        child.unref();
        resolve(true);
      });
    });
    if (ok) return;
  }
  throw new Error(
    `Unable to open browser automatically. Open this URL manually:\n  ${url}`,
  );
}

function waitWithTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  timeoutMessage: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new Error('Sign-in cancelled.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    p.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
  });
}

// Re-export for callers that want a clean public surface from a single module.
export { WindsurfRegistrationError };

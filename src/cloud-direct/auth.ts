/**
 * Mint the short-lived `user_jwt` that every chat RPC needs alongside the
 * persistent OAuth-issued `api_key`.
 *
 *   POST https://server.codeium.com/exa.auth_pb.AuthService/GetUserJwt
 *   Content-Type: application/proto             ← unary, NOT streaming
 *   Body: GetUserJwtRequest { metadata: Metadata }
 *   Response: GetUserJwtResponse { user_jwt: string }  (field 1)
 *
 * The returned JWT has a payload like:
 *   {
 *     "api_key": "devin-synthetic-apikey$account-…$user-…",
 *     "auth_uid": "devin-auth-uid$…",
 *     "email": "user@example.com",
 *     "exp": <unix-seconds>,         ← ~24 minute TTL
 *     "pro": true,
 *     "teams_tier": "TEAMS_TIER_DEVIN_PRO",
 *     ...
 *   }
 *
 * The JWT is signed HS256 by the server — can't be forged client-side. We
 * cache it and refresh shortly before `exp`.
 */

import * as crypto from 'crypto';
import { encodeMessage, iterFields } from './wire.js';
import { buildMetadata } from './metadata.js';

const DEFAULT_HOST = 'https://server.codeium.com';

export interface MintedUserJwt {
  jwt: string;
  /** Unix epoch seconds when the JWT expires. */
  expiresAt: number;
}

export class CloudAuthError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'CloudAuthError';
  }
}

/**
 * Default mint timeout — 30s is generous (the endpoint responds in ~200ms
 * in steady state) but enough headroom for slow networks. Callers can pass
 * a tighter `signal` to override.
 */
const MINT_TIMEOUT_MS = 30_000;

/**
 * Mint a fresh user_jwt by calling exa.auth_pb.AuthService/GetUserJwt.
 * `host` defaults to https://server.codeium.com — pass your tenant URL if your
 * RegisterUser response gave a different host.
 *
 * Always applies an internal 30s timeout so a network stall here can't
 * deadlock every concurrent chat request. If the caller passes a `signal`,
 * we honor whichever fires first via AbortSignal.any.
 */
export async function mintUserJwt(
  apiKey: string,
  host: string = DEFAULT_HOST,
  signal?: AbortSignal,
): Promise<MintedUserJwt> {
  const metadata = buildMetadata({
    apiKey,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
  });
  // GetUserJwtRequest { metadata: Metadata }   — Metadata is field 1
  const req = encodeMessage(1, metadata);

  // Compose caller signal with our internal timeout. AbortSignal.any was
  // added in Node 20 / Bun ≥1.0; for older runtimes we fall back to the
  // timeout-only signal.
  const timeoutSignal = AbortSignal.timeout(MINT_TIMEOUT_MS);
  let combinedSignal: AbortSignal = timeoutSignal;
  if (signal) {
    const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
    if (typeof anyFn === 'function') {
      combinedSignal = anyFn([signal, timeoutSignal]);
    }
  }

  const resp = await fetch(`${host.replace(/\/$/, '')}/exa.auth_pb.AuthService/GetUserJwt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/proto',
      'Connect-Protocol-Version': '1',
    },
    body: req,
    signal: combinedSignal,
  });
  const buf = Buffer.from(await resp.arrayBuffer());

  if (!resp.ok) {
    const text = buf.toString('utf8');
    throw new CloudAuthError(`GetUserJwt HTTP ${resp.status}: ${text.slice(0, 400)}`, resp.status);
  }

  // Response is GetUserJwtResponse { user_jwt: string } where user_jwt is
  // field 1, length-delimited. Decode the field properly instead of
  // regex-scanning the whole buffer — the previous regex would pick up
  // any JWT-shaped substring in the response (trace IDs, signature
  // headers, any cached token inadvertently logged) and could even land
  // on a non-user_jwt if Cognition ever embeds another JWT in a sibling
  // field.
  let jwt: string | null = null;
  for (const f of iterFields(buf)) {
    if (f.num === 1 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      const s = (f.value as Buffer).toString('utf8');
      // Sanity-check the shape — defensive: if the cloud ever moves user_jwt
      // out from field 1 we want a clean error, not silently wrong creds.
      // base64url with OPTIONAL `=` padding on each segment. Most modern
      // JWTs omit the `=`, but the spec allows it and a future server-side
      // change could re-introduce it; either way it's still a valid token.
      if (/^eyJ[A-Za-z0-9_-]{10,}={0,2}\.[A-Za-z0-9_-]+={0,2}\.[A-Za-z0-9_-]+={0,2}$/.test(s)) {
        jwt = s;
        break;
      }
    }
  }
  if (!jwt) {
    throw new CloudAuthError(
      `GetUserJwt 200 but no field-1 JWT found (${buf.length} bytes): ${buf.toString('utf8').slice(0, 200)}`,
    );
  }

  // Decode the payload to get the expiry.
  let expiresAt = Math.floor(Date.now() / 1000) + 600;   // fallback: 10 min
  try {
    const parts = jwt.split('.');
    const pad = (s: string) => s + '='.repeat((4 - (s.length % 4)) % 4);
    const payload = JSON.parse(
      Buffer.from(pad(parts[1]).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    if (typeof payload.exp === 'number') expiresAt = payload.exp;
  } catch { /* fall back to default */ }

  return { jwt, expiresAt };
}

// ----------------------------------------------------------------------------
// In-memory cache — refresh ~60s before expiry
// ----------------------------------------------------------------------------

interface CacheEntry {
  jwt: string;
  expiresAt: number;
  apiKey: string;
  host: string;
}

/**
 * Cache is keyed by (apiKey, host). A single shared `cache` slot only holds
 * the MOST RECENTLY USED entry — common case is one account at a time, so
 * a single slot is enough. inFlight is a per-key map so a JWT mint for
 * account A doesn't get returned to a concurrent request for account B.
 *
 * Previously `inFlight` was a singleton — if account A's mint was in flight
 * and a request for account B arrived, B got A's JWT. That's the M1
 * "concurrent requests after account switch get wrong JWT" bug.
 */
let cache: CacheEntry | null = null;
const inFlight = new Map<string, Promise<MintedUserJwt>>();

function flightKey(apiKey: string, host: string): string {
  return `${host}\x1f${apiKey}`;
}

/**
 * Get a cached user_jwt or mint a new one. Refreshes when the cached JWT is
 * within 60s of expiry. Multiple concurrent callers for the SAME (apiKey, host)
 * share the same in-flight mint; concurrent callers for DIFFERENT keys each
 * get their own mint.
 */
export async function getCachedUserJwt(apiKey: string, host: string = DEFAULT_HOST, signal?: AbortSignal): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cache && cache.apiKey === apiKey && cache.host === host && cache.expiresAt > now + 60) {
    return cache.jwt;
  }
  const key = flightKey(apiKey, host);
  const existing = inFlight.get(key);
  if (existing) return (await existing).jwt;
  const promise = mintUserJwt(apiKey, host, signal);
  inFlight.set(key, promise);
  try {
    const minted = await promise;
    cache = { jwt: minted.jwt, expiresAt: minted.expiresAt, apiKey, host };
    return minted.jwt;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Drop the in-memory JWT cache. Call after credential changes (logout,
 * account switch) so long-running opencode processes don't keep using a
 * JWT minted from a now-invalid api_key.
 */
export function clearCachedUserJwt(): void {
  cache = null;
  inFlight.clear();
}

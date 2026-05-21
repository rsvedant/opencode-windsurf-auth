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
import { encodeMessage } from './wire.js';
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
 * Mint a fresh user_jwt by calling exa.auth_pb.AuthService/GetUserJwt.
 * `host` defaults to https://server.codeium.com — pass your tenant URL if your
 * RegisterUser response gave a different host.
 */
export async function mintUserJwt(apiKey: string, host: string = DEFAULT_HOST): Promise<MintedUserJwt> {
  const metadata = buildMetadata({
    apiKey,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
  });
  // GetUserJwtRequest { metadata: Metadata }   — Metadata is field 1
  const req = encodeMessage(1, metadata);

  const resp = await fetch(`${host.replace(/\/$/, '')}/exa.auth_pb.AuthService/GetUserJwt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/proto',
      'Connect-Protocol-Version': '1',
    },
    body: req,
  });
  const buf = Buffer.from(await resp.arrayBuffer());

  if (!resp.ok) {
    const text = buf.toString('utf8');
    throw new CloudAuthError(`GetUserJwt HTTP ${resp.status}: ${text.slice(0, 400)}`, resp.status);
  }

  // Response is GetUserJwtResponse { user_jwt: string }. Rather than write a
  // full proto reader for one field, just regex out the JWT-shaped substring.
  // A devin user_jwt is HS256-signed and well-formed (`eyJhbGc...`).
  const m = buf.toString('binary').match(/eyJ[A-Za-z0-9_-]{20,2000}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (!m) {
    throw new CloudAuthError(`GetUserJwt 200 but no JWT in response (${buf.length} bytes): ${buf.toString('utf8').slice(0, 200)}`);
  }
  const jwt = m[0];

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

let cache: CacheEntry | null = null;
let inFlight: Promise<MintedUserJwt> | null = null;

/**
 * Get a cached user_jwt or mint a new one. Refreshes when the cached JWT is
 * within 60s of expiry. Multiple concurrent callers share the same in-flight
 * mint to avoid hammering the server.
 */
export async function getCachedUserJwt(apiKey: string, host: string = DEFAULT_HOST): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cache && cache.apiKey === apiKey && cache.host === host && cache.expiresAt > now + 60) {
    return cache.jwt;
  }
  if (inFlight) return (await inFlight).jwt;
  inFlight = mintUserJwt(apiKey, host);
  try {
    const minted = await inFlight;
    cache = { jwt: minted.jwt, expiresAt: minted.expiresAt, apiKey, host };
    return minted.jwt;
  } finally {
    inFlight = null;
  }
}

export function clearCachedUserJwt(): void {
  cache = null;
}

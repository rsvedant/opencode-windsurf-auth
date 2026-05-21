# Windsurf OAuth — Protocol, Gotchas, and Why Cloud-Bypass Is Impossible

Reverse-engineering notes for the `opencode-windsurf-auth login` flow added in 0.3+.
Captures the parts that cost hours of grep/curl/strace to discover and would
be miserable to re-derive. Sibling to [CASCADE_PROTOCOL.md](CASCADE_PROTOCOL.md)
(wire format) and [REVERSE_ENGINEERING.md](REVERSE_ENGINEERING.md) (legacy
process scraping).

## TL;DR — the only working flow

```
       ┌───────────────────┐  1. open browser            ┌─────────────────────┐
opencode-windsurf-auth ───▶│ windsurf.com/         ────▶│ Auth0 / Firebase    │
       (loopback :PORT)    │   windsurf/signin     │    │ Auth (response_type │
                           └───────────────────────┘    │  =token, implicit)  │
                                                        └──────────┬──────────┘
                                                                   │ 2. redirect
                       ┌───────────────────────────────────────────▼──────┐
                       │ GET 127.0.0.1:PORT/auth?firebase_id_token=…&…    │
                       └─────────────────────────┬────────────────────────┘
                                                 │ 3. exchange
                            ┌────────────────────▼─────────────────────┐
                            │ POST register.windsurf.com               │
                            │  /exa.seat_management_pb                 │
                            │  .SeatManagementService/RegisterUser     │
                            │ JSON: { firebase_id_token: … }           │
                            │ Resp: { api_key, name, api_server_url }  │
                            └────────────────────┬─────────────────────┘
                                                 │ 4. persist
                          ┌──────────────────────▼────────────────────────┐
                          │ ~/.config/opencode-windsurf-auth/credentials.json
                          │ { apiKey, name, apiServerUrl, issuedAt, … }     │
                          └─────────────────────────────────────────────────┘
                                                 │
                                                 │ 5. for every Cascade RPC:
                            ┌────────────────────▼──────────────────────────┐
                            │ Spawn local language_server with WINDSURF_CSRF │
                            │ env + pipe `api_key` Metadata to stdin, then   │
                            │ POST /exa.language_server_pb.../{cascade RPC}  │
                            └────────────────────────────────────────────────┘
```

## The OAuth URL: anatomy

Both extracted from `/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js`
and reproduced verbatim in [`src/oauth/login.ts`](../src/oauth/login.ts).

```
https://windsurf.com/windsurf/signin
  ?response_type=token                              ← implicit grant, NOT PKCE
  &client_id=3GUryQ7ldAeKEuD2obYnppsnmj58eP5u        ← Windsurf's Auth0 client; only one occurrence in extension.js
  &redirect_uri=<R>                                  ← three different shapes (see below)
  &state=<uuid-v4>                                   ← we echo and verify against CSRF
  &prompt=login                                      ← force fresh credentials (safe default)
  &redirect_parameters_type=<query|fragment>         ← MUST match the redirect_uri family
  &workflow=<empty|onboarding>                       ← informational; safe to omit
  [&login_hint=<email>]                              ← only if --email passed
```

`/windsurf/signin` 307-redirects to `/editor/signin` on the live site; preserved
query params survive the redirect, so the original URL works fine.

### redirect_uri family — three options, one of them is wrong if you guess

| `redirect_uri`                          | `redirect_parameters_type` | When                                                            |
|-----------------------------------------|----------------------------|-----------------------------------------------------------------|
| `windsurf://codeium.windsurf`           | `fragment`                 | Desktop extension only — requires the `windsurf://` OS handler  |
| `show-auth-token`                       | `query`                    | Manual-paste fallback; renders token on `/show-auth-token` page |
| `http://127.0.0.1:<port>/auth`          | `query`                    | Loopback callback. **Confirmed not allowlist-restricted.** Used by CLI default. |

> **Critical pairing**: with `redirect_parameters_type=fragment` the token lands in the URL hash (`#access_token=…`), which the OS protocol handler can see but `127.0.0.1` cannot (browsers don't send fragments to servers). For loopback you **must** use `redirect_parameters_type=query`, otherwise your callback receives an empty querystring and a fragment that never reaches the listener. Our loopback handler also serves a JS shim (`renderFragmentHarvester`) that re-emits any stray `#…` it does see as `?…` — belt-and-braces, but the query mode is the one that actually triggers.

The Windsurf SPA itself controls what `redirect_uri` it accepts — Auth0 has no opinion. We tested `http://127.0.0.1:<random>/auth` end-to-end and the SPA happily redirected the firebase_id_token via query string. No whitelist rejection observed for the public `3GUryQ7l…` client.

### Callback query-parameter names

The SPA hands the token off as `firebase_id_token=…`, but historical clients (the VS plugin's LSP) read `access_token=` (and some custom integrations apparently use `token=`). Our loopback accepts all three (`src/oauth/login.ts`, `startCallbackServer`). Defensive but cheap.

## The exchange: `RegisterUser`

The browser's `firebase_id_token` is short-lived (~1h) and useless to the language_server. We trade it for a long-lived `apiKey` via the same Connect-RPC the desktop extension uses.

```
POST https://register.windsurf.com
  /exa.seat_management_pb.SeatManagementService/RegisterUser
Content-Type: application/json          ← Connect supports JSON, no protobuf needed
Connect-Protocol-Version: 1              ← optional but matches official clients

{ "firebase_id_token": "<jwt>" }
```

Response (proto: `exa.seat_management_pb.RegisterUserResponse`, field tags 1–5):

```json
{
  "api_key": "devin-session-token$eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZXNzaW9uX2lkIjoid2luZHN1cmYtc2Vzc2lvbi0…",
  "name": "Satvik Kapoor",
  "api_server_url": "https://server.self-serve.windsurf.com",
  "redirect_url": "",
  "team_options": []
}
```

Three findings that don't appear elsewhere:

1. **Connect supports plain JSON.** The desktop extension uses `useBinaryFormat: true` (protobuf wire), but Connect's HTTP routing accepts `Content-Type: application/json` against the same path. We use JSON because the messages are tiny and skipping protobuf encode/decode shaves a dependency.

2. **`api_server_url` is tenant-scoped.** Default users get `""` (treat as `https://server.codeium.com`). Self-serve / EU / FedRAMP / enterprise users get a different host (`https://server.self-serve.windsurf.com` for our test account, `https://eu.windsurf.com/_route/api_server` for EU, etc.). The language_server **must** be started with this exact URL as `--api_server_url` or every Cascade RPC 401s upstream. We forward it through to the spawner and store it in `credentials.json`.

3. **The api_key format already encodes a server-side session.** For Cognition-era users it's `devin-session-token$<JWT>`. The JWT is HS256 (server-side secret, can't be reissued), payload is `{"session_id":"windsurf-session-<32-hex>"}`. We never look inside it; the entire thing is what gets written to `Metadata.api_key` in every Cascade RPC.

   The desktop extension *additionally* calls `GetSelfDevinSessionToken` to mint a new devin-session-token, but our testing shows `RegisterUser` already returns one directly for Cognition-tier accounts. The extra hop is only needed if the returned `api_key` does NOT start with `devin-session-token$`. We left an `if-prefix-is-wrong-add-this-step` note in [`src/oauth/register-user.ts`](../src/oauth/register-user.ts) for future-proofing.

## The local part: spawning `language_server` ourselves

This is the section that costs the most when you re-derive it. The runtime quirks are not documented anywhere outside the binary's own logs.

### Why you can't skip it

We probed the cloud server for every Cascade RPC name with a real api_key:

```
POST https://server.self-serve.windsurf.com/exa.language_server_pb.LanguageServerService/StartCascade
→ HTTP 404 "404 page not found"
```

Same for `SendUserCascadeMessage`, `GetCascadeTranscriptForTrajectoryId`, `InitializeCascadePanelState`, `ArchiveCascadeTrajectory`, `GetChatMessage`. The cloud only exposes `SeatManagementService` (registration, session minting) and downstream inference endpoints that the LS forwards to internally. **Cascade chat strictly requires a local language_server.**

### The five non-obvious gotchas

1. **`--parent_pipe_path` must point at a live Unix socket** that the *parent* (us) keeps open. The LS connects to it on startup as a liveness signal and shuts down 50ms after it closes:

   ```
   server.go:1579] Parent pipe closed on language server process 74370
   server.go:1528] Language server shutting down
   ```

   Fix: bind a `net.createServer` listener on the pipe path BEFORE spawn and never close it until you want the LS dead. `src/plugin/language-server-spawner.ts` does this in `doStart()` (around the `this.parentPipeServer = net.createServer(...)` block).

2. **`WINDSURF_CSRF_TOKEN` is a 36-char UUID generated by *you* (the parent).** It's not a cloud credential — it's a per-spawn shared secret that prevents other local processes from hitting the LS's gRPC port. `crypto.randomUUID()` is exactly what the extension uses. Every Cascade RPC must include `x-codeium-csrf-token: <uuid>` or you get `permission_denied` before the request even leaves the LS. Setting this on the spawn `env` is mandatory; passing it as `--csrf_token` CLI arg only works on Windsurf < 1.9577.

3. **`--stdin_initial_metadata` + binary protobuf on stdin** is how the api_key actually reaches the LS. There's no `--api_key` flag; you build an `exa.codeium_common_pb.Metadata` message (the same struct cascade-client.ts builds for every per-RPC metadata) with `api_key` populated, serialize to wire bytes, write to the child's stdin, then `stdin.end()`. The LS reads it once at startup. Missing → no usable inference (every cascade returns `failed_precondition: api_key not set`).

4. **`--server_port X --lsp_port Y` only opens ONE port — and it's the gRPC one.** The extension actually uses `--random_port` and discovers ports via `lsof`; our spawner picks an explicit port instead because we generated it. Either path works as long as you connect to the port you passed for `--server_port`. The `--extension_server_port` port is for IPC back to a hosting extension (Cascade panel UI) — we point it at a different free port that we never listen on; the LS doesn't care that nobody answers there.

5. **Spawned LSs share `~/.codeium/windsurf/database/<hash>/` per workspace hash.** Concurrent LSs on the same hash race on lockfiles. We derive our hash from `md5("opencode-<user>")` so we never collide with Windsurf's own LS even when both are running.

### Confirmed Args (mirrors extension.js's `startLanguageServer`)

```
language_server_<platform>_<arch>
  --api_server_url        <from RegisterUser, e.g. https://server.self-serve.windsurf.com>
  --run_child
  --enable_lsp
  --extension_server_port <free port — we never bind anything here>
  --ide_name              windsurf
  --server_port           <free port — the one we'll talk to>
  --lsp_port              <free port — LSP-side; usually unused for chat>
  --inference_api_server_url https://inference.codeium.com
  --database_dir          ~/.codeium/windsurf/database/<our-hash>/
  --enable_index_service
  --enable_local_search
  --search_max_workspace_file_count 5000
  --indexed_files_retention_period_days 30
  --sentry_telemetry
  --sentry_environment    stable
  --codeium_dir           .codeium/windsurf
  --extensions_dir        <any existing dir; not used for chat>
  --parent_pipe_path      <our Unix socket — KEEP IT OPEN>
  --windsurf_version      <string echoed in telemetry; "2.0.0" is fine>
  --stdin_initial_metadata
  --detect_proxy=false

env:
  WINDSURF_CSRF_TOKEN     <UUID — must match the x-codeium-csrf-token header on every RPC>
  CODEIUM_EDITOR_APP_ROOT <any existing dir; some telemetry paths read this>
```

## Things that look like they should work and don't

- **PKCE flow**: `SeatManagementService.CreatePKCEAuthorizationCode` and `ExchangePKCEAuthorizationCode` exist server-side (proto defined at byte offset 2,124,136 in `extension.js`) but the desktop extension never calls them. Probably reserved for the web portal or an upcoming flow. Not worth pursuing for CLI sign-in.
- **`StartDeviceFlow` / `GetDeviceFlowState`**: don't exist in either `extension.js` or the `language_server_macos_arm` binary. Despite being referenced in our own `src/constants.ts` historically, they were aspirational placeholders. Removed.
- **Talking to `register.windsurf.com` with a Bearer header**: the api_key goes inside the request body (or `X-Api-Key` header for follow-ups like `GetSelfDevinSessionToken`), not as `Authorization: Bearer`. The Connect runtime hosting these endpoints doesn't process `Authorization` at all.
- **Hitting `server.codeium.com` for Cascade**: 404, see above.

## Reference table: byte offsets in `extension.js`

For when extension.js changes and you need to re-verify these claims. Offsets are from the Windsurf 2.3.9 bundle (`/Applications/Windsurf.app/.../extension.js`, 9,630,084 bytes).

| Offset    | Anchor                                                                                          | What it proves                                              |
|-----------|-------------------------------------------------------------------------------------------------|-------------------------------------------------------------|
| 687,894   | `class y { context; … BASE_SESSIONS_SECRET_KEY = "windsurf_auth.sessions" …`                    | The full `WindsurfAuthProvider` class                       |
| 687,396   | `[\"response_type\",\"token\"],[\"client_id\",\"3GUryQ7ldAeKEuD2obYnppsnmj58eP5u\"], …`         | Auth0 client_id (only occurrence)                           |
| 687,447   | `[\"redirect_uri\",e?\"show-auth-token\":this.redirectUri]`                                     | The two-mode redirect_uri logic                             |
| 692,142   | `e.registerUser = async function(A) { … createConnectTransport({baseUrl: …}) … }`               | The cloud RegisterUser client (Connect-RPC, useBinaryFormat:true) |
| 692,934   | `interceptors:[e=>async t=>(""!==A&&t.header.set("X-Api-Key",A), …)]`                           | `GetSelfDevinSessionToken` uses `X-Api-Key` header          |
| 693,535   | `if (!C.sessionToken.startsWith("devin-session-token$")) throw new Error(…)`                    | Devin session token prefix is load-bearing                  |
| 1,827,807 | `static typeName="exa.language_server_pb.RegisterUserRequest";static fields=…{no:1,name:"firebase_id_token",…}` | RegisterUser proto (language_server_pb variant)             |
| 2,150,682 | `static typeName="exa.seat_management_pb.RegisterUserRequest"…`                                 | RegisterUser proto (seat_management_pb variant — what we use) |
| 2,178,318 | `static typeName="exa.seat_management_pb.RegisterUserResponse"…{api_key,name,api_server_url,redirect_url,team_options}` | Response fields                                             |
| 2,420,958 | `env: { …, CODEIUM_EDITOR_APP_ROOT: s.env.appRoot, WINDSURF_CSRF_TOKEN: A.csrfToken }`          | CSRF env var name confirmed                                 |
| 2,564,492 | `e.DEFAULT_API_SERVER_URL = "https://server.codeium.com"`                                       | URL defaults                                                |
| 2,564,555 | `e.DEFAULT_REGISTER_API_SERVER_URL = "https://register.windsurf.com"`                           | URL defaults                                                |

## When something breaks

Order of suspicion:

1. **`401 unauthenticated` on RegisterUser** → the firebase_id_token expired (it's ~1h). Re-run `opencode-windsurf-auth login`. State validation will fail loudly if it's a real CSRF mismatch.
2. **`failed_precondition: Cascade session error` from cascade-client** → LS started OK but didn't get `Metadata.api_key`. Check that `--stdin_initial_metadata` was passed AND that the stdin write happened before `stdin.end()`. The "first call" of every fresh LS can occasionally hit this transiently; cascade-client retries once.
3. **`Parent pipe closed`** in LS stderr → you let the Unix socket close. Bind a listener and never call `.close()` on it.
4. **`Failed to connect` from http2.connect** → the LS is alive (lsof shows the port) but isn't speaking HTTP/2 on that port → you passed `--server_port`/`--lsp_port` reversed, OR the LS exited shortly after binding (check `lastStderr`).
5. **`HTTP 404` on the api_server_url** → check the `api_server_url` returned by RegisterUser is what you're using. Default users get empty; self-serve/EU users get a tenant-specific host. Hard-coding `server.codeium.com` for everyone will 404 their tenants.

## What "Windsurf installed but not running" actually requires

- Windsurf.app present at `/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/bin/language_server_<platform>_<arch>`. The macOS-arm binary is 172 MB; full app is much larger.
- That's it. `Windsurf.app` does **not** need to be running. Our test confirms a fresh spawn from a quit Windsurf, with our OAuth credentials, talks Cascade end-to-end through 6 different models without ever opening the IDE.

To fully eliminate the Windsurf-installed dependency, we'd need to ship the `language_server_<platform>_<arch>` binary ourselves. Codeium publishes standalone language_server binaries for their open-source plugins (codeium.vim, etc.), but their version may lag Cascade's wire format. Not pursued in 0.3.

# Windsurf 2.x Cascade Protocol — Reverse-Engineering Notes

This document captures findings that aren't obvious from reading the codebase, the
bundled `extension.js`, or the original [REVERSE_ENGINEERING.md](REVERSE_ENGINEERING.md).
Each section is something that took multiple wrong turns to figure out.

If you're touching `cascade-client.ts` or `auth.ts`, read this first. The
[API spec](WINDSURF_API_SPEC.md) is still mostly correct for the wire format,
but the *flow* it describes (`RawGetChatMessage`) is effectively dead in
Windsurf 2.x.

---

## 1. `RawGetChatMessage` is server-gated for non-IDE clients

Windsurf 2.x's `language_server_macos_arm` (the Go binary, not the JS extension)
rejects `RawGetChatMessage` with:

```
failed_precondition: There was an error with your Cascade session,
please update your editor (error ID: …) (trace ID: …)
```

…even when:
- The CSRF token is correct.
- The API key is valid.
- The Metadata is fully populated.
- All wire-format bytes parse cleanly server-side.

The error is generated **inside the language_server itself** (string is not in
extension.js; it is in `strings language_server_macos_arm`, alongside
`Successfully logged cascade session hybrid request with %d workspace paths`).
The gate enforces: *the caller's session must be a known Cascade trajectory.*
A standalone caller with no Cascade history is not a valid session.

**The error can arrive in two places** — easy to miss:

1. As a gRPC trailer (`grpc-status: 9`, `grpc-message: failed_precondition…`).
2. As an in-band `ChatMessage{source=SYSTEM, text="failed_precondition…", is_error=true}` wrapped in `grpc-status: 0`.

Form (2) looks like a successful empty response unless you check `ChatMessage`
field 7 (`is_error`, bool). The plugin's `extractTextFromRawChatMessage` reads
field 5 (text) and would return the error string AS IF it were the model's
reply — silent failure. Don't trust `grpc-status: 0` alone; verify field 7.

---

## 2. The Cascade flow is the only path that works

`RawGetChatMessage` doesn't work. `GetChatMessage` returns:

```
unimplemented: GetChatMessage is deprecated :)
```

Yes, with the smiley. The actual chat path is the IDE's Cascade flow:

```
InitializeCascadePanelState(metadata)               # once per CSRF token
  → StartCascade(metadata, source, trajectory_type) # returns cascade_id
  → SendUserCascadeMessage(cascade_id, items,
                           cascade_config{
                             planner_config{
                               conversational={}    # required; oneof field 2
                               requested_model_uid="…"  # field 35
                             }
                           })
  → poll GetCascadeTranscriptForTrajectoryId(cascade_id)
  → ArchiveCascadeTrajectory(cascade_id)            # cleanup
```

### Things that bite

- **`StartCascade` with `base_trajectory_identifier.last_active_doc=true`
  attaches you to whichever Cascade the IDE is currently displaying**, and your
  user message gets appended into that conversation. Look at it through the
  IDE and you'll see your prompt land in someone else's chat. To create a
  fresh, isolated trajectory, **omit `base_trajectory_identifier` entirely**.

- **`SendUserCascadeMessage` requires `requested_model_uid`**, not just
  `plan_model_deprecated`. Sending only the enum number gets you
  `neither PlanModel nor RequestedModel specified`. The string UID is field
  **35** of `CascadePlannerConfig` (see §3 on UID format).

- **`conversational={}` is mandatory.** Without the empty conversational
  sub-message inside `planner_type_config`, the cascade just sits there with
  no planner attached.

- **`StreamCascadeReactiveUpdates` is unreceivable for non-IDE callers.**
  You can open the stream and get `grpc-status: 0`, but no data ever arrives.
  The IDE multiplexes this stream over a connection it owns; standalone clients
  don't get diff updates. **Use polling.** The transcript text format (§4)
  makes this surprisingly cheap.

---

## 3. Model UIDs are strings now; the proto enum lags

This was the surprise.

`GetUserStatus` returns the **live** model list in
`user_status.cascade_model_config_data.client_model_configs[]`. Each entry has:

- field 1: `label` — display name (e.g. `"Claude Opus 4.7 Medium"`)
- field 2: `model_or_alias` — submessage with optional `model` (int, field 1)
- field **22: `model_uid` (string)** — the **actual identifier**
- field 15: `is_new` (bool) — recent additions, useful for UX

Old models look like:
```
id=391 uid=MODEL_CLAUDE_4_5_OPUS               label="Claude Opus 4.5"
```

New models look like:
```
id=0   uid=claude-opus-4-7-medium              label="Claude Opus 4.7 Medium"
id=0   uid=gemini-3-5-flash-medium             label="Gemini 3.5 Flash Medium"
id=0   uid=gpt-5-5-high                        label="GPT-5.5 High Thinking"
id=0   uid=kimi-k2-6                           label="Kimi K2.6"
id=0   uid=deepseek-v4                         label="DeepSeek V4"
```

**`id=0` means the proto enum has no entry**, but the server still accepts
`requested_model_uid = "claude-opus-4-7-medium"`. The bundled `extension.js`
proto enum is **months behind**; rolling out a new model server-side doesn't
require a new Windsurf release.

**Consequence:** to discover all available models, **call `GetUserStatus` at
runtime**. Don't rely on `extension.js` grep'ing alone.

`GetCascadeModelConfigs` returns
`unimplemented: GetCascadeModelConfigs is not implemented; use GetUserStatus instead`
— so this is the only path.

---

## 4. PRIVATE_N slots map to specific models per-account

The proto enum reserves 30 `MODEL_PRIVATE_*` slots (IDs 219–223, 314–318, 347–351,
363–367, 372–376, 380–384). Cognition uses these for unannounced rollouts —
the same `MODEL_PRIVATE_X` enum number maps to different actual models in
different accounts. From `GetUserStatus` on one test account:

```
PRIVATE_2  → "Claude Sonnet 4.5"           (id 220)
PRIVATE_3  → "Claude Sonnet 4.5 Thinking"  (id 221)
PRIVATE_4  → "Grok Code Fast 1"            (id 222)
PRIVATE_6  → "GPT-5 Low Thinking"          (id 314)
PRIVATE_11 → "Claude Haiku 4.5"            (id 347)
PRIVATE_12 → "GPT-5.1 No Thinking"         (id 348)
…
```

`SendUserCascadeMessage` with `requested_model_uid = "MODEL_PRIVATE_2"` reaches
Claude Sonnet 4.5 *for the account that has that mapping*. Other accounts get
their own resolution of `PRIVATE_2`. So PRIVATE slots are not stable
identifiers; the per-account resolution lives in
`UserStatus.cascade_model_config_data`.

Cognition also publishes the *same* models under stable string UIDs (e.g.
`claude-opus-4-7-medium`) without going through a PRIVATE slot. **Prefer the
string UID** — it's the public-facing name and works across accounts.

---

## 5. Authentication moved from process args to env vars

Windsurf 1.9577+ no longer passes `--csrf_token` on the command line.
The signal that this changed is the new `--stdin_initial_metadata` flag on the
language_server process — bootstrap data (including the CSRF token) is now
piped over stdin from the parent.

For non-IDE callers there's no way to tap that stdin pipe, but Windsurf
**also exports the token as an env var** on the child:

```
WINDSURF_CSRF_TOKEN=<uuid>
```

Read it via:
- **macOS:** `ps -E -ww -p <PID>` (env vars appear after the command line)
- **Linux:** `/proc/<PID>/environ` (null-separated)
- **Windows:** PowerShell `Get-Process … | … EnvironmentVariables` (best-effort
  on hardened runtimes)

`extension.js` confirms this — search for `WINDSURF_CSRF_TOKEN: A.csrfToken`,
which is the spawn block that sets it.

For older Windsurf builds, the legacy `--csrf_token <uuid>` arg still works;
the plugin probes env first, falls back to the arg.

---

## 6. API key format has three coexisting formats

The migration helper in `extension.js` tells the story:

```js
if (apiKey && !apiKey.startsWith("sk-ws-01-")
            && !apiKey.startsWith("devin-session-token$")
            && !apiKey.startsWith("cog_")) {
  // migrate legacy UUID-style key → sk-ws-01-*
  client.migrateApiKey({apiKey});
}
```

So a user's API key can be any of:

- Legacy UUID (older Codeium era — migrated on first run)
- `sk-ws-01-<base64>` — Windsurf self-serve session token
- `devin-session-token$<JWT>` — current Cognition/Devin era. The `$`-suffix is
  literal; the JWT decodes to `{session_id: "windsurf-session-<32hex>"}`.
- `cog_<id>` — Cognition team token

The storage location also moved. `~/.codeium/config.json` is gone; the key is
now in **`~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb`**
(SQLite), in the `ItemTable` row keyed `windsurfAuthStatus`. The value is JSON
with an `apiKey` field plus base64-encoded protobuf blobs for the cached
allowed-models list.

---

## 7. Metadata has 15+ load-bearing fields

The `Metadata` message in `exa.codeium_common_pb` has 25+ fields, but Windsurf
2.x's language_server checks for a specific subset before it will route a
Cascade request. Sending fewer fields → same `Cascade session error` you'd
get for a complete auth failure, which made this very hard to bisect.

Minimum populated set (field numbers shown):

| # | Field | Source |
|---|---|---|
| 1 | `ide_name` | constant `"windsurf"` |
| 2 | `extension_version` | from `--windsurf_version` arg or 2.x default |
| 3 | `api_key` | `state.vscdb` |
| 4 | `locale` | `"en"` |
| 5 | `os` | `darwin` / `linux` / `windows` |
| 7 | `ide_version` | same as extension_version |
| 9 | `request_id` (uint64) | **monotonic per-process counter** — see §8 |
| 10 | `session_id` | UUID per request |
| 12 | `extension_name` | constant `"windsurf"` |
| 16 | `ls_timestamp` | `google.protobuf.Timestamp` (seconds + nanos) |
| 17 | `extension_path` | empty string OK |
| 24 | `device_fingerprint` | empty string OK |
| 25 | `trigger_id` | UUID per request |
| 26 | `plan_name` | `"Unset"` if unknown |
| 28 | `ide_type` | constant `"windsurf"` |

### Wire-format gotchas

- **Multi-byte tags are required for fields ≥ 16.** A naive `(field_num << 3) | wire_type`
  encoder writing a single byte produces an invalid varint for any field
  whose number puts the tag above 127. Field 35
  (`CascadePlannerConfig.requested_model_uid`, see §3) silently corrupts under
  this bug — the server tries to parse it as a different field and returns
  either `neither PlanModel nor RequestedModel specified` (because the real
  field 35 was never parsed) or `invalid UTF-8` (if the mis-parsed bytes
  happen to land in a string field). Always varint-encode the tag.

- **`request_id` is uint64**, not uint32. Tag wire-type is 0 (varint). Don't
  send it as a 32-bit fixed.

- **Field 16 (`ls_timestamp`) is a `google.protobuf.Timestamp` submessage**,
  not a Unix int. Encode the body as `field 1 (seconds) + field 2 (nanos)`,
  then wrap.

---

## 8. `request_id` should be monotonic per-process

The IDE's `MetadataProvider.getMetadata()` increments `requestId++` per call
(see extension.js `this.requestId++; return new E.Metadata({…, requestId: BigInt(this.requestId)})`).
Each call to `getCredentials() → buildMetadata()` should produce a *strictly
increasing* value. The server uses it for correlation/idempotency; sending the
same id twice in quick succession can yield odd cascade behaviour.

Start the counter at `BigInt(Date.now())` so two plugin instances on the same
account don't immediately collide.

---

## 9. The Cascade transcript format

`GetCascadeTranscriptForTrajectoryId` returns a single flat string in field 1,
plus `numTotalSteps` in field 2. The string has a predictable header format:

```
=== MESSAGE 0 - Tool ===
[CORTEX_STEP_TYPE_RETRIEVE_MEMORY]

=== MESSAGE 1 - Tool ===
[CORTEX_STEP_TYPE_MEMORY]

=== MESSAGE 2 - User ===
Reply with exactly one word: ping

=== MESSAGE 3 - Assistant ===
pong

=== MESSAGE 4 - Tool ===
[CORTEX_STEP_TYPE_CHECKPOINT]
```

### Useful properties

- Each block is `=== MESSAGE <N> - <Role> ===\n<body>\n\n`. Role is one of
  `User`, `Assistant`, `Tool`, `System`.
- **`[CORTEX_STEP_TYPE_CHECKPOINT]` is the reliable end-of-turn marker.** The
  cascade always emits one after the planner finishes. Don't rely on
  step-count staleness alone — a slow planner can produce steady step counts
  during long-running tool calls.
- **Assistant text grows in place.** Successive polls of the same Assistant
  message N can show partial text, then more text. Compare the *full
  previous text* per index, not just length — Cascade does rewrite earlier
  text after checkpoints/redactions, and a length-only check will
  double-emit on backfill.
- **Indices are USUALLY monotonic in the transcript dump but not
  guaranteed.** Planner branches can insert a smaller-indexed Assistant
  message later. Sort Assistant messages by index before emitting deltas.
- **Tool-only turns happen.** Some prompts produce only Tool steps and never
  produce an Assistant message. Termination should require *either* assistant
  bytes were emitted *or* a CHECKPOINT was seen — `sawNonUserMessage` is too
  loose (the initial RETRIEVE_MEMORY/MEMORY pair fires it before the planner
  runs).

---

## 10. `.pb` trajectory files leak

Every `StartCascade` writes the trajectory state to
`~/.codeium/windsurf/cascade/<cascade_id>.pb`. Without cleanup, each run
leaves a **~20 MB** file behind. Across a few weeks of normal use this
accumulates to hundreds of MB.

`ArchiveCascadeTrajectory` (takes just `cascade_id` in field 1, no metadata)
truncates the file to ~240 KB. Call it best-effort in a `finally` block;
errors are fine to swallow — the user-visible chat is already complete by
that point.

---

## 11. Process discovery has to disambiguate Antigravity

`ps aux | grep language_server_macos` catches Windsurf *and* Antigravity *and*
older Codeium IDEs. The reliable filter is either of:

- Substring match on the binary path: `/Windsurf.app/`
- The CLI flag: `--ide_name windsurf`

Without this, a user running both Windsurf and Antigravity will see your
plugin pick up the wrong process's CSRF token.

Also: when a Windsurf restart leaves a zombie language_server behind, the
new live one is the *newer* PID. Sort by `lstart` descending and try the
newest first; the others are dead sessions.

---

## 12. Endpoints to know — and to avoid

```
Used (the working flow):
  /exa.language_server_pb.LanguageServerService/InitializeCascadePanelState
  /exa.language_server_pb.LanguageServerService/StartCascade
  /exa.language_server_pb.LanguageServerService/SendUserCascadeMessage
  /exa.language_server_pb.LanguageServerService/GetCascadeTranscriptForTrajectoryId
  /exa.language_server_pb.LanguageServerService/ArchiveCascadeTrajectory
  /exa.language_server_pb.LanguageServerService/GetUserStatus    # for live model list

Dead ends (do not use):
  /…/RawGetChatMessage                  → Cascade session error
  /…/GetChatMessage                     → "deprecated :)"
  /…/GetCascadeModelConfigs             → "not implemented; use GetUserStatus instead"
  /…/StreamCascadeReactiveUpdates       → opens but never emits to non-IDE callers
```

---

## Appendix: useful one-liners

Live model list (run while Windsurf is running):

```sh
# Decodes UserStatus.cascade_model_config_data.client_model_configs[]
bun /tmp/probe_userstatus.ts    # see git history for the script
```

Decode cached allowed-models from `state.vscdb`:

```sh
sqlite3 ~/Library/Application\ Support/Windsurf/User/globalStorage/state.vscdb \
  "SELECT value FROM ItemTable WHERE key='windsurfAuthStatus';" \
  | python3 -c "import sys,json,base64; print('\n'.join(base64.b64decode(c).decode('latin1','replace') for c in json.load(sys.stdin)['allowedCommandModelConfigsProtoBinaryBase64']))"
```

Force-fresh CSRF / port discovery (after a Windsurf restart):

```sh
LSPID=$(ps -axo pid,command | grep -E "language_server_macos_arm.*--ide_name windsurf" | grep -v grep | awk '{print $1}' | head -1)
ps -E -ww -p $LSPID | tr ' ' '\n' | grep WINDSURF_CSRF_TOKEN=
lsof -p $LSPID -iTCP -sTCP:LISTEN -P -n
```

Tail the cascade trajectory file for the cascade you just started (useful for
debugging when the transcript poll returns suspicious results):

```sh
ls -lat ~/.codeium/windsurf/cascade/ | head -5
```

Anything you find that isn't covered here, add a section.

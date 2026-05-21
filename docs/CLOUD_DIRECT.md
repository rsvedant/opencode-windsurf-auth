# Cloud-direct inference — bypassing `language_server` for Windsurf models

Research log for the question: *"can we talk to Cognition's inference servers directly, without spawning a `language_server` binary?"*

**Short answer**: yes. Endpoint is `https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage`. Wire format is binary-proto Connect-RPC with gzip-compressed payloads. We **proved this works end-to-end** by capturing a real LS upstream request via a mitm reverse-proxy and replaying it from a `python3 urllib` script — the cloud accepted it and answered with a Connect error (quota exhausted, not auth or format error).

This document captures findings that took hours of mitm setup, binary string analysis, and proto reverse-engineering. Without these notes, re-deriving them is *days* of work.

## TL;DR — what's where

| Endpoint | Speaks | What it gives you | Trade-off |
|---|---|---|---|
| `server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage` | Connect-RPC binary proto, **gzip-required** | Full Cascade chat with all Windsurf models (claude-opus-4.7, gpt-5.5, kimi-k2.6, deepseek-v4, gemini-3.5-flash, claude-opus-4.6, …). Streaming response. | Body is ~96 KB after decompression — must include `Metadata`, `ChatMessagePrompts`, `Tools` (the full IDE tool list), `ExperimentConfig` (300+ feature flag rows), `CascadeId`, etc. |
| `inference.codeium.com/exa.api_server_pb.ApiServerService/GetStreamingModelAPITextCompletion` | Connect-RPC, **bidirectional streaming** | Raw single-shot model text completion (no Cascade harness). | Proto definition exists in the LS binary but the LS doesn't appear to *call* this method in normal chat flow — likely an external/admin endpoint that requires a different auth tier. |
| `wss://app.devin.ai/api/acp/live?token=<JWT>` | JSON-RPC 2.0 over WebSocket, ACP protocol | Conversational chat with **Devin AI** (Cognition's autonomous coding agent). Not Windsurf IDE models — Devin orchestrates planning/tool-calls/actions on top of Anthropic/OpenAI under the hood. | Adds ~10–15s of Devin agent overhead per turn. Only ~4 persona/model choices exposed (`devin-2-5`, `devin-fast-opus`, `devin-gpt-5-5`, `devin-opus-4-7`), not the full 6+ Windsurf model catalog. Different product. |
| `server.codeium.com/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs` | Connect-RPC unary, **plain JSON works** | Full model catalog: every model UID, family, modelInfo (with `inferenceServerUrl`), provider, pricing, max tokens. | This is how you discover model UIDs — see "Model catalog" section. |
| `wss://app.devin.ai/api/acp/live` is **NOT** the path for raw Windsurf model access. It is the Devin product. Confirmed by the `configOptions` response listing only Devin personas, and by the wrapping overhead.

## Wire format details (gotchas)

These are the things the mitm capture revealed that you cannot guess:

1. **`Content-Type: application/connect+proto`** — Connect-RPC binary proto. JSON (`application/json`, `application/connect+json`) works for *some* unary methods (`GetCascadeModelConfigs`, `GetUserStatus`) but `GetChatMessage` rejects JSON with HTTP 415 unless served as binary proto via the Connect-streaming envelope.

2. **`Connect-Content-Encoding: gzip`** — the request body is gzip-compressed. The frame `flags` byte has bit `0x01` set. Without this header **the server returns 200 with an internal_error frame** rather than a useful "use gzip" message — it took a mitm capture to find this.

3. **5-byte Connect-streaming envelope** wraps every frame:
   ```
   ┌────────┬─────────────┬──────────────┐
   │ 1 byte │   4 bytes   │  N bytes     │
   │  flags │  length BE  │   payload    │
   └────────┴─────────────┴──────────────┘
     flags bit 0x01 = gzip-compressed payload
     flags bit 0x02 = end-of-stream (trailers frame; payload is JSON {error:...} or empty)
   ```

4. **Response frames** also use the envelope. The **last frame** has `flags & 0x02` set (end-of-stream). For successful streaming responses, the EOS frame's payload is empty JSON `{}`; on error it's `{"error":{"code":"...","message":"..."}}`. Intermediate data frames carry the actual proto-encoded `ChatMessage` chunks.

5. **Trace IDs are in error messages**. `failed_precondition` errors carry `(trace ID: <hex>)` — useful when reporting issues to Cognition.

6. **HTTP/2 required for streaming** — Connect's bidi-streaming methods (like `GetStreamingModelAPITextCompletion`) only work over HTTP/2. Unary methods (`GetChatMessage`, despite being a streaming response, sends only one request frame) work over HTTP/1.1 too.

## Auth — actually a TWO-step handshake

The api key goes inside the request body in the `Metadata.api_key` field (field 3) — **not** as an `Authorization` header. The server rejects requests with `Authorization` set: HTTP 401 `bad Authorization header`. But that's only half the story:

**Step 1 — mint a short-lived user JWT.** The LS calls `POST https://server.codeium.com/exa.auth_pb.AuthService/GetUserJwt` (unary, `application/proto`, no envelope) with a Metadata-only request body. The response includes a `synthetic-apikey` JWT (~24 min TTL) carrying claims like `team_id`, `pro: true`, `teams_tier: TEAMS_TIER_DEVIN_PRO`. This `userJwt` is **the auth credential for chat**, not the api_key alone.

**Step 2 — every chat call includes BOTH.** `GetChatMessage` requests inline:
- `metadata.api_key` (field 3) = the persistent `devin-session-token$<JWT>` we got from `RegisterUser`
- `metadata.user_jwt` (field 21) = the freshly-minted JWT from step 1

Concretely (JSON shape — switch to proto wire for `GetChatMessage`):

```json
{
  "metadata": {
    "apiKey": "devin-session-token$<JWT-from-RegisterUser>",
    "userJwt": "<JWT-from-GetUserJwt-response>",
    "extensionName": "windsurf",
    "ideName": "windsurf",
    ...
  },
  ...
}
```

The `apiKey` value is the full token *including* the `devin-session-token$` prefix. The JWT inside it has payload `{"session_id":"windsurf-session-<hex>"}` and is signed with HS256 — server-side validation, can't forge.

**This was the missing piece.** Earlier replay test worked because the captured body already contained both `apiKey` and `userJwt`. Constructing a fresh request needs:
1. POST `GetUserJwt` once at session start (and every ~20 min thereafter)
2. Cache the userJwt in memory
3. Inline both into every `GetChatMessage`'s `Metadata`

The `GetUserJwt` request body (captured at `/tmp/mitm3-bodies/011-REQ-GetUserJwt.bin`) is just `Metadata` with apiKey, ide_name, extension_name set. Tiny payload, ~360 bytes.

## The exact captured request body (annotated)

Below is the `GetChatMessage` body the LS sent on first turn of a fresh Cascade. **96,632 bytes after gzip decompression.** Field numbers are wire-format integers (no .proto in hand, so these are reverse-engineered from observed structure):

```
GetChatMessageRequest {
  #1  metadata: codeium_common_pb.Metadata {
    #1  ide_name: "windsurf"
    #3  api_key: "devin-session-token$eyJhbGciOi…"
    #5  os: '{"Os":"darwin","Arch":"arm64","Release":"25.2.0", …}'   ← JSON-encoded OSInfo
    #8  hardware: '{"NumSockets":1,"NumCores":8, …}'                  ← JSON-encoded HardwareInfo
    #9  request_id: 1779279074826                                     ← epoch millis
    #10 session_id: "40a74063-8f14-4db1-a60c-5c8ec174e580"           ← UUID
    #12 extension_name: "windsurf"
    #16 ls_timestamp: Timestamp { seconds: 1779279076, nanos: 316238000 }
    #25 trigger_id: "735644c9-9537-…"
    #27 device_fingerprint: "6fce2dce335b9090…"                       ← sha256-shaped hex
    #28 ide_type: "windsurf"
  }
  #2  prompt_id: <message>
  #3  chat_message_prompts: [
        ChatMessagePrompt {
          #2 source: 1  (CHAT_MESSAGE_SOURCE_USER probably; the LS marks system-context blocks the same way)
          #3 prompt: "No MEMORIES were retrieved. Continue your work without acknowledging this message."
          #4 num_tokens: 23
        },
        ChatMessagePrompt {
          #2 source: 1
          #3 prompt: "<additional_metadata>...</additional_metadata>\n<user_request>\n<actual user prompt>\n</user_request>"
          #4 num_tokens: 104
          #5 safe_for_code_telemetry: 1
        },
      ]
  #7  request_type: 5  (CHAT_MESSAGE_REQUEST_TYPE_USER ≈ enum value, varint)
  #8  completion_configuration: {
        #1 ?: 1
        #2 max_input_tokens: 64000
        #3 max_output_tokens: 200
        #5 temperature: 0.6 (encoded as IEEE 754 float64 0x3FE3333333333333)
        #6 (same — likely top_p)
        #7 top_k: 50
        #8 ?_: 1.0
        #9 stop_tokens: ["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"]
        #11 repetition_penalty: 1.0
      }
  #9  experiment_config: ExperimentConfig {            ← ENORMOUS, ~150 feature flag rows
        flag_entries: [
          { name: "CASCADE_PLAN_MODE_EXIT_TOOL", on: ? },
          { name: "cascade-add-annotation", on: ? },
          { name: "cascade-brain-config", json: '{"brainModel":"MODEL_CHAT_GPT_4_1_2025_04_14", …}' },
          { name: "cascade-tool-calling-section-content", json: '…"if asked about what your underlying model is, respond with `Cascade`"' },
          { name: "CASCADE_MEMORY_CONFIG_OVERRIDE", json: '{"memory_model": "MODEL_GPT_5_NANO"}' },
          { name: "CASCADE_USER_MEMORIES_IN_SYS_PROMPT", json: '{"add_user_memories_to_system_prompt": true}' },
          … 150 more …
        ]
      }
  #10 tools: [
        Tool { name: "browser_preview", description: "...", schema: '{"$schema":"…"}' },
        Tool { name: "check_deploy_status", … },
        Tool { name: "code_search", … },
        Tool { name: "command_status", … },
        Tool { name: "deploy_web_app", … },
        Tool { name: "grep_search", … },
        Tool { name: "list_dir", … },
        Tool { name: "list_resources", … },
        Tool { name: "search_web", … },
        Tool { name: "skill", … },
        Tool { name: "todo_list", … },
        Tool { name: "trajectory_search", … },
        Tool { name: "view_content_chunk", … },
        Tool { name: "write_to_file", schema_with_CodeContent_key },
        …
      ]
  #13 use_internal_chat_model: 1  (or some other bool)
  #15 tool_choice: { … }
  #16 cascade_id: "78c099-91db-407b-8f7b-816203fb8798"          ← UUID; the LS allocates this
  #20 ?: 1                                                       ← bool flag, role unclear
  #21 chat_model_uid: "claude-opus-4-7-medium"                  ← THE MODEL UID
  #22 prompt_id: "45a4304f-26d8-4fbb-b5b7-9b90e66ac02f"          ← UUID; identifies this specific prompt
}
```

The 96 KB is dominated by the `experiment_config` flag list and the `tools` definitions (each tool's JSON schema is large). A bare-bones chat request that doesn't use tools and disables non-essential flags could be much smaller — probably 2-3 KB. Did not yet test the minimum, because quota.

## Cascade session state — the big unknown

The `cascade_id` (field 16) is allocated **locally** by the language_server when the IDE calls `InitializeCascadePanelState` + `StartCascade`. It's then included in every `GetChatMessage` request to the cloud. **Critically: the LS never makes any upstream RPC to "register" a cascade_id with the cloud.** The mitm capture sequence shows:

```
GetUserJwt → GetUserStatus → GetMcpClientInfos →
RecordStateInitializationData → RecordCortexTrajectoryStep →
RecordCortexGeneratorMetadata → RecordCortexTrajectory →
GetChatMessage(cascade_id="78c099-91db-…")
```

No `StartCascade` upstream. The cascade_id appears in `GetChatMessage` as if minted out of thin air. The cloud either:

- (A) **Lazy-registers** the cascade_id on first use (would mean a random UUID works for cloud-direct), or
- (B) **Validates** cascade_id against some server-side allowlist seeded by … something (would mean cloud-direct is blocked).

The captured cascade_id from a real LS session **was accepted on replay** — but that doesn't prove (A) because the cloud may have already seen that UUID. Earlier attempts with a hand-rolled minimal body returned `failed_precondition: "Cascade session error, please update your editor"`, but those bodies were ALSO missing `userJwt` and many other required fields, so the cascade_id error message may have been the generic catch-all.

**Concrete next test** when quota resets: build the smallest possible `GetChatMessage` body with:
- ✅ valid `apiKey` + fresh `userJwt` (we now know how)
- ✅ all required metadata fields
- ✅ `chat_model_uid = "claude-opus-4-7-medium"`
- ✅ ONE `chat_message_prompt`
- ✅ `cascade_id = <freshly-generated UUID>`

If the cloud responds with model output → (A) is true, cloud-direct is fully feasible.
If the cloud responds with `Cascade session error` → (B) is true, we need either:
1. A reverse-engineered upstream `RegisterCascade` call (if it exists — none found in mitm so far), or
2. Acceptance that the local LS is the only thing that can mint cloud-recognized cascade_ids.

## Model catalog

`POST https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs` (or `server.self-serve.windsurf.com` for self-serve tenants) returns the **complete authoritative model list**. Plain JSON works:

```bash
curl -s -X POST https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs \
  -H "content-type: application/json" \
  -d '{"metadata":{"apiKey":"devin-session-token$<JWT>","extensionName":"windsurf","ideName":"windsurf"}}'
```

Each row of `clientModelConfigs` has:

```json
{
  "label": "Claude Opus 4.7 Medium",
  "modelUid": "claude-opus-4-7-medium",          ← what to put in chat_model_uid
  "creditMultiplier": 40,
  "provider": "MODEL_PROVIDER_ANTHROPIC",
  "modelInfo": {
    "modelUid": "claude-opus-4-7-medium",
    "modelType": "MODEL_TYPE_CHAT",
    "maxTokens": 1000000,
    "tokenizerType": "LLAMA_WITH_SPECIAL",
    "maxOutputTokens": 128000,
    "inferenceServerUrl": "https://server.codeium.com",   ← which host serves THIS model
    "harnessUids": ["strawberry-pancake"],                ← internal harness identifier
    "modelFamilyUid": "claude-opus-4.7"                   ← the README's friendly name
  },
  "modelCostTier": "MODEL_COST_TIER_HIGH",
  "modelFamilyMetadata": {
    "modelFamilyLabel": "Claude Opus 4.7",
    "entries": [
      {"key":"Effort","value":{"order":1,"name":"Medium"}},
      {"key":"Thinking"}, {"key":"Fast Mode"}, {"key":"1M Context"}
    ]
  }
}
```

So the mapping between the README's friendly name and the wire UID is:

| README name | `modelUid` to send | `modelFamilyUid` |
|---|---|---|
| `claude-opus-4.7` (= medium variant) | `claude-opus-4-7-medium` | `claude-opus-4.7` |
| `claude-opus-4.7-high` | `claude-opus-4-7-high` | `claude-opus-4.7` |
| `claude-opus-4.7-low` | `claude-opus-4-7-low` | `claude-opus-4.7` |
| `claude-opus-4.7-fast` | `claude-opus-4-7-fast` (or `-fast-mode`) | `claude-opus-4.7` |
| `gpt-5.5` | `gpt-5.5` (or `gpt-5-5`?) | `gpt-5.5` |
| `gemini-3.5-flash` | `gemini-3-5-flash` | `gemini-3.5-flash` |
| `deepseek-v4` | `deepseek-v4` | `deepseek-v4` |
| `kimi-k2.6` | `kimi-k2-6` | `kimi-k2.6` |

(Fetched live to be sure — `GetCascadeModelConfigs` is the source of truth.)

## Tenant routing — the `apiServerUrl` returned by RegisterUser is load-bearing

After OAuth → `RegisterUser`, the response carries an `api_server_url`. For default users it's empty (use `https://server.codeium.com`). For self-serve / EU / FedRAMP / enterprise it's a tenant-specific host (e.g. `https://server.self-serve.windsurf.com`). **Cloud-direct callers must honor this** — sending `GetChatMessage` to the wrong host can:
- Succeed with the wrong account context, or
- Fail with `internal_error` and no useful detail.

The catalog response also carries per-model `inferenceServerUrl` — for some models (the ones routed through the inference cluster rather than the api server) you'd send to a different host. The captured LS traffic showed *all* `GetChatMessage` calls going to `server.codeium.com` regardless of model; the per-model inferenceServerUrl is consulted server-side, not client-side.

## How we proved cloud-direct works

The path we took, condensed:

1. **mitm reverse-proxy**: `mitmdump --mode reverse:https://server.codeium.com -p 8890`. Spawn the language_server with `--api_server_url=http://127.0.0.1:8890` — the LS happily talks to the proxy, the proxy forwards to the real server.codeium.com, and we see every byte going either way. (Note: trying to intercept via `HTTPS_PROXY=` on the spawned LS *does not work* — the LS uses connect-go's custom transport that ignores HTTP_PROXY env regardless of the LS's `--detect_proxy` flag.)

2. **Dump bodies to disk**: a tiny mitm Python addon writes every request/response body to `/tmp/mitm3-bodies/<n>-REQ-<MethodName>.bin`. Each body has the 5-byte Connect-streaming envelope, then a gzip-compressed proto.

3. **Decompress + parse**: simple Python script (`varint` + length-delimited proto parser) decodes the 96 KB GetChatMessage request body and prints the full nested structure with field numbers, strings, and varints. **Don't try this with `protoc --decode_raw`** — the Connect-streaming envelope confuses it. Strip the 5-byte header + gunzip first.

4. **Replay verbatim**: feed the raw captured bytes (envelope + gzipped proto, unchanged) to `urllib.request.urlopen('https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage', ...)`. The cloud accepted it — returned `failed_precondition: Your daily usage quota has been exhausted` (a *content*-level rejection, not a transport-level one — meaning every envelope/encoding/auth header was correct).

## State as of the last update

| Capability | Status | Notes |
|---|---|---|
| OAuth login (browser) | ✅ shipped (`opencode-windsurf-auth login`) | `docs/OAUTH.md` |
| Mint short-lived `user_jwt` | ✅ shipped | `src/cloud-direct/auth.ts`, ~24-min TTL with refresh-60s-before-expiry cache |
| Streaming chat (free models) | ✅ proven live with `swe-1-6` and `kimi-k2-6` | `tests/live/cloud-direct.ts`, `tests/live/oauth-e2e.ts` |
| OpenAI-style `/v1/chat/completions` SSE | ✅ shipped | `src/plugin.ts`, mode auto-routes when `OPENCODE_WINDSURF_AUTH_MODE=cloud-direct` |
| End-to-end through `opencode run` | ✅ shipped | swe-1.6 replied "hi from opencode cloud direct" with zero `language_server` in the process tree |
| Tool-call decoding | ✅ shipped | `streamChatEvents` emits `tool_call_start`/`_args`/`finish`; plugin re-emits as OpenAI SSE deltas |
| Tool-call request encoding | ✅ shipped | `tools[]` → proto field #10 with `{name, description, json-schema}` |
| Multi-turn conversations | ✅ shipped | Each `ChatHistoryItem` becomes a `ChatMessagePrompt` (proto #3) keyed by role |
| Cascade-id lazy registration | ✅ confirmed | Fresh random UUID accepted by cloud; no upstream `StartCascade` needed |
| Quota error surfacing | ✅ shipped | `CloudChatError` carries `code` + `traceId` |
| MCP tools (via `tools[]`) | ✅ inherited | opencode passes MCP-derived tool defs in the `tools` field; we encode them like any other |
| Image input | ⏳ partial | `ChatMessagePrompt` proto has an `images` field (observed); not yet plumbed through |
| Tool-call **invocation** end-to-end | ⏳ verified in test, **flaky on small models** | `swe-1.6` narrates instead of calling unless you really pin the prompt. Production-grade tool use likely needs claude-opus-4.7 / gpt-5.5 (quota-gated). |
| Cascade-side feature flags (`ExperimentConfig`) | 🚫 not sent | Server uses defaults. Most are cosmetic; the LS-shipped 150-row list is not required for chat. |

## Why we keep the local-LS path for now

Even though cloud-direct provably works, we ship the spawned-LS path because:

1. **Building the 96 KB request body from scratch is non-trivial.** We'd need to:
   - Encode `Metadata` proto with 15 fields including JSON-stringified `OSInfo` and `HardwareInfo`
   - Build the full `Tools` list (each tool's JSON schema is ~1 KB; the IDE ships ~25 tools)
   - Track `cascade_id` lifecycle (allocate, persist, eventually validate against the server's session store)
   - Build the `experiment_config` flag list (~150 rows) — and figure out which ones are actually *required* vs cosmetic
2. **Quota visibility**: when the local LS makes upstream calls, the LS sees rate-limit hints and surfaces them as Cascade UI messages. A direct client would have to handle quota_exhausted errors itself and tell the user where they ran into limits.
3. **Cascade response parsing**: the LS does heavy lifting to decode the streaming `ChatMessage` proto and emit per-step transcript chunks. Replicating that decoder is its own multi-day project.
4. **Future-proofing**: `experiment_config` shape changes with every Windsurf release. Our spawned LS automatically picks up new fields; a direct client would have to keep up by re-extracting from `extension.js` / mitm captures.

The cloud-direct path is therefore "documented as feasible, not productized". Worth revisiting when:
- The spawned LS startup time becomes a UX problem (currently ~250 ms), or
- Windsurf stops shipping `language_server_<platform>_<arch>` in the public app (would force the issue), or
- A user wants a *much* smaller deploy (the LS binary is 172 MB; a cloud-direct client would be a few hundred KB).

## The Devin Cloud WebSocket — what it actually is

`wss://app.devin.ai/api/acp/live?token=<JWT>` is **Cognition's Devin product**, not Windsurf inference. Confirmed empirically: open the WebSocket, do the ACP `initialize`/`session/new`/`session/prompt` handshake, ask Claude Opus 4.7 to reply "hi from devin ws" — got the reply, but it took **14 seconds** (12:02:53 → 12:03:08) because Devin's `session/update` notifications walked through `deciding_action` → `initialized` → `is_typing` → `executing_actions` → `finish_executing_actions` first.

The `configOptions` reply during `session/new` exposes 4 "personas":
- `devin-2-5` (default agent, long-horizon planning)
- `devin-fast-opus` (fast mode, Claude Opus underneath)
- `devin-gpt-5-5` (GPT 5.5 underneath)
- `devin-opus-4-7` (Opus 4.7 underneath)

These map to Anthropic/OpenAI models but the Devin agent's planning loop sits between you and the model. If you want raw model output, this is **not** the right surface — even though it's the simplest one to integrate against.

## File offsets & artifacts referenced in this doc

- `/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_arm` — the Go binary (172 MB)
- `/tmp/wsre/exa_paths_clean.txt` — 580 unique `/exa.*` paths extracted from the binary
- `/tmp/wsre/api_server_client_methods.txt` — 104 methods on the LS's `ApiServerClient`
- `/tmp/wsre/all_strings.txt` — full `strings -n 8 -a` dump (33 MB)
- `/tmp/mitm3-bodies/027-REQ-GetChatMessage.bin` — the captured LS upstream request (36 KB gzipped → 96 KB proto)
- `/tmp/mitm3-bodies/027-REQ-GetChatMessage.decoded-frame-0.proto` — decompressed proto for analysis
- `/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin` — the Devin stdio agent (119 MB, separate binary)

## The streaming-response shape (decoded live)

Each non-trailer Connect frame from `GetChatMessage` is a gzipped proto with this layout:

```
ChatMessage (streaming chunk) {
  #1  bot_id           string   "bot-<uuid>"           // always present
  #2  timestamp        message  { #1 seconds, #2 nanos }
  #5  finish_reason    varint   10 = "tool_calls"; absent for in-progress
  #6  ToolCallDelta    message  // PRESENT ONLY when the model emits a tool call
        {
          #1 id          string  "chatcmpl-tool-<hex>"    // only in first ToolCall frame
          #2 name        string  "add_numbers"            // only in first ToolCall frame
          #3 args_delta  string  '{"a": 17'               // streamed JSON fragment
        }
  #7  ChatStatus       message  { #6 status_code, #9 model_name } // header info each frame
  #9  delta_text       string   "The"                    // incremental text content
  #12 (fixed64)        hash-ish                          // ignore
  #17 message_uuid     string   <uuid>                   // session marker
  #28 UsageStats       message  // ONLY on final non-trailer frame
        { #1 label="Token Usage", #2 input_tokens, #3 output_tokens, ... }
}
```

Discovered by sending a tool-using prompt to `swe-1-6` with one `add_numbers` tool defined and observing the live stream:

```
[TXT] "The" " user" " is" "explicitly" "asking" "me" "to" "call" ...
[TXT] "I" "need" "to" "call" "add_numbers" "with" "a=17" "and" "b=25"
[TOOL_START]  id=chatcmpl-tool-b5564b159e83f9a4  name=add_numbers
[TOOL_ARGS]   '{"a": 17'
[TOOL_ARGS]   ',"b": 25'
[TOOL_ARGS]   '}'
[FINISH]      reason=tool_calls
```

Mapping to OpenAI `/v1/chat/completions` streaming SSE (what `@ai-sdk` consumes):

| Cloud event | OpenAI SSE delta |
|---|---|
| `text "The"` | `delta: { content: "The" }` |
| `tool_call_start {id, name}` | `delta: { tool_calls: [{ index, id, type:"function", function:{ name, arguments:"" } }] }` |
| `tool_call_args '{"a":17'` | `delta: { tool_calls: [{ index, function:{ arguments: '{"a":17' } }] }` |
| `finish(tool_calls)` | final chunk with `finish_reason: "tool_calls"` |
| `finish(stop)` | final chunk with `finish_reason: "stop"` |

The opencode plugin's `createStreamingResponse` does this translation in `src/plugin.ts`. For cloud-direct credentials, it uses `streamChatEvents` (event-typed) instead of `streamChatGenerator` (text-only) so tool_calls survive.

## Sending tool definitions

The request's `tools` field is `repeated ChatToolDefinition` at top-level proto field **#10**:

```
ChatToolDefinition {
  #1 name        string  "add_numbers"
  #2 description string  "Add two integers and return the sum"
  #3 schema      string  JSON.stringify({ type:"object", properties:{...}, required:[...] })
}
```

We encode opencode's `tools[]` array (each item shaped as `{type:"function", function:{name, description, parameters}}`) one-to-one. `parameters` is the JSON Schema; we stringify it because the proto field is `string`, not `bytes`/`Any`.

Encoding lives in [`src/cloud-direct/chat.ts`](../src/cloud-direct/chat.ts) → `encodeToolDef`.

## A working tool-using request, end to end (curl-shaped)

```bash
# Mint a user_jwt (step 1)
curl -s -X POST 'https://server.codeium.com/exa.auth_pb.AuthService/GetUserJwt' \
  -H 'Content-Type: application/proto' \
  -H 'Connect-Protocol-Version: 1' \
  --data-binary @<gzipped-metadata-only-proto>
# → response contains a JWT starting with "eyJ"

# Then GetChatMessage with tools (step 2)
curl -sN -X POST 'https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage' \
  -H 'Content-Type: application/connect+proto' \
  -H 'Connect-Protocol-Version: 1' \
  -H 'Connect-Content-Encoding: gzip' \
  -H 'Connect-Accept-Encoding: gzip' \
  --data-binary @<gzipped-proto-with-metadata-prompt-tool-cascadeid-modeluid>
# → stream of Connect frames containing text deltas and (when the model decides) tool_call deltas
```

The proto-encoding helpers in `src/cloud-direct/wire.ts` make this a few lines of Node code — see [`tests/live/cloud-events.ts`](../tests/live/cloud-events.ts) for a self-contained example.

## Loose ends / unanswered

- **Is cascade_id actually validated?** See "Cascade session state" above — the LS makes zero upstream `StartCascade`-equivalent calls, so we genuinely don't know if the cloud lazy-registers or strictly validates. Concrete bisection plan documented above.
- **`GetStreamingModelAPITextCompletion` — confirmed gated.** A subagent exhaustively probed it with every plausible (model enum, request_type, override_model_info, system_prompt) combination using both `apiKey` and a freshly-minted `userJwt`. Every response was `permission_denied`. With a deliberately-bad apiKey it returned `unauthenticated`, proving the gate is post-auth — i.e., a higher trust tier than `devin-session-token` carries. The proto exists in the binary because it's part of the same `api_server_pb` package, but only some upstream consumer (perhaps Codeium's fleet internal services) can call it. **Don't pursue this endpoint.**
- **`MODEL_CHAT_CLAUDE_4_7_OPUS` enum does NOT exist.** The 508 `MODEL_*` enums in the binary top out at `MODEL_CLAUDE_4_5_OPUS = 391` and `MODEL_CLAUDE_4_5_OPUS_THINKING = 392`. Claude 4.7 is referenced ONLY as the Cognition string UID `claude-opus-4-7-medium`. The migration from proto enums to string UIDs is one-way — newer models don't get numeric enums. So even if `GetStreamingModelAPITextCompletion` did work for our tier, no proto enum value for Opus 4.7 exists to put in its `model` field.
- **Minimum viable GetChatMessage body**: the captured one is 96 KB; the practical minimum is probably 2–3 KB if we drop tools, experiment_config, and the second metadata-prompt entry. Not yet measured. Subagent confirmed the body structure but did not bisect.
- **HTTPS_PROXY bypass**: the LS appears to bypass `HTTPS_PROXY` env var. `--detect_proxy=true` flag doesn't change this. Setting `--api_server_url=http://127.0.0.1:<port>` works (and is how we captured), but for capturing the *inference.codeium.com* leg of any model that uses it, we'd need pf-based redirect or a frida hook. Not pursued — the api server captured everything we needed.

## Recommended order of operations if/when we productize cloud-direct

1. Wait for quota reset (resets daily, presumably midnight Cognition-side).
2. **First test: cascade_id validation.** Build the smallest possible body — Metadata (with apiKey + freshly-minted userJwt) + ONE chat_message_prompt + chat_model_uid + a random UUID cascade_id. Send it. If it returns model output → (A) lazy-register, cloud-direct unblocked. If it returns "Cascade session error" → (B) strict, cloud-direct blocked unless we find an upstream cascade-allocation RPC.
3. **If (A) is true**: bisect the minimum required fields. Drop `experiment_config`, drop `tools`, drop the second chat_message_prompt. Each iteration: replay, see if cloud still answers. Goal: 2-3 KB request body.
4. **If (B) is true**: dig further into the LS binary for any RPC that registers a cascade_id with the cloud. `RecordStateInitializationData` / `RecordCortexTrajectoryStep` / `RecordCortexTrajectory` (all observed in mitm capture before the first GetChatMessage) are likely candidates — they may carry the cascade_id and serve as the registration step. If yes, replicate those.
5. **If (B) and no registration RPC exists**: cloud-direct without the LS is not possible for this auth tier. Ship the spawned-LS path we already have.
6. Implement a streaming response decoder. Each data frame is a gzipped proto `ChatMessage` chunk; concatenating their `delta_text` fields gives the user-visible output.
7. Implement `GetUserJwt` refresh — the user_jwt is ~24 min TTL, must be re-minted before expiry.
8. Implement quota error UX (`failed_precondition: Your daily usage quota has been exhausted`).
9. Wire into the plugin's resolver as a third strategy: `OPENCODE_WINDSURF_AUTH_MODE=cloud-direct`.

## Auth-flow worth remembering even if cloud-direct never ships

Even if we conclude cascade_id-registration is impossible, the `GetUserJwt` flow is useful intelligence:
- Our existing spawned-LS approach inherits the LS's own GetUserJwt minting; we never have to handle it directly.
- But: if Cognition ever changes their auth model so the `devin-session-token` alone stops working with the LS (forcing IDE callers to provide an externally-minted userJwt), `GetUserJwt` is the API we'd call to mint one. The endpoint is in `auth_pb.AuthService/GetUserJwt`, content-type `application/proto`, body is just `Metadata` with `api_key` populated. Response carries the JWT in a field on `GetUserJwtResponse`.

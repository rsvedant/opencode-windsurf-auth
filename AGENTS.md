# AGENTS.md

Guidance for AI agents working with this repository.

## Overview

This is an **OpenCode plugin** that enables authentication with Windsurf/Codeium's local language server. It allows access to 90+ models including `swe-1.5`, `claude-4.5-sonnet`, `gpt-5`, and others available through Windsurf.

**Key insight**: Windsurf does NOT use REST APIs or cloud OAuth - it uses **local gRPC** to communicate with a language server process that runs when Windsurf is open.

## Build & Test

```bash
bun install      # Install dependencies
bun run build    # Compile TypeScript
bun run typecheck # Type checking only
bun test         # Run tests
```

## Module Structure

```
src/
├── plugin.ts              # Main entry, OpenAI-compatible fetch handler
├── constants.ts           # Plugin ID, gRPC service names
└── plugin/
    ├── auth.ts            # Credential discovery from process args
    ├── grpc-client.ts     # HTTP/2 gRPC client with manual protobuf encoding
    ├── models.ts          # Model name → enum mappings (90+ models)
    └── types.ts           # TypeScript types, ModelEnum values
```

## Key Design Patterns

### 1. Request Interception
Plugin intercepts OpenCode's `fetch()`, transforms to Windsurf gRPC format, returns OpenAI-compatible SSE.

### 2. Credential Discovery from Process
Credentials are extracted from the running Windsurf process - no user input required:
- **CSRF Token**: `WINDSURF_CSRF_TOKEN` env var on the `language_server_*` process. Windsurf 1.9577+ removed this from CLI args; we read it via `ps -E -ww -p <PID>` on macOS, `/proc/<PID>/environ` on Linux, PowerShell on Windows. Falls back to the legacy `--csrf_token` CLI arg for older builds.
- **Port**: Discovered via `lsof -p <PID> -iTCP -sTCP:LISTEN` (Windows: `Get-NetTCPConnection -OwningProcess <PID>`). We pick the lowest listening port strictly greater than `--extension_server_port`.
- **API Key**: Read from the VSCode state DB (`Library/Application Support/Windsurf/User/globalStorage/state.vscdb`, key `windsurfAuthStatus`). The current format is `devin-session-token$<JWT>` (Cognition era); older builds also accepted `sk-ws-01-*` and `cog_*`.

Credentials are resolved in `getCredentials()` from a *single* `getLanguageServerPIDs()` lookup so a Windsurf restart racing between the calls can't yield a token from PID A and a port from PID B.

### 3. Manual Protobuf Encoding
No protobuf library needed - messages are encoded manually. Field tags must be varint-encoded (single-byte tags are only safe for fields 0–15; the Metadata message uses fields up to 28 and `CascadePlannerConfig.requested_model_uid` is field 35):
```typescript
function encodeTag(fieldNum: number, wireType: number): number[] {
  return encodeVarint((fieldNum << 3) | wireType); // <-- varint, not a single byte
}
function encodeString(fieldNum: number, str: string): number[] {
  const strBytes = Buffer.from(str, 'utf8');
  return [...encodeTag(fieldNum, 2), ...encodeVarint(strBytes.length), ...strBytes];
}
```

Notes:
- `Metadata` (`exa.codeium_common_pb.Metadata`) populates 15 fields the IDE itself sends: `ide_name`, `extension_version`, `api_key`, `locale`, `os`, `ide_version`, `request_id` (uint64 varint, monotonic), `session_id`, `extension_name`, `ls_timestamp`, `extension_path`, `device_fingerprint`, `trigger_id`, `plan_name`, `ide_type`. Without these the server returns `failed_precondition: Cascade session error`.
- `discovery.ts` parses field numbers from `extension.js` at runtime so they keep working if Windsurf renumbers them.
- All assistant/tool roles from OpenCode history are preserved (flattened into the prompt with role-tagged sections); the tools path uses `buildToolPrompt` which preserves structured context.
- Tool execution stays in OpenCode (MCP/tool registry). The plugin asks Windsurf to produce `tool_calls`/final text only.

### 4. Model Enum Mapping
Model names are mapped to protobuf enum values extracted from Windsurf's extension.js:
```typescript
const ModelEnum = {
  CLAUDE_4_5_SONNET: 353,
  GPT_5: 340,
  SWE_1_5: 359,
  // ... 80+ more
};
```

## Key Files

| File | Purpose |
|------|---------|
| `src/plugin.ts` | Main entry, orchestrates flow |
| `src/plugin/auth.ts` | Credential discovery from process |
| `src/plugin/grpc-client.ts` | HTTP/2 gRPC with protobuf encoding |
| `src/plugin/models.ts` | Model name → enum mappings |
| `src/plugin/types.ts` | TypeScript types + ModelEnum values |

## Windsurf Architecture

### How It Works (Windsurf 2.x — Cascade flow)

Windsurf 2.x rejects `RawGetChatMessage` with `failed_precondition: Cascade session error` for any client that isn't an active Cascade session. The plugin drives the same RPC sequence the IDE uses:

1. **`InitializeCascadePanelState`** — once per CSRF token. Registers the plugin as a panel client. Cached by `creds.csrfToken` so a Windsurf restart (which rotates the token) re-initializes automatically.
2. **`StartCascade`** — per conversation. We omit `base_trajectory_identifier` so the server creates a fresh trajectory; setting `last_active_doc=true` would attach to whichever Cascade the IDE is currently showing. Returns a `cascade_id`.
3. **`SendUserCascadeMessage`** — sends the prompt. Requires `CascadeConfig.PlannerConfig` populated with:
   - `planner_type_config.conversational = {}` (field 2 oneof)
   - `requested_model_uid = "MODEL_<NAME>"` (field 35, **two-byte tag** — single-byte encoding silently corrupts the payload)
4. **`GetCascadeTranscriptForTrajectoryId`** — polled every 500 ms. Returns a human-readable transcript with `=== MESSAGE N - <Role> ===` headers. We track emitted bytes per Assistant message index, stream deltas as the model writes, and terminate when both byte count and step count are steady for 4 ticks.
5. **`ArchiveCascadeTrajectory`** — best-effort cleanup at the end of each call. Without this every chat leaves a ~20 MB `.pb` file in `~/.codeium/windsurf/cascade/`.

The legacy `RawGetChatMessage` path is still in the codebase but unused — kept only because the encoders are shared and the request shape is documented for anyone debugging against older Windsurf.

### gRPC Endpoint
All RPCs hit the local language_server at `http://127.0.0.1:{port}` over HTTP/2 with gRPC framing. Service path:
```
POST http://localhost:{port}/exa.language_server_pb.LanguageServerService/<MethodName>
Headers:
  content-type: application/grpc
  te: trailers
  x-codeium-csrf-token: {csrf_token}
```

### Credential Locations
- **CSRF Token**: `ps aux | grep language_server_macos | grep -oE '\-\-csrf_token\s+[a-f0-9-]+'`
- **Port**: discovered via `lsof -p <PID>`; if missing, fallback offset from `--extension_server_port` (varies)
- **API Key**: `~/.codeium/config.json`
- **Version**: `--windsurf_version` from process args

## Model Enum Source

Extracted from Windsurf's bundled extension:
```
/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js
```

To discover new models:
```bash
grep -oE '[A-Z0-9_]+\s*=\s*[0-9]+' extension.js | grep -E 'CLAUDE|GPT|GEMINI|DEEPSEEK|SWE'
```

## Supported Models (90+)

| Category | Examples |
|----------|----------|
| **SWE** | `swe-1.5`, `swe-1.5-thinking` |
| **Claude** | `claude-3.5-sonnet`, `claude-4-opus`, `claude-4.5-sonnet`, `claude-4.5-opus` |
| **GPT** | `gpt-4o`, `gpt-4.5`, `gpt-5`, `gpt-5.2`, `gpt-5-codex` |
| **O-Series** | `o1`, `o3`, `o3-mini`, `o3-pro`, `o4-mini` |
| **Gemini** | `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3.0-pro` |
| **DeepSeek** | `deepseek-v3`, `deepseek-r1`, `deepseek-r1-fast` |
| **Other** | `llama-3.3-70b`, `qwen-3-235b`, `grok-3`, `kimi-k2` |

## Current Status

### Implemented
- Plugin structure matching OpenCode API
- Credential discovery from running Windsurf process
- Manual protobuf encoding (no library dependencies)
- Model name → enum mapping (90+ models with aliases)
- HTTP/2 gRPC client
- OpenAI-compatible response transformation

### Known Limitations
- **Windsurf must be running** - No daemon mode
- **macOS focused** - Linux/Windows paths need verification
- **Tool calling** - Not yet implemented (chat-only)

## Documentation

- [README.md](README.md) - Installation & usage
- [docs/CASCADE_PROTOCOL.md](docs/CASCADE_PROTOCOL.md) - **Read this first if you're touching the wire format.** Windsurf 2.x Cascade-flow gotchas: session gate, string-UID models, metadata field requirements, transcript parsing, `.pb` cleanup, etc. All non-obvious findings live here.
- [docs/WINDSURF_API_SPEC.md](docs/WINDSURF_API_SPEC.md) - API reference (wire format still accurate; the `RawGetChatMessage` flow it describes is dead — see CASCADE_PROTOCOL.md)
- [docs/REVERSE_ENGINEERING.md](docs/REVERSE_ENGINEERING.md) - How the original gRPC approach was discovered

## Related Projects

- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) - Similar plugin for Google's Antigravity API (this project is based on it)

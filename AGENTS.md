# AGENTS.md

Guidance for AI agents working with this repository.

## Overview

This is an **OpenCode plugin** that enables authentication with Windsurf/Codeium's local language server. It allows access to 90+ models including `swe-1.5`, `claude-4.5-sonnet`, `gpt-5`, and others available through Windsurf.

**Key insight**: Windsurf does NOT use REST APIs or cloud OAuth - it uses **local gRPC** to communicate with a language server process that runs when Windsurf is open.

## Build & Test

```bash
npm install      # Install dependencies
npm run build    # Compile TypeScript
npm run typecheck # Type checking only
npm test         # Run tests
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
- **CSRF Token**: From `--csrf_token` process argument
- **Port**: Dynamically discovered via `lsof -p <PID>` (offset varies due to `--random_port`; falls back to offset heuristics)
- **API Key**: From `~/.codeium/config.json`

### 3. Manual Protobuf Encoding
No protobuf library needed - messages are encoded manually:
```typescript
function encodeString(fieldNum: number, str: string): number[] {
  const strBytes = Buffer.from(str, 'utf8');
  return [(fieldNum << 3) | 2, ...encodeVarint(strBytes.length), ...strBytes];
}
```

Notes:
- Assistant replies are encoded as plain text (field 5) while user/system/tool use intent wrapper.
- We send both model enum and `chat_model_name` for fidelity.
- Assistant/tool messages from history are filtered before sending to Windsurf.

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

### How It Works
1. Windsurf spawns `language_server_macos` process with auth tokens in args
2. Plugin extracts credentials: `ps aux | grep language_server_macos`
3. gRPC requests go to `localhost:{port}/exa.language_server_pb.LanguageServerService/RawGetChatMessage`
4. Responses are protobuf-encoded; text extracted via protobuf decoding (no heuristic parsing)

### gRPC Endpoint
```
POST http://localhost:{port}/exa.language_server_pb.LanguageServerService/RawGetChatMessage
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
- [docs/WINDSURF_API_SPEC.md](docs/WINDSURF_API_SPEC.md) - API reference
- [docs/REVERSE_ENGINEERING.md](docs/REVERSE_ENGINEERING.md) - How the gRPC approach was discovered

## Related Projects

- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) - Similar plugin for Google's Antigravity API (this project is based on it)

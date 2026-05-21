# opencode-windsurf-auth

[![npm version](https://img.shields.io/npm/v/opencode-windsurf-auth.svg)](https://www.npmjs.com/package/opencode-windsurf-auth)
[![npm beta](https://img.shields.io/npm/v/opencode-windsurf-auth/beta.svg?label=beta)](https://www.npmjs.com/package/opencode-windsurf-auth)
[![npm downloads](https://img.shields.io/npm/dw/opencode-windsurf-codeium.svg)](https://www.npmjs.com/package/opencode-windsurf-auth)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Opencode plugin for Windsurf/Codeium authentication - use Windsurf models in Opencode.

## Features

- OpenAI-compatible `/v1/chat/completions` interface with streaming SSE
- Automatic model discovery - Models are auto-pulled from Windsurf
- Automatic credential discovery (CSRF token, port, API key)
- Transparent REST↔gRPC translation over HTTP/2
- Zero extra auth prompts when Windsurf is running
- Opencode tool-calling compatible: tools are planned via Windsurf inference but executed by Opencode (MCP/tool registry remains authoritative)

## Overview

This plugin enables Opencode users to access Windsurf/Codeium models by leveraging their existing Windsurf installation. It communicates directly with the **local Windsurf language server** via gRPC—no network traffic capture or OAuth flows required.

## Prerequisites

1. **Windsurf IDE installed** - Download from [windsurf.com](https://windsurf.com)
2. **Windsurf running** - The plugin communicates with the local language server
3. **Logged into Windsurf** - Provides API key in `~/.codeium/config.json`
4. **Active Windsurf subscription** - Model access depends on your plan

## Installation

```bash
bun add opencode-windsurf-auth@beta
```

## Opencode Configuration

Add the following to your Opencode config (typically `~/.config/opencode/config.json`). The plugin starts a local proxy server on port 42100 (falls back to a random free port and updates `chat.params` automatically).

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-windsurf-auth@beta"],
  "provider": {
    "windsurf": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:42100/v1"
      }
    }
  }
}
```

After saving the config:

```bash
opencode models windsurf                                        # confirm models appear under windsurf/
opencode run --model=windsurf/claude-opus-4.7-high "Hello"      # quick smoke test
```

Keep Windsurf running and signed in—credentials are fetched live from the IDE process.

## Project Layout

```
src/
├── plugin.ts              # Fetch interceptor that routes to Windsurf
├── constants.ts           # gRPC service metadata
└── plugin/
    ├── auth.ts            # Credential discovery
    ├── grpc-client.ts     # Streaming chat bridge
    ├── models.ts          # Model lookup tables
    └── types.ts           # Shared enums/types
```

### How It Works

1. **Credential Discovery**: Pulls the CSRF token from the `WINDSURF_CSRF_TOKEN` env var on the running `language_server_*` process (Windsurf 1.9577+ removed the `--csrf_token` CLI arg). Port is discovered via `lsof`/`Get-NetTCPConnection` on the same PID.
2. **API Key**: Read from Windsurf's VSCode state DB (`state.vscdb`, key `windsurfAuthStatus`). Supports the current `devin-session-token$<JWT>` format as well as `sk-ws-01-*` and `cog_*`.
3. **gRPC Communication**: HTTP/2 gRPC to `http://localhost:{port}`. Full Metadata payload (15 fields, including `request_id`, `trigger_id`, `ls_timestamp`, `device_fingerprint`, `plan_name`, `ide_type`) — anything less triggers the server's "Cascade session" gate.
4. **Cascade Flow**: `InitializeCascadePanelState` → `StartCascade` → `SendUserCascadeMessage` (with `requested_model_uid = "MODEL_*"`) → poll `GetCascadeTranscriptForTrajectoryId` → archive. The plugin uses Cascade because Windsurf 2.x rejects `RawGetChatMessage` for non-IDE clients.
5. **Streaming**: Deltas of each Assistant message are emitted as the transcript grows; multi-step planner runs (Assistant → Tool → Assistant) are concatenated in order.
6. **Tool Planning**: When `tools` are provided, the plugin builds a structured tool-calling prompt (with system messages preserved) and asks Windsurf to produce `tool_calls`/final text. Tool execution and the MCP tool registry stay on OpenCode's side.

### Supported Models (canonical names)

**Claude**: `claude-3-opus`, `claude-3-sonnet`, `claude-3-haiku`, `claude-3.5-sonnet`, `claude-3.5-haiku`, `claude-3.7-sonnet`, `claude-3.7-sonnet-thinking`, `claude-4-opus`, `claude-4-opus-thinking`, `claude-4-sonnet`, `claude-4-sonnet-thinking`, `claude-4.1-opus`, `claude-4.1-opus-thinking`, `claude-4.5-sonnet`, `claude-4.5-sonnet-thinking`, `claude-4.5-opus`, `claude-4.5-opus-thinking`, `claude-code`.

**OpenAI GPT**: `gpt-4`, `gpt-4-turbo`, `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-5`, `gpt-5-nano`, `gpt-5-codex`, `gpt-5.1-codex-mini`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.2` (variants low/medium/high/xhigh + priority tiers). Non-thinking vs thinking are separate model IDs, not variants.

**OpenAI O-series**: `o3`, `o3-mini`, `o3-low`, `o3-high`, `o3-pro`, `o3-pro-low`, `o3-pro-high`, `o4-mini`, `o4-mini-low`, `o4-mini-high`.

**Gemini**: `gemini-2.0-flash`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-thinking`, `gemini-2.5-flash-lite`, `gemini-3.0-pro` (variants: `minimal`, `low`, `medium`, `high`), `gemini-3.0-flash` (variants: `minimal`, `low`, `medium`, `high`). Thinking versions of Gemini 2.5 are separate models.

**DeepSeek**: `deepseek-v3`, `deepseek-v3-2`, `deepseek-r1`, `deepseek-r1-fast`, `deepseek-r1-slow`.

**Llama**: `llama-3.1-8b`, `llama-3.1-70b`, `llama-3.1-405b`, `llama-3.3-70b`, `llama-3.3-70b-r1`.

**Qwen**: `qwen-2.5-7b`, `qwen-2.5-32b`, `qwen-2.5-72b`, `qwen-2.5-32b-r1`, `qwen-3-235b`, `qwen-3-coder-480b`, `qwen-3-coder-480b-fast`.

**Grok (xAI)**: `grok-2`, `grok-3`, `grok-3-mini`, `grok-code-fast`.

**Specialty & Proprietary**: `mistral-7b`, `kimi-k2`, `kimi-k2-thinking`, `kimi-k2.5`, `kimi-k2.6`, `glm-4.5`, `glm-4.5-fast`, `glm-4.6`, `glm-4.6-fast`, `glm-4.7`, `glm-4.7-fast`, `glm-5.1`, `minimax-m2`, `minimax-m2.1`, `minimax-m2.5`, `swe-1.5`, `swe-1.5-thinking`, `swe-1.5-slow`, `swe-1.6` (variants: `fast`), `gpt-oss-120b`, `gpt-5.2-codex` (`low`/`medium`/`high`/`xhigh` + `-priority` tiers), `deepseek-v4`.

### Cognition-era string-UID models

Windsurf 2.x has shifted away from numeric proto-enum identifiers toward string `model_uid`s the server publishes via `GetUserStatus`. These models have no entry in the bundled `extension.js` proto enum, so the only way to enumerate them is to query the running language_server (see [docs/CASCADE_PROTOCOL.md](docs/CASCADE_PROTOCOL.md) §3 for the protocol).

The plugin maps them to canonical names you can use in OpenCode config:

- **Claude Opus 4.7** — `claude-opus-4.7` with variants `low`/`medium`/`high`/`xhigh`/`max` and `*-fast` priority-routing twins (10 total).
- **Claude Opus 4.6** — `claude-opus-4.6` with variants `thinking`, `1m`, `thinking-1m`, `fast`, `thinking-fast`.
- **Claude Sonnet 4.6** — `claude-sonnet-4.6` with `thinking`, `1m`, `thinking-1m`.
- **Gemini 3.5 Flash** — `gemini-3.5-flash` with `minimal`/`low`/`medium`/`high`.
- **Gemini 3.1 Pro** — `gemini-3.1-pro` with `low`/`high`.
- **GPT-5.4** — `gpt-5.4` with `none`/`low`/`medium`/`high`/`xhigh` + `-priority` twins.
- **GPT-5.4 Mini** — `gpt-5.4-mini` with `low`/`medium`/`high`/`xhigh`.
- **GPT-5.5** — `gpt-5.5` with the same shape as 5.4.
- **GPT-5.3 Codex** — `gpt-5.3-codex` with `low`/`medium`/`high`/`xhigh` + `-priority` twins.

The available list **varies per account**. Call `GET http://127.0.0.1:42100/v1/models` once the plugin is loaded to see what's advertised for you specifically.

Aliases (e.g., `gpt-5.2-low-priority`) are also accepted. Variants live under `provider.windsurf.models[model].variants`; thinking/non-thinking are distinct models.

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Type check
bun run typecheck

# Run tests
bun test
```

## Known Limitations

- **Windsurf must be running** - The plugin communicates with the local language server
- **macOS focus** - Linux/Windows paths need verification

## Further Reading

- [docs/CASCADE_PROTOCOL.md](https://github.com/rsvedant/opencode-windsurf-auth/blob/master/docs/CASCADE_PROTOCOL.md) – **Windsurf 2.x findings.** Why `RawGetChatMessage` is dead, how the Cascade flow works, why model UIDs are now strings instead of proto enum numbers, metadata field requirements, etc.
- [docs/WINDSURF_API_SPEC.md](https://github.com/rsvedant/opencode-windsurf-auth/blob/master/docs/WINDSURF_API_SPEC.md) – gRPC endpoints & protobuf notes
- [docs/REVERSE_ENGINEERING.md](https://github.com/rsvedant/opencode-windsurf-auth/blob/master/docs/REVERSE_ENGINEERING.md) – credential discovery + tooling (Windsurf 1.x era; supplement with CASCADE_PROTOCOL.md)
- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) – related project

## License

[MIT](LICENSE)

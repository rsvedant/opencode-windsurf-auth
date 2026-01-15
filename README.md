# opencode-windsurf-codeium

OpenCode plugin for Windsurf/Codeium authentication - use Windsurf models in OpenCode.

## Features

- OpenAI-compatible `/v1/chat/completions` interface with streaming SSE
- Automatic credential discovery (CSRF token, port, API key)
- Transparent REST↔gRPC translation over HTTP/2
- Zero extra auth prompts when Windsurf is running

## Overview

This plugin enables OpenCode users to access Windsurf/Codeium models by leveraging their existing Windsurf installation. It communicates directly with the **local Windsurf language server** via gRPC—no network traffic capture or OAuth flows required.

## Prerequisites

1. **Windsurf IDE installed** - Download from [windsurf.com](https://windsurf.com)
2. **Windsurf running** - The plugin communicates with the local language server
3. **Logged into Windsurf** - Provides API key in `~/.codeium/config.json`
4. **Active Windsurf subscription** - Model access depends on your plan

## Installation

```bash
bun add opencode-windsurf-codeium@beta
```

## OpenCode Configuration

Add the following to your OpenCode config (typically `~/.config/opencode/config.json`). The plugin starts a local proxy server on port 42100 (falls back to a random free port and updates `chat.params` automatically):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-windsurf-codeium"],
  "provider": {
    "windsurf": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:42100/v1"
      },
      "models": {
        "claude-4.5-opus": {
          "name": "Claude 4.5 Opus (Windsurf)",
          "limit": { "context": 200000, "output": 8192 }
        },
        "gpt-5.2-xhigh": {
          "name": "GPT 5.2 XHigh (Windsurf)",
          "limit": { "context": 128000, "output": 16384 }
        },
        "gemini-3.0-pro-high": {
          "name": "Gemini 3.0 Pro High (Windsurf)",
          "limit": { "context": 200000, "output": 8192 }
        },
        "deepseek-r1": {
          "name": "DeepSeek R1 (Windsurf)",
          "limit": { "context": 64000, "output": 8192 }
        },
        "swe-1.5": {
          "name": "SWE 1.5 (Windsurf)",
          "limit": { "context": 128000, "output": 32000 }
        }
      }
    }
  }
}
```

After saving the config:

```bash
bun run build && bun add -g opencode-windsurf-codeium@beta  # local install during development
opencode models list                                            # confirm models appear under windsurf/
opencode chat --model=windsurf/claude-4.5-opus "Hello"          # quick smoke test
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

1. **Credential Discovery**: Extracts CSRF token and port from the running `language_server_macos` process
2. **API Key**: Reads from `~/.codeium/config.json`
3. **gRPC Communication**: Sends requests to `localhost:{port}` using HTTP/2 gRPC protocol
4. **Response Transformation**: Converts gRPC responses to OpenAI-compatible SSE format (assistant/tool turns are not replayed back to Windsurf)
5. **Model Naming**: Sends both model enum and `chat_model_name` for fidelity with Windsurf’s expectations

### Supported Models (canonical names)

**Claude**: `claude-3-opus`, `claude-3-sonnet`, `claude-3-haiku`, `claude-3.5-sonnet`, `claude-3.5-haiku`, `claude-3.7-sonnet`, `claude-3.7-sonnet-thinking`, `claude-4-opus`, `claude-4-opus-thinking`, `claude-4-sonnet`, `claude-4-sonnet-thinking`, `claude-4.1-opus`, `claude-4.1-opus-thinking`, `claude-4.5-sonnet`, `claude-4.5-sonnet-thinking`, `claude-4.5-opus`, `claude-4.5-opus-thinking`, `claude-code`.

**OpenAI GPT**: `gpt-4`, `gpt-4-turbo`, `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-5`, `gpt-5-nano`, `gpt-5-low`, `gpt-5-high`, `gpt-5-codex`, `gpt-5.1-codex-mini`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.2-low`, `gpt-5.2`, `gpt-5.2-high`, `gpt-5.2-xhigh`, `gpt-5.2-priority` (plus the low/high/xhigh priority variants).

**OpenAI O-series**: `o3`, `o3-mini`, `o3-low`, `o3-high`, `o3-pro`, `o3-pro-low`, `o3-pro-high`, `o4-mini`, `o4-mini-low`, `o4-mini-high`.

**Gemini**: `gemini-2.0-flash`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-thinking`, `gemini-2.5-flash-lite`, `gemini-3.0-pro`, `gemini-3.0-pro-low`, `gemini-3.0-pro-high`, `gemini-3.0-flash`, `gemini-3.0-flash-high`.

**DeepSeek**: `deepseek-v3`, `deepseek-v3-2`, `deepseek-r1`, `deepseek-r1-fast`, `deepseek-r1-slow`.

**Llama**: `llama-3.1-8b`, `llama-3.1-70b`, `llama-3.1-405b`, `llama-3.3-70b`, `llama-3.3-70b-r1`.

**Qwen**: `qwen-2.5-7b`, `qwen-2.5-32b`, `qwen-2.5-72b`, `qwen-2.5-32b-r1`, `qwen-3-235b`, `qwen-3-coder-480b`, `qwen-3-coder-480b-fast`.

**Grok (xAI)**: `grok-2`, `grok-3`, `grok-3-mini`, `grok-code-fast`.

**Specialty & Proprietary**: `mistral-7b`, `kimi-k2`, `kimi-k2-thinking`, `glm-4.5`, `glm-4.5-fast`, `glm-4.6`, `glm-4.6-fast`, `glm-4.7`, `glm-4.7-fast`, `minimax-m2`, `minimax-m2.1`, `swe-1.5`, `swe-1.5-thinking`, `swe-1.5-slow`.

Aliases (e.g., `gpt-5.2-low-priority`) are also accepted.

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
- **Tool calling** - Not yet implemented (chat-only)

## Further Reading

- `docs/WINDSURF_API_SPEC.md` – gRPC endpoints & protobuf notes
- `docs/REVERSE_ENGINEERING.md` – credential discovery + tooling
- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) – related project

## License

MIT

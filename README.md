# opencode-windsurf-auth

[![npm version](https://img.shields.io/npm/v/opencode-windsurf-auth.svg)](https://www.npmjs.com/package/opencode-windsurf-auth)
[![npm beta](https://img.shields.io/npm/v/opencode-windsurf-auth/beta.svg?label=beta)](https://www.npmjs.com/package/opencode-windsurf-auth)
[![npm downloads](https://img.shields.io/npm/dw/opencode-windsurf-codeium.svg)](https://www.npmjs.com/package/opencode-windsurf-auth)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Opencode plugin that registers Windsurf/Cognition as a model provider. Sign in with `opencode auth login` → "Cognition (Windsurf)" and use any of the 100+ Cascade models (Claude, GPT-5, Gemini, SWE-1.6, Kimi K2.6, …) directly from opencode.

## Features

- **`opencode auth login` integration** — Cognition (Windsurf) shows up as a provider in opencode's native auth picker; browser-based sign-in via loopback callback (just like Google/GitHub providers)
- **Cloud-direct streaming, no install required** — talks to `server.codeium.com` over HTTPS; **no local `language_server`, no Windsurf dependency**
- **OpenAI-compatible `/v1/chat/completions` proxy** — full streaming SSE per spec (delta.role on first chunk, delta.content/reasoning/tool_calls, separate finish + usage chunks, `data: [DONE]`)
- **MCP tools + full system prompt** — opencode hands every tool, every MCP server, the entire system prompt to the cloud, identical to any other provider
- **Multimodal** — text + image content parts
- **Tenant-aware** — honors `apiServerUrl` from RegisterUser (self-serve, EU, FedRAMP, enterprise portals)

## Overview

This plugin enables Opencode users to access Windsurf models by leveraging their existing Windsurf subscription. It communicates directly with the Cognition cloud API, no local Windsurf installation required.

## Prerequisites

- An opencode install (this plugin loads via opencode's plugin system)
- A Windsurf account at [windsurf.com](https://windsurf.com)
- Bun (opencode's runtime)

You do **NOT** need Windsurf installed.

## Installation

```bash
bun add opencode-windsurf-auth@beta
```

Add to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-windsurf-auth@beta"]
}
```

## Sign in

```bash
opencode auth login
# → pick "Cognition (Windsurf)"
# → browser opens; sign in
# → opencode stores the credential
```

Or use the standalone CLI (useful for headless setups):

```bash
npx opencode-windsurf-auth login           # browser + loopback
npx opencode-windsurf-auth login --manual  # for environments without a GUI or open port
npx opencode-windsurf-auth status          # show credential path + account
npx opencode-windsurf-auth whoami          # print name + apiServerUrl
npx opencode-windsurf-auth logout          # delete credentials
```

Credentials live at the XDG-config location (mode `0600`):
- Linux: `~/.config/opencode-windsurf-auth/credentials.json`
- macOS: `~/Library/Application Support/opencode-windsurf-auth/credentials.json` (XDG → Cocoa-style path)
- Windows: `%APPDATA%\opencode-windsurf-auth\credentials.json`

`opencode auth logout windsurf` also clears them on the next plugin load.

## Opencode Configuration

The plugin starts a local proxy on `127.0.0.1:42100` (random free port on fallback) and updates `chat.params.options.baseURL` automatically. You only need to declare the provider + which models you want exposed. Set `"name": "Cognition (Windsurf)"` if you want the picker label to match opencode's auth UI. The full ready-to-paste example is in [`opencode_config_example.json`](opencode_config_example.json).

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-windsurf-auth@beta"],
  "provider": {
    "windsurf": {
      "name": "Cognition",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:42100/v1"
      },
      "models": {
        "claude-opus-4.7": {
          "name": "Claude Opus 4.7",
          "limit": { "context": 1000000, "output": 128000 },
          "variants": {
            "low": {}, "medium": {}, "high": {}, "xhigh": {}, "max": {},
            "low-fast": {}, "medium-fast": {}, "high-fast": {}, "xhigh-fast": {}, "max-fast": {}
          }
        },
        "gpt-5.5": {
          "name": "GPT 5.5",
          "limit": { "context": 1050000, "output": 128000 },
          "variants": {
            "none": {}, "low": {}, "medium": {}, "high": {}, "xhigh": {},
            "none-priority": {}, "low-priority": {}, "medium-priority": {}, "high-priority": {}, "xhigh-priority": {}
          }
        },
        "deepseek-v4": {
          "name": "DeepSeek V4",
          "limit": { "context": 1000000, "output": 384000 }
        },
        "kimi-k2.6": {
          "name": "Kimi K2.6",
          "limit": { "context": 262144, "output": 262144 }
        },
        "gemini-3.5-flash": {
          "name": "Gemini 3.5 Flash",
          "limit": { "context": 1048576, "output": 65536 },
          "variants": { "minimal": {}, "low": {}, "medium": {}, "high": {} }
        },
        "claude-opus-4.6": {
          "name": "Claude Opus 4.6",
          "limit": { "context": 1000000, "output": 128000 },
          "variants": {
            "thinking": {}, "1m": {}, "thinking-1m": {}, "fast": {}, "thinking-fast": {}
          }
        }
      }
    }
  }
}
```

After saving the config:

```bash
opencode models windsurf                                       # confirm models appear under windsurf/
opencode run --model=windsurf/swe-1.6 "hi"                     # free-tier smoke test
opencode run --model=windsurf/claude-opus-4.7:high "hi"        # paid models
```

## Project Layout

```
src/
├── plugin.ts                  # Proxy server + opencode auth.methods + chat.params hooks
├── cli.ts                     # `opencode-windsurf-auth` CLI (login/logout/whoami/status)
├── cloud-direct/              # Direct cloud streaming
│   ├── chat.ts                # GetChatMessage stream → text/reasoning/tool_calls/usage events
│   ├── wire.ts                # Hand-rolled proto + Connect-RPC framing
│   ├── auth.ts                # GetUserJwt mint + cache
│   └── metadata.ts            # Metadata proto builder
├── oauth/                     # Browser OAuth flow
│   ├── login.ts               # `prepareLogin` (loopback + openBrowser) and manual-paste fallback
│   ├── register-user.ts       # POST register.windsurf.com → {apiKey, name, apiServerUrl}
│   ├── storage.ts             # ~/.config/opencode-windsurf-auth/credentials.json (O_EXCL lock, mode 0600)
│   └── types.ts               # Region + persisted-credentials shape
└── plugin/
    ├── credentials-resolver.ts # Cloud-direct only; legacy modes documented but commented out
    ├── models.ts               # ~110 models with variants; auto-generated from GetCascadeModelConfigs
    ├── auth.ts                 # WindsurfCredentials/WindsurfError types (legacy helpers retired)
    ├── discovery.ts            # `GET /v1/models` source
    ├── protobuf.ts             # Shared varint/string helpers
    └── types.ts                # ModelEnum integer values for legacy aliases
```

### How It Works

1. **Auth (opencode auth login)**: opencode invokes `auth.methods[0].authorize()`. We pre-bind a loopback HTTP server on a random ephemeral port, open the browser to `windsurf.com/windsurf/signin?redirect_uri=http://127.0.0.1:<port>/auth&…`, wait for the callback, exchange the `access_token` (Cognition `ott$…` one-time format) via `RegisterUser` → long-lived api_key. Persist + return to opencode.
2. **Per-chat flow**: opencode hits our `127.0.0.1:42100/v1/chat/completions` proxy. We translate the OpenAI-shaped request into a Cognition `GetChatMessage` proto (system messages inlined into user turn, tool descriptions truncated at 6,998 chars to satisfy the cloud validator) and stream the response back as OpenAI SSE.
3. **Wire decode** (`src/cloud-direct/chat.ts`): proto field `#3` = visible text → `delta.content`; field `#9` = reasoning/CoT → `delta.reasoning`; field `#6` = tool-call deltas → `delta.tool_calls`; field `#5` = StopReason enum → `finish_reason`; field `#28` = token usage block → final usage chunk.
4. **Tool calling**: every opencode tool + MCP server tool reaches the cloud; tool execution stays opencode-side. The cloud returns `STOP_REASON_FUNCTION_CALL` (`10`) when it wants a tool invoked.
5. **Usage**: input/output token counts surface as a separate `{choices: [], usage: {…}}` chunk before `data: [DONE]`, per OpenAI's `stream_options.include_usage: true` convention.

### Supported Models

Addressed as `windsurf/<name>` (or `windsurf/<name>:<variant>`). Grouped by vendor, newest-first within each group:

**Anthropic** — `claude-opus-4.7` (variants `low`/`medium`/`high`/`xhigh`/`max` plus their `-fast` priority-routing twins, 10 total), `claude-opus-4.6` (`thinking`, `1m`, `thinking-1m`, `fast`, `thinking-fast`), `claude-opus-4.5` (+`thinking`), `claude-sonnet-4.6` (`thinking`, `1m`, `thinking-1m`), `claude-sonnet-4.5`, `claude-4.5-opus` (+`thinking`), `claude-4.5-sonnet` (+`thinking`), `claude-4.1-opus` (+`thinking`), `claude-4-opus` (+`thinking`), `claude-4-sonnet` (+`thinking`), `claude-3.7-sonnet` (+`thinking`), `claude-3.5-sonnet`, `claude-3.5-haiku`, `claude-3-opus`, `claude-3-sonnet`, `claude-3-haiku`, `claude-code`.

**OpenAI** — `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2`, `gpt-5.2-codex`, `gpt-5.1-codex-max`, `gpt-5.1-codex`, `gpt-5.1-codex-mini`, `gpt-5-codex`, `gpt-5` (variants `low`/`high`/`nano`), `gpt-4.1` (+`mini`, +`nano`), `gpt-4o` (+`mini`), `gpt-4-turbo`, `gpt-4`, `o4-mini` (+`low`/`high`), `o3-pro` (+`low`/`high`), `o3` (+`low`/`high`), `o3-mini`, `gpt-oss-120b`. Reasoning models expose tiers as variants (`low`/`medium`/`high`/`xhigh`, sometimes `none`, plus `-priority` twins).

**Google** — `gemini-3.5-flash` (`minimal`/`low`/`medium`/`high`), `gemini-3.1-pro` (`low`/`high`), `gemini-3.0-pro` (`minimal`/`low`/`medium`/`high`), `gemini-3.0-flash` (`minimal`/`low`/`medium`/`high`), `gemini-2.5-pro`, `gemini-2.5-flash` (+`thinking`, +`lite`), `gemini-2.0-flash`.

**DeepSeek** — `deepseek-v4`, `deepseek-v3-2`, `deepseek-v3`, `deepseek-r1` (+`fast`, +`slow`).

**z.ai** — `glm-5.1`, `glm-4.7` (+`fast`), `glm-4.6` (+`fast`), `glm-4.5` (+`fast`).

**Moonshot** — `kimi-k2.6`, `kimi-k2.5`, `kimi-k2-thinking`, `kimi-k2`.

**MiniMax** — `minimax-m2.5`, `minimax-m2.1`, `minimax-m2`.

**xAI** — `grok-3` (+`mini`), `grok-2`, `grok-code-fast`.

**Meta** — `llama-3.3-70b` (+`r1`), `llama-3.1-405b`, `llama-3.1-70b`, `llama-3.1-8b`.

**Alibaba** — `qwen-3-coder-480b` (+`fast`), `qwen-3-235b`, `qwen-2.5-72b`, `qwen-2.5-32b` (+`r1`), `qwen-2.5-7b`.

**Mistral** — `mistral-7b`.

**Cognition / Windsurf** — `swe-1.6` (+`fast`), `swe-1.5` (+`thinking`, +`slow`).

The list **varies per account** — call `GET http://127.0.0.1:42100/v1/models` once the plugin is loaded to see what your plan exposes. Variants are addressable two ways: `windsurf/claude-opus-4.7:high` (colon form, preferred) or `windsurf/claude-opus-4-7-high` (dash form, accepted as alias). Declare them under `provider.windsurf.models[model].variants` in your opencode config — see `opencode_config_example.json`.

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

- **macOS focus** — Linux works end-to-end; Windows is untested (loopback callback path and credentials directory both portable in theory)
- **Tool descriptions over ~7,000 chars get truncated** — cloud-side validator rejects longer ones with a misleading "MCP configuration issue" error; we truncate to 6,998 chars client-side
- **No multi-account / token-rotation yet** — a single signed-in account at a time

## Further Reading

- [docs/CASCADE_PROTOCOL.md](https://github.com/rsvedant/opencode-windsurf-auth/blob/master/docs/CASCADE_PROTOCOL.md) – **Windsurf 2.x findings.** Why `RawGetChatMessage` is dead, how the Cascade flow works, why model UIDs are now strings instead of proto enum numbers, metadata field requirements, etc.
- [docs/WINDSURF_API_SPEC.md](https://github.com/rsvedant/opencode-windsurf-auth/blob/master/docs/WINDSURF_API_SPEC.md) – gRPC endpoints & protobuf notes
- [docs/REVERSE_ENGINEERING.md](https://github.com/rsvedant/opencode-windsurf-auth/blob/master/docs/REVERSE_ENGINEERING.md) – credential discovery + tooling (Windsurf 1.x era; supplement with CASCADE_PROTOCOL.md)
- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) – related project

## License

MIT

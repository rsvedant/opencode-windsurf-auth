# opencode-windsurf-auth

[![npm version](https://img.shields.io/npm/v/opencode-windsurf-auth.svg)](https://www.npmjs.com/package/opencode-windsurf-auth)
[![npm beta](https://img.shields.io/npm/v/opencode-windsurf-auth/beta.svg?label=beta)](https://www.npmjs.com/package/opencode-windsurf-auth)
[![npm downloads](https://img.shields.io/npm/dw/opencode-windsurf-codeium.svg)](https://www.npmjs.com/package/opencode-windsurf-auth)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Opencode plugin that registers Windsurf/Cognition as a model provider. Sign in with `opencode auth login` → "Cognition (Windsurf)" and use any of the 100+ Cascade models (Claude, GPT-5, Gemini, SWE-1.6, Kimi K2.6, …) directly from opencode.

## Features

- **`opencode auth login` integration** — Cognition (Windsurf) shows up as a provider in opencode's native auth picker; browser-based sign-in via loopback callback (just like Google/GitHub providers)
- **Cloud-direct streaming** — talks to `server.codeium.com` over HTTPS; **no local `language_server`, no Windsurf.app dependency**
- **OpenAI-compatible `/v1/chat/completions` proxy** — full streaming SSE per spec (delta.role on first chunk, delta.content/reasoning/tool_calls, separate finish + usage chunks, `data: [DONE]`)
- **Reasoning split from content** — Cascade's CoT lands on `delta.reasoning` so opencode renders it in a collapsed block; the visible answer lands on `delta.content`
- **MCP tools + full system prompt** — opencode hands every tool, every MCP server, the entire 100KB system prompt to the cloud, identical to any other provider
- **Multimodal** — text + image content parts
- **Tenant-aware** — honors `apiServerUrl` from RegisterUser (self-serve, EU, FedRAMP, enterprise portals)

## Overview

Sign in once via opencode's native auth flow; opencode invokes our `authorize()` hook which opens `windsurf.com/windsurf/signin`, captures the token on a loopback callback, exchanges it via `register.windsurf.com/RegisterUser` for a long-lived api_key, and writes both opencode's `~/.local/share/opencode/auth.json` AND our `~/.config/opencode-windsurf-auth/credentials.json` (with a `syncedViaOpencodeAuth: true` marker so `opencode auth logout windsurf` mirror-clears both).

Each chat completion flows: opencode → our local proxy on `127.0.0.1:42100` (via `chat.params` baseURL injection) → Connect-RPC stream to `server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage` → response decoded frame-by-frame and re-emitted as OpenAI SSE.

The wire-protocol details, tool-description size cap, system→user message collapse, and finish_reason mapping are all documented in [docs/CLOUD_DIRECT.md](docs/CLOUD_DIRECT.md).

## Prerequisites

- An opencode install (this plugin loads via opencode's plugin system)
- A Windsurf/Cognition account at [windsurf.com](https://windsurf.com) — free tier works for `swe-1.6` and `kimi-k2.6`; other models require a paid plan
- Bun (opencode's runtime)

You do **not** need Windsurf.app installed.

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

Credentials live at `~/.config/opencode-windsurf-auth/credentials.json` (mode `0600`). `opencode auth logout windsurf` also clears them on next plugin load.

## Opencode Configuration

The plugin starts a local proxy on `127.0.0.1:42100` (random free port on fallback) and updates `chat.params.options.baseURL` automatically. You only need to declare the provider + which models you want exposed. Set `"name": "Cognition (Windsurf)"` if you want the picker label to match opencode's auth UI. The full ready-to-paste example is in [`opencode_config_example.json`](opencode_config_example.json).

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-windsurf-auth@beta"],
  "provider": {
    "windsurf": {
      "name": "Cognition (Windsurf)",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:42100/v1"
      },
      "models": {
        "claude-opus-4.7": {
          "name": "Claude Opus 4.7 (Windsurf)",
          "limit": { "context": 1000000, "output": 128000 },
          "variants": {
            "low": {}, "medium": {}, "high": {}, "xhigh": {}, "max": {},
            "low-fast": {}, "medium-fast": {}, "high-fast": {}, "xhigh-fast": {}, "max-fast": {}
          }
        },
        "gpt-5.5": {
          "name": "GPT 5.5 (Windsurf)",
          "limit": { "context": 1050000, "output": 128000 },
          "variants": {
            "none": {}, "low": {}, "medium": {}, "high": {}, "xhigh": {},
            "none-priority": {}, "low-priority": {}, "medium-priority": {}, "high-priority": {}, "xhigh-priority": {}
          }
        },
        "deepseek-v4": {
          "name": "DeepSeek V4 (Windsurf)",
          "limit": { "context": 1000000, "output": 384000 }
        },
        "kimi-k2.6": {
          "name": "Kimi K2.6 (Windsurf)",
          "limit": { "context": 262144, "output": 262144 }
        },
        "gemini-3.5-flash": {
          "name": "Gemini 3.5 Flash (Windsurf)",
          "limit": { "context": 1048576, "output": 65536 },
          "variants": { "minimal": {}, "low": {}, "medium": {}, "high": {} }
        },
        "claude-opus-4.6": {
          "name": "Claude Opus 4.6 (Windsurf)",
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
opencode run --model=windsurf/claude-opus-4.7:high "Refactor X" # paid models
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

- **macOS focus** — Linux works end-to-end; Windows is untested (loopback callback path and credentials directory both portable in theory)
- **Tool descriptions over ~7,000 chars get truncated** — cloud-side validator rejects longer ones with a misleading "MCP configuration issue" error; we truncate to 6,998 chars client-side
- **No multi-account / token-rotation yet** — a single signed-in account at a time
- **Some legacy model names are deprecated upstream.** The plugin still resolves all 94 names listed in `opencode_config_example.json` — but Cognition's cloud has retired 38 of them and responds with `"an internal error occurred"` when called. Affected families: `claude-code`; `gpt-4`/`gpt-4-turbo`/`gpt-4o-mini`/`gpt-4.1-mini`/`gpt-4.1-nano`/`gpt-5` (root, the `:nano` variant still works); `o3-pro` and `o4-mini` (entire families); `gemini-2.0-flash`/`gemini-2.5-flash` (+thinking/lite)/`gemini-3.0-pro`; `deepseek-v3`/`deepseek-v3-2`/`deepseek-r1` (use `deepseek-v4`); all `llama-*`; all `qwen-*`; `grok-2`/`grok-code-fast`; `mistral-7b`; `glm-4.5-fast`/`glm-4.6`(+fast)/`glm-4.7-fast` (use `glm-5.1`); `minimax-m2` (use `minimax-m2.5`). The 56 still-served families include every Claude (3.5+), GPT-5.x non-deprecated, Gemini 2.5-pro / 3.0-flash / 3.1-pro / 3.5-flash, `swe-1.5`/`swe-1.6`, `kimi-k2.5`/`kimi-k2.6`, `deepseek-v4`, `glm-5.1`, `minimax-m2.5`, `gpt-oss-120b`, `o3`. Run `opencode run --model=windsurf/<name> "hi"` to probe live.

## Further Reading

- [docs/CASCADE_PROTOCOL.md](https://github.com/rsvedant/opencode-windsurf-auth/blob/master/docs/CASCADE_PROTOCOL.md) – **Windsurf 2.x findings.** Why `RawGetChatMessage` is dead, how the Cascade flow works, why model UIDs are now strings instead of proto enum numbers, metadata field requirements, etc.
- [docs/WINDSURF_API_SPEC.md](https://github.com/rsvedant/opencode-windsurf-auth/blob/master/docs/WINDSURF_API_SPEC.md) – gRPC endpoints & protobuf notes
- [docs/REVERSE_ENGINEERING.md](https://github.com/rsvedant/opencode-windsurf-auth/blob/master/docs/REVERSE_ENGINEERING.md) – credential discovery + tooling (Windsurf 1.x era; supplement with CASCADE_PROTOCOL.md)
- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) – related project

## License

MIT

# Reverse Engineering Windsurf: Discovery Without Prior Knowledge

This document explains how you would discover Windsurf's local gRPC architecture through reverse engineering, even if mitmproxy shows nothing useful.

## Why mitmproxy Failed

mitmproxy only captures HTTP/HTTPS traffic going through the network stack. Windsurf's language server communicates via **localhost gRPC** - traffic that never leaves the machine and bypasses any system proxy.

Key insight: **If mitmproxy shows nothing interesting, the app is likely talking to itself.**

## Step 1: Process Inspection

Start by examining what processes Windsurf spawns:

```bash
# Find all Windsurf-related processes
ps aux | grep -i windsurf

# Look for any language server processes
ps aux | grep -i language_server

# Example output:
# vedant  12345  0.5  1.2 language_server_macos --csrf_token abc123 --extension_server_port 42100
```

The process arguments are a goldmine:
- `--csrf_token` → Authentication token
- `--extension_server_port` → Base port for communication
- `--windsurf_version` → Version info

## Step 2: Network Port Discovery

Check what ports the language server is listening on:

```bash
# Find ports opened by language_server_macos
lsof -i -P -n | grep language_server

# Or get the PID first then check its ports
pgrep -f language_server_macos
lsof -i -P -n -p <PID>

# Example output:
# language_server 12345 vedant 23u IPv4 TCP 127.0.0.1:42100 (LISTEN)
# language_server 12345 vedant 24u IPv4 TCP 127.0.0.1:42101 (LISTEN)
# language_server 12345 vedant 25u IPv4 TCP 127.0.0.1:42102 (LISTEN)
```

You'll see multiple ports. We now resolve the gRPC endpoint via `lsof -p <PID>` (the offset can vary; common offsets are +2/+3/+4 relative to `extension_server_port`).

## Step 3: Extension Source Analysis

Electron apps bundle their extension code. Find and examine it:

```bash
# Locate the extension code
find /Applications/Windsurf.app -name "extension.js" 2>/dev/null

# The main extension file is usually at:
# /Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js
```

This file is minified but searchable:

```bash
# Search for gRPC service names
grep -oE 'exa\.[a-z_]+_pb\.[A-Za-z]+Service' extension.js | sort -u

# Output:
# exa.language_server_pb.LanguageServerService
# exa.api_server_pb.ApiServerService
# exa.seat_management_pb.SeatManagementService
```

```bash
# Search for RPC method names
grep -oE 'Raw[A-Za-z]+Message|Get[A-Za-z]+|Send[A-Za-z]+' extension.js | sort -u

# Look for model enum definitions
grep -oE '[A-Z][A-Z0-9_]{3,}\s*=\s*[0-9]+' extension.js | head -50
```

## Step 4: Config File Discovery

Applications store credentials somewhere:

```bash
# Check common config locations
ls -la ~/.codeium/
cat ~/.codeium/config.json

# Example content:
# {"apiKey": "abc123-your-key-here"}
```

Also check:
```bash
# Keychain items
security find-generic-password -s "codeium" 2>/dev/null

# Electron's localStorage/IndexedDB
ls ~/Library/Application\ Support/Windsurf/
```

## Step 5: Traffic Capture on Localhost

To actually see the gRPC traffic:

```bash
# Use tcpdump on loopback interface
sudo tcpdump -i lo0 -A port 42102

# Or use ngrep for pattern matching
sudo ngrep -d lo0 -W byline port 42102
```

This reveals the protobuf-encoded messages and HTTP/2 frames.

## Step 6: Protocol Reconstruction

From the captured traffic and source code:

1. **Service path**: `POST /exa.language_server_pb.LanguageServerService/RawGetChatMessage`
2. **Headers**: 
   - `content-type: application/grpc`
   - `te: trailers`
   - `x-codeium-csrf-token: {token from process args}`
3. **Body**: gRPC-framed protobuf message

## Step 7: Model Enum Extraction

The extension.js contains all model definitions:

```bash
# Extract model enums with context
grep -E 'CLAUDE|GPT|GEMINI|DEEPSEEK|SWE' extension.js | head -100

# Better: use a formatter then search
# npx prettier extension.js > extension-formatted.js
# Then search the formatted version
```

Look for patterns like:
```javascript
e.CLAUDE_4_5_SONNET = 353
e.GPT_5 = 340
e.SWE_1_5 = 359
```

## Step 8: Verify with curl

Test your findings:

```bash
# Get credentials
CSRF=$(ps aux | grep language_server_macos | grep -oE '\-\-csrf_token\s+[a-f0-9-]+' | awk '{print $2}')
PORT=$(ps aux | grep language_server_macos | grep -oE '\-\-extension_server_port\s+[0-9]+' | awk '{print $2}')
GRPC_PORT=$((PORT + 4))

# Test the endpoint (will fail without proper protobuf, but confirms it's listening)
curl -v -X POST "http://localhost:$GRPC_PORT/exa.language_server_pb.LanguageServerService/RawGetChatMessage" \
  -H "content-type: application/grpc" \
  -H "te: trailers" \
  -H "x-codeium-csrf-token: $CSRF"
```

## Key Indicators of Local gRPC Architecture

1. **No network traffic in mitmproxy** → App is using localhost
2. **Process args contain tokens/ports** → Direct process communication
3. **Electron app with bundled extensions** → Look for extension.js
4. **gRPC service names in code** → `*_pb.*Service` patterns
5. **Protobuf enum definitions** → `UPPER_CASE = number` patterns

## Tools Summary

| Tool | Purpose |
|------|---------|
| `ps aux` | Process inspection, argument discovery |
| `lsof -i` | Port/socket discovery |
| `grep` | Source code analysis |
| `tcpdump` | Localhost traffic capture |
| `curl` | Endpoint verification |
| `security` | Keychain credential discovery |

## Alternative: Frida/LLDB

For deeper inspection, you can attach debuggers:

```bash
# Attach Frida to the language server
frida -n language_server_macos -l script.js

# Or use LLDB
lldb -n language_server_macos
```

This allows intercepting function calls and inspecting memory, but is usually overkill for API discovery.

## Conclusion

When mitmproxy shows nothing:
1. **Check process arguments** - Often contain tokens and ports
2. **Inspect listening ports** - `lsof` reveals local servers
3. **Analyze bundled code** - Extension.js contains service definitions
4. **Capture localhost traffic** - `tcpdump` on loopback interface

The key insight is recognizing that Electron apps often spawn background processes that communicate via local sockets, completely bypassing network proxies.

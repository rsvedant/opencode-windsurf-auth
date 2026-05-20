/**
 * Windsurf Credential Discovery Module
 *
 * Windsurf 1.9577+ moved the CSRF token from --csrf_token (CLI arg) to the
 * WINDSURF_CSRF_TOKEN environment variable passed to the language_server child.
 * We probe env vars first, then fall back to the legacy CLI arg.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Types
// ============================================================================

export interface WindsurfCredentials {
  /** CSRF token for authenticating with local language server */
  csrfToken: string;
  /** Port where the language server is listening */
  port: number;
  /** Codeium API key */
  apiKey: string;
  /** Windsurf version string */
  version: string;
}

export enum WindsurfErrorCode {
  NOT_RUNNING = 'NOT_RUNNING',
  CSRF_MISSING = 'CSRF_MISSING',
  API_KEY_MISSING = 'API_KEY_MISSING',
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  AUTH_FAILED = 'AUTH_FAILED',
  STREAM_ERROR = 'STREAM_ERROR',
}

export class WindsurfError extends Error {
  code: WindsurfErrorCode;
  details?: unknown;

  constructor(message: string, code: WindsurfErrorCode, details?: unknown) {
    super(message);
    this.name = 'WindsurfError';
    this.code = code;
    this.details = details;
  }
}

// ============================================================================
// Config Paths
// ============================================================================

// Paths for API key discovery
const VSCODE_STATE_PATHS = {
  darwin: path.join(os.homedir(), 'Library/Application Support/Windsurf/User/globalStorage/state.vscdb'),
  linux: path.join(os.homedir(), '.config/Windsurf/User/globalStorage/state.vscdb'),
  win32: path.join(os.homedir(), 'AppData/Roaming/Windsurf/User/globalStorage/state.vscdb'),
} as const;

// Legacy config path (fallback)
const LEGACY_CONFIG_PATH = path.join(os.homedir(), '.codeium', 'config.json');

// Platform-specific process names. Binaries currently used by Windsurf 2.x:
//   macOS:   language_server_macos_arm | language_server_macos_x64
//   Linux:   language_server_linux_x64 | language_server_linux_arm64
//   Windows: language_server_windows_x64.exe
// The substring `language_server_<platform>` matches all variants.
const LANGUAGE_SERVER_PATTERNS = {
  darwin: 'language_server_macos',
  linux: 'language_server_linux',
  win32: 'language_server_windows',
} as const;

const CSRF_ENV_VAR = 'WINDSURF_CSRF_TOKEN';

// ============================================================================
// Process Discovery
// ============================================================================

/**
 * Get the language server process pattern for the current platform
 */
function getLanguageServerPattern(): string {
  const platform = process.platform as keyof typeof LANGUAGE_SERVER_PATTERNS;
  return LANGUAGE_SERVER_PATTERNS[platform] || 'language_server';
}

/**
 * Get the running language-server command line (used for arg-based discovery).
 * Returns the full `ps`-style command line(s) joined by newlines, or null.
 */
function getLanguageServerProcess(): string | null {
  const pattern = getLanguageServerPattern();

  try {
    if (process.platform === 'win32') {
      // Windows 11 22H2+ removed wmic. Use PowerShell + CIM instead.
      const psCmd =
        `Get-CimInstance Win32_Process -Filter "Name LIKE '%${pattern}%'" ` +
        `| Select-Object ProcessId,CommandLine ` +
        `| Format-Table -HideTableHeaders -Wrap | Out-String -Width 4096`;
      const output = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"`,
        { encoding: 'utf8', timeout: 5000 }
      );
      return output;
    }

    // ps aux gives CLI args including --csrf_token for legacy Windsurf builds.
    // -ww disables truncation so very long arg lists aren't cut off.
    const output = execSync(
      `ps -ww -axo pid,command | grep ${pattern} | grep -v grep`,
      { encoding: 'utf8', timeout: 5000 }
    );
    return output || null;
  } catch {
    return null;
  }
}

/**
 * Pull the PID(s) of every running language_server_<platform> binary that
 * belongs to Windsurf (not Antigravity / other Codeium IDEs).
 *
 * Returns the most recently-started PID — that's the active language server
 * even when stale ones linger after a restart.
 */
function getLanguageServerPIDs(): number[] {
  const pattern = getLanguageServerPattern();
  try {
    if (process.platform === 'win32') {
      const psCmd =
        `Get-CimInstance Win32_Process -Filter "Name LIKE '%${pattern}%'" ` +
        `| Where-Object { $_.CommandLine -match '/windsurf/|--ide_name windsurf' } ` +
        `| Sort-Object CreationDate -Descending ` +
        `| ForEach-Object { $_.ProcessId }`;
      const output = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"`,
        { encoding: 'utf8', timeout: 5000 }
      );
      return output
        .split(/\r?\n/)
        .map((line) => parseInt(line.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    }

    // Constrain to processes whose command line contains the Windsurf binary
    // path or the `--ide_name windsurf` flag, avoiding Antigravity collisions.
    const output = execSync(
      `ps -ww -axo pid,lstart,command | grep ${pattern} | grep -iE '/windsurf/|--ide_name windsurf' | grep -v grep`,
      { encoding: 'utf8', timeout: 5000 }
    );
    const rows = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    // Sort by lstart descending — most recent first. lstart format is
    // "DDD MMM DD HH:MM:SS YYYY" which sorts lexicographically by date when
    // we delegate to Date parsing.
    const parsed = rows
      .map((row) => {
        // PID is the first token; lstart is fields 2-6; command starts at 7.
        const tokens = row.split(/\s+/);
        const pid = parseInt(tokens[0], 10);
        const lstart = tokens.slice(1, 6).join(' ');
        const startedAt = Date.parse(lstart);
        return { pid, startedAt };
      })
      .filter((p) => Number.isFinite(p.pid) && p.pid > 0)
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

    return parsed.map((p) => p.pid);
  } catch {
    return [];
  }
}

/**
 * Read all environment variables for the given PID.
 * Returns a flat string the caller can regex-match (`KEY=value` per entry).
 */
function getProcessEnvironment(pid: number): string {
  try {
    if (process.platform === 'darwin') {
      // ps -E -ww -p <pid> prints env vars after the command line.
      // -ww prevents truncation.
      const output = execSync(`ps -E -ww -p ${pid}`, {
        encoding: 'utf8',
        timeout: 5000,
      });
      return output;
    }
    if (process.platform === 'linux') {
      // /proc/<pid>/environ is null-separated. Requires same-user access.
      const buf = fs.readFileSync(`/proc/${pid}/environ`);
      return buf.toString('utf8').replace(/\0/g, '\n');
    }
    if (process.platform === 'win32') {
      // No reliable cross-Windows way to read another process's env via
      // PowerShell without a native helper. Best effort: probe the current
      // user's environment (Windsurf launches the language server as the
      // same user, so any vars Windsurf exported globally will be present).
      const output = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem env: | ForEach-Object { ($_.Name) + '=' + ($_.Value) }"`,
        { encoding: 'utf8', timeout: 5000 }
      );
      return output;
    }
  } catch {
    // fall through
  }
  return '';
}

/**
 * Discover the Windsurf CSRF token.
 *
 * Order of attempts:
 *   1. WINDSURF_CSRF_TOKEN env var on the language_server process
 *      (Windsurf 1.9577+ — current behavior).
 *   2. `--csrf_token <uuid>` CLI arg (legacy Windsurf builds).
 */
export function getCSRFToken(): string {
  return getCSRFTokenForPIDs(getLanguageServerPIDs());
}

/**
 * Internal: extract the CSRF token from a known PID list. Used by
 * `getCredentials` so token + port + version all resolve against the same
 * language_server process (otherwise a restart racing between the two calls
 * leaves us with token from PID A and port from PID B).
 */
function getCSRFTokenForPIDs(pids: number[]): string {
  if (pids.length === 0 && !getLanguageServerProcess()) {
    throw new WindsurfError(
      'Windsurf language server not found. Is Windsurf running?',
      WindsurfErrorCode.NOT_RUNNING
    );
  }

  // Anchor the env-var match so we don't fall for a coincidental substring
  // (e.g. a logging env var that includes the literal "WINDSURF_CSRF_TOKEN=").
  const envRegex = new RegExp(`\\b${CSRF_ENV_VAR}=([0-9a-f-]{36})`, 'i');

  // Newest PID first — see getLanguageServerPIDs.
  for (const pid of pids) {
    const env = getProcessEnvironment(pid);
    if (!env) continue;
    const m = env.match(envRegex);
    if (m?.[1]) return m[1];
  }

  // Legacy CLI arg fallback for older Windsurf builds.
  const processInfo = getLanguageServerProcess();
  if (processInfo) {
    const argMatch = processInfo.match(/--csrf_token\s+([0-9a-f-]{36})/i);
    if (argMatch?.[1]) return argMatch[1];
  }

  throw new WindsurfError(
    'CSRF token not found via WINDSURF_CSRF_TOKEN env var or --csrf_token arg. ' +
      'Restart Windsurf and re-run; ensure the plugin runs as the same user.',
    WindsurfErrorCode.CSRF_MISSING
  );
}

/**
 * Get the language server gRPC port.
 *
 * Windsurf uses `--random_port` so the gRPC listener is always one of the
 * PID's listening sockets — `lsof` is the source of truth. We pick the
 * lowest listening port strictly greater than `--extension_server_port`,
 * which is the historical convention for the chat-server slot.
 */
export function getPort(): number {
  return getPortForPIDs(getLanguageServerPIDs());
}

function getPortForPIDs(pids: number[], processInfo: string | null = getLanguageServerProcess()): number {
  if (pids.length === 0 && !processInfo) {
    throw new WindsurfError(
      'Windsurf language server not found. Is Windsurf running?',
      WindsurfErrorCode.NOT_RUNNING
    );
  }

  // extension_server_port anchors the search to ports beyond the index server.
  const extPortMatch = processInfo?.match(/--extension_server_port\s+(\d+)/);
  const extPort = extPortMatch ? parseInt(extPortMatch[1], 10) : null;

  if (process.platform !== 'win32') {
    for (const pid of pids) {
      try {
        const lsof = execSync(`lsof -p ${pid} -iTCP -sTCP:LISTEN -P -n`, {
          encoding: 'utf8',
          timeout: 15000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });

        const ports = Array.from(lsof.matchAll(/:(\d+)\s+\(LISTEN\)/g)).map((m) =>
          parseInt(m[1], 10)
        );
        if (ports.length === 0) continue;

        if (extPort) {
          const above = ports.filter((p) => p > extPort).sort((a, b) => a - b);
          if (above.length > 0) return above[0];
        }
        return ports.sort((a, b) => a - b)[0];
      } catch {
        // try the next PID
      }
    }
  } else {
    // Windows: PowerShell Get-NetTCPConnection scoped by PID.
    for (const pid of pids) {
      try {
        const output = execSync(
          `powershell -NoProfile -ExecutionPolicy Bypass -Command ` +
            `"Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalPort }"`,
          { encoding: 'utf8', timeout: 15000 }
        );
        const ports = output
          .split(/\r?\n/)
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (ports.length === 0) continue;
        if (extPort) {
          const above = ports.filter((p) => p > extPort).sort((a, b) => a - b);
          if (above.length > 0) return above[0];
        }
        return ports.sort((a, b) => a - b)[0];
      } catch {
        // try next PID
      }
    }
  }

  // Final fallback — best-effort offset from extension_server_port. Windsurf
  // historically gave the chat server a slot between extPort+3 and extPort+8.
  if (extPort) {
    return extPort + 3;
  }

  throw new WindsurfError(
    'Windsurf language server port not found. Is Windsurf running?',
    WindsurfErrorCode.NOT_RUNNING
  );
}

/**
 * Read API key from VSCode state database (windsurfAuthStatus)
 * 
 * The API key is stored in the SQLite database at:
 * ~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb
 * 
 * It's stored in the 'windsurfAuthStatus' key as JSON containing apiKey.
 */
export function getApiKey(): string {
  const platform = process.platform as keyof typeof VSCODE_STATE_PATHS;
  const statePath = VSCODE_STATE_PATHS[platform];
  
  if (!statePath) {
    throw new WindsurfError(
      `Unsupported platform: ${process.platform}`,
      WindsurfErrorCode.API_KEY_MISSING
    );
  }
  
  // Try to get API key from VSCode state database
  if (fs.existsSync(statePath)) {
    try {
      const result = execSync(
        `sqlite3 "${statePath}" "SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus';"`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      
      if (result) {
        const parsed = JSON.parse(result);
        if (parsed.apiKey) {
          return parsed.apiKey;
        }
      }
    } catch (error) {
      // Fall through to legacy config
    }
  }
  
  // Try legacy config file
  if (fs.existsSync(LEGACY_CONFIG_PATH)) {
    try {
      const config = fs.readFileSync(LEGACY_CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(config);
      if (parsed.apiKey) {
        return parsed.apiKey;
      }
    } catch {
      // Fall through
    }
  }
  
  throw new WindsurfError(
    'API key not found. Please login to Windsurf first.',
    WindsurfErrorCode.API_KEY_MISSING
  );
}

/**
 * Get Windsurf version from process arguments.
 *
 * Default fallback updated to match Windsurf 2.x naming. The exact value only
 * matters when the running language server is unreachable, in which case the
 * request will fail anyway — but we want a non-stale default.
 */
export function getWindsurfVersion(): string {
  return getWindsurfVersionFromProcessInfo(getLanguageServerProcess());
}

function getWindsurfVersionFromProcessInfo(processInfo: string | null): string {
  if (processInfo) {
    const match = processInfo.match(/--windsurf_version\s+([^\s]+)/);
    if (match) {
      return match[1].split('+')[0];
    }
  }
  return '2.0.0';
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get all credentials needed to communicate with Windsurf.
 *
 * Resolves the language_server PID set once and reuses it for both the CSRF
 * and port lookups — otherwise a Windsurf restart racing between the two
 * calls would yield a CSRF for PID A and a port for PID B.
 */
export function getCredentials(): WindsurfCredentials {
  // Resolve the language_server's process state ONCE so a restart racing
  // between sub-lookups can't yield a CSRF token for PID A, port for PID B,
  // and version from PID C. PIDs are sorted newest-first by lstart.
  const pids = getLanguageServerPIDs();
  const processInfo = getLanguageServerProcess();
  return {
    csrfToken: getCSRFTokenForPIDs(pids),
    port: getPortForPIDs(pids, processInfo),
    apiKey: getApiKey(),
    version: getWindsurfVersionFromProcessInfo(processInfo),
  };
}

/**
 * Check if Windsurf is running and accessible
 */
export function isWindsurfRunning(): boolean {
  try {
    getCSRFToken();
    getPort();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Windsurf is installed (app exists)
 */
export function isWindsurfInstalled(): boolean {
  if (process.platform === 'darwin') {
    return fs.existsSync('/Applications/Windsurf.app');
  } else if (process.platform === 'linux') {
    return (
      fs.existsSync('/usr/share/windsurf') ||
      fs.existsSync(path.join(os.homedir(), '.local/share/windsurf'))
    );
  } else if (process.platform === 'win32') {
    return (
      fs.existsSync('C:\\Program Files\\Windsurf') ||
      fs.existsSync(path.join(os.homedir(), 'AppData\\Local\\Programs\\Windsurf'))
    );
  }
  return false;
}

/**
 * Validate credentials structure
 */
export function validateCredentials(credentials: Partial<WindsurfCredentials>): credentials is WindsurfCredentials {
  return (
    typeof credentials.csrfToken === 'string' &&
    credentials.csrfToken.length > 0 &&
    typeof credentials.port === 'number' &&
    credentials.port > 0 &&
    typeof credentials.apiKey === 'string' &&
    credentials.apiKey.length > 0 &&
    typeof credentials.version === 'string'
  );
}

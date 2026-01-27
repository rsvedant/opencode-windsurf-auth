/**
 * Windsurf Credential Discovery Module
 * 
 * Automatically discovers credentials from the running Windsurf language server:
 * - CSRF token from process arguments
 * - Port from process arguments (extension_server_port + 2)
 * - API key from VSCode state database (~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb)
 * - Version from process arguments
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

// Platform-specific process names
const LANGUAGE_SERVER_PATTERNS = {
  darwin: 'language_server_macos',
  linux: 'language_server_linux',
  win32: 'language_server_windows',
} as const;

// Windsurf log directories for port discovery
const WINDSURF_LOG_PATHS = {
  darwin: path.join(os.homedir(), 'Library/Application Support/Windsurf/logs'),
  linux: path.join(os.homedir(), '.config/Windsurf/logs'),
  win32: path.join(os.homedir(), 'AppData/Roaming/Windsurf/logs'),
} as const;

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
 * Get process listing for language server
 * Filters specifically for Windsurf's language server (not Antigravity's)
 */
function getLanguageServerProcess(): string | null {
  const pattern = getLanguageServerPattern();

  try {
    if (process.platform === 'win32') {
      // Windows: use WMIC
      const output = execSync(
        `wmic process where "name like '%${pattern}%'" get CommandLine /format:list`,
        { encoding: 'utf8', timeout: 5000 }
      );
      // Filter for Windsurf-specific lines (path contains /windsurf/ or \windsurf\ or has --ide_name windsurf)
      const lines = output.split('\n').filter(line =>
        line.includes('/windsurf/') || line.includes('\\windsurf\\') || line.includes('--ide_name windsurf')
      );
      return lines.length > 0 ? lines.join('\n') : null;
    } else {
      // Unix-like: use ps and filter for Windsurf-specific process
      // Use /windsurf/ in path or --ide_name windsurf to avoid matching other language servers
      const output = execSync(
        `ps aux | grep ${pattern} | grep -E "/windsurf/|--ide_name windsurf" | grep -v grep`,
        { encoding: 'utf8', timeout: 5000 }
      );
      return output.trim() || null;
    }
  } catch {
    return null;
  }
}

/**
 * Extract CSRF token from running Windsurf language server process
 */
export function getCSRFToken(): string {
  const processInfo = getLanguageServerProcess();

  if (!processInfo) {
    throw new WindsurfError(
      'Windsurf language server not found. Is Windsurf running?',
      WindsurfErrorCode.NOT_RUNNING
    );
  }

  const match = processInfo.match(/--csrf_token\s+([a-f0-9-]+)/);
  if (match?.[1]) {
    return match[1];
  }

  throw new WindsurfError(
    'CSRF token not found in Windsurf process. Is Windsurf running?',
    WindsurfErrorCode.CSRF_MISSING
  );
}

/**
 * Get the language server gRPC port from Windsurf log files
 * Parses the most recent "Language server listening on random port at XXXXX" log entry
 */
export function getPort(): number {
  const platform = process.platform as keyof typeof WINDSURF_LOG_PATHS;
  const logsDir = WINDSURF_LOG_PATHS[platform];

  if (!logsDir || !fs.existsSync(logsDir)) {
    throw new WindsurfError(
      `Windsurf logs directory not found at ${logsDir}. Is Windsurf installed?`,
      WindsurfErrorCode.NOT_RUNNING
    );
  }

  try {
    // Search for port in log files and get the most recent entry
    // Log line format: "2026-01-27 11:46:40.251 [info] ... Language server listening on random port at 41085"
    let grepCmd: string;
    if (process.platform === 'win32') {
      // Windows: use findstr
      grepCmd = `findstr /s /r "Language server listening on random port at" "${logsDir}\\*Windsurf.log"`;
    } else {
      // Unix-like: use grep with recursive search
      grepCmd = `grep -rh "Language server listening on random port at" "${logsDir}" 2>/dev/null | sort | tail -1`;
    }

    const output = execSync(grepCmd, { encoding: 'utf8', timeout: 10000 }).trim();

    if (output) {
      // Extract port from the log line
      const portMatch = output.match(/Language server listening on random port at (\d+)/);
      if (portMatch?.[1]) {
        return parseInt(portMatch[1], 10);
      }
    }
  } catch {
    // Fall through to error
  }

  throw new WindsurfError(
    'Windsurf language server port not found in logs. Is Windsurf running?',
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
 * Get Windsurf version from process arguments
 */
export function getWindsurfVersion(): string {
  const processInfo = getLanguageServerProcess();

  if (processInfo) {
    const match = processInfo.match(/--windsurf_version\s+([^\s]+)/);
    if (match) {
      // Extract just the version number (before + if present)
      const version = match[1].split('+')[0];
      return version;
    }
  }

  // Default fallback version
  return '1.13.104';
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get all credentials needed to communicate with Windsurf
 */
export function getCredentials(): WindsurfCredentials {
  return {
    csrfToken: getCSRFToken(),
    port: getPort(),
    apiKey: getApiKey(),
    version: getWindsurfVersion(),
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

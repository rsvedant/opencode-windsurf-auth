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
      return output;
    } else {
      // Unix-like: use ps
      const output = execSync(
        `ps aux | grep ${pattern}`,
        { encoding: 'utf8', timeout: 5000 }
      );
      return output;
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
 * Get the language server port from process arguments
 * The actual gRPC port is extension_server_port + 2
 */
export function getPort(): number {
  const processInfo = getLanguageServerProcess();
  
  if (!processInfo) {
    throw new WindsurfError(
      'Windsurf language server not found. Is Windsurf running?',
      WindsurfErrorCode.NOT_RUNNING
    );
  }
  
  // Try to get extension_server_port from process args
  const portMatch = processInfo.match(/--extension_server_port\s+(\d+)/);
  if (portMatch) {
    // The gRPC port is extension_server_port + 2
    return parseInt(portMatch[1], 10) + 2;
  }
  
  // Fallback: try to find from lsof
  if (process.platform !== 'win32') {
    try {
      const pattern = getLanguageServerPattern();
      const lsof = execSync(
        `lsof -c ${pattern.substring(0, 15)} -i -P 2>/dev/null | grep LISTEN`,
        { encoding: 'utf8', timeout: 15000 }
      );
      const match = lsof.match(/:(\d+)\s+\(LISTEN\)/);
      if (match) {
        return parseInt(match[1], 10);
      }
    } catch {
      // Ignore fallback errors
    }
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

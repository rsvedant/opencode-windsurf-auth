/**
 * TypeScript type definitions for the Windsurf plugin
 */

import type { PluginInput } from '@opencode-ai/plugin';

// ============================================================================
// Model Enums (Protobuf values from Windsurf language server)
// ============================================================================

/**
 * Numeric enum values for Windsurf models (used in protobuf encoding)
 * These values are extracted from Windsurf's extension.js via reverse engineering.
 * 
 * To discover these values yourself:
 * 1. Find extension.js: /Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js
 * 2. Search for patterns like: grep -oE 'CLAUDE[A-Z0-9_]+\s*=\s*[0-9]+' extension.js
 */
export const ModelEnum = {
  MODEL_UNSPECIFIED: 0,

  // ============================================================================
  // Claude Models
  // ============================================================================
  CLAUDE_3_OPUS_20240229: 63,
  CLAUDE_3_SONNET_20240229: 64,
  CLAUDE_3_HAIKU_20240307: 172,
  CLAUDE_3_5_SONNET_20240620: 80,
  CLAUDE_3_5_SONNET_20241022: 166,
  CLAUDE_3_5_HAIKU_20241022: 171,
  CLAUDE_3_7_SONNET_20250219: 226,
  CLAUDE_3_7_SONNET_20250219_THINKING: 227,
  CLAUDE_4_OPUS: 290,
  CLAUDE_4_OPUS_THINKING: 291,
  CLAUDE_4_SONNET: 281,
  CLAUDE_4_SONNET_THINKING: 282,
  CLAUDE_4_1_OPUS: 328,
  CLAUDE_4_1_OPUS_THINKING: 329,
  CLAUDE_4_5_SONNET: 353,
  CLAUDE_4_5_SONNET_THINKING: 354,
  CLAUDE_4_5_SONNET_1M: 370,
  CLAUDE_4_5_OPUS: 391,
  CLAUDE_4_5_OPUS_THINKING: 392,
  CLAUDE_CODE: 344,

  // ============================================================================
  // GPT Models
  // ============================================================================
  GPT_4: 30,
  GPT_4_1106_PREVIEW: 37,
  GPT_4O_2024_05_13: 71,
  GPT_4O_2024_08_06: 109,
  GPT_4O_MINI_2024_07_18: 113,
  GPT_4_5: 228,
  GPT_4_1_2025_04_14: 259,
  GPT_4_1_MINI_2025_04_14: 260,
  GPT_4_1_NANO_2025_04_14: 261,
  GPT_5_NANO: 337,
  GPT_5_MINIMAL: 338,
  GPT_5_LOW: 339,
  GPT_5: 340,
  GPT_5_HIGH: 341,
  GPT_5_CODEX: 346,
  // GPT 5.1 Codex variants
  GPT_5_1_CODEX_MINI_LOW: 385,
  GPT_5_1_CODEX_MINI_MEDIUM: 386,
  GPT_5_1_CODEX_MINI_HIGH: 387,
  GPT_5_1_CODEX_LOW: 388,
  GPT_5_1_CODEX_MEDIUM: 389,
  GPT_5_1_CODEX_HIGH: 390,
  GPT_5_1_CODEX_MAX_LOW: 395,
  GPT_5_1_CODEX_MAX_MEDIUM: 396,
  GPT_5_1_CODEX_MAX_HIGH: 397,
  // GPT 5.2 variants
  GPT_5_2_NONE: 399,
  GPT_5_2_LOW: 400,
  GPT_5_2_MEDIUM: 401,
  GPT_5_2_HIGH: 402,
  GPT_5_2_XHIGH: 403,
  GPT_5_2_NONE_PRIORITY: 404,
  GPT_5_2_LOW_PRIORITY: 405,
  GPT_5_2_MEDIUM_PRIORITY: 406,
  GPT_5_2_HIGH_PRIORITY: 407,
  GPT_5_2_XHIGH_PRIORITY: 408,

  // ============================================================================
  // O-Series (OpenAI Reasoning)
  // ============================================================================
  O1_PREVIEW: 117,
  O1_MINI: 118,
  O1: 170,
  O3_MINI: 207,
  O3_MINI_LOW: 213,
  O3_MINI_HIGH: 214,
  O3: 218,
  O3_LOW: 262,
  O3_HIGH: 263,
  O3_PRO: 294,
  O3_PRO_LOW: 295,
  O3_PRO_HIGH: 296,
  O4_MINI: 264,
  O4_MINI_LOW: 265,
  O4_MINI_HIGH: 266,

  // ============================================================================
  // Google Gemini
  // ============================================================================
  GEMINI_1_0_PRO: 61,
  GEMINI_1_5_PRO: 62,
  GEMINI_2_0_FLASH: 184,
  GEMINI_2_5_PRO: 246,
  GEMINI_2_5_FLASH: 312,
  GEMINI_2_5_FLASH_THINKING: 313,
  GEMINI_2_5_FLASH_LITE: 343,
  GEMINI_3_0_PRO_LOW: 378,
  GEMINI_3_0_PRO_HIGH: 379,
  GEMINI_3_0_PRO_MINIMAL: 411,
  GEMINI_3_0_PRO_MEDIUM: 412,
  GEMINI_3_0_FLASH_MINIMAL: 413,
  GEMINI_3_0_FLASH_LOW: 414,
  GEMINI_3_0_FLASH_MEDIUM: 415,
  GEMINI_3_0_FLASH_HIGH: 416,

  // ============================================================================
  // DeepSeek
  // ============================================================================
  DEEPSEEK_V3: 205,
  DEEPSEEK_R1: 206,
  DEEPSEEK_R1_SLOW: 215,
  DEEPSEEK_R1_FAST: 216,
  DEEPSEEK_V3_2: 409,

  // ============================================================================
  // Llama
  // ============================================================================
  LLAMA_3_1_8B_INSTRUCT: 106,
  LLAMA_3_1_70B_INSTRUCT: 107,
  LLAMA_3_1_405B_INSTRUCT: 105,
  LLAMA_3_3_70B_INSTRUCT: 208,
  LLAMA_3_3_70B_INSTRUCT_R1: 209,

  // ============================================================================
  // Qwen
  // ============================================================================
  QWEN_2_5_7B_INSTRUCT: 178,
  QWEN_2_5_32B_INSTRUCT: 179,
  QWEN_2_5_72B_INSTRUCT: 180,
  QWEN_3_235B_INSTRUCT: 324,
  QWEN_3_CODER_480B_INSTRUCT: 325,
  QWEN_3_CODER_480B_INSTRUCT_FAST: 327,

  // ============================================================================
  // XAI Grok
  // ============================================================================
  GROK_2: 212,
  GROK_3: 217,
  GROK_3_MINI_REASONING: 234,
  GROK_CODE_FAST: 345,

  // ============================================================================
  // Other Models
  // ============================================================================
  MISTRAL_7B: 77,
  KIMI_K2: 323,
  KIMI_K2_THINKING: 394,
  GLM_4_5: 342,
  GLM_4_6: 356,
  GLM_4_7: 417,
  MINIMAX_M2: 368,
  MINIMAX_M2_1: 419,
  SWE_1_5: 359,
  SWE_1_5_THINKING: 369,
} as const;

export type ModelEnumValue = (typeof ModelEnum)[keyof typeof ModelEnum];

/**
 * Chat message source types for protobuf encoding
 */
export const ChatMessageSource = {
  UNSPECIFIED: 0,
  USER: 1,
  SYSTEM: 2,
  ASSISTANT: 3,
  TOOL: 4,
} as const;

export type ChatMessageSourceValue = (typeof ChatMessageSource)[keyof typeof ChatMessageSource];

// ============================================================================
// Authentication Types
// ============================================================================

/** Firebase authentication data stored by Windsurf */
export interface FirebaseAuthData {
  /** Firebase ID token (JWT) */
  idToken: string;
  /** Refresh token for getting new ID tokens */
  refreshToken: string;
  /** Token expiry timestamp (ms) */
  expiresAt: number;
  /** User's email */
  email?: string;
  /** User's display name */
  displayName?: string;
  /** Firebase user ID */
  uid?: string;
}

/** Windsurf account stored by the plugin */
export interface WindsurfAccount {
  /** Account identifier (email or UID) */
  id: string;
  /** Display name for the account */
  name: string;
  /** Firebase authentication data */
  auth: FirebaseAuthData;
  /** Codeium API key (if separate from Firebase token) */
  apiKey?: string;
  /** Installation ID */
  installationId?: string;
  /** Account status */
  status: 'active' | 'expired' | 'rate_limited' | 'error';
  /** Last error message if status is 'error' */
  lastError?: string;
  /** Rate limit state */
  rateLimit?: RateLimitState;
  /** When the account was added */
  addedAt: number;
  /** Last successful request timestamp */
  lastUsedAt?: number;
}

/** Rate limit tracking state */
export interface RateLimitState {
  /** Whether currently rate limited */
  isLimited: boolean;
  /** When the rate limit expires (ms) */
  resetAt?: number;
  /** Number of consecutive rate limit hits */
  consecutiveHits: number;
  /** Current backoff duration (ms) */
  backoffMs: number;
}

/** Accounts storage file format */
export interface AccountsStorage {
  /** Storage format version */
  version: number;
  /** Stored accounts */
  accounts: WindsurfAccount[];
  /** Currently selected account ID */
  selectedAccountId?: string;
  /** Plugin settings */
  settings?: PluginSettings;
}

/** Plugin settings */
export interface PluginSettings {
  /** Account selection strategy */
  accountStrategy: 'sticky' | 'round-robin' | 'least-used';
  /** Enable debug logging */
  debug?: boolean;
  /** Custom API server URL (for enterprise) */
  customApiServer?: string;
  /** Custom inference server URL */
  customInferenceServer?: string;
}

// ============================================================================
// gRPC/API Types
// ============================================================================

/** Metadata sent with every gRPC request */
export interface RequestMetadata {
  /** User's API key */
  apiKey: string;
  /** IDE name */
  ideName: string;
  /** IDE version */
  ideVersion: string;
  /** Extension version */
  extensionVersion: string;
  /** Unique session ID */
  sessionId: string;
  /** User locale */
  locale: string;
}

/** Chat message in Windsurf format */
export interface WindsurfChatMessage {
  /** Message role */
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** Message content */
  content: string;
  /** Tool call ID (for tool role) */
  toolCallId?: string;
  /** Tool calls made by assistant */
  toolCalls?: WindsurfToolCall[];
}

/** Tool call in Windsurf format */
export interface WindsurfToolCall {
  /** Tool call ID */
  id: string;
  /** Tool/function name */
  name: string;
  /** Arguments as JSON string */
  arguments: string;
}

/** Tool definition in Windsurf format */
export interface WindsurfToolDefinition {
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** Parameters schema (JSON Schema) */
  parameters: Record<string, unknown>;
}

/** Cascade session info */
export interface CascadeSession {
  /** Session ID */
  cascadeId: string;
  /** Model being used */
  model: string;
  /** Session start time */
  startedAt: number;
  /** Message count */
  messageCount: number;
}

// ============================================================================
// Plugin Types
// ============================================================================

/** Plugin initialization context */
export interface WindsurfPluginContext extends PluginInput {
  /** Plugin-specific client extensions */
  client: PluginInput['client'] & {
    /** TUI methods */
    tui?: {
      showToast?: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
    };
  };
}

/** Account loader function signature */
export type AccountLoader = (
  getAuth: () => Promise<{ account: WindsurfAccount } | undefined>,
  provider: string
) => Promise<{
  apiKey: string;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}>;

/** Plugin result returned by createWindsurfPlugin */
export interface WindsurfPluginResult {
  /** Event handler registration */
  event: (handler: (event: PluginEvent) => void) => void;
  /** Authentication configuration */
  auth: {
    /** Provider identifier */
    provider: string;
    /** Account loader */
    loader: AccountLoader;
    /** Auth methods */
    methods: {
      login: () => Promise<void>;
      logout: () => Promise<void>;
      refresh: () => Promise<void>;
    };
  };
}

/** Plugin events */
export type PluginEvent = 
  | { type: 'account_added'; account: WindsurfAccount }
  | { type: 'account_removed'; accountId: string }
  | { type: 'account_refreshed'; account: WindsurfAccount }
  | { type: 'rate_limited'; accountId: string; resetAt: number }
  | { type: 'error'; message: string; accountId?: string };

// ============================================================================
// Request/Response Types
// ============================================================================

/** OpenCode request format (what we receive) */
export interface OpenCodeRequest {
  /** Model name */
  model: string;
  /** Messages */
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  }>;
  /** Tools */
  tools?: Array<{
    type: string;
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  /** Streaming */
  stream?: boolean;
  /** Temperature */
  temperature?: number;
  /** Max tokens */
  max_tokens?: number;
  /** System instruction */
  system?: string;
}

/** Transformed Windsurf request format */
export interface WindsurfRequest {
  /** Request metadata */
  metadata: RequestMetadata;
  /** Cascade session ID */
  cascadeId?: string;
  /** Model or alias */
  modelOrAlias: string;
  /** Chat messages */
  messages: WindsurfChatMessage[];
  /** Tool definitions */
  tools?: WindsurfToolDefinition[];
  /** Tool choice constraint */
  toolChoice?: 'auto' | 'none' | { name: string };
  /** Generation config */
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}

/** Windsurf streaming response chunk */
export interface WindsurfStreamChunk {
  /** Chunk type */
  type: 'content' | 'tool_call' | 'done' | 'error';
  /** Content delta */
  content?: string;
  /** Tool call delta */
  toolCall?: Partial<WindsurfToolCall>;
  /** Error message */
  error?: string;
  /** Usage stats (on done) */
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

// ============================================================================
// Device Flow Types
// ============================================================================

/**
 * Device flow OAuth state
 */
export interface DeviceFlowState {
  /** Device code for polling */
  deviceCode: string;
  /** User code to display */
  userCode: string;
  /** Verification URL */
  verificationUrl: string;
  /** URL with code embedded */
  verificationUrlComplete: string;
  /** Polling interval in seconds */
  interval: number;
  /** Expiry time */
  expiresAt: number;
}

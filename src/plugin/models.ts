/**
 * Model name to enum mappings for Windsurf gRPC protocol
 * 
 * Maps OpenAI-compatible model names to Windsurf protobuf enum values.
 * These values were extracted from Windsurf's extension.js.
 * 
 * To discover/verify these values:
 * 1. Find: /Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js
 * 2. Search: grep -oE 'CLAUDE[A-Z0-9_]+\s*=\s*[0-9]+' extension.js
 */

import { ModelEnum, type ModelEnumValue } from './types.js';

// ============================================================================
// Model Name Mappings
// ============================================================================

/**
 * Map of model name strings to their protobuf enum values
 * Supports multiple aliases for each model
 */
const MODEL_NAME_TO_ENUM: Record<string, ModelEnumValue> = {
  // ============================================================================
  // Claude Models
  // ============================================================================
  'claude-3-opus': ModelEnum.CLAUDE_3_OPUS_20240229,
  'claude-3-opus-20240229': ModelEnum.CLAUDE_3_OPUS_20240229,
  'claude-3-sonnet': ModelEnum.CLAUDE_3_SONNET_20240229,
  'claude-3-sonnet-20240229': ModelEnum.CLAUDE_3_SONNET_20240229,
  'claude-3-haiku': ModelEnum.CLAUDE_3_HAIKU_20240307,
  'claude-3-haiku-20240307': ModelEnum.CLAUDE_3_HAIKU_20240307,
  
  'claude-3.5-sonnet': ModelEnum.CLAUDE_3_5_SONNET_20241022,
  'claude-3-5-sonnet': ModelEnum.CLAUDE_3_5_SONNET_20241022,
  'claude-3-5-sonnet-20241022': ModelEnum.CLAUDE_3_5_SONNET_20241022,
  'claude-3.5-haiku': ModelEnum.CLAUDE_3_5_HAIKU_20241022,
  'claude-3-5-haiku': ModelEnum.CLAUDE_3_5_HAIKU_20241022,
  'claude-3-5-haiku-20241022': ModelEnum.CLAUDE_3_5_HAIKU_20241022,
  
  'claude-3.7-sonnet': ModelEnum.CLAUDE_3_7_SONNET_20250219,
  'claude-3-7-sonnet': ModelEnum.CLAUDE_3_7_SONNET_20250219,
  'claude-3-7-sonnet-20250219': ModelEnum.CLAUDE_3_7_SONNET_20250219,
  'claude-3.7-sonnet-thinking': ModelEnum.CLAUDE_3_7_SONNET_20250219_THINKING,
  'claude-3-7-sonnet-thinking': ModelEnum.CLAUDE_3_7_SONNET_20250219_THINKING,
  
  'claude-4-opus': ModelEnum.CLAUDE_4_OPUS,
  'claude-4-opus-thinking': ModelEnum.CLAUDE_4_OPUS_THINKING,
  'claude-4-sonnet': ModelEnum.CLAUDE_4_SONNET,
  'claude-4-sonnet-thinking': ModelEnum.CLAUDE_4_SONNET_THINKING,
  
  'claude-4.1-opus': ModelEnum.CLAUDE_4_1_OPUS,
  'claude-4-1-opus': ModelEnum.CLAUDE_4_1_OPUS,
  'claude-4.1-opus-thinking': ModelEnum.CLAUDE_4_1_OPUS_THINKING,
  'claude-4-1-opus-thinking': ModelEnum.CLAUDE_4_1_OPUS_THINKING,
  
  'claude-4.5-sonnet': ModelEnum.CLAUDE_4_5_SONNET,
  'claude-4-5-sonnet': ModelEnum.CLAUDE_4_5_SONNET,
  'claude-4.5-sonnet-thinking': ModelEnum.CLAUDE_4_5_SONNET_THINKING,
  'claude-4-5-sonnet-thinking': ModelEnum.CLAUDE_4_5_SONNET_THINKING,
  'claude-4.5-sonnet-1m': ModelEnum.CLAUDE_4_5_SONNET_1M,
  'claude-4-5-sonnet-1m': ModelEnum.CLAUDE_4_5_SONNET_1M,
  
  'claude-4.5-opus': ModelEnum.CLAUDE_4_5_OPUS,
  'claude-4-5-opus': ModelEnum.CLAUDE_4_5_OPUS,
  'claude-4.5-opus-thinking': ModelEnum.CLAUDE_4_5_OPUS_THINKING,
  'claude-4-5-opus-thinking': ModelEnum.CLAUDE_4_5_OPUS_THINKING,
  
  'claude-code': ModelEnum.CLAUDE_CODE,

  // ============================================================================
  // GPT Models
  // ============================================================================
  'gpt-4': ModelEnum.GPT_4,
  'gpt-4-turbo': ModelEnum.GPT_4_1106_PREVIEW,
  'gpt-4-1106-preview': ModelEnum.GPT_4_1106_PREVIEW,
  
  'gpt-4o': ModelEnum.GPT_4O_2024_08_06,
  'gpt-4o-2024-08-06': ModelEnum.GPT_4O_2024_08_06,
  'gpt-4o-mini': ModelEnum.GPT_4O_MINI_2024_07_18,
  'gpt-4o-mini-2024-07-18': ModelEnum.GPT_4O_MINI_2024_07_18,
  
  'gpt-4.5': ModelEnum.GPT_4_5,
  'gpt-4-5': ModelEnum.GPT_4_5,
  
  'gpt-4.1': ModelEnum.GPT_4_1_2025_04_14,
  'gpt-4-1': ModelEnum.GPT_4_1_2025_04_14,
  'gpt-4.1-mini': ModelEnum.GPT_4_1_MINI_2025_04_14,
  'gpt-4-1-mini': ModelEnum.GPT_4_1_MINI_2025_04_14,
  'gpt-4.1-nano': ModelEnum.GPT_4_1_NANO_2025_04_14,
  'gpt-4-1-nano': ModelEnum.GPT_4_1_NANO_2025_04_14,
  
  'gpt-5': ModelEnum.GPT_5,
  'gpt-5-nano': ModelEnum.GPT_5_NANO,
  'gpt-5-low': ModelEnum.GPT_5_LOW,
  'gpt-5-high': ModelEnum.GPT_5_HIGH,
  'gpt-5-codex': ModelEnum.GPT_5_CODEX,
  
  // GPT 5.1 Codex variants
  'gpt-5.1-codex-mini-low': ModelEnum.GPT_5_1_CODEX_MINI_LOW,
  'gpt-5.1-codex-mini-medium': ModelEnum.GPT_5_1_CODEX_MINI_MEDIUM,
  'gpt-5.1-codex-mini-high': ModelEnum.GPT_5_1_CODEX_MINI_HIGH,
  'gpt-5.1-codex-mini': ModelEnum.GPT_5_1_CODEX_MINI_MEDIUM,
  'gpt-5.1-codex-low': ModelEnum.GPT_5_1_CODEX_LOW,
  'gpt-5.1-codex-medium': ModelEnum.GPT_5_1_CODEX_MEDIUM,
  'gpt-5.1-codex-high': ModelEnum.GPT_5_1_CODEX_HIGH,
  'gpt-5.1-codex': ModelEnum.GPT_5_1_CODEX_MEDIUM,
  'gpt-5.1-codex-max-low': ModelEnum.GPT_5_1_CODEX_MAX_LOW,
  'gpt-5.1-codex-max-medium': ModelEnum.GPT_5_1_CODEX_MAX_MEDIUM,
  'gpt-5.1-codex-max-high': ModelEnum.GPT_5_1_CODEX_MAX_HIGH,
  'gpt-5.1-codex-max': ModelEnum.GPT_5_1_CODEX_MAX_MEDIUM,
  
  // GPT 5.2 variants
  'gpt-5.2': ModelEnum.GPT_5_2_MEDIUM,
  'gpt-5-2': ModelEnum.GPT_5_2_MEDIUM,
  'gpt-5.2-low': ModelEnum.GPT_5_2_LOW,
  'gpt-5-2-low': ModelEnum.GPT_5_2_LOW,
  'gpt-5.2-high': ModelEnum.GPT_5_2_HIGH,
  'gpt-5-2-high': ModelEnum.GPT_5_2_HIGH,
  'gpt-5.2-xhigh': ModelEnum.GPT_5_2_XHIGH,
  'gpt-5-2-xhigh': ModelEnum.GPT_5_2_XHIGH,
  'gpt-5.2-priority': ModelEnum.GPT_5_2_MEDIUM_PRIORITY,
  'gpt-5.2-low-priority': ModelEnum.GPT_5_2_LOW_PRIORITY,
  'gpt-5.2-high-priority': ModelEnum.GPT_5_2_HIGH_PRIORITY,
  'gpt-5.2-xhigh-priority': ModelEnum.GPT_5_2_XHIGH_PRIORITY,

  // ============================================================================
  // O-Series (OpenAI Reasoning)
  // ============================================================================
  'o1': ModelEnum.O1,
  'o1-mini': ModelEnum.O1_MINI,
  'o1-preview': ModelEnum.O1_PREVIEW,
  
  'o3': ModelEnum.O3,
  'o3-mini': ModelEnum.O3_MINI,
  'o3-low': ModelEnum.O3_LOW,
  'o3-high': ModelEnum.O3_HIGH,
  
  'o3-pro': ModelEnum.O3_PRO,
  'o3-pro-low': ModelEnum.O3_PRO_LOW,
  'o3-pro-high': ModelEnum.O3_PRO_HIGH,
  
  'o4-mini': ModelEnum.O4_MINI,
  'o4-mini-low': ModelEnum.O4_MINI_LOW,
  'o4-mini-high': ModelEnum.O4_MINI_HIGH,

  // ============================================================================
  // Google Gemini
  // ============================================================================
  'gemini-1.0-pro': ModelEnum.GEMINI_1_0_PRO,
  'gemini-1-0-pro': ModelEnum.GEMINI_1_0_PRO,
  'gemini-1.5-pro': ModelEnum.GEMINI_1_5_PRO,
  'gemini-1-5-pro': ModelEnum.GEMINI_1_5_PRO,
  
  'gemini-2.0-flash': ModelEnum.GEMINI_2_0_FLASH,
  'gemini-2-0-flash': ModelEnum.GEMINI_2_0_FLASH,
  
  'gemini-2.5-pro': ModelEnum.GEMINI_2_5_PRO,
  'gemini-2-5-pro': ModelEnum.GEMINI_2_5_PRO,
  'gemini-2.5-flash': ModelEnum.GEMINI_2_5_FLASH,
  'gemini-2-5-flash': ModelEnum.GEMINI_2_5_FLASH,
  'gemini-2.5-flash-thinking': ModelEnum.GEMINI_2_5_FLASH_THINKING,
  'gemini-2-5-flash-thinking': ModelEnum.GEMINI_2_5_FLASH_THINKING,
  'gemini-2.5-flash-lite': ModelEnum.GEMINI_2_5_FLASH_LITE,
  'gemini-2-5-flash-lite': ModelEnum.GEMINI_2_5_FLASH_LITE,
  
  'gemini-3.0-pro-low': ModelEnum.GEMINI_3_0_PRO_LOW,
  'gemini-3-0-pro-low': ModelEnum.GEMINI_3_0_PRO_LOW,
  'gemini-3.0-pro-high': ModelEnum.GEMINI_3_0_PRO_HIGH,
  'gemini-3-0-pro-high': ModelEnum.GEMINI_3_0_PRO_HIGH,
  'gemini-3.0-pro': ModelEnum.GEMINI_3_0_PRO_MEDIUM,
  'gemini-3-0-pro': ModelEnum.GEMINI_3_0_PRO_MEDIUM,
  'gemini-3.0-pro-minimal': ModelEnum.GEMINI_3_0_PRO_MINIMAL,
  'gemini-3-0-pro-minimal': ModelEnum.GEMINI_3_0_PRO_MINIMAL,
  'gemini-3.0-pro-medium': ModelEnum.GEMINI_3_0_PRO_MEDIUM,
  'gemini-3-0-pro-medium': ModelEnum.GEMINI_3_0_PRO_MEDIUM,
  'gemini-3.0-flash': ModelEnum.GEMINI_3_0_FLASH_MEDIUM,
  'gemini-3-0-flash': ModelEnum.GEMINI_3_0_FLASH_MEDIUM,
  'gemini-3.0-flash-minimal': ModelEnum.GEMINI_3_0_FLASH_MINIMAL,
  'gemini-3-0-flash-minimal': ModelEnum.GEMINI_3_0_FLASH_MINIMAL,
  'gemini-3.0-flash-low': ModelEnum.GEMINI_3_0_FLASH_LOW,
  'gemini-3-0-flash-low': ModelEnum.GEMINI_3_0_FLASH_LOW,
  'gemini-3.0-flash-medium': ModelEnum.GEMINI_3_0_FLASH_MEDIUM,
  'gemini-3-0-flash-medium': ModelEnum.GEMINI_3_0_FLASH_MEDIUM,
  'gemini-3.0-flash-high': ModelEnum.GEMINI_3_0_FLASH_HIGH,
  'gemini-3-0-flash-high': ModelEnum.GEMINI_3_0_FLASH_HIGH,

  // ============================================================================
  // DeepSeek
  // ============================================================================
  'deepseek-v3': ModelEnum.DEEPSEEK_V3,
  'deepseek-v3-2': ModelEnum.DEEPSEEK_V3_2,
  'deepseek-r1': ModelEnum.DEEPSEEK_R1,
  'deepseek-r1-fast': ModelEnum.DEEPSEEK_R1_FAST,
  'deepseek-r1-slow': ModelEnum.DEEPSEEK_R1_SLOW,

  // ============================================================================
  // Llama
  // ============================================================================
  'llama-3.1-8b': ModelEnum.LLAMA_3_1_8B_INSTRUCT,
  'llama-3-1-8b': ModelEnum.LLAMA_3_1_8B_INSTRUCT,
  'llama-3.1-70b': ModelEnum.LLAMA_3_1_70B_INSTRUCT,
  'llama-3-1-70b': ModelEnum.LLAMA_3_1_70B_INSTRUCT,
  'llama-3.1-405b': ModelEnum.LLAMA_3_1_405B_INSTRUCT,
  'llama-3-1-405b': ModelEnum.LLAMA_3_1_405B_INSTRUCT,
  'llama-3.3-70b': ModelEnum.LLAMA_3_3_70B_INSTRUCT,
  'llama-3-3-70b': ModelEnum.LLAMA_3_3_70B_INSTRUCT,
  'llama-3.3-70b-r1': ModelEnum.LLAMA_3_3_70B_INSTRUCT_R1,
  'llama-3-3-70b-r1': ModelEnum.LLAMA_3_3_70B_INSTRUCT_R1,

  // ============================================================================
  // Qwen
  // ============================================================================
  'qwen-2.5-7b': ModelEnum.QWEN_2_5_7B_INSTRUCT,
  'qwen-2-5-7b': ModelEnum.QWEN_2_5_7B_INSTRUCT,
  'qwen-2.5-32b': ModelEnum.QWEN_2_5_32B_INSTRUCT,
  'qwen-2-5-32b': ModelEnum.QWEN_2_5_32B_INSTRUCT,
  'qwen-2.5-72b': ModelEnum.QWEN_2_5_72B_INSTRUCT,
  'qwen-2-5-72b': ModelEnum.QWEN_2_5_72B_INSTRUCT,
  'qwen-3-235b': ModelEnum.QWEN_3_235B_INSTRUCT,
  'qwen-3-coder-480b': ModelEnum.QWEN_3_CODER_480B_INSTRUCT,
  'qwen-3-coder-480b-fast': ModelEnum.QWEN_3_CODER_480B_INSTRUCT_FAST,
  'qwen-3-coder': ModelEnum.QWEN_3_CODER_480B_INSTRUCT,

  // ============================================================================
  // XAI Grok
  // ============================================================================
  'grok-2': ModelEnum.GROK_2,
  'grok-3': ModelEnum.GROK_3,
  'grok-3-mini': ModelEnum.GROK_3_MINI_REASONING,
  'grok-code-fast': ModelEnum.GROK_CODE_FAST,

  // ============================================================================
  // Other Models
  // ============================================================================
  'mistral-7b': ModelEnum.MISTRAL_7B,
  'kimi-k2': ModelEnum.KIMI_K2,
  'kimi-k2-thinking': ModelEnum.KIMI_K2_THINKING,
  'glm-4.5': ModelEnum.GLM_4_5,
  'glm-4-5': ModelEnum.GLM_4_5,
  'glm-4.6': ModelEnum.GLM_4_6,
  'glm-4-6': ModelEnum.GLM_4_6,
  'glm-4.7': ModelEnum.GLM_4_7,
  'glm-4-7': ModelEnum.GLM_4_7,
  'minimax-m2': ModelEnum.MINIMAX_M2,
  'minimax-m2.1': ModelEnum.MINIMAX_M2_1,
  'minimax-m2-1': ModelEnum.MINIMAX_M2_1,
  'swe-1.5': ModelEnum.SWE_1_5,
  'swe-1-5': ModelEnum.SWE_1_5,
  'swe-1.5-thinking': ModelEnum.SWE_1_5_THINKING,
  'swe-1-5-thinking': ModelEnum.SWE_1_5_THINKING,
};

/**
 * Reverse mapping from enum values to canonical model names
 */
const ENUM_TO_MODEL_NAME: Partial<Record<ModelEnumValue, string>> = {
  // Claude
  [ModelEnum.CLAUDE_3_OPUS_20240229]: 'claude-3-opus',
  [ModelEnum.CLAUDE_3_SONNET_20240229]: 'claude-3-sonnet',
  [ModelEnum.CLAUDE_3_HAIKU_20240307]: 'claude-3-haiku',
  [ModelEnum.CLAUDE_3_5_SONNET_20241022]: 'claude-3.5-sonnet',
  [ModelEnum.CLAUDE_3_5_HAIKU_20241022]: 'claude-3.5-haiku',
  [ModelEnum.CLAUDE_3_7_SONNET_20250219]: 'claude-3.7-sonnet',
  [ModelEnum.CLAUDE_3_7_SONNET_20250219_THINKING]: 'claude-3.7-sonnet-thinking',
  [ModelEnum.CLAUDE_4_OPUS]: 'claude-4-opus',
  [ModelEnum.CLAUDE_4_OPUS_THINKING]: 'claude-4-opus-thinking',
  [ModelEnum.CLAUDE_4_SONNET]: 'claude-4-sonnet',
  [ModelEnum.CLAUDE_4_SONNET_THINKING]: 'claude-4-sonnet-thinking',
  [ModelEnum.CLAUDE_4_1_OPUS]: 'claude-4.1-opus',
  [ModelEnum.CLAUDE_4_1_OPUS_THINKING]: 'claude-4.1-opus-thinking',
  [ModelEnum.CLAUDE_4_5_SONNET]: 'claude-4.5-sonnet',
  [ModelEnum.CLAUDE_4_5_SONNET_THINKING]: 'claude-4.5-sonnet-thinking',
  [ModelEnum.CLAUDE_4_5_SONNET_1M]: 'claude-4.5-sonnet-1m',
  [ModelEnum.CLAUDE_4_5_OPUS]: 'claude-4.5-opus',
  [ModelEnum.CLAUDE_4_5_OPUS_THINKING]: 'claude-4.5-opus-thinking',
  [ModelEnum.CLAUDE_CODE]: 'claude-code',
  
  // GPT
  [ModelEnum.GPT_4]: 'gpt-4',
  [ModelEnum.GPT_4_1106_PREVIEW]: 'gpt-4-turbo',
  [ModelEnum.GPT_4O_2024_08_06]: 'gpt-4o',
  [ModelEnum.GPT_4O_MINI_2024_07_18]: 'gpt-4o-mini',
  [ModelEnum.GPT_4_5]: 'gpt-4.5',
  [ModelEnum.GPT_4_1_2025_04_14]: 'gpt-4.1',
  [ModelEnum.GPT_4_1_MINI_2025_04_14]: 'gpt-4.1-mini',
  [ModelEnum.GPT_4_1_NANO_2025_04_14]: 'gpt-4.1-nano',
  [ModelEnum.GPT_5]: 'gpt-5',
  [ModelEnum.GPT_5_NANO]: 'gpt-5-nano',
  [ModelEnum.GPT_5_LOW]: 'gpt-5-low',
  [ModelEnum.GPT_5_HIGH]: 'gpt-5-high',
  [ModelEnum.GPT_5_CODEX]: 'gpt-5-codex',
  [ModelEnum.GPT_5_1_CODEX_MINI_MEDIUM]: 'gpt-5.1-codex-mini',
  [ModelEnum.GPT_5_1_CODEX_MEDIUM]: 'gpt-5.1-codex',
  [ModelEnum.GPT_5_1_CODEX_MAX_MEDIUM]: 'gpt-5.1-codex-max',
  [ModelEnum.GPT_5_2_LOW]: 'gpt-5.2-low',
  [ModelEnum.GPT_5_2_MEDIUM]: 'gpt-5.2',
  [ModelEnum.GPT_5_2_HIGH]: 'gpt-5.2-high',
  [ModelEnum.GPT_5_2_XHIGH]: 'gpt-5.2-xhigh',
  [ModelEnum.GPT_5_2_MEDIUM_PRIORITY]: 'gpt-5.2-priority',
  
  // O-Series
  [ModelEnum.O1]: 'o1',
  [ModelEnum.O1_MINI]: 'o1-mini',
  [ModelEnum.O1_PREVIEW]: 'o1-preview',
  [ModelEnum.O3]: 'o3',
  [ModelEnum.O3_MINI]: 'o3-mini',
  [ModelEnum.O3_LOW]: 'o3-low',
  [ModelEnum.O3_HIGH]: 'o3-high',
  [ModelEnum.O3_PRO]: 'o3-pro',
  [ModelEnum.O3_PRO_LOW]: 'o3-pro-low',
  [ModelEnum.O3_PRO_HIGH]: 'o3-pro-high',
  [ModelEnum.O4_MINI]: 'o4-mini',
  [ModelEnum.O4_MINI_LOW]: 'o4-mini-low',
  [ModelEnum.O4_MINI_HIGH]: 'o4-mini-high',
  
  // Gemini
  [ModelEnum.GEMINI_1_0_PRO]: 'gemini-1.0-pro',
  [ModelEnum.GEMINI_1_5_PRO]: 'gemini-1.5-pro',
  [ModelEnum.GEMINI_2_0_FLASH]: 'gemini-2.0-flash',
  [ModelEnum.GEMINI_2_5_PRO]: 'gemini-2.5-pro',
  [ModelEnum.GEMINI_2_5_FLASH]: 'gemini-2.5-flash',
  [ModelEnum.GEMINI_2_5_FLASH_THINKING]: 'gemini-2.5-flash-thinking',
  [ModelEnum.GEMINI_2_5_FLASH_LITE]: 'gemini-2.5-flash-lite',
  [ModelEnum.GEMINI_3_0_PRO_LOW]: 'gemini-3.0-pro-low',
  [ModelEnum.GEMINI_3_0_PRO_HIGH]: 'gemini-3.0-pro-high',
  [ModelEnum.GEMINI_3_0_PRO_MEDIUM]: 'gemini-3.0-pro',
  [ModelEnum.GEMINI_3_0_FLASH_MEDIUM]: 'gemini-3.0-flash',
  [ModelEnum.GEMINI_3_0_FLASH_HIGH]: 'gemini-3.0-flash-high',
  
  // DeepSeek
  [ModelEnum.DEEPSEEK_V3]: 'deepseek-v3',
  [ModelEnum.DEEPSEEK_V3_2]: 'deepseek-v3-2',
  [ModelEnum.DEEPSEEK_R1]: 'deepseek-r1',
  [ModelEnum.DEEPSEEK_R1_FAST]: 'deepseek-r1-fast',
  [ModelEnum.DEEPSEEK_R1_SLOW]: 'deepseek-r1-slow',
  
  // Llama
  [ModelEnum.LLAMA_3_1_8B_INSTRUCT]: 'llama-3.1-8b',
  [ModelEnum.LLAMA_3_1_70B_INSTRUCT]: 'llama-3.1-70b',
  [ModelEnum.LLAMA_3_1_405B_INSTRUCT]: 'llama-3.1-405b',
  [ModelEnum.LLAMA_3_3_70B_INSTRUCT]: 'llama-3.3-70b',
  [ModelEnum.LLAMA_3_3_70B_INSTRUCT_R1]: 'llama-3.3-70b-r1',
  
  // Qwen
  [ModelEnum.QWEN_2_5_7B_INSTRUCT]: 'qwen-2.5-7b',
  [ModelEnum.QWEN_2_5_32B_INSTRUCT]: 'qwen-2.5-32b',
  [ModelEnum.QWEN_2_5_72B_INSTRUCT]: 'qwen-2.5-72b',
  [ModelEnum.QWEN_3_235B_INSTRUCT]: 'qwen-3-235b',
  [ModelEnum.QWEN_3_CODER_480B_INSTRUCT]: 'qwen-3-coder-480b',
  [ModelEnum.QWEN_3_CODER_480B_INSTRUCT_FAST]: 'qwen-3-coder-480b-fast',
  
  // Grok
  [ModelEnum.GROK_2]: 'grok-2',
  [ModelEnum.GROK_3]: 'grok-3',
  [ModelEnum.GROK_3_MINI_REASONING]: 'grok-3-mini',
  [ModelEnum.GROK_CODE_FAST]: 'grok-code-fast',
  
  // Other
  [ModelEnum.MISTRAL_7B]: 'mistral-7b',
  [ModelEnum.KIMI_K2]: 'kimi-k2',
  [ModelEnum.KIMI_K2_THINKING]: 'kimi-k2-thinking',
  [ModelEnum.GLM_4_5]: 'glm-4.5',
  [ModelEnum.GLM_4_6]: 'glm-4.6',
  [ModelEnum.GLM_4_7]: 'glm-4.7',
  [ModelEnum.MINIMAX_M2]: 'minimax-m2',
  [ModelEnum.MINIMAX_M2_1]: 'minimax-m2.1',
  [ModelEnum.SWE_1_5]: 'swe-1.5',
  [ModelEnum.SWE_1_5_THINKING]: 'swe-1.5-thinking',
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Convert a model name string to its protobuf enum value
 * @param modelName - Model name (e.g., "claude-4-sonnet", "gpt-4o")
 * @returns The corresponding enum value, defaults to CLAUDE_3_5_SONNET if unknown
 */
export function modelNameToEnum(modelName: string): ModelEnumValue {
  const normalized = modelName.toLowerCase().trim();
  return MODEL_NAME_TO_ENUM[normalized] ?? ModelEnum.CLAUDE_3_5_SONNET_20241022;
}

/**
 * Convert a protobuf enum value to a canonical model name
 * @param enumValue - The enum value
 * @returns The canonical model name string
 */
export function enumToModelName(enumValue: ModelEnumValue): string {
  return ENUM_TO_MODEL_NAME[enumValue] ?? 'claude-3.5-sonnet';
}

/**
 * Get all supported model names
 * @returns Array of all supported model name strings
 */
export function getSupportedModels(): string[] {
  return Object.keys(MODEL_NAME_TO_ENUM);
}

/**
 * Check if a model name is supported
 * @param modelName - Model name to check
 * @returns True if the model is supported
 */
export function isModelSupported(modelName: string): boolean {
  return modelName.toLowerCase().trim() in MODEL_NAME_TO_ENUM;
}

/**
 * Get the default model name
 * @returns The default model name
 */
export function getDefaultModel(): string {
  return 'claude-3.5-sonnet';
}

/**
 * Get the default model enum value
 * @returns The default model enum value
 */
export function getDefaultModelEnum(): ModelEnumValue {
  return ModelEnum.CLAUDE_3_5_SONNET_20241022;
}

/**
 * Get canonical model names (one per enum value, no aliases)
 * @returns Array of canonical model names
 */
export function getCanonicalModels(): string[] {
  return Object.values(ENUM_TO_MODEL_NAME).filter((v): v is string => v !== undefined);
}

/**
 * Model Discovery - Auto-pull models from Windsurf
 * 
 * Fetches live model configs from Windsurf via GetUserStatus and transforms
 * them into OpenCode-compatible format with names, context limits, and variants.
 */

import { getUserStatus, type ModelConfig as WindsurfModelConfig } from './cascade-client.js';
import { getCredentials } from './auth.js';

// ============================================================================
// Types
// ============================================================================

export interface OpenCodeModel {
  id: string;
  name: string;
  limit: {
    context: number;
    output: number;
  };
  variants?: Record<string, {}>;
}

// Extend Windsurf's ModelConfig with variantName for internal use
interface ModelConfig extends WindsurfModelConfig {
  variantName?: string;
}

// ============================================================================
// Context Limit Defaults
// ============================================================================

// Default context limits by model family (when not provided by Windsurf)

// If for some reason these fail please open a issue - Openlyst
const DEFAULT_CONTEXT_LIMITS: Record<string, { context: number; output: number }> = {
  // Claude models
  'claude-opus-4': { context: 1000000, output: 128000 },
  'claude-opus-4.6': { context: 1000000, output: 128000 },
  'claude-opus-4.7': { context: 1000000, output: 128000 },
  'claude-sonnet-4': { context: 200000, output: 64000 },
  'claude-sonnet-4.6': { context: 200000, output: 64000 },
  'claude-4.5': { context: 200000, output: 64000 },
  'claude-4': { context: 200000, output: 32000 },
  'claude-3.7': { context: 200000, output: 64000 },
  'claude-3.5': { context: 200000, output: 8192 },
  'claude-3': { context: 200000, output: 4096 },
  
  // GPT models
  'gpt-5': { context: 400000, output: 128000 },
  'gpt-5.5': { context: 1050000, output: 128000 },
  'gpt-5.4': { context: 1050000, output: 128000 },
  'gpt-5.3': { context: 400000, output: 128000 },
  'gpt-5.2': { context: 400000, output: 128000 },
  'gpt-5.1': { context: 400000, output: 128000 },
  'gpt-4.1': { context: 1047576, output: 32768 },
  'gpt-4o': { context: 128000, output: 16384 },
  'gpt-4': { context: 128000, output: 8192 },
  
  // O-series
  'o3': { context: 200000, output: 100000 },
  'o3-pro': { context: 200000, output: 100000 },
  'o4-mini': { context: 200000, output: 100000 },
  
  // Gemini
  'gemini-3': { context: 1048576, output: 65536 },
  'gemini-2.5': { context: 1048576, output: 65536 },
  'gemini-2': { context: 1048576, output: 8192 },
  
  // DeepSeek
  'deepseek-v4': { context: 1000000, output: 384000 },
  'deepseek-v3': { context: 163840, output: 16384 },
  'deepseek-r1': { context: 163840, output: 163840 },
  
  // SWE
  'swe-1.6': { context: 200000, output: 8192 },
  'swe-1.5': { context: 200000, output: 8192 },
  
  // Others
  'llama-3': { context: 131072, output: 16384 },
  'qwen-3': { context: 262144, output: 65536 },
  'qwen-2.5': { context: 32768, output: 32768 },
  'grok': { context: 131072, output: 8192 },
  'glm-5': { context: 204800, output: 131072 },
  'glm-4': { context: 204800, output: 131072 },
  'minimax': { context: 204800, output: 131072 },
  'kimi': { context: 262144, output: 65536 },
};

// Default fallback for unknown models
const DEFAULT_LIMITS = { context: 200000, output: 8192 };

// ============================================================================
// Caching
// ============================================================================

let cachedModels: OpenCodeModel[] | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// Model ID Transformation
// ============================================================================

/**
 * Convert Windsurf model_uid to canonical OpenCode model ID.
 * 
 * Examples:
 * - "claude-opus-4-7-medium" -> "claude-opus-4.7"
 * - "swe-1-6" -> "swe-1.6"
 * - "MODEL_CLAUDE_4_5_OPUS" -> "claude-4.5-opus"
 */
function modelUidToId(modelUid: string): string {
  // Handle legacy enum-style UIDs
  if (modelUid.startsWith('MODEL_')) {
    const name = modelUid.slice(7); // Remove "MODEL_"
    return name
      .toLowerCase()
      .replace(/_/g, '-');
  }
  
  // Known variant suffixes to stop at
  const variantSuffixes = [
    'fast', 'thinking', 'low', 'medium', 'high', 'xhigh', 'max',
    'minimal', 'lite', 'priority', 'codex', 'pro', 'flash', 'mini'
  ];
  
  // Find where the variant starts
  const parts = modelUid.split('-');
  let versionEnd = parts.length;
  
  for (let i = 0; i < parts.length; i++) {
    if (variantSuffixes.includes(parts[i])) {
      versionEnd = i;
      break;
    }
  }
  
  // Only convert version numbers in the base part
  const basePart = parts.slice(0, versionEnd).join('-');
  const converted = basePart
    .replace(/(\d)-(\d)/g, '$1.$2')  // 4-7 -> 4.7
    .replace(/(\d)-(\d)/g, '$1.$2');  // Apply twice for cases like 1-6-5
  
  return converted;
}

/**
 * Extract base model family from model ID for context limit lookup.
 * 
 * Examples:
 * - "claude-opus-4.7" -> "claude-opus-4"
 * - "gpt-5.4" -> "gpt-5"
 * - "swe-1.6" -> "swe-1"
 */
function getModelFamily(modelId: string): string {
  // Extract the base name before version numbers
  const match = modelId.match(/^([a-z-]+-\d+\.?\d*)/);
  if (match) {
    const base = match[1];
    // For versioned models, return the family (e.g., gpt-5.4 -> gpt-5)
    const familyMatch = base.match(/^([a-z-]+-\d+)\.?/);
    if (familyMatch) {
      return familyMatch[1];
    }
    return base;
  }
  
  // Fallback: return first two segments
  const parts = modelId.split('-');
  if (parts.length >= 2) {
    return `${parts[0]}-${parts[1]}`;
  }
  
  return modelId;
}

/**
 * Get context limits for a model based on its family.
 */
function getContextLimits(modelId: string): { context: number; output: number } {
  const family = getModelFamily(modelId);
  
  // Try exact family match first
  if (DEFAULT_CONTEXT_LIMITS[family]) {
    return DEFAULT_CONTEXT_LIMITS[family];
  }
  
  // Try prefix match
  for (const [key, limits] of Object.entries(DEFAULT_CONTEXT_LIMITS)) {
    if (modelId.startsWith(key)) {
      return limits;
    }
  }
  
  return DEFAULT_LIMITS;
}

/**
 * Generate a smart name from the model label.
 * 
 * Examples:
 * - "Claude Opus 4.7 Medium" -> "Claude Opus 4.7 Medium (Windsurf)"
 * - "SWE 1.6" -> "SWE 1.6 (Windsurf)"
 */
function generateSmartName(label: string): string {
  return `${label} (Windsurf)`;
}

/**
 * Extract variant name from model_uid by comparing it to the base pattern.
 * 
 * Parses variant indicators from the model_uid string.
 * Examples:
 * - "claude-opus-4-7-medium" -> "medium"
 * - "claude-opus-4-7-medium-fast" -> "medium-fast"
 * - "swe-1-6-fast" -> "fast"
 * - "gpt-5-5-low" -> "low"
 */
function extractVariantName(modelUid: string, modelId: string): string | undefined {
  // Convert modelId back to uid format to find the base pattern
  // e.g., "claude-opus-4.7" -> "claude-opus-4-7"
  const basePattern = modelId.replace(/\./g, '-');
  
  // If model_uid starts with basePattern, the rest is the variant
  if (modelUid.startsWith(basePattern) && modelUid !== basePattern) {
    const variant = modelUid.slice(basePattern.length);
    // Remove leading dash if present
    return variant.startsWith('-') ? variant.slice(1) : variant;
  }
  
  return undefined;
}

/**
 * Group models by their base model ID and collect variants dynamically.
 * 
 * This function takes all discovered models and groups them by their canonical ID,
 * collecting all variant names from the model_uid strings.
 */
function groupModelsByBase(models: ModelConfig[]): Map<string, ModelConfig[]> {
  const groups = new Map<string, ModelConfig[]>();
  
  for (const model of models) {
    const modelId = modelUidToId(model.modelUid);
    const variantName = extractVariantName(model.modelUid, modelId);
    
    // Store the variant name in the model config for later use
    if (variantName) {
      model.variantName = variantName;
    }
    
    if (!groups.has(modelId)) {
      groups.set(modelId, []);
    }
    groups.get(modelId)!.push(model);
  }
  
  return groups;
}

/**
 * Extract variants for a model by looking at all models with the same base ID.
 * 
 * This is fully dynamic - it doesn't rely on the hardcoded VARIANT_CATALOG.
 */
function extractVariants(modelId: string, allModels: ModelConfig[]): Record<string, {}> | undefined {
  const groups = groupModelsByBase(allModels);
  const group = groups.get(modelId);
  
  if (!group || group.length <= 1) {
    // No variants found (only one model with this base ID)
    return undefined;
  }
  
  // Collect all variant names from the group
  const variants: Record<string, {}> = {};
  
  for (const model of group) {
    const variantName = model.variantName;
    if (variantName) {
      variants[variantName] = {};
    }
  }
  
  // If we have at least one variant, return them
  if (Object.keys(variants).length > 0) {
    return variants;
  }
  
  return undefined;
}

// ============================================================================
// Main Discovery Function
// ============================================================================

/**
 * Fetch and transform live models from Windsurf into OpenCode format.
 * 
 * This calls GetUserStatus to get the current model list, then transforms
 * each entry into the OpenCode config format with:
 * - id: canonical model identifier
 * - name: human-readable display name
 * - limit: context and output token limits
 * - variants: available model variants (if any)
 * 
 * Results are cached for 5 minutes to avoid repeated RPC calls.
 */
export async function discoverModels(): Promise<OpenCodeModel[]> {
  const now = Date.now();
  
  // Return cached results if still valid
  if (cachedModels && (now - cacheTime) < CACHE_TTL_MS) {
    return cachedModels;
  }
  
  try {
    const creds = getCredentials();
    const configs = await getUserStatus(creds);
    
    // Transform configs into OpenCode format
    const models: OpenCodeModel[] = [];
    const seenIds = new Set<string>();
    
    for (const config of configs) {
      const modelId = modelUidToId(config.modelUid);
      
      // Skip duplicates (keep first occurrence)
      if (seenIds.has(modelId)) {
        continue;
      }
      seenIds.add(modelId);
      
      // Use context limit from Windsurf if available, otherwise use defaults
      const contextLimit = config.contextLimit || getContextLimits(modelId).context;
      const outputLimit = config.outputLimit || getContextLimits(modelId).output;
      const variants = extractVariants(modelId, configs);
      
      models.push({
        id: modelId,
        name: generateSmartName(config.label || modelId),
        limit: {
          context: contextLimit,
          output: outputLimit,
        },
        ...(variants && { variants }),
      });
    }
    
    // Sort by ID for consistent ordering
    models.sort((a, b) => a.id.localeCompare(b.id));
    
    // Cache the results
    cachedModels = models;
    cacheTime = now;
    
    return models;
  } catch (error) {
    // If discovery fails, fall back to empty list
    // (The static catalog in models.ts will still work for chat)
    return [];
  }
}

/**
 * Clear the model discovery cache.
 * 
 * Call this after Windsurf restarts or when you need fresh data.
 */
export function clearModelCache(): void {
  cachedModels = null;
  cacheTime = 0;
}

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

/**
 * Reverse lookup: enum number → "MODEL_<NAME>" string.
 *
 * The Cascade flow's CascadePlannerConfig.requested_model_uid expects the
 * proto3 enum name (e.g. "MODEL_CLAUDE_4_5_OPUS"), not the integer value, so
 * we derive it from the `ModelEnum` keys we already maintain.
 */
const ENUM_VALUE_TO_NAME: Map<number, string> = (() => {
  const map = new Map<number, string>();
  for (const [key, value] of Object.entries(ModelEnum)) {
    if (typeof value === 'number') {
      map.set(value, `MODEL_${key}`);
    }
  }
  return map;
})();

export function enumNameForValue(value: ModelEnumValue): string {
  return ENUM_VALUE_TO_NAME.get(value as number) ?? 'MODEL_UNSPECIFIED';
}

// ==========================================================================
// Variant-aware catalog
// ==========================================================================

type VariantName = string;

/**
 * A Windsurf model is identified server-side by its `model_uid` string. Two
 * coexisting formats:
 *   - Legacy proto-enum models: uid is the enum-name string, e.g.
 *     `"MODEL_CLAUDE_4_5_OPUS"`. We can also derive this from the numeric
 *     `enumValue` via `MODEL_${key}`.
 *   - New string-UID models (claude-opus-4-7-*, gemini-3-5-flash-*, …):
 *     server returns them with proto-enum `0`. The uid IS the identifier and
 *     there's no enum number to fall back to.
 *
 * VariantMeta lets either path supply a uid; the legacy `enumValue` is kept
 * optional for callers that still want the integer.
 */
type VariantMeta = {
  /** Human-oriented hint used in /v1/models variants payload */
  description?: string;
  /**
   * Server `model_uid` string (sent in `CascadePlannerConfig.requested_model_uid`).
   * If omitted but `enumValue` is set, the resolver derives it as `MODEL_${key}`.
   */
  modelUid?: string;
  /** Optional proto enum value — used for legacy callers and debugging. */
  enumValue?: ModelEnumValue;
};

type ModelCatalogEntry = {
  /** Canonical model id exposed to OpenCode (e.g. "claude-opus-4.7") */
  id: string;
  /** Default proto enum when no variant supplied (legacy path) */
  defaultEnum?: ModelEnumValue;
  /** Default server uid when no variant supplied (new path) */
  defaultUid?: string;
  /** Optional variants keyed by variant name (lowercase) */
  variants?: Record<VariantName, VariantMeta>;
  /** Aliases accepted for backwards compatibility */
  aliases?: string[];
};

// ==========================================================================
// Variant Catalog
// ==========================================================================

const VARIANT_CATALOG: Record<string, ModelCatalogEntry> = {
  // Claude thinking variants
  'claude-3.7-sonnet': {
    id: 'claude-3.7-sonnet',
    defaultEnum: ModelEnum.CLAUDE_3_7_SONNET_20250219,
    variants: {
      thinking: { enumValue: ModelEnum.CLAUDE_3_7_SONNET_20250219_THINKING, description: 'Thinking mode' },
    },
  },
  'claude-4.5-sonnet': {
    id: 'claude-4.5-sonnet',
    defaultEnum: ModelEnum.CLAUDE_4_5_SONNET,
    variants: {
      thinking: { enumValue: ModelEnum.CLAUDE_4_5_SONNET_THINKING, description: 'Thinking mode' },
    },
  },
  'claude-4.5-opus': {
    id: 'claude-4.5-opus',
    defaultEnum: ModelEnum.CLAUDE_4_5_OPUS,
    variants: {
      thinking: { enumValue: ModelEnum.CLAUDE_4_5_OPUS_THINKING, description: 'Thinking mode' },
    },
  },
  'claude-4.1-opus': {
    id: 'claude-4.1-opus',
    defaultEnum: ModelEnum.CLAUDE_4_1_OPUS,
    variants: {
      thinking: { enumValue: ModelEnum.CLAUDE_4_1_OPUS_THINKING, description: 'Thinking mode' },
    },
    aliases: ['claude-4-1-opus'],
  },
  'claude-4-opus': {
    id: 'claude-4-opus',
    defaultEnum: ModelEnum.CLAUDE_4_OPUS,
    variants: {
      thinking: { enumValue: ModelEnum.CLAUDE_4_OPUS_THINKING, description: 'Thinking mode' },
    },
  },
  'claude-4-sonnet': {
    id: 'claude-4-sonnet',
    defaultEnum: ModelEnum.CLAUDE_4_SONNET,
    variants: {
      thinking: { enumValue: ModelEnum.CLAUDE_4_SONNET_THINKING, description: 'Thinking mode' },
    },
  },

  // Google Gemini 2.5 / 3.0
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    defaultEnum: ModelEnum.GEMINI_2_5_FLASH,
    variants: {
      thinking: { enumValue: ModelEnum.GEMINI_2_5_FLASH_THINKING, description: 'Thinking budget enabled' },
      lite: { enumValue: ModelEnum.GEMINI_2_5_FLASH_LITE, description: 'Lite / lower cost' },
    },
    aliases: ['gemini-2-5-flash'],
  },
  // Google Gemini 3.0 Pro
  'gemini-3.0-pro': {
    id: 'gemini-3.0-pro',
    defaultEnum: ModelEnum.GEMINI_3_0_PRO_MEDIUM,
    variants: {
      minimal: { enumValue: ModelEnum.GEMINI_3_0_PRO_MINIMAL, description: 'Cheaper, least reasoning' },
      low: { enumValue: ModelEnum.GEMINI_3_0_PRO_LOW, description: 'Lower cost / speed' },
      medium: { enumValue: ModelEnum.GEMINI_3_0_PRO_MEDIUM, description: 'Balanced (default)' },
      high: { enumValue: ModelEnum.GEMINI_3_0_PRO_HIGH, description: 'Higher reasoning budget' },
    },
    aliases: ['gemini-3-0-pro'],
  },
  // Google Gemini 3.0 Flash
  'gemini-3.0-flash': {
    id: 'gemini-3.0-flash',
    defaultEnum: ModelEnum.GEMINI_3_0_FLASH_MEDIUM,
    variants: {
      minimal: { enumValue: ModelEnum.GEMINI_3_0_FLASH_MINIMAL, description: 'Cheapest, lowest latency' },
      low: { enumValue: ModelEnum.GEMINI_3_0_FLASH_LOW, description: 'Low thinking budget' },
      medium: { enumValue: ModelEnum.GEMINI_3_0_FLASH_MEDIUM, description: 'Balanced (default)' },
      high: { enumValue: ModelEnum.GEMINI_3_0_FLASH_HIGH, description: 'Higher reasoning budget' },
    },
    aliases: ['gemini-3-0-flash'],
  },
  // GPT 5.2
  'gpt-5.2': {
    id: 'gpt-5.2',
    defaultEnum: ModelEnum.GPT_5_2_MEDIUM,
    variants: {
      low: { enumValue: ModelEnum.GPT_5_2_LOW, description: 'Lower cost' },
      medium: { enumValue: ModelEnum.GPT_5_2_MEDIUM, description: 'Balanced (default)' },
      high: { enumValue: ModelEnum.GPT_5_2_HIGH, description: 'Higher capability' },
      xhigh: { enumValue: ModelEnum.GPT_5_2_XHIGH, description: 'Maximum capability' },
      priority: { enumValue: ModelEnum.GPT_5_2_MEDIUM_PRIORITY, description: 'Priority routing (medium)' },
      'low-priority': { enumValue: ModelEnum.GPT_5_2_LOW_PRIORITY, description: 'Priority routing (low)' },
      'high-priority': { enumValue: ModelEnum.GPT_5_2_HIGH_PRIORITY, description: 'Priority routing (high)' },
      'xhigh-priority': { enumValue: ModelEnum.GPT_5_2_XHIGH_PRIORITY, description: 'Priority routing (xhigh)' },
    },
    aliases: ['gpt-5-2'],
  },
  // GPT 5.2 Codex
  'gpt-5.2-codex': {
    id: 'gpt-5.2-codex',
    defaultEnum: ModelEnum.GPT_5_2_CODEX_MEDIUM,
    variants: {
      low: { enumValue: ModelEnum.GPT_5_2_CODEX_LOW, description: 'Lower cost' },
      medium: { enumValue: ModelEnum.GPT_5_2_CODEX_MEDIUM, description: 'Balanced (default)' },
      high: { enumValue: ModelEnum.GPT_5_2_CODEX_HIGH, description: 'Higher capability' },
      xhigh: { enumValue: ModelEnum.GPT_5_2_CODEX_XHIGH, description: 'Maximum capability' },
      'low-priority': { enumValue: ModelEnum.GPT_5_2_CODEX_LOW_PRIORITY, description: 'Priority routing (low)' },
      'medium-priority': { enumValue: ModelEnum.GPT_5_2_CODEX_MEDIUM_PRIORITY, description: 'Priority routing (medium)' },
      'high-priority': { enumValue: ModelEnum.GPT_5_2_CODEX_HIGH_PRIORITY, description: 'Priority routing (high)' },
      'xhigh-priority': { enumValue: ModelEnum.GPT_5_2_CODEX_XHIGH_PRIORITY, description: 'Priority routing (xhigh)' },
    },
    aliases: ['gpt-5-2-codex'],
  },
  // SWE-1.6 — both proto enum and string-uid metadata, but the string UID is
  // what we actually send (uidForEntry prefers defaultUid). The enumValue is
  // kept for callers of `modelNameToEnum()` who still want the integer; the
  // server itself only sees `swe-1-6` / `swe-1-6-fast`.
  'swe-1.6': {
    id: 'swe-1.6',
    defaultEnum: ModelEnum.SWE_1_6,
    defaultUid: 'swe-1-6',
    variants: {
      fast: { enumValue: ModelEnum.SWE_1_6_FAST, modelUid: 'swe-1-6-fast', description: 'Faster variant' },
    },
    aliases: ['swe-1-6'],
  },

  // ============================================================================
  // String-UID models (Cognition-era).
  //
  // These have NO proto enum entry — `model_or_alias.model = 0` in the server
  // response. The identifier IS the `model_uid` string. To enumerate the live
  // set on any given account, call GetUserStatus and walk
  //   user_status.cascade_model_config_data.client_model_configs[]
  // See docs/CASCADE_PROTOCOL.md §3 for the protocol details.
  // ============================================================================

  // Claude Opus 4.7 — 5 reasoning intensities × {default, -fast (priority)}
  'claude-opus-4.7': {
    id: 'claude-opus-4.7',
    defaultUid: 'claude-opus-4-7-medium',
    variants: {
      low: { modelUid: 'claude-opus-4-7-low', description: 'Lowest reasoning budget' },
      medium: { modelUid: 'claude-opus-4-7-medium', description: 'Balanced (default)' },
      high: { modelUid: 'claude-opus-4-7-high', description: 'Higher reasoning' },
      xhigh: { modelUid: 'claude-opus-4-7-xhigh', description: 'Even higher reasoning' },
      max: { modelUid: 'claude-opus-4-7-max', description: 'Maximum reasoning' },
      'low-fast': { modelUid: 'claude-opus-4-7-low-fast', description: 'Priority/fast tier' },
      'medium-fast': { modelUid: 'claude-opus-4-7-medium-fast', description: 'Priority/fast tier' },
      'high-fast': { modelUid: 'claude-opus-4-7-high-fast', description: 'Priority/fast tier' },
      'xhigh-fast': { modelUid: 'claude-opus-4-7-xhigh-fast', description: 'Priority/fast tier' },
      'max-fast': { modelUid: 'claude-opus-4-7-max-fast', description: 'Priority/fast tier' },
    },
    aliases: ['claude-opus-4-7', 'opus-4.7', 'opus-4-7'],
  },

  // Claude Opus 4.6 — base + thinking + 1M context + fast variants
  'claude-opus-4.6': {
    id: 'claude-opus-4.6',
    defaultUid: 'claude-opus-4-6',
    variants: {
      thinking: { modelUid: 'claude-opus-4-6-thinking', description: 'Extended thinking' },
      '1m': { modelUid: 'claude-opus-4-6-1m', description: '1M context window' },
      'thinking-1m': { modelUid: 'claude-opus-4-6-thinking-1m', description: 'Thinking + 1M context' },
      fast: { modelUid: 'claude-opus-4-6-fast', description: 'Priority/fast tier' },
      'thinking-fast': { modelUid: 'claude-opus-4-6-thinking-fast', description: 'Thinking, priority tier' },
    },
    aliases: ['claude-opus-4-6'],
  },

  // Claude Sonnet 4.6
  'claude-sonnet-4.6': {
    id: 'claude-sonnet-4.6',
    defaultUid: 'claude-sonnet-4-6',
    variants: {
      thinking: { modelUid: 'claude-sonnet-4-6-thinking', description: 'Extended thinking' },
      '1m': { modelUid: 'claude-sonnet-4-6-1m', description: '1M context window' },
      'thinking-1m': { modelUid: 'claude-sonnet-4-6-thinking-1m', description: 'Thinking + 1M context' },
    },
    aliases: ['claude-sonnet-4-6', 'sonnet-4.6'],
  },

  // Gemini 3.5 Flash — 4 reasoning budgets
  'gemini-3.5-flash': {
    id: 'gemini-3.5-flash',
    defaultUid: 'gemini-3-5-flash-medium',
    variants: {
      minimal: { modelUid: 'gemini-3-5-flash-minimal', description: 'Cheapest, lowest reasoning' },
      low: { modelUid: 'gemini-3-5-flash-low', description: 'Low reasoning' },
      medium: { modelUid: 'gemini-3-5-flash-medium', description: 'Balanced (default)' },
      high: { modelUid: 'gemini-3-5-flash-high', description: 'High reasoning' },
    },
    aliases: ['gemini-3-5-flash'],
  },

  // Gemini 3.1 Pro
  'gemini-3.1-pro': {
    id: 'gemini-3.1-pro',
    defaultUid: 'gemini-3-1-pro-low',
    variants: {
      low: { modelUid: 'gemini-3-1-pro-low', description: 'Lower reasoning (default)' },
      high: { modelUid: 'gemini-3-1-pro-high', description: 'Higher reasoning' },
    },
    aliases: ['gemini-3-1-pro'],
  },

  // GPT-5.4 — 5 reasoning intensities × {default, -priority}
  'gpt-5.4': {
    id: 'gpt-5.4',
    defaultUid: 'gpt-5-4-medium',
    variants: {
      none: { modelUid: 'gpt-5-4-none', description: 'No reasoning' },
      low: { modelUid: 'gpt-5-4-low', description: 'Low reasoning' },
      medium: { modelUid: 'gpt-5-4-medium', description: 'Balanced (default)' },
      high: { modelUid: 'gpt-5-4-high', description: 'High reasoning' },
      xhigh: { modelUid: 'gpt-5-4-xhigh', description: 'Maximum reasoning' },
      'none-priority': { modelUid: 'gpt-5-4-none-priority', description: 'Priority routing' },
      'low-priority': { modelUid: 'gpt-5-4-low-priority', description: 'Priority routing' },
      'medium-priority': { modelUid: 'gpt-5-4-medium-priority', description: 'Priority routing' },
      'high-priority': { modelUid: 'gpt-5-4-high-priority', description: 'Priority routing' },
      'xhigh-priority': { modelUid: 'gpt-5-4-xhigh-priority', description: 'Priority routing' },
    },
    aliases: ['gpt-5-4'],
  },

  // GPT-5.4 Mini
  'gpt-5.4-mini': {
    id: 'gpt-5.4-mini',
    defaultUid: 'gpt-5-4-mini-medium',
    variants: {
      low: { modelUid: 'gpt-5-4-mini-low', description: 'Low reasoning' },
      medium: { modelUid: 'gpt-5-4-mini-medium', description: 'Balanced (default)' },
      high: { modelUid: 'gpt-5-4-mini-high', description: 'High reasoning' },
      xhigh: { modelUid: 'gpt-5-4-mini-xhigh', description: 'Maximum reasoning' },
    },
    aliases: ['gpt-5-4-mini'],
  },

  // GPT-5.5
  'gpt-5.5': {
    id: 'gpt-5.5',
    defaultUid: 'gpt-5-5-medium',
    variants: {
      none: { modelUid: 'gpt-5-5-none', description: 'No reasoning' },
      low: { modelUid: 'gpt-5-5-low', description: 'Low reasoning' },
      medium: { modelUid: 'gpt-5-5-medium', description: 'Balanced (default)' },
      high: { modelUid: 'gpt-5-5-high', description: 'High reasoning' },
      xhigh: { modelUid: 'gpt-5-5-xhigh', description: 'Maximum reasoning' },
      'none-priority': { modelUid: 'gpt-5-5-none-priority', description: 'Priority routing' },
      'low-priority': { modelUid: 'gpt-5-5-low-priority', description: 'Priority routing' },
      'medium-priority': { modelUid: 'gpt-5-5-medium-priority', description: 'Priority routing' },
      'high-priority': { modelUid: 'gpt-5-5-high-priority', description: 'Priority routing' },
      'xhigh-priority': { modelUid: 'gpt-5-5-xhigh-priority', description: 'Priority routing' },
    },
    aliases: ['gpt-5-5'],
  },

  // GPT-5.3 Codex
  'gpt-5.3-codex': {
    id: 'gpt-5.3-codex',
    defaultUid: 'gpt-5-3-codex-medium',
    variants: {
      low: { modelUid: 'gpt-5-3-codex-low', description: 'Low reasoning' },
      medium: { modelUid: 'gpt-5-3-codex-medium', description: 'Balanced (default)' },
      high: { modelUid: 'gpt-5-3-codex-high', description: 'High reasoning' },
      xhigh: { modelUid: 'gpt-5-3-codex-xhigh', description: 'Maximum reasoning' },
      'low-priority': { modelUid: 'gpt-5-3-codex-low-priority', description: 'Priority routing' },
      'medium-priority': { modelUid: 'gpt-5-3-codex-medium-priority', description: 'Priority routing' },
      'high-priority': { modelUid: 'gpt-5-3-codex-high-priority', description: 'Priority routing' },
      'xhigh-priority': { modelUid: 'gpt-5-3-codex-xhigh-priority', description: 'Priority routing' },
    },
    aliases: ['gpt-5-3-codex'],
  },

  // Single-variant new models
  'kimi-k2.5': {
    id: 'kimi-k2.5',
    defaultUid: 'kimi-k2-5',
    aliases: ['kimi-k2-5'],
  },
  'kimi-k2.6': {
    id: 'kimi-k2.6',
    defaultUid: 'kimi-k2-6',
    aliases: ['kimi-k2-6'],
  },
  'deepseek-v4': {
    id: 'deepseek-v4',
    defaultUid: 'deepseek-v4',
  },
  'glm-5.1': {
    id: 'glm-5.1',
    defaultUid: 'glm-5-1',
    aliases: ['glm-5-1'],
  },
  'minimax-m2.5': {
    id: 'minimax-m2.5',
    defaultUid: 'minimax-m2-5',
    aliases: ['minimax-m2-5'],
  },
  // GPT 5
  'gpt-5': {
    id: 'gpt-5',
    defaultEnum: ModelEnum.GPT_5,
    variants: {
      low: { enumValue: ModelEnum.GPT_5_LOW, description: 'Lower cost' },
      high: { enumValue: ModelEnum.GPT_5_HIGH, description: 'Higher capability' },
      nano: { enumValue: ModelEnum.GPT_5_NANO, description: 'Small footprint' },
    },
  },
  // GPT 5.1 Codex families
  'gpt-5.1-codex-mini': {
    id: 'gpt-5.1-codex-mini',
    defaultEnum: ModelEnum.GPT_5_1_CODEX_MINI_MEDIUM,
    variants: {
      low: { enumValue: ModelEnum.GPT_5_1_CODEX_MINI_LOW },
      medium: { enumValue: ModelEnum.GPT_5_1_CODEX_MINI_MEDIUM },
      high: { enumValue: ModelEnum.GPT_5_1_CODEX_MINI_HIGH },
    },
    aliases: ['gpt-5-1-codex-mini'],
  },
  'gpt-5.1-codex': {
    id: 'gpt-5.1-codex',
    defaultEnum: ModelEnum.GPT_5_1_CODEX_MEDIUM,
    variants: {
      low: { enumValue: ModelEnum.GPT_5_1_CODEX_LOW },
      medium: { enumValue: ModelEnum.GPT_5_1_CODEX_MEDIUM },
      high: { enumValue: ModelEnum.GPT_5_1_CODEX_HIGH },
    },
    aliases: ['gpt-5-1-codex'],
  },
  'gpt-5.1-codex-max': {
    id: 'gpt-5.1-codex-max',
    defaultEnum: ModelEnum.GPT_5_1_CODEX_MAX_MEDIUM,
    variants: {
      low: { enumValue: ModelEnum.GPT_5_1_CODEX_MAX_LOW },
      medium: { enumValue: ModelEnum.GPT_5_1_CODEX_MAX_MEDIUM },
      high: { enumValue: ModelEnum.GPT_5_1_CODEX_MAX_HIGH },
    },
    aliases: ['gpt-5-1-codex-max'],
  },
  // O series
  o3: {
    id: 'o3',
    defaultEnum: ModelEnum.O3,
    variants: {
      low: { enumValue: ModelEnum.O3_LOW },
      high: { enumValue: ModelEnum.O3_HIGH },
    },
  },
  'o3-pro': {
    id: 'o3-pro',
    defaultEnum: ModelEnum.O3_PRO,
    variants: {
      low: { enumValue: ModelEnum.O3_PRO_LOW },
      high: { enumValue: ModelEnum.O3_PRO_HIGH },
    },
  },
  'o4-mini': {
    id: 'o4-mini',
    defaultEnum: ModelEnum.O4_MINI,
    variants: {
      low: { enumValue: ModelEnum.O4_MINI_LOW },
      high: { enumValue: ModelEnum.O4_MINI_HIGH },
    },
  },
};

const VARIANT_NAME_SET = new Set<string>();
for (const entry of Object.values(VARIANT_CATALOG)) {
  if (entry.variants) {
    for (const variantKey of Object.keys(entry.variants)) {
      VARIANT_NAME_SET.add(`${entry.id}-${variantKey}`);
      if (entry.aliases) {
        for (const alias of entry.aliases) {
          VARIANT_NAME_SET.add(`${alias}-${variantKey}`);
        }
      }
    }
  }
}

// Mapping of alias -> canonical id for quick lookup
const ALIAS_TO_ID: Record<string, string> = Object.values(VARIANT_CATALOG).reduce(
  (acc, entry) => {
    acc[entry.id] = entry.id;
    for (const alias of entry.aliases || []) {
      acc[alias] = entry.id;
    }
    return acc;
  },
  {} as Record<string, string>
);

function normalizeModelId(modelName: string): string {
  return modelName.toLowerCase().trim();
}

function splitModelAndVariant(raw: string): { base: string; variant?: string } {
  const normalized = normalizeModelId(raw);
  // Colon-delimited form is unambiguous: `claude-opus-4.7:low-fast` always
  // means base=claude-opus-4.7, variant=low-fast.
  const colonIdx = normalized.indexOf(':');
  if (colonIdx !== -1) {
    const base = normalized.slice(0, colonIdx);
    const variant = normalized.slice(colonIdx + 1).trim();
    return { base, variant: variant || undefined };
  }

  // Hyphen-suffix form: `claude-opus-4.7-low-fast`. Try progressively shorter
  // suffix variants so multi-segment variant names (e.g. `low-fast`,
  // `thinking-1m`, `medium-priority`) work too. Single-segment peeling alone
  // misses every compound variant we ship.
  const parts = normalized.split('-');
  for (let cut = 1; cut < parts.length; cut++) {
    const base = parts.slice(0, parts.length - cut).join('-');
    const maybeVariant = parts.slice(parts.length - cut).join('-');
    const entry = VARIANT_CATALOG[ALIAS_TO_ID[base] || base];
    if (entry?.variants?.[maybeVariant]) {
      return { base, variant: maybeVariant };
    }
  }

  return { base: normalized };
}

// ============================================================================
// Model Name Mappings (legacy fallback)
//
// SOURCE-OF-TRUTH POLICY:
//   - For models with multiple variants or string UIDs → add to VARIANT_CATALOG
//   - For legacy proto-enum models with no variants → add to this map
//   - resolveModel checks VARIANT_CATALOG first, then this fallback
//
// A module-load sanity check below (`enforceModelTableInvariants`) verifies
// every VARIANT_CATALOG.id resolves through this table too (for callers that
// hit the legacy alias path) — drift gets caught at import time rather than
// silently routing to a wrong model.
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
  // NOTE: claude-4.5-sonnet-1m is defined in enum but not available via API
  
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
  
  // NOTE: gpt-4.5 is defined in enum but not available via API
  
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
  // NOTE: o1, o1-mini, o1-preview are deprecated - use o3/o4 series instead
  // ============================================================================
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
  // NOTE: gemini-1.0-pro and gemini-1.5-pro are deprecated - use 2.x+ versions
  // ============================================================================
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
  'qwen-2.5-32b-r1': ModelEnum.QWEN_2_5_32B_INSTRUCT_R1,
  'qwen-2-5-32b-r1': ModelEnum.QWEN_2_5_32B_INSTRUCT_R1,

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
  'glm-4.5-fast': ModelEnum.GLM_4_5_FAST,
  'glm-4-5-fast': ModelEnum.GLM_4_5_FAST,
  'glm-4.6': ModelEnum.GLM_4_6,
  'glm-4-6': ModelEnum.GLM_4_6,
  'glm-4.6-fast': ModelEnum.GLM_4_6_FAST,
  'glm-4-6-fast': ModelEnum.GLM_4_6_FAST,
  'glm-4.7': ModelEnum.GLM_4_7,
  'glm-4-7': ModelEnum.GLM_4_7,
  'glm-4.7-fast': ModelEnum.GLM_4_7_FAST,
  'glm-4-7-fast': ModelEnum.GLM_4_7_FAST,
  'minimax-m2': ModelEnum.MINIMAX_M2,
  'minimax-m2.1': ModelEnum.MINIMAX_M2_1,
  'minimax-m2-1': ModelEnum.MINIMAX_M2_1,
  'swe-1.5': ModelEnum.SWE_1_5,
  'swe-1-5': ModelEnum.SWE_1_5,
  'swe-1.5-thinking': ModelEnum.SWE_1_5_THINKING,
  'swe-1-5-thinking': ModelEnum.SWE_1_5_THINKING,
  'swe-1.5-slow': ModelEnum.SWE_1_5_SLOW,
  'swe-1-5-slow': ModelEnum.SWE_1_5_SLOW,
  'swe-1.6': ModelEnum.SWE_1_6,
  'swe-1-6': ModelEnum.SWE_1_6,
  'swe-1.6-fast': ModelEnum.SWE_1_6_FAST,
  'swe-1-6-fast': ModelEnum.SWE_1_6_FAST,

  // GPT-OSS
  'gpt-oss-120b': ModelEnum.GPT_OSS_120B,
  'gpt-oss': ModelEnum.GPT_OSS_120B,

  // GPT 5.2 Codex
  'gpt-5.2-codex': ModelEnum.GPT_5_2_CODEX_MEDIUM,
  'gpt-5-2-codex': ModelEnum.GPT_5_2_CODEX_MEDIUM,
  'gpt-5.2-codex-low': ModelEnum.GPT_5_2_CODEX_LOW,
  'gpt-5.2-codex-medium': ModelEnum.GPT_5_2_CODEX_MEDIUM,
  'gpt-5.2-codex-high': ModelEnum.GPT_5_2_CODEX_HIGH,
  'gpt-5.2-codex-xhigh': ModelEnum.GPT_5_2_CODEX_XHIGH,
  'gpt-5.2-codex-low-priority': ModelEnum.GPT_5_2_CODEX_LOW_PRIORITY,
  'gpt-5.2-codex-medium-priority': ModelEnum.GPT_5_2_CODEX_MEDIUM_PRIORITY,
  'gpt-5.2-codex-high-priority': ModelEnum.GPT_5_2_CODEX_HIGH_PRIORITY,
  'gpt-5.2-codex-xhigh-priority': ModelEnum.GPT_5_2_CODEX_XHIGH_PRIORITY,
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
  // NOTE: CLAUDE_4_5_SONNET_1M not available via API
  [ModelEnum.CLAUDE_4_5_OPUS]: 'claude-4.5-opus',
  [ModelEnum.CLAUDE_4_5_OPUS_THINKING]: 'claude-4.5-opus-thinking',
  [ModelEnum.CLAUDE_CODE]: 'claude-code',
  
  // GPT
  [ModelEnum.GPT_4]: 'gpt-4',
  [ModelEnum.GPT_4_1106_PREVIEW]: 'gpt-4-turbo',
  [ModelEnum.GPT_4O_2024_08_06]: 'gpt-4o',
  [ModelEnum.GPT_4O_MINI_2024_07_18]: 'gpt-4o-mini',
  // NOTE: GPT_4_5 not available via API
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
  
  // O-Series (o1 series deprecated - use o3/o4)
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
  
  // Gemini (1.x series deprecated - use 2.x+)
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
  [ModelEnum.QWEN_2_5_32B_INSTRUCT_R1]: 'qwen-2.5-32b-r1',
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
  [ModelEnum.GLM_4_5_FAST]: 'glm-4.5-fast',
  [ModelEnum.GLM_4_6]: 'glm-4.6',
  [ModelEnum.GLM_4_6_FAST]: 'glm-4.6-fast',
  [ModelEnum.GLM_4_7]: 'glm-4.7',
  [ModelEnum.GLM_4_7_FAST]: 'glm-4.7-fast',
  [ModelEnum.MINIMAX_M2]: 'minimax-m2',
  [ModelEnum.MINIMAX_M2_1]: 'minimax-m2.1',
  [ModelEnum.SWE_1_5]: 'swe-1.5',
  [ModelEnum.SWE_1_5_THINKING]: 'swe-1.5-thinking',
  [ModelEnum.SWE_1_5_SLOW]: 'swe-1.5-slow',
  [ModelEnum.SWE_1_6]: 'swe-1.6',
  [ModelEnum.SWE_1_6_FAST]: 'swe-1.6-fast',
  [ModelEnum.GPT_OSS_120B]: 'gpt-oss-120b',
  [ModelEnum.GPT_5_2_CODEX_LOW]: 'gpt-5.2-codex-low',
  [ModelEnum.GPT_5_2_CODEX_MEDIUM]: 'gpt-5.2-codex',
  [ModelEnum.GPT_5_2_CODEX_HIGH]: 'gpt-5.2-codex-high',
  [ModelEnum.GPT_5_2_CODEX_XHIGH]: 'gpt-5.2-codex-xhigh',
};

// ============================================================================
// Public API
// ============================================================================

export interface ResolvedModel {
  /** Canonical model id (e.g. "claude-opus-4.7" — what OpenCode displays) */
  modelId: string;
  /** Server `model_uid` string sent in `requested_model_uid`. */
  modelUid: string;
  /** Selected variant if any (e.g. "high", "thinking", "1m"). */
  variant?: string;
  /** Legacy proto-enum value. Undefined for Cognition-era string-UID models. */
  enumValue?: ModelEnumValue;
}

export function resolveModel(modelName: string, variantOverride?: string): ResolvedModel {
  const { base, variant } = splitModelAndVariant(modelName);
  const baseId = ALIAS_TO_ID[base] || base;

  const entry = VARIANT_CATALOG[baseId];
  if (entry) {
    const effectiveVariant = (variantOverride || variant || '').trim().toLowerCase();
    if (effectiveVariant && entry.variants?.[effectiveVariant]) {
      const v = entry.variants[effectiveVariant]!;
      return {
        modelId: entry.id,
        modelUid: uidForVariant(v) ?? uidForEntry(entry),
        enumValue: v.enumValue,
        variant: effectiveVariant,
      };
    }
    return { modelId: entry.id, modelUid: uidForEntry(entry), enumValue: entry.defaultEnum };
  }

  // Fallback to legacy alias table (proto-enum-only models).
  const normalized = normalizeModelId(modelName);
  const enumValue = MODEL_NAME_TO_ENUM[normalized];
  if (enumValue) {
    return { modelId: normalized, modelUid: enumNameForValueOrFail(enumValue), enumValue };
  }

  // Unknown model — surface a typed error rather than silently routing to a
  // random model. A typo in the OpenCode config used to land on
  // claude-3.5-sonnet, which billed the user and produced confusing results.
  throw new Error(
    `Unknown Windsurf model: "${modelName}". ` +
      `See README "Supported Models (canonical names)" or call /v1/models for the full list.`
  );
}

/**
 * Variant → uid resolution:
 *   1. explicit `modelUid` (Cognition-era string UID)
 *   2. derive from `enumValue` as "MODEL_<KEY>"
 *   3. nothing → caller falls back to entry-level
 */
function uidForVariant(v: VariantMeta): string | undefined {
  if (v.modelUid) return v.modelUid;
  if (v.enumValue !== undefined) return ENUM_VALUE_TO_NAME.get(v.enumValue as number);
  return undefined;
}

function uidForEntry(entry: ModelCatalogEntry): string {
  if (entry.defaultUid) return entry.defaultUid;
  if (entry.defaultEnum !== undefined) {
    const uid = ENUM_VALUE_TO_NAME.get(entry.defaultEnum as number);
    if (uid) return uid;
  }
  throw new Error(`Catalog entry "${entry.id}" has neither defaultUid nor defaultEnum`);
}

function enumNameForValueOrFail(v: ModelEnumValue): string {
  const uid = ENUM_VALUE_TO_NAME.get(v as number);
  if (!uid) throw new Error(`No enum-name found for value ${v}`);
  return uid;
}

/**
 * Convert a model name string (optionally including variant) to its proto
 * enum value.
 *
 * New string-UID models (claude-opus-4.7, gemini-3.5-flash, …) don't have a
 * proto enum — calling this for them is a programming error. Use
 * `resolveModel(name).modelUid` instead, which works uniformly.
 */
export function modelNameToEnum(modelName: string, variantOverride?: string): ModelEnumValue {
  const resolved = resolveModel(modelName, variantOverride);
  if (resolved.enumValue === undefined) {
    throw new Error(
      `Model "${modelName}" has no proto enum value (string-UID model "${resolved.modelUid}"). ` +
        `Use resolveModel(name).modelUid instead of modelNameToEnum().`
    );
  }
  return resolved.enumValue;
}

// `enumToModelName` removed: was unused after the Cascade flow switch, and
// the previous silent-fallback-to-claude-3.5-sonnet was a footgun. If a
// future caller needs the reverse lookup, read from ENUM_TO_MODEL_NAME
// directly so the `undefined` case is impossible to ignore.

/**
 * Get all supported model names (includes legacy aliases)
 */
export function getSupportedModels(): string[] {
  const fromVariants = Object.keys(VARIANT_CATALOG);
  const aliases: string[] = [];
  for (const entry of Object.values(VARIANT_CATALOG)) {
    if (entry.aliases) aliases.push(...entry.aliases);
    if (entry.variants) {
      for (const variantKey of Object.keys(entry.variants)) {
        aliases.push(`${entry.id}-${variantKey}`);
        for (const alias of entry.aliases || []) {
          aliases.push(`${alias}-${variantKey}`);
        }
      }
    }
  }
  return Array.from(new Set([...fromVariants, ...aliases, ...Object.keys(MODEL_NAME_TO_ENUM)]));
}

/**
 * Check if a model name is supported (canonical or alias or variant)
 */
export function isModelSupported(modelName: string): boolean {
  const normalized = normalizeModelId(modelName);
  const { base, variant } = splitModelAndVariant(normalized);
  const baseId = ALIAS_TO_ID[base] || base;
  if (variant && VARIANT_CATALOG[baseId]?.variants?.[variant]) return true;
  if (VARIANT_CATALOG[baseId]) return true;
  return normalized in MODEL_NAME_TO_ENUM;
}

/** Default canonical model */
export function getDefaultModel(): string {
  return 'claude-3.5-sonnet';
}

export function getDefaultModelEnum(): ModelEnumValue {
  return ModelEnum.CLAUDE_3_5_SONNET_20241022;
}

/**
 * Canonical models (no variants), aligned with OpenCode listing
 */
export function getCanonicalModels(): string[] {
  const bases = new Set<string>(Object.keys(VARIANT_CATALOG));

  // Add non-variant canonical names derived from enum mapping
  for (const name of Object.values(ENUM_TO_MODEL_NAME)) {
    if (!name) continue;
    if (VARIANT_NAME_SET.has(name)) continue; // skip variant entries
    if (!bases.has(name)) bases.add(name);
  }

  return Array.from(bases).sort();
}

export function getModelVariants(modelId: string): Record<string, VariantMeta> | undefined {
  const baseId = ALIAS_TO_ID[normalizeModelId(modelId)] || normalizeModelId(modelId);
  return VARIANT_CATALOG[baseId]?.variants;
}

// Note on the dual model tables (VARIANT_CATALOG + MODEL_NAME_TO_ENUM):
//   - VARIANT_CATALOG is the primary source of truth. resolveModel checks it
//     first and only falls through to MODEL_NAME_TO_ENUM for entries that
//     don't appear in the catalog.
//   - When adding a new proto-enum model, prefer adding it to VARIANT_CATALOG
//     (even with no variants) rather than only to the legacy table.
//   - The two are not auto-synchronised; a sanity check used to live here but
//     was removed because its only signalling channel was console output,
//     which surfaces in the user's opencode terminal when the plugin loads.
//   - To audit drift manually: every VARIANT_CATALOG entry with a
//     `defaultEnum` should ALSO appear in MODEL_NAME_TO_ENUM keyed by its
//     canonical id, mapping to the same enum value.

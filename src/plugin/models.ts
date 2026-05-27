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
 * Reverse lookup: enum number → cloud `model_uid` string.
 *
 * The Cascade flow's `CascadePlannerConfig.requested_model_uid` expects the
 * proto3 enum name (e.g. "MODEL_CLAUDE_4_5_OPUS"). For most models we can
 * derive that as `MODEL_${ENUM_KEY}`, but some families on the cloud carry an
 * extra path component the local enum doesn't (because the enum keys are
 * named for compactness, while the cloud's UIDs are organized by namespace):
 *
 *   - GPT chat / o3 chat   → `MODEL_CHAT_<KEY>`     (verified live: cloud
 *     advertises `MODEL_CHAT_GPT_4O_2024_08_06`, `MODEL_CHAT_O3`, etc.;
 *     `MODEL_GPT_*` returns "internal error")
 *   - Gemini               → `MODEL_GOOGLE_GEMINI_*`
 *   - Grok                 → `MODEL_XAI_GROK_*`
 *
 * The override table below maps an enum-key prefix to the cloud-side UID
 * prefix. If a prefix isn't listed, we fall back to `MODEL_<KEY>`. To verify
 * a model's actual cloud UID, call `GetCascadeModelConfigs` and grep.
 */
const ENUM_PREFIX_OVERRIDES: Array<{ enumPrefix: string; uidPrefix: string }> = [
  { enumPrefix: 'GPT_4_1_2025_04_14',      uidPrefix: 'MODEL_CHAT_GPT_4_1_2025_04_14' },
  { enumPrefix: 'GPT_4O_2024_08_06',       uidPrefix: 'MODEL_CHAT_GPT_4O_2024_08_06' },
  { enumPrefix: 'GPT_5_CODEX',             uidPrefix: 'MODEL_CHAT_GPT_5_CODEX' },
  { enumPrefix: 'O3_HIGH',                 uidPrefix: 'MODEL_CHAT_O3_HIGH' },
  { enumPrefix: 'O3',                      uidPrefix: 'MODEL_CHAT_O3' },
  { enumPrefix: 'GEMINI_3_0_FLASH',        uidPrefix: 'MODEL_GOOGLE_GEMINI_3_0_FLASH' },
  { enumPrefix: 'GEMINI_2_5_PRO',          uidPrefix: 'MODEL_GOOGLE_GEMINI_2_5_PRO' },
  { enumPrefix: 'GROK_3_MINI_REASONING',   uidPrefix: 'MODEL_XAI_GROK_3_MINI_REASONING' },
  { enumPrefix: 'GROK_3',                  uidPrefix: 'MODEL_XAI_GROK_3' },
];

function enumKeyToCloudUid(key: string): string {
  // Longest-prefix match so e.g. `O3_HIGH` doesn't accidentally match the
  // shorter `O3` rule first.
  const sorted = [...ENUM_PREFIX_OVERRIDES].sort((a, b) => b.enumPrefix.length - a.enumPrefix.length);
  for (const { enumPrefix, uidPrefix } of sorted) {
    if (key === enumPrefix) return uidPrefix;
    if (key.startsWith(enumPrefix + '_')) {
      return uidPrefix + key.slice(enumPrefix.length);
    }
  }
  return `MODEL_${key}`;
}

const ENUM_VALUE_TO_NAME: Map<number, string> = (() => {
  const map = new Map<number, string>();
  for (const [key, value] of Object.entries(ModelEnum)) {
    if (typeof value === 'number') {
      map.set(value, enumKeyToCloudUid(key));
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
  /**
   * True when Cognition's cloud rejects tool-bearing requests for every
   * variant of this model. The plugin strips tools and warns the user.
   */
  textOnly?: boolean;
};

// ==========================================================================
// Variant Catalog
// ==========================================================================

const VARIANT_CATALOG: Record<string, ModelCatalogEntry> = {
  // ============================================================================
  // Source-of-truth: live `GetCascadeModelConfigs` snapshot (Cognition cloud).
  // Regenerate with: python3 scripts/regen-models.py < cascade-models.json > /tmp/.
  // The generated block below contains EVERY model + variant Cognition currently
  // ships. Adding manual entries here is fine but they'll be overwritten on the
  // next regen — prefer the upstream catalog as the editing surface.
  // ============================================================================
// Auto-generated 2026-05-20 from Cognition GetCascadeModelConfigs.
// 102 models across 22 families.
// To regenerate manually:
//   curl -s -X POST https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs \
//     -H 'content-type: application/json' -d '{"metadata":{"apiKey":"<KEY>","extensionName":"windsurf","ideName":"windsurf"}}'

  'claude-opus-4.5': {
    id: 'claude-opus-4.5',
    defaultUid: 'MODEL_CLAUDE_4_5_OPUS',
    textOnly: true,
    variants: {
      'base': { modelUid: 'MODEL_CLAUDE_4_5_OPUS', description: 'Claude Opus 4.5' },
      'thinking': { modelUid: 'MODEL_CLAUDE_4_5_OPUS_THINKING', description: 'Claude Opus 4.5 Thinking' },
    },
    aliases: ['claude-opus-4-5'],
  },
  'claude-opus-4.6': {
    id: 'claude-opus-4.6',
    defaultUid: 'claude-opus-4-6-thinking',
    textOnly: true,
    variants: {
      'thinking': { modelUid: 'claude-opus-4-6-thinking', description: 'Claude Opus 4.6 Thinking' },
      'base': { modelUid: 'claude-opus-4-6', description: 'Claude Opus 4.6' },
      '1m': { modelUid: 'claude-opus-4-6-1m', description: 'Claude Opus 4.6 1M' },
      'thinking-1m': { modelUid: 'claude-opus-4-6-thinking-1m', description: 'Claude Opus 4.6 Thinking 1M' },
      'fast': { modelUid: 'claude-opus-4-6-fast', description: 'Claude Opus 4.6 Fast' },
      'thinking-fast': { modelUid: 'claude-opus-4-6-thinking-fast', description: 'Claude Opus 4.6 Thinking Fast' },
    },
    aliases: ['claude-opus-4-6'],
  },
  'claude-opus-4.7': {
    id: 'claude-opus-4.7',
    defaultUid: 'claude-opus-4-7-medium',
    textOnly: true,
    variants: {
      'medium': { modelUid: 'claude-opus-4-7-medium', description: 'Claude Opus 4.7 Medium' },
      'low': { modelUid: 'claude-opus-4-7-low', description: 'Claude Opus 4.7 Low' },
      'high': { modelUid: 'claude-opus-4-7-high', description: 'Claude Opus 4.7 High' },
      'xhigh': { modelUid: 'claude-opus-4-7-xhigh', description: 'Claude Opus 4.7 XHigh' },
      'max': { modelUid: 'claude-opus-4-7-max', description: 'Claude Opus 4.7 Max' },
      'low-fast': { modelUid: 'claude-opus-4-7-low-fast', description: 'Claude Opus 4.7 Low Fast' },
      'medium-fast': { modelUid: 'claude-opus-4-7-medium-fast', description: 'Claude Opus 4.7 Medium Fast' },
      'high-fast': { modelUid: 'claude-opus-4-7-high-fast', description: 'Claude Opus 4.7 High Fast' },
      'xhigh-fast': { modelUid: 'claude-opus-4-7-xhigh-fast', description: 'Claude Opus 4.7 XHigh Fast' },
      'max-fast': { modelUid: 'claude-opus-4-7-max-fast', description: 'Claude Opus 4.7 Max Fast' },
    },
    aliases: ['claude-opus-4-7'],
  },
  'claude-sonnet-4.5': {
    id: 'claude-sonnet-4.5',
    defaultUid: 'MODEL_PRIVATE_2',
    textOnly: true,
    variants: {
      '2': { modelUid: 'MODEL_PRIVATE_2', description: 'Claude Sonnet 4.5' },
      '3': { modelUid: 'MODEL_PRIVATE_3', description: 'Claude Sonnet 4.5 Thinking' },
    },
    aliases: ['claude-sonnet-4-5'],
  },
  'claude-sonnet-4.6': {
    id: 'claude-sonnet-4.6',
    defaultUid: 'claude-sonnet-4-6-thinking',
    textOnly: true,
    variants: {
      'thinking': { modelUid: 'claude-sonnet-4-6-thinking', description: 'Claude Sonnet 4.6 Thinking' },
      'base': { modelUid: 'claude-sonnet-4-6', description: 'Claude Sonnet 4.6' },
      '1m': { modelUid: 'claude-sonnet-4-6-1m', description: 'Claude Sonnet 4.6 1M' },
      'thinking-1m': { modelUid: 'claude-sonnet-4-6-thinking-1m', description: 'Claude Sonnet 4.6 Thinking 1M' },
    },
    aliases: ['claude-sonnet-4-6'],
  },
  'gemini-3.0-flash': {
    id: 'gemini-3.0-flash',
    defaultUid: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL',
    variants: {
      'minimal': { modelUid: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL', description: 'Gemini 3 Flash Minimal' },
      'low': { modelUid: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW', description: 'Gemini 3 Flash Low' },
      'medium': { modelUid: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM', description: 'Gemini 3 Flash Medium' },
      'high': { modelUid: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH', description: 'Gemini 3 Flash High' },
    },
    aliases: ['gemini-3-0-flash'],
  },
  'gemini-3.1-pro': {
    id: 'gemini-3.1-pro',
    defaultUid: 'gemini-3-1-pro-low',
    variants: {
      'low': { modelUid: 'gemini-3-1-pro-low', description: 'Gemini 3.1 Pro Low Thinking' },
      'high': { modelUid: 'gemini-3-1-pro-high', description: 'Gemini 3.1 Pro High Thinking' },
    },
    aliases: ['gemini-3-1-pro'],
  },
  'gemini-3.5-flash': {
    id: 'gemini-3.5-flash',
    defaultUid: 'gemini-3-5-flash-medium',
    variants: {
      'medium': { modelUid: 'gemini-3-5-flash-medium', description: 'Gemini 3.5 Flash Medium' },
      'minimal': { modelUid: 'gemini-3-5-flash-minimal', description: 'Gemini 3.5 Flash Minimal' },
      'low': { modelUid: 'gemini-3-5-flash-low', description: 'Gemini 3.5 Flash Low' },
      'high': { modelUid: 'gemini-3-5-flash-high', description: 'Gemini 3.5 Flash High' },
    },
    aliases: ['gemini-3-5-flash'],
  },
  'glm-5.1': {
    id: 'glm-5.1',
    defaultUid: 'glm-5-1',
    aliases: ['glm-5-1'],
  },
  'gpt-5.1': {
    id: 'gpt-5.1',
    defaultUid: 'MODEL_PRIVATE_12',
    variants: {
      '12': { modelUid: 'MODEL_PRIVATE_12', description: 'GPT-5.1 No Thinking' },
      '13': { modelUid: 'MODEL_PRIVATE_13', description: 'GPT-5.1 Low Thinking' },
      '14': { modelUid: 'MODEL_PRIVATE_14', description: 'GPT-5.1 Medium Thinking' },
      '15': { modelUid: 'MODEL_PRIVATE_15', description: 'GPT-5.1 High Thinking' },
      '20': { modelUid: 'MODEL_PRIVATE_20', description: 'GPT-5.1 No Thinking Fast' },
      '21': { modelUid: 'MODEL_PRIVATE_21', description: 'GPT-5.1 Low Thinking Fast' },
      '22': { modelUid: 'MODEL_PRIVATE_22', description: 'GPT-5.1 Medium Thinking Fast' },
      '23': { modelUid: 'MODEL_PRIVATE_23', description: 'GPT-5.1 High Thinking Fast' },
    },
    aliases: ['gpt-5-1'],
  },
  'gpt-5.1-codex': {
    id: 'gpt-5.1-codex',
    defaultUid: 'MODEL_GPT_5_1_CODEX_LOW',
    aliases: ['gpt-5-1-codex'],
  },
  'gpt-5.1-codex-max': {
    id: 'gpt-5.1-codex-max',
    defaultUid: 'MODEL_GPT_5_1_CODEX_MAX_LOW',
    variants: {
      'low': { modelUid: 'MODEL_GPT_5_1_CODEX_MAX_LOW', description: 'GPT-5.1-Codex Max Low' },
      'medium': { modelUid: 'MODEL_GPT_5_1_CODEX_MAX_MEDIUM', description: 'GPT-5.1-Codex Max Medium' },
      'high': { modelUid: 'MODEL_GPT_5_1_CODEX_MAX_HIGH', description: 'GPT-5.1-Codex Max High' },
    },
    aliases: ['gpt-5-1-codex-max'],
  },
  'gpt-5.1-codex-mini': {
    id: 'gpt-5.1-codex-mini',
    defaultUid: 'MODEL_GPT_5_1_CODEX_MINI_LOW',
    aliases: ['gpt-5-1-codex-mini'],
  },
  'gpt-5.2': {
    id: 'gpt-5.2',
    defaultUid: 'MODEL_GPT_5_2_LOW',
    variants: {
      'low': { modelUid: 'MODEL_GPT_5_2_LOW', description: 'GPT-5.2 Low Thinking' },
      'medium': { modelUid: 'MODEL_GPT_5_2_MEDIUM', description: 'GPT-5.2 Medium Thinking' },
      'low-priority': { modelUid: 'MODEL_GPT_5_2_LOW_PRIORITY', description: 'GPT-5.2 Low Thinking Fast' },
      'medium-priority': { modelUid: 'MODEL_GPT_5_2_MEDIUM_PRIORITY', description: 'GPT-5.2 Medium Thinking Fast' },
      'none': { modelUid: 'MODEL_GPT_5_2_NONE', description: 'GPT-5.2 No Thinking' },
      'high': { modelUid: 'MODEL_GPT_5_2_HIGH', description: 'GPT-5.2 High Thinking' },
      'xhigh': { modelUid: 'MODEL_GPT_5_2_XHIGH', description: 'GPT-5.2 XHigh Thinking' },
      'none-priority': { modelUid: 'MODEL_GPT_5_2_NONE_PRIORITY', description: 'GPT-5.2 No Thinking Fast' },
      'high-priority': { modelUid: 'MODEL_GPT_5_2_HIGH_PRIORITY', description: 'GPT-5.2 High Thinking Fast' },
      'xhigh-priority': { modelUid: 'MODEL_GPT_5_2_XHIGH_PRIORITY', description: 'GPT-5.2 XHigh Thinking Fast' },
    },
    aliases: ['gpt-5-2'],
  },
  'gpt-5.2-codex': {
    id: 'gpt-5.2-codex',
    defaultUid: 'MODEL_GPT_5_2_CODEX_LOW',
    variants: {
      'low': { modelUid: 'MODEL_GPT_5_2_CODEX_LOW', description: 'GPT-5.2-Codex Low' },
      'medium': { modelUid: 'MODEL_GPT_5_2_CODEX_MEDIUM', description: 'GPT-5.2-Codex Medium' },
      'high': { modelUid: 'MODEL_GPT_5_2_CODEX_HIGH', description: 'GPT-5.2-Codex High' },
      'xhigh': { modelUid: 'MODEL_GPT_5_2_CODEX_XHIGH', description: 'GPT-5.2-Codex XHigh' },
      'low-priority': { modelUid: 'MODEL_GPT_5_2_CODEX_LOW_PRIORITY', description: 'GPT-5.2-Codex Low Fast' },
      'medium-priority': { modelUid: 'MODEL_GPT_5_2_CODEX_MEDIUM_PRIORITY', description: 'GPT-5.2-Codex Medium Fast' },
      'high-priority': { modelUid: 'MODEL_GPT_5_2_CODEX_HIGH_PRIORITY', description: 'GPT-5.2-Codex High Fast' },
      'xhigh-priority': { modelUid: 'MODEL_GPT_5_2_CODEX_XHIGH_PRIORITY', description: 'GPT-5.2-Codex XHigh Fast' },
    },
    aliases: ['gpt-5-2-codex'],
  },
  'gpt-5.3-codex': {
    id: 'gpt-5.3-codex',
    defaultUid: 'gpt-5-3-codex-medium',
    variants: {
      'low': { modelUid: 'gpt-5-3-codex-low', description: 'GPT-5.3-Codex Low' },
      'medium': { modelUid: 'gpt-5-3-codex-medium', description: 'GPT-5.3-Codex Medium' },
      'high': { modelUid: 'gpt-5-3-codex-high', description: 'GPT-5.3-Codex High' },
      'xhigh': { modelUid: 'gpt-5-3-codex-xhigh', description: 'GPT-5.3-Codex X-High' },
      'low-priority': { modelUid: 'gpt-5-3-codex-low-priority', description: 'GPT-5.3-Codex Low Fast' },
      'medium-priority': { modelUid: 'gpt-5-3-codex-medium-priority', description: 'GPT-5.3-Codex Medium Fast' },
      'high-priority': { modelUid: 'gpt-5-3-codex-high-priority', description: 'GPT-5.3-Codex High Fast' },
      'xhigh-priority': { modelUid: 'gpt-5-3-codex-xhigh-priority', description: 'GPT-5.3-Codex XHigh Fast' },
    },
    aliases: ['gpt-5-3-codex'],
  },
  'gpt-5.4': {
    id: 'gpt-5.4',
    defaultUid: 'gpt-5-4-none',
    variants: {
      'none': { modelUid: 'gpt-5-4-none', description: 'GPT-5.4 No Thinking' },
      'low': { modelUid: 'gpt-5-4-low', description: 'GPT-5.4 Low Thinking' },
      'medium': { modelUid: 'gpt-5-4-medium', description: 'GPT-5.4 Medium Thinking' },
      'high': { modelUid: 'gpt-5-4-high', description: 'GPT-5.4 High Thinking' },
      'xhigh': { modelUid: 'gpt-5-4-xhigh', description: 'GPT-5.4 XHigh Thinking' },
      'none-priority': { modelUid: 'gpt-5-4-none-priority', description: 'GPT-5.4 No Thinking Fast' },
      'low-priority': { modelUid: 'gpt-5-4-low-priority', description: 'GPT-5.4 Low Thinking Fast' },
      'medium-priority': { modelUid: 'gpt-5-4-medium-priority', description: 'GPT-5.4 Medium Thinking Fast' },
      'high-priority': { modelUid: 'gpt-5-4-high-priority', description: 'GPT-5.4 High Thinking Fast' },
      'xhigh-priority': { modelUid: 'gpt-5-4-xhigh-priority', description: 'GPT-5.4 XHigh Thinking Fast' },
    },
    aliases: ['gpt-5-4'],
  },
  'gpt-5.4-mini': {
    id: 'gpt-5.4-mini',
    defaultUid: 'gpt-5-4-mini-low',
    variants: {
      'low': { modelUid: 'gpt-5-4-mini-low', description: 'GPT-5.4 Mini Low Thinking' },
      'medium': { modelUid: 'gpt-5-4-mini-medium', description: 'GPT-5.4 Mini Medium Thinking' },
      'high': { modelUid: 'gpt-5-4-mini-high', description: 'GPT-5.4 Mini High Thinking' },
      'xhigh': { modelUid: 'gpt-5-4-mini-xhigh', description: 'GPT-5.4 Mini XHigh Thinking' },
    },
    aliases: ['gpt-5-4-mini'],
  },
  'gpt-5.5': {
    id: 'gpt-5.5',
    defaultUid: 'gpt-5-5-low',
    variants: {
      'low': { modelUid: 'gpt-5-5-low', description: 'GPT-5.5 Low Thinking' },
      'none': { modelUid: 'gpt-5-5-none', description: 'GPT-5.5 No Thinking' },
      'medium': { modelUid: 'gpt-5-5-medium', description: 'GPT-5.5 Medium Thinking' },
      'high': { modelUid: 'gpt-5-5-high', description: 'GPT-5.5 High Thinking' },
      'xhigh': { modelUid: 'gpt-5-5-xhigh', description: 'GPT-5.5 XHigh Thinking' },
      'none-priority': { modelUid: 'gpt-5-5-none-priority', description: 'GPT-5.5 No Thinking Fast' },
      'low-priority': { modelUid: 'gpt-5-5-low-priority', description: 'GPT-5.5 Low Thinking Fast' },
      'medium-priority': { modelUid: 'gpt-5-5-medium-priority', description: 'GPT-5.5 Medium Thinking Fast' },
      'high-priority': { modelUid: 'gpt-5-5-high-priority', description: 'GPT-5.5 High Thinking Fast' },
      'xhigh-priority': { modelUid: 'gpt-5-5-xhigh-priority', description: 'GPT-5.5 XHigh Thinking Fast' },
    },
    aliases: ['gpt-5-5'],
  },
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
  'o3': {
    id: 'o3',
    defaultUid: 'MODEL_CHAT_O3',
    variants: {
      'base': { modelUid: 'MODEL_CHAT_O3', description: 'o3' },
      'high': { modelUid: 'MODEL_CHAT_O3_HIGH', description: 'o3 High Reasoning' },
    },
  },

  // ============================================================================
  // Family-less models. Cognition's catalog returns these with no
  // `modelFamilyUid`, so the regen script can't group them. Registered here
  // so user-facing names `swe-1.6`, `deepseek-v4`, etc. resolve correctly.
  // ============================================================================

  'swe-1.6': {
    id: 'swe-1.6',
    defaultUid: 'swe-1-6',
    variants: {
      'base': { modelUid: 'swe-1-6', description: 'SWE-1.6' },
      'fast': { modelUid: 'swe-1-6-fast', description: 'SWE-1.6 Fast' },
    },
    aliases: ['swe-1-6'],
  },
  'deepseek-v4': {
    id: 'deepseek-v4',
    defaultUid: 'deepseek-v4',
  },
  'minimax-m2.5': {
    id: 'minimax-m2.5',
    defaultUid: 'minimax-m2-5',
    aliases: ['minimax-m2-5'],
  },
  'swe-1.5': {
    id: 'swe-1.5',
    defaultUid: 'MODEL_SWE_1_5_SLOW',
    variants: {
      'base': { modelUid: 'MODEL_SWE_1_5_SLOW', description: 'SWE-1.5' },
      'fast': { modelUid: 'MODEL_SWE_1_5', description: 'SWE-1.5 Fast' },
    },
    aliases: ['swe-1-5'],
  },

  // ============================================================================
  // Legacy variant-bearing entries (pre-Cognition naming). These models are no
  // longer in `GetCascadeModelConfigs`, but plenty of opencode configs still
  // address them by the old human-readable family name + colon-variant. We
  // keep them around so `windsurf/claude-3.7-sonnet:thinking` and friends still
  // resolve via the legacy `MODEL_*` proto-enum names that the cloud still
  // accepts. The bare family alias (no `:variant`) is also covered by the
  // bottom MODEL_NAME_TO_ENUM fallback table; these entries add the
  // `:thinking` / `:lite` / `:minimal` / etc. variant routing on top.
  // ============================================================================

  'claude-3.7-sonnet': {
    id: 'claude-3.7-sonnet',
    defaultEnum: ModelEnum.CLAUDE_3_7_SONNET_20250219,
    textOnly: true,
    variants: {
      thinking: { enumValue: ModelEnum.CLAUDE_3_7_SONNET_20250219_THINKING, description: 'Thinking mode' },
    },
    aliases: ['claude-3-7-sonnet'],
  },
  'claude-4-opus': {
    id: 'claude-4-opus',
    defaultEnum: ModelEnum.CLAUDE_4_OPUS,
    textOnly: true,
    variants: {
      thinking: { enumValue: ModelEnum.CLAUDE_4_OPUS_THINKING, description: 'Thinking mode' },
    },
  },
  'claude-4-sonnet': {
    id: 'claude-4-sonnet',
    defaultEnum: ModelEnum.CLAUDE_4_SONNET,
    textOnly: true,
    variants: {
      thinking: { enumValue: ModelEnum.CLAUDE_4_SONNET_THINKING, description: 'Thinking mode' },
    },
  },
  'claude-4.1-opus': {
    id: 'claude-4.1-opus',
    defaultEnum: ModelEnum.CLAUDE_4_1_OPUS,
    textOnly: true,
    variants: {
      thinking: { enumValue: ModelEnum.CLAUDE_4_1_OPUS_THINKING, description: 'Thinking mode' },
    },
    aliases: ['claude-4-1-opus'],
  },
  'claude-4.5-sonnet': {
    id: 'claude-4.5-sonnet',
    defaultEnum: ModelEnum.CLAUDE_4_5_SONNET,
    textOnly: true,
    variants: {
      thinking: { enumValue: ModelEnum.CLAUDE_4_5_SONNET_THINKING, description: 'Thinking mode' },
    },
    aliases: ['claude-4-5-sonnet'],
  },
  'claude-4.5-opus': {
    id: 'claude-4.5-opus',
    defaultEnum: ModelEnum.CLAUDE_4_5_OPUS,
    textOnly: true,
    variants: {
      thinking: { enumValue: ModelEnum.CLAUDE_4_5_OPUS_THINKING, description: 'Thinking mode' },
    },
    aliases: ['claude-4-5-opus'],
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    defaultEnum: ModelEnum.GEMINI_2_5_FLASH,
    variants: {
      thinking: { enumValue: ModelEnum.GEMINI_2_5_FLASH_THINKING, description: 'Thinking budget enabled' },
      lite: { enumValue: ModelEnum.GEMINI_2_5_FLASH_LITE, description: 'Lite / lower cost' },
    },
    aliases: ['gemini-2-5-flash'],
  },
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
  'gpt-5': {
    id: 'gpt-5',
    defaultEnum: ModelEnum.GPT_5,
    variants: {
      low: { enumValue: ModelEnum.GPT_5_LOW, description: 'Lower reasoning' },
      high: { enumValue: ModelEnum.GPT_5_HIGH, description: 'Higher reasoning' },
      nano: { enumValue: ModelEnum.GPT_5_NANO, description: 'Smaller footprint' },
    },
  },
  'o3-pro': {
    id: 'o3-pro',
    defaultEnum: ModelEnum.O3_PRO,
    variants: {
      low: { enumValue: ModelEnum.O3_PRO_LOW, description: 'Lower reasoning' },
      high: { enumValue: ModelEnum.O3_PRO_HIGH, description: 'Higher reasoning' },
    },
  },
  'o4-mini': {
    id: 'o4-mini',
    defaultEnum: ModelEnum.O4_MINI,
    variants: {
      low: { enumValue: ModelEnum.O4_MINI_LOW, description: 'Lower reasoning' },
      high: { enumValue: ModelEnum.O4_MINI_HIGH, description: 'Higher reasoning' },
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

  // Enterprise / private model slots — `private-1` .. `private-30`
  // (resolves to cloud model_uid `MODEL_PRIVATE_N` via the default
  // enum→uid fallback). Whether a given slot is populated for a user's
  // account is account-specific; the cloud's GetCascadeModelConfigs
  // endpoint reveals which slots back real models for the caller.
  'private-1': ModelEnum.PRIVATE_1,
  'private-2': ModelEnum.PRIVATE_2,
  'private-3': ModelEnum.PRIVATE_3,
  'private-4': ModelEnum.PRIVATE_4,
  'private-5': ModelEnum.PRIVATE_5,
  'private-6': ModelEnum.PRIVATE_6,
  'private-7': ModelEnum.PRIVATE_7,
  'private-8': ModelEnum.PRIVATE_8,
  'private-9': ModelEnum.PRIVATE_9,
  'private-10': ModelEnum.PRIVATE_10,
  'private-11': ModelEnum.PRIVATE_11,
  'private-12': ModelEnum.PRIVATE_12,
  'private-13': ModelEnum.PRIVATE_13,
  'private-14': ModelEnum.PRIVATE_14,
  'private-15': ModelEnum.PRIVATE_15,
  'private-16': ModelEnum.PRIVATE_16,
  'private-17': ModelEnum.PRIVATE_17,
  'private-18': ModelEnum.PRIVATE_18,
  'private-19': ModelEnum.PRIVATE_19,
  'private-20': ModelEnum.PRIVATE_20,
  'private-21': ModelEnum.PRIVATE_21,
  'private-22': ModelEnum.PRIVATE_22,
  'private-23': ModelEnum.PRIVATE_23,
  'private-24': ModelEnum.PRIVATE_24,
  'private-25': ModelEnum.PRIVATE_25,
  'private-26': ModelEnum.PRIVATE_26,
  'private-27': ModelEnum.PRIVATE_27,
  'private-28': ModelEnum.PRIVATE_28,
  'private-29': ModelEnum.PRIVATE_29,
  'private-30': ModelEnum.PRIVATE_30,
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

  // Enterprise / private slots (see MODEL_NAME_TO_ENUM above)
  [ModelEnum.PRIVATE_1]: 'private-1',
  [ModelEnum.PRIVATE_2]: 'private-2',
  [ModelEnum.PRIVATE_3]: 'private-3',
  [ModelEnum.PRIVATE_4]: 'private-4',
  [ModelEnum.PRIVATE_5]: 'private-5',
  [ModelEnum.PRIVATE_6]: 'private-6',
  [ModelEnum.PRIVATE_7]: 'private-7',
  [ModelEnum.PRIVATE_8]: 'private-8',
  [ModelEnum.PRIVATE_9]: 'private-9',
  [ModelEnum.PRIVATE_10]: 'private-10',
  [ModelEnum.PRIVATE_11]: 'private-11',
  [ModelEnum.PRIVATE_12]: 'private-12',
  [ModelEnum.PRIVATE_13]: 'private-13',
  [ModelEnum.PRIVATE_14]: 'private-14',
  [ModelEnum.PRIVATE_15]: 'private-15',
  [ModelEnum.PRIVATE_16]: 'private-16',
  [ModelEnum.PRIVATE_17]: 'private-17',
  [ModelEnum.PRIVATE_18]: 'private-18',
  [ModelEnum.PRIVATE_19]: 'private-19',
  [ModelEnum.PRIVATE_20]: 'private-20',
  [ModelEnum.PRIVATE_21]: 'private-21',
  [ModelEnum.PRIVATE_22]: 'private-22',
  [ModelEnum.PRIVATE_23]: 'private-23',
  [ModelEnum.PRIVATE_24]: 'private-24',
  [ModelEnum.PRIVATE_25]: 'private-25',
  [ModelEnum.PRIVATE_26]: 'private-26',
  [ModelEnum.PRIVATE_27]: 'private-27',
  [ModelEnum.PRIVATE_28]: 'private-28',
  [ModelEnum.PRIVATE_29]: 'private-29',
  [ModelEnum.PRIVATE_30]: 'private-30',
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
  /** True when the cloud API rejects tool-bearing requests for this model. */
  textOnly?: boolean;
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
        textOnly: entry.textOnly,
      };
    }
    return { modelId: entry.id, modelUid: uidForEntry(entry), enumValue: entry.defaultEnum, textOnly: entry.textOnly };
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
/**
 * Default model returned by `getDefaultModel()`. The catalog snapshot
 * lists `swe-1.6` as a free, currently-served model — it's the safest
 * default for opencode calls that drop `request.model` (title gen,
 * summaries). The previous default of `claude-3.5-sonnet` resolved to a
 * legacy enum the Cognition cloud no longer accepts, so any
 * model-less request would fail with the misleading `"an internal
 * error occurred"` trailer.
 */
const DEFAULT_MODEL_ID = 'swe-1.6';

export function getDefaultModel(): string {
  return DEFAULT_MODEL_ID;
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

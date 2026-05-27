import { describe, expect, test } from 'bun:test';
import { resolveModel, getModelVariants } from '../../src/plugin/models.js';

// Pins the variant-resolution contract against the live Cognition model catalog
// (see src/plugin/models.ts auto-generated block + family-less manual entries).
// Update these when adding/removing models.

describe('resolveModel variants', () => {
  test('defaults to family-default uid when no variant provided', () => {
    const result = resolveModel('claude-opus-4.7');
    expect(result.modelId).toBe('claude-opus-4.7');
    expect(result.modelUid).toBe('claude-opus-4-7-medium');
    expect(result.variant).toBeUndefined();
  });

  test('resolves colon-delimited variant', () => {
    const result = resolveModel('claude-opus-4.7:high');
    expect(result.modelId).toBe('claude-opus-4.7');
    expect(result.variant).toBe('high');
    expect(result.modelUid).toBe('claude-opus-4-7-high');
  });

  test('resolves dash-suffix variant (hyphenated alias form)', () => {
    const result = resolveModel('claude-opus-4-7-high');
    expect(result.modelId).toBe('claude-opus-4.7');
    expect(result.variant).toBe('high');
    expect(result.modelUid).toBe('claude-opus-4-7-high');
  });

  test('respects variant override', () => {
    const result = resolveModel('claude-opus-4.7', 'max-fast');
    expect(result.variant).toBe('max-fast');
    expect(result.modelUid).toBe('claude-opus-4-7-max-fast');
  });

  test('resolves family-less models (swe-1.6 + its fast variant)', () => {
    expect(resolveModel('swe-1.6').modelUid).toBe('swe-1-6');
    expect(resolveModel('swe-1.6:fast').modelUid).toBe('swe-1-6-fast');
  });

  test('resolves multi-segment variants like xhigh-priority', () => {
    expect(resolveModel('gpt-5.5:xhigh-priority').modelUid).toBe('gpt-5-5-xhigh-priority');
  });

  test('resolves legacy enum-style family (gpt-5.2 → MODEL_GPT_5_2_*)', () => {
    expect(resolveModel('gpt-5.2:low').modelUid).toBe('MODEL_GPT_5_2_LOW');
    expect(resolveModel('gpt-5.2:high-priority').modelUid).toBe('MODEL_GPT_5_2_HIGH_PRIORITY');
  });

  test('marks Claude cloud models as text-only', () => {
    expect(resolveModel('claude-opus-4.7').textOnly).toBe(true);
    expect(resolveModel('claude-sonnet-4.6').textOnly).toBe(true);
    expect(resolveModel('swe-1.6').textOnly).toBeUndefined();
  });
});

describe('getModelVariants', () => {
  test('returns full variant set for a multi-variant family', () => {
    const variants = getModelVariants('claude-opus-4.7');
    expect(variants).toBeDefined();
    const keys = Object.keys(variants ?? {});
    expect(keys).toContain('medium');
    expect(keys).toContain('low');
    expect(keys).toContain('max-fast');
    expect(keys.length).toBeGreaterThanOrEqual(10);
  });

  test('returns undefined for single-variant families like kimi-k2.6', () => {
    const variants = getModelVariants('kimi-k2.6');
    expect(variants).toBeUndefined();
  });
});

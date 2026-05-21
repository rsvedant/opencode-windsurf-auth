#!/usr/bin/env bun
/**
 * Sync our model catalog against the LIVE Cognition cloud catalog.
 *
 * Source of truth: the cloud's GetCascadeModelConfigs RPC, which the
 * Windsurf extension queries via the LSP and we now hit directly. Returns
 * the full ClientModelConfig[] — every model the cloud serves to the
 * caller's account, with label, model_uid, supports_images, max_tokens,
 * pricing tier, etc. This is the same data Windsurf's UI renders.
 *
 *   POST https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs
 *   body: GetCascadeModelConfigsRequest { metadata: Metadata }
 *   resp: GetCascadeModelConfigsResponse { client_model_configs: ClientModelConfig[], ... }
 *
 *   ClientModelConfig (verified against extension.js):
 *     #1  label              string
 *     #2  model_or_alias     submessage   (carries the proto enum value)
 *     #22 model_uid          string       ← what the cloud accepts in /GetChatMessage
 *     #5  supports_images    bool         ← authoritative attachment flag
 *     #18 max_tokens         int32        ← per-model context/output limit
 *     #4  disabled           bool
 *     #7  is_premium         bool
 *     #9  is_beta            bool
 *
 * Usage:
 *
 *   bun run scripts/sync-models.ts              # READ-ONLY — diffs catalog
 *                                                 vs opencode_config_example.json
 *                                                 and prints what's new/changed
 *
 *   bun run scripts/sync-models.ts --write      # also writes a fresh
 *                                                 opencode_config_example.json
 *                                                 (backup at .bak)
 *
 *   bun run scripts/sync-models.ts --dump       # dump the raw catalog as JSON
 *                                                 to stdout (for inspection)
 *
 * Auth: reads credentials.json the same way the plugin does. Run after
 * `opencode auth login` (or `npx opencode-windsurf-auth login`) so this
 * script has a usable api_key.
 *
 * SAFETY: this is a SKETCH (not yet committed). Review before wiring into
 * the release process. In particular, the --write path will REWRITE the
 * committed example config — review the diff before pushing.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { mintUserJwt } from '../src/cloud-direct/auth.js';
import { buildMetadata } from '../src/cloud-direct/metadata.js';
import { encodeMessage, iterFields } from '../src/cloud-direct/wire.js';
import { loadCredentials } from '../src/oauth/storage.js';

// ─── CLI args ──────────────────────────────────────────────────────────
const ARGS = new Set(process.argv.slice(2));
const WRITE = ARGS.has('--write');
const DUMP = ARGS.has('--dump');

// ─── Paths ─────────────────────────────────────────────────────────────
// CWD-relative is fine for a script — invoked as `bun run scripts/sync-models.ts`
// from the repo root.
const REPO_ROOT = process.cwd();
const EXAMPLE_PATH = path.join(REPO_ROOT, 'opencode_config_example.json');

// ─── Wire: fetch the catalog ───────────────────────────────────────────
interface ClientModelConfig {
  label?: string;
  modelUid?: string;
  supportsImages?: boolean;
  maxTokens?: number;
  disabled?: boolean;
  isPremium?: boolean;
  isBeta?: boolean;
  isRecommended?: boolean;
  modelEnum?: number;
}

async function fetchCatalog(): Promise<ClientModelConfig[]> {
  const creds = loadCredentials();
  if (!creds) {
    throw new Error(
      'No Windsurf credentials found. Run `opencode auth login` (or ' +
      '`npx opencode-windsurf-auth login`) first.',
    );
  }
  const host = (creds.apiServerUrl ?? 'https://server.codeium.com').replace(/\/$/, '');
  const jwt = await mintUserJwt(creds.apiKey, host);
  const metadata = buildMetadata({
    apiKey: creds.apiKey,
    userJwt: jwt.jwt,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
  });
  const reqBody = encodeMessage(1, metadata); // GetCascadeModelConfigsRequest{metadata: 1}

  // Buffer/Uint8Array are accepted by fetch at runtime (Bun + undici both
  // handle it), but TS's default BodyInit doesn't include Uint8Array.
  // We cast through `unknown` to keep the script `bun run`-able without
  // pulling in @types/bun (this file is excluded from the publish build).
  const resp = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/proto', 'Connect-Protocol-Version': '1' },
    body: reqBody as unknown as BodyInit,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GetCascadeModelConfigs HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());

  const configs: ClientModelConfig[] = [];
  for (const f of iterFields(buf)) {
    if (f.num === 1 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      configs.push(parseClientModelConfig(f.value));
    }
  }
  return configs;
}

function parseClientModelConfig(buf: Buffer): ClientModelConfig {
  const c: ClientModelConfig = {};
  for (const f of iterFields(buf)) {
    if (f.num === 1 && f.wire === 2) c.label = (f.value as Buffer).toString('utf8');
    else if (f.num === 22 && f.wire === 2) c.modelUid = (f.value as Buffer).toString('utf8');
    else if (f.num === 5 && f.wire === 0) c.supportsImages = f.value === 1n;
    else if (f.num === 4 && f.wire === 0) c.disabled = f.value === 1n;
    else if (f.num === 7 && f.wire === 0) c.isPremium = f.value === 1n;
    else if (f.num === 9 && f.wire === 0) c.isBeta = f.value === 1n;
    else if (f.num === 11 && f.wire === 0) c.isRecommended = f.value === 1n;
    else if (f.num === 18 && f.wire === 0) c.maxTokens = Number(f.value);
    else if (f.num === 2 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      // model_or_alias submessage — first varint field is the proto enum
      for (const sf of iterFields(f.value)) {
        if (sf.wire === 0) {
          c.modelEnum = Number(sf.value);
          break;
        }
      }
    }
  }
  return c;
}

// ─── Catalog → opencode config shape ───────────────────────────────────
/**
 * Convert a ClientModelConfig into the per-model entry our
 * `opencode_config_example.json` uses. We're conservative on modalities:
 * even if the cloud advertises pdf/audio/video for a model, we only
 * declare ["text", "image"] because our cloud-direct wire encoder only
 * transports those two (ChatMessagePrompt field #10 → ImageData).
 */
function toConfigEntry(c: ClientModelConfig) {
  const entry: Record<string, unknown> = {
    name: c.label ?? c.modelUid ?? 'Unknown',
    limit: {
      context: c.maxTokens ?? 200000,
      output: Math.min(c.maxTokens ?? 200000, 128000),
    },
  };
  if (c.supportsImages) {
    entry.attachment = true;
    entry.modalities = { input: ['text', 'image'], output: ['text'] };
  }
  return entry;
}

/**
 * Map a cloud model_uid to the opencode-side id we'd use as the key in
 * `provider.windsurf.models`. The cloud uses underscore-separated upper
 * (e.g. `MODEL_PRIVATE_2`) for enterprise slots and dash-lower
 * (`claude-opus-4-7-medium`) for everything else. opencode keys are
 * dash-lower with dots for version segments (`claude-opus-4.7`).
 *
 * For variants like `claude-opus-4-7-medium`, we strip the variant suffix
 * and emit `claude-opus-4.7` with a variants[] subtree — but that
 * normalization is non-trivial. For this first sketch, just preserve
 * the cloud's exact id, lowercased and with dashes; the diff report
 * will flag mismatches against our hand-curated keys for review.
 */
function cloudUidToConfigKey(uid: string): string {
  if (uid.startsWith('MODEL_PRIVATE_')) {
    const n = uid.slice('MODEL_PRIVATE_'.length);
    return `private-${n}`;
  }
  // For dash-lower uids, return as-is. The hand-curated catalog uses
  // dots in version segments — sync would need a separate pass to
  // collapse variants. Keep that work for a follow-up.
  return uid.toLowerCase();
}

// ─── Diff report ───────────────────────────────────────────────────────
function loadExampleModels(): Record<string, Record<string, unknown>> {
  if (!fs.existsSync(EXAMPLE_PATH)) return {};
  const cfg = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
  return cfg?.provider?.windsurf?.models ?? {};
}

function report(catalog: ClientModelConfig[], current: Record<string, Record<string, unknown>>): void {
  const cloudByKey = new Map<string, ClientModelConfig>();
  for (const c of catalog) {
    if (!c.modelUid) continue;
    if (c.disabled) continue;
    cloudByKey.set(cloudUidToConfigKey(c.modelUid), c);
  }

  const currentKeys = new Set(Object.keys(current));
  const cloudKeys = new Set(cloudByKey.keys());

  const onlyCloud = [...cloudKeys].filter((k) => !currentKeys.has(k));
  const onlyLocal = [...currentKeys].filter((k) => !cloudKeys.has(k));
  const both = [...cloudKeys].filter((k) => currentKeys.has(k));

  console.log('═══ catalog vs opencode_config_example.json ═══');
  console.log(`  cloud catalog:   ${cloudKeys.size} models`);
  console.log(`  current config:  ${currentKeys.size} models`);
  console.log(`  shared:          ${both.length}`);
  console.log(`  cloud-only:      ${onlyCloud.length} (missing from our config)`);
  console.log(`  local-only:      ${onlyLocal.length} (we ship these; cloud doesn't return)`);
  console.log();

  if (onlyCloud.length > 0) {
    console.log('─── cloud-only (consider adding) ───');
    for (const k of onlyCloud.slice(0, 50)) {
      const c = cloudByKey.get(k)!;
      const flags = [
        c.supportsImages ? 'image' : 'text',
        c.isPremium ? 'premium' : null,
        c.isBeta ? 'beta' : null,
        c.isRecommended ? 'recommended' : null,
      ].filter(Boolean).join(' ');
      console.log(`  ${k.padEnd(35)} ${(c.label ?? '').padEnd(40)} ${flags}`);
    }
    if (onlyCloud.length > 50) console.log(`  … and ${onlyCloud.length - 50} more`);
    console.log();
  }

  if (onlyLocal.length > 0) {
    console.log('─── local-only (in config but not in YOUR account catalog) ───');
    console.log('  (could be: variants we expand locally, or models scoped to other tiers/accounts)');
    for (const k of onlyLocal.slice(0, 30)) console.log(`  ${k}`);
    if (onlyLocal.length > 30) console.log(`  … and ${onlyLocal.length - 30} more`);
    console.log();
  }

  // Field-level diffs for shared models (attachment flag drift)
  const drift: string[] = [];
  for (const k of both) {
    const c = cloudByKey.get(k)!;
    const local = current[k] as { attachment?: boolean };
    const cloudAttachment = !!c.supportsImages;
    const localAttachment = !!local.attachment;
    if (cloudAttachment !== localAttachment) {
      drift.push(`  ${k.padEnd(35)} cloud=${cloudAttachment}  local=${localAttachment}`);
    }
  }
  if (drift.length > 0) {
    console.log('─── attachment-flag drift (cloud says X, our config says Y) ───');
    drift.forEach((l) => console.log(l));
    console.log();
  }
}

// ─── Optional write path ───────────────────────────────────────────────
function writeFreshExampleConfig(catalog: ClientModelConfig[]): void {
  const cfg = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
  const newModels: Record<string, ReturnType<typeof toConfigEntry>> = {};
  for (const c of catalog) {
    if (!c.modelUid || c.disabled) continue;
    newModels[cloudUidToConfigKey(c.modelUid)] = toConfigEntry(c);
  }
  cfg.provider.windsurf.models = newModels;
  fs.copyFileSync(EXAMPLE_PATH, EXAMPLE_PATH + '.bak');
  fs.writeFileSync(EXAMPLE_PATH, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`wrote ${Object.keys(newModels).length} models to ${EXAMPLE_PATH}`);
  console.log(`backup at ${EXAMPLE_PATH}.bak`);
  console.log();
  console.log('IMPORTANT: review the diff before committing. This sketch does NOT yet preserve');
  console.log('  - the variants[] subtree on our base-model entries');
  console.log('  - hand-curated context/output limits that differ from the cloud snapshot');
  console.log('  - the provider-level name/npm/options fields (they should round-trip OK)');
}

// ─── Main ──────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const catalog = await fetchCatalog();

  if (DUMP) {
    console.log(JSON.stringify(catalog, null, 2));
    return;
  }

  console.log(`fetched ${catalog.length} models from GetCascadeModelConfigs`);
  console.log();

  const current = loadExampleModels();
  report(catalog, current);

  if (WRITE) {
    writeFreshExampleConfig(catalog);
  } else {
    console.log('read-only run. pass --write to regenerate opencode_config_example.json,');
    console.log('or --dump to print the raw catalog as JSON.');
  }
}

main().catch((err) => {
  console.error('sync-models failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

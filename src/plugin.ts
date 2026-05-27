/**
 * Windsurf Plugin for OpenCode
 * 
 * Enables using Windsurf/Codeium models through OpenCode by intercepting
 * requests and routing them through the local Windsurf language server.
 * 
 * Architecture:
 * 1. Plugin registers a custom fetch handler for windsurf.local domain
 * 2. Requests are transformed to gRPC format and sent to local language server
 * 3. Responses are streamed back in OpenAI-compatible SSE format
 * 
 * Requirements:
 * - Windsurf must be running (launches language_server_macos process)
 * - User must be logged into Windsurf (provides API key in ~/.codeium/config.json)
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

/**
 * ESM-safe replacement for the CommonJS `__dirname`. Our package declares
 * `"type": "module"` so the compiled dist runs in ESM mode — Node's ESM
 * loader does NOT define `__dirname` (a bare reference throws
 * ReferenceError). Bun does polyfill it, which is why earlier smoke runs
 * appeared healthy; pure-Node consumers (and the npm install path) need
 * this `import.meta.url`-based fallback.
 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
import type { PluginInput, Hooks } from '@opencode-ai/plugin';
import type { Auth } from '@opencode-ai/sdk';

// File-based debug logger because opencode-darwin-arm64 swallows our
// console.error in some invocations (TUI takes over stderr). Set
// WINDSURF_PLUGIN_DEBUG=1 to enable; logs land in
// ~/.cache/opencode-windsurf-auth/plugin.log so they're easy to tail.
const debugLog = (() => {
  const enabled = !!process.env.WINDSURF_PLUGIN_DEBUG;
  // Debug log lives under tmp; tighten permissions to 0700 dir + 0600 file
  // since the log mirrors request bodies (system prompts, tool schemas,
  // sometimes prompt content) and we'd rather not have it world-readable
  // on shared multi-user hosts.
  const dir = path.join(os.tmpdir(), 'opencode-windsurf-auth-debug');
  let writeStream: fs.WriteStream | null = null;
  if (enabled) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const p = path.join(dir, `plugin.${process.pid}.log`);
      writeStream = fs.createWriteStream(p, { flags: 'a', mode: 0o600 });
      // Re-chmod in case createWriteStream's mode arg was ignored (Node
      // versions differ on whether `mode` is honored on append-open).
      try { fs.chmodSync(p, 0o600); } catch { /* ok */ }
      writeStream.write(`\n=== plugin loaded at ${new Date().toISOString()} pid=${process.pid} ===\n`);
    } catch { /* don't crash on log-init failure */ }
  }
  return {
    enabled,
    log(...args: unknown[]) {
      if (!enabled) return;
      const line = args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n';
      try { writeStream?.write(line); } catch { /* ok */ }
      // Also mirror to stderr for the cases where opencode does pipe it.
      try { console.error(...args); } catch { /* */ }
    },
  };
})();
import { WindsurfCredentials, WindsurfError } from './plugin/auth.js';
import { resolveCredentials } from './plugin/credentials-resolver.js';
import { loadCredentials as loadOAuthCredentials } from './oauth/storage.js';
import type { ChatHistoryItem, CloudChatEvent } from './cloud-direct/index.js';
import {
  getDefaultModel,
  getCanonicalModels,
  getModelVariants,
  resolveModel,
} from './plugin/models.js';
import { PLUGIN_ID } from './constants.js';

// ============================================================================
// Types
// ============================================================================

interface ChatCompletionRequest {
  model?: string;
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string }>;
    /** Present on `role:'tool'` messages — the call id this result answers. */
    tool_call_id?: string;
    /** Present on `role:'assistant'` messages — tools the assistant called. */
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: Array<{
    type?: string;
    function?: {
      name?: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  providerOptions?: Record<string, unknown>;
}

type ToolDef = NonNullable<ChatCompletionRequest['tools']>[number];

type CloudToolDef = {
  name: string;
  description: string;
  parameters: unknown;
};

const DEFAULT_TOOL_CALL_TRANSLATOR_MODEL = 'swe-1.6';
const DEFAULT_TOOL_INTENT_DETECTION: ToolIntentDetectionMode = 'always';
const DEFAULT_TOOL_TRANSLATOR_CONTEXT_MESSAGES = 8;
const DEFAULT_TOOL_RESULT_CONTEXT: ToolResultContextMode = 'tail';
const DEFAULT_TOOL_RESULT_CONTEXT_MESSAGES = 24;
const MAX_STORED_PLANNER_DRAFTS = 200;

type ToolIntentDetectionMode = 'always' | 'assist' | 'marker';
type ToolResultContextMode = 'full' | 'tail' | 'minimal';

interface TextOnlyToolConfig {
  toolIntentDetection: ToolIntentDetectionMode;
  toolTranslatorContextMessages: number;
  toolResultContext: ToolResultContextMode;
  toolResultContextMessages: number;
}

interface PlannerDraftEntry {
  draft: string;
  modelUid: string;
  createdAt: number;
}

const plannerDraftByToolCallId = new Map<string, PlannerDraftEntry>();

function storePlannerDraft(toolCallId: string, entry: Omit<PlannerDraftEntry, 'createdAt'>): void {
  if (!toolCallId || !entry.draft) return;
  plannerDraftByToolCallId.set(toolCallId, { ...entry, createdAt: Date.now() });
  while (plannerDraftByToolCallId.size > MAX_STORED_PLANNER_DRAFTS) {
    const oldest = plannerDraftByToolCallId.keys().next().value;
    if (!oldest) break;
    plannerDraftByToolCallId.delete(oldest);
  }
}

function extractToolCallTranslatorFromProviderOptions(providerOptions: Record<string, unknown> | undefined): string | undefined {
  if (!providerOptions) return undefined;
  const windsurfRaw = providerOptions['windsurf'];
  const windsurf =
    windsurfRaw && typeof windsurfRaw === 'object'
      ? (windsurfRaw as Record<string, unknown>)
      : undefined;
  const pickString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return (
    pickString(windsurf?.['toolCallTranslatorModel']) ??
    pickString(windsurf?.['toolFallbackModel']) ??
    pickString(windsurf?.['fallbackModel']) ??
    pickString(providerOptions['toolCallTranslatorModel']) ??
    pickString(providerOptions['toolFallbackModel']) ??
    pickString(providerOptions['fallbackModel'])
  );
}

function windsurfProviderOptions(providerOptions: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!providerOptions) return undefined;
  const raw = providerOptions['windsurf'];
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
}

function pickStringConfig(providerOptions: Record<string, unknown> | undefined, key: string): string | undefined {
  const windsurf = windsurfProviderOptions(providerOptions);
  const v = windsurf?.[key] ?? providerOptions?.[key];
  return typeof v === 'string' ? v : undefined;
}

function pickNumberConfig(providerOptions: Record<string, unknown> | undefined, key: string): number | undefined {
  const windsurf = windsurfProviderOptions(providerOptions);
  const v = windsurf?.[key] ?? providerOptions?.[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function clampInt(v: number | undefined, fallback: number, min: number, max: number): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

function resolveToolConfig(providerOptions: Record<string, unknown> | undefined): TextOnlyToolConfig {
  const detectionRaw =
    pickStringConfig(providerOptions, 'toolIntentDetection') ??
    process.env.OPENCODE_WINDSURF_TOOL_INTENT_DETECTION ??
    DEFAULT_TOOL_INTENT_DETECTION;
  const detection: ToolIntentDetectionMode =
    detectionRaw === 'marker' || detectionRaw === 'assist' || detectionRaw === 'always'
      ? detectionRaw
      : DEFAULT_TOOL_INTENT_DETECTION;

  const resultRaw =
    pickStringConfig(providerOptions, 'toolResultContext') ??
    process.env.OPENCODE_WINDSURF_TOOL_RESULT_CONTEXT ??
    DEFAULT_TOOL_RESULT_CONTEXT;
  const resultContext: ToolResultContextMode =
    resultRaw === 'full' || resultRaw === 'tail' || resultRaw === 'minimal'
      ? resultRaw
      : DEFAULT_TOOL_RESULT_CONTEXT;

  return {
    toolIntentDetection: detection,
    toolTranslatorContextMessages: clampInt(
      pickNumberConfig(providerOptions, 'toolTranslatorContextMessages') ?? Number(process.env.OPENCODE_WINDSURF_TOOL_TRANSLATOR_CONTEXT_MESSAGES),
      DEFAULT_TOOL_TRANSLATOR_CONTEXT_MESSAGES,
      1,
      64,
    ),
    toolResultContext: resultContext,
    toolResultContextMessages: clampInt(
      pickNumberConfig(providerOptions, 'toolResultContextMessages') ?? Number(process.env.OPENCODE_WINDSURF_TOOL_RESULT_CONTEXT_MESSAGES),
      DEFAULT_TOOL_RESULT_CONTEXT_MESSAGES,
      1,
      128,
    ),
  };
}

function getToolCallTranslatorModel(providerOptions: Record<string, unknown> | undefined): ReturnType<typeof resolveModel> {
  const fallbackName =
    extractToolCallTranslatorFromProviderOptions(providerOptions)?.trim() ||
    process.env.OPENCODE_WINDSURF_TOOL_CALL_TRANSLATOR_MODEL?.trim() ||
    DEFAULT_TOOL_CALL_TRANSLATOR_MODEL;
  const fallback = resolveModel(fallbackName);
  if (fallback.textOnly) {
    throw new Error(
      `Tool-call translator model "${fallbackName}" is marked text-only. ` +
      `Set OPENCODE_WINDSURF_TOOL_CALL_TRANSLATOR_MODEL to a tool-capable model like swe-1.6.`,
    );
  }
  return fallback;
}

function buildOpusToolPlanningMessages(messages: ChatHistoryItem[], tools: CloudToolDef[]): ChatHistoryItem[] {
  const manifest = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  return [
    ...messages,
    {
      role: 'system',
      content:
        `Native tool schemas cannot be sent to this model, but opencode can still execute tools after your decision.\n` +
        `You are responsible for planning the next step.\n` +
        `If the next step needs a command, file read/edit/search, todo update, web fetch, or any tool action, describe the intended tool action plainly.\n` +
        `Prefer: TOOL_INTENT: <tool name> <arguments/purpose>.\n` +
        `Do not invent tool output and do not continue as if a tool already ran.\n` +
        `If no tool is needed, answer normally.\n\n` +
        `Available tools:\n${JSON.stringify(manifest)}`,
    },
  ];
}

function recentMessages(messages: ChatHistoryItem[], count: number): ChatHistoryItem[] {
  return messages.filter((m) => m.role !== 'system').slice(-count);
}

function latestUserMessage(messages: ChatHistoryItem[]): ChatHistoryItem | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i];
  }
  return undefined;
}

function plannerDraftContext(messages: ChatHistoryItem[]): string {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && typeof m.tool_call_id === 'string' && m.tool_call_id) ids.add(m.tool_call_id);
  }
  const parts: string[] = [];
  for (const id of ids) {
    const entry = plannerDraftByToolCallId.get(id);
    if (entry) parts.push(`tool_call_id=${id}\n${entry.draft}`);
  }
  return parts.join('\n\n');
}

function buildToolCallTranslatorMessages(messages: ChatHistoryItem[], opusDraft: string, tailCount: number): ChatHistoryItem[] {
  const latestUser = latestUserMessage(messages);
  const tail = recentMessages(messages, tailCount);
  const context: ChatHistoryItem[] = latestUser ? [latestUser, ...tail.filter((m) => m !== latestUser)] : tail;
  return [
    ...context,
    {
      role: 'user',
      content:
        `The requested model cannot emit native tool calls. It produced this planned next step:\n\n` +
        `<opus_draft>\n${opusDraft}\n</opus_draft>\n\n` +
        `Convert that planned next step into at most one native tool call.\n` +
        `If the draft implies command execution, file read/edit/search, todo update, web fetch, or any tool action, call exactly the matching tool.\n` +
        `If the draft is a final answer or no tool is needed, respond with exactly: NO_TOOL.\n` +
        `Do not answer the user. Do not add commentary.`,
    },
  ];
}

function buildToolResultMessages(messages: ChatHistoryItem[], config: TextOnlyToolConfig): ChatHistoryItem[] {
  const draftContext = plannerDraftContext(messages);
  if (!draftContext) return messages;

  const injected: ChatHistoryItem = {
    role: 'system',
    content:
      `Previous Opus planner draft(s) that led to the tool result(s) in this turn:\n` +
      `${draftContext}\n\nUse this to interpret the tool result and continue from the original plan.`,
  };

  if (config.toolResultContext === 'full') return [...messages, injected];

  const latestUser = latestUserMessage(messages);
  const tailCount = config.toolResultContext === 'minimal' ? 6 : config.toolResultContextMessages;
  const tail = recentMessages(messages, tailCount);
  const context = latestUser ? [latestUser, ...tail.filter((m) => m !== latestUser)] : tail;
  return [...context, injected];
}

function shouldCallToolTranslator(draft: string, mode: ToolIntentDetectionMode): boolean {
  if (mode === 'always') return true;
  if (/\bTOOL_INTENT\s*:/i.test(draft)) return true;
  if (mode === 'marker') return false;
  return /\b(?:I'll|I will|let me|now|next I'll|I need to)\s+(?:run|execute|read|inspect|check|edit|search|grep|build|flash|capture|write|update)\b/i.test(draft);
}

/**
 * Map an opencode/OpenAI-shaped chat message into the ChatHistoryItem the
 * cloud-direct encoder expects. Importantly, this preserves `tool_call_id`
 * (for role:'tool' results) and `tool_calls` (for role:'assistant' calls)
 * — the encoder uses both to populate ChatMessagePrompt fields #6 and #7
 * so the cloud can pair multi-tool conversations. Previously these were
 * silently dropped, causing the model to lose track of which tool call
 * produced which result.
 */
function mapMessageToHistoryItem(m: ChatCompletionRequest['messages'][number]): ChatHistoryItem {
  const item: ChatHistoryItem = {
    role: m.role as ChatHistoryItem['role'],
    content: m.content as ChatHistoryItem['content'],
  };
  if (m.role === 'tool' && typeof m.tool_call_id === 'string' && m.tool_call_id.length > 0) {
    item.tool_call_id = m.tool_call_id;
  }
  if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
    item.tool_calls = m.tool_calls
      .map((tc) => ({
        id: typeof tc.id === 'string' ? tc.id : '',
        name: typeof tc.function?.name === 'string' ? tc.function.name : '',
        arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : '',
      }))
      .filter((tc) => tc.id !== '' && tc.name !== '');
  }
  return item;
}

function extractVariantFromProviderOptions(providerOptions: Record<string, unknown> | undefined): string | undefined {
  if (!providerOptions) return undefined;
  const windsurfRaw = providerOptions['windsurf'];
  const windsurf =
    windsurfRaw && typeof windsurfRaw === 'object'
      ? (windsurfRaw as Record<string, unknown>)
      : undefined;
  const pickString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const candidate =
    pickString(windsurf?.['variant']) ??
    pickString(windsurf?.['variantID']) ??
    pickString(windsurf?.['variantId']) ??
    pickString(providerOptions['variant']) ??
    pickString(providerOptions['variantID']) ??
    pickString(providerOptions['variantId']);
  return candidate;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
}

// ============================================================================
// Response Helpers
// ============================================================================

/**
 * Create a streaming response. Cloud-direct only — every message routes through
 * `streamChatEvents`, which yields text / reasoning / tool_call deltas straight
 * from the Cognition cloud's GetChatMessage stream. We translate each event into
 * the @ai-sdk-compatible OpenAI SSE chunk shape (`delta.content`,
 * `delta.reasoning`, `delta.tool_calls`) opencode expects.
 */
function createStreamingResponse(
  credentials: WindsurfCredentials,
  request: ChatCompletionRequest
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const responseId = `chatcmpl-${crypto.randomUUID()}`;
  const requestedModel = request.model || getDefaultModel();
  const variantOverride = extractVariantFromProviderOptions(request.providerOptions);

  const abort = new AbortController();

  return new ReadableStream({
    async start(controller) {
      try {
        const resolved = resolveModel(requestedModel, variantOverride);

        const tools = (request.tools ?? []).map((t) => ({
          name: t.function?.name ?? 'unknown',
          description: t.function?.description ?? '',
          parameters: t.function?.parameters ?? {},
        }));
        const { streamChatEvents } = await import('./cloud-direct/index.js');
        // Cloud-direct accepts the FULL @ai-sdk multimodal content shape
        // (text + image_url parts). We pass `request.messages` straight
        // through; streamChatEvents → normalizeContent handles it.
        // The OpenAI request shape allows wider element shapes than
        // cloud-direct's ContentPart; normalizeContent re-validates server
        // side, so cast through the public ChatHistoryItem type.
        const multimodalMessages: ChatHistoryItem[] = request.messages.map((m) => mapMessageToHistoryItem(m));
        let toolCallIndex = -1;
        // Map from cloud's tool-call id → the index we assigned it in the
        // OpenAI-shaped output. Cloud streams args by id; we need to route
        // each argsDelta to the right index when calls interleave (parallel
        // tool calls — Claude Sonnet 4.6+ and OpenAI parallel-tools both
        // support this). Without this map, args from a later call would
        // overwrite an earlier call's index.
        const toolIdToIndex = new Map<string, number>();
        let lastToolCallId: string | undefined;
        let finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null = null;
        let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null = null;
        let firstChunkSent = false;
        const t0 = Date.now();
        const toolConfig = resolveToolConfig(request.providerOptions);
        const useTranslator = !!resolved.textOnly && tools.length > 0;
        const translator = useTranslator ? getToolCallTranslatorModel(request.providerOptions) : undefined;
        const opusMessages = resolved.textOnly
          ? buildToolResultMessages(multimodalMessages, toolConfig)
          : multimodalMessages;
        debugLog.log(`[windsurf-plugin] streamChatEvents starting (model=${resolved.modelUid}, msgs=${opusMessages.length}, tools=${useTranslator ? 0 : tools.length}, toolCallTranslator=${translator?.modelUid ?? 'none'}, intent=${toolConfig.toolIntentDetection}, resultContext=${toolConfig.toolResultContext}:${toolConfig.toolResultContextMessages})`);
        let eventCount = 0;
        let textBytes = 0;
        // Thread the caller's `max_tokens` into the proto's
        // `CompletionConfiguration.max_output_tokens` (proto field #3).
        // Without this we used to ship a hardcoded 4096-token cap — way
        // below what swe-1.6 / gpt-5.5 / claude-opus-4.7 advertise (32K-128K
        // output) — which caused long agentic responses to silently
        // truncate before the model could write the final answer. The
        // model's reasoning would happily fill 4096 tokens and the visible
        // answer never arrived.
        //
        // Resolution order:
        //   1. `request.max_tokens` (opencode/ai-sdk side, set per call)
        //   2. 128_000 fallback — matches the catalog's `maxOutputTokens`
        //      for the most permissive models. The cloud clamps to the
        //      per-model limit anyway.
        const requestedMaxTokens =
          typeof request.max_tokens === 'number' && request.max_tokens > 0
            ? request.max_tokens
            : 128_000;

        const eventSource = async function* (): AsyncGenerator<CloudChatEvent> {
          const common = {
            apiKey: credentials.apiKey,
            apiServerUrl: credentials.apiServerUrl,
            signal: abort.signal,
            completionOpts: { maxOutputTokens: requestedMaxTokens },
          };

          if (!useTranslator || !translator) {
            yield* streamChatEvents({
              ...common,
              modelUid: resolved.modelUid,
              messages: opusMessages,
              tools: tools.length > 0 ? tools : undefined,
            });
            return;
          }

          const opusEvents: CloudChatEvent[] = [];
          let opusDraft = '';
          for await (const ev of streamChatEvents({
            ...common,
            modelUid: resolved.modelUid,
            messages: buildOpusToolPlanningMessages(opusMessages, tools),
          })) {
            opusEvents.push(ev);
            if (ev.kind === 'text') opusDraft += ev.text;
          }

          debugLog.log(`[windsurf-plugin] opus planner draft (${opusDraft.length}B): ${opusDraft.slice(0, 500).replace(/\n/g, '\\n')}`);

          if (!shouldCallToolTranslator(opusDraft, toolConfig.toolIntentDetection)) {
            debugLog.log(`[windsurf-plugin] tool-call translator skipped by detection=${toolConfig.toolIntentDetection}`);
            for (const ev of opusEvents) yield ev;
            return;
          }

          let fallbackSawTool = false;
          const fallbackEvents: CloudChatEvent[] = [];
          for await (const ev of streamChatEvents({
            ...common,
            modelUid: translator.modelUid,
            messages: buildToolCallTranslatorMessages(multimodalMessages, opusDraft, toolConfig.toolTranslatorContextMessages),
            tools,
          })) {
            fallbackEvents.push(ev);
            if (ev.kind === 'tool_call_start') fallbackSawTool = true;
          }

          if (fallbackSawTool) {
            debugLog.log(`[windsurf-plugin] tool-call translator model=${translator.modelUid} emitted tool call(s)`);
            for (const ev of fallbackEvents) {
              if (ev.kind === 'tool_call_start') {
                storePlannerDraft(ev.id, { draft: opusDraft, modelUid: resolved.modelUid });
                debugLog.log(`[windsurf-plugin] stored opus planner draft for tool_call_id=${ev.id}`);
              }
              if (ev.kind === 'text' || ev.kind === 'reasoning') continue;
              yield ev;
            }
            return;
          }

          debugLog.log(`[windsurf-plugin] tool-call translator model=${translator.modelUid} emitted no tool call; streaming opus draft`);
          for (const ev of opusEvents) yield ev;
        };

        for await (const ev of eventSource()) {
          eventCount++;
          if (eventCount === 1) debugLog.log(`[windsurf-plugin] streamChatEvents first event after ${Date.now() - t0}ms (kind=${ev.kind})`);
          // @ai-sdk expects `delta.role: 'assistant'` on the *first* chunk
          // of an assistant turn. Inject it into whichever event arrives
          // first (text / tool_call_start / reasoning).
          const role = firstChunkSent ? undefined : 'assistant';
          if (ev.kind === 'text') {
            textBytes += ev.text.length;
            const chunk = {
              id: responseId,
              object: 'chat.completion.chunk' as const,
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [{
                index: 0,
                delta: role ? { role, content: ev.text } : { content: ev.text },
                finish_reason: null,
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            firstChunkSent = true;
          } else if (ev.kind === 'reasoning') {
            // @ai-sdk supports `delta.reasoning` for Anthropic/OpenAI-o*
            // hidden CoT. opencode renders it in a collapsible block.
            const chunk = {
              id: responseId,
              object: 'chat.completion.chunk' as const,
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [{
                index: 0,
                delta: role ? { role, reasoning: ev.text } : { reasoning: ev.text },
                finish_reason: null,
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            firstChunkSent = true;
          } else if (ev.kind === 'tool_call_start') {
            toolCallIndex += 1;
            toolIdToIndex.set(ev.id, toolCallIndex);
            lastToolCallId = ev.id;
            // delta.role belongs ONLY on the first chunk of an assistant
            // turn per OpenAI streaming spec. Previously we hard-coded
            // role:'assistant' on every tool_call_start, which violated
            // the convention and could trip ai-sdk parsers that reject
            // mid-stream role re-assignment.
            const baseDelta = {
              tool_calls: [{
                index: toolCallIndex,
                id: ev.id,
                type: 'function',
                function: { name: ev.name, arguments: '' },
              }],
            };
            const delta = firstChunkSent ? baseDelta : { role: 'assistant', ...baseDelta };
            const chunk = {
              id: responseId,
              object: 'chat.completion.chunk' as const,
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [{ index: 0, delta, finish_reason: null }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            firstChunkSent = true;
          } else if (ev.kind === 'tool_call_args') {
            // Defensive: if the cloud ever emits an arguments_delta WITHOUT
            // a preceding tool_call_start (id+name), we have no valid call
            // index to attribute the args to. Previously this produced a
            // phantom delta at index 0 with no name, which @ai-sdk's
            // parser renders as a tool call with undefined name. Drop
            // orphan args instead of inventing a fake call.
            if (lastToolCallId === undefined || toolCallIndex < 0) {
              debugLog.log('[windsurf-plugin] dropping orphan tool_call_args (no preceding tool_call_start)');
              continue;
            }
            // Prefer the id carried on this frame (when present) over the
            // rolling lastToolCallId. Cognition only sets the id on start
            // frames today, so most argsDelta events carry no id and we
            // attribute them to the most recent start — but if future
            // wire-format changes ever interleave args across calls, an
            // explicit id lets us route correctly.
            const routeKey = ev.id ?? lastToolCallId;
            const idx = toolIdToIndex.get(routeKey) ?? toolCallIndex;
            const chunk = {
              id: responseId,
              object: 'chat.completion.chunk' as const,
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: idx,
                    function: { arguments: ev.argsDelta },
                  }],
                },
                finish_reason: null,
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          } else if (ev.kind === 'finish') {
            finishReason = ev.reason;
          } else if (ev.kind === 'usage') {
            usage = {
              promptTokens: ev.promptTokens,
              completionTokens: ev.completionTokens,
              totalTokens: ev.totalTokens,
            };
          }
        }
        const finalReason = finishReason ?? (toolCallIndex >= 0 ? 'tool_calls' : 'stop');
        debugLog.log(`[windsurf-plugin] streamChatEvents finished: ${eventCount} events, ${textBytes}B text, ${toolCallIndex + 1} tool_calls, reason=${finalReason}, usage=${usage ? JSON.stringify(usage) : 'none'}, total=${Date.now() - t0}ms`);

        // Per OpenAI streaming spec (`stream_options.include_usage: true`):
        //   1. Finish chunk: `choices: [{ index, delta: {}, finish_reason }]`
        //      (usage MUST NOT appear here)
        //   2. Usage chunk (separate, only when include_usage is on):
        //      `choices: []` and `usage: { prompt_tokens, completion_tokens, total_tokens }`
        //   3. `data: [DONE]`
        // @ai-sdk/openai-compatible reads both chunks and merges them.
        const finishChunk = {
          id: responseId,
          object: 'chat.completion.chunk' as const,
          created: Math.floor(Date.now() / 1000),
          model: requestedModel,
          choices: [{ index: 0, delta: {}, finish_reason: finalReason }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));

        if (usage) {
          const usageChunk = {
            id: responseId,
            object: 'chat.completion.chunk' as const,
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [],
            usage: {
              prompt_tokens: usage.promptTokens ?? 0,
              completion_tokens: usage.completionTokens ?? 0,
              total_tokens: usage.totalTokens ?? ((usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)),
            },
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
        }

        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        // Mid-stream errors used to silently truncate the response: we'd
        // emit an `{error:{...}}` chunk and close, but never send
        // `data: [DONE]\n\n` and never send a finish_reason. @ai-sdk
        // would just hang or render an incomplete turn — looked like
        // "model started writing then stopped" to the user.
        //
        // Three things now happen on any mid-stream failure:
        //   1. emit an `{error:{...}}` data event so opencode's adapter can
        //      surface it,
        //   2. emit a synthetic finish chunk with `finish_reason: 'stop'`
        //      so the adapter resolves the stream as terminated (not stuck
        //      waiting for more deltas),
        //   3. emit `data: [DONE]\n\n` per OpenAI SSE spec.
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        debugLog.log(`[windsurf-plugin] streaming error: ${errorMessage}`);
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: { message: errorMessage } })}\n\n`),
          );
          const finishChunk = {
            id: responseId,
            object: 'chat.completion.chunk' as const,
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' as const }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch {
          /* controller already closed (e.g. via cancel) */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });
}

/**
 * Create a non-streaming response by collecting every text event from the
 * cloud-direct stream into a single completion. opencode emits `stream: false`
 * for ancillary calls like title generation, so this path must stay working
 * even though the streaming path is the hot one.
 */
async function createNonStreamingResponse(
  credentials: WindsurfCredentials,
  request: ChatCompletionRequest,
  signal?: AbortSignal,
): Promise<ChatCompletionResponse> {
  const responseId = `chatcmpl-${crypto.randomUUID()}`;
  const requestedModel = request.model || getDefaultModel();
  const variantOverride = extractVariantFromProviderOptions(request.providerOptions);
  const resolved = resolveModel(requestedModel, variantOverride);

  const tools = (request.tools ?? []).map((t) => ({
    name: t.function?.name ?? 'unknown',
    description: t.function?.description ?? '',
    parameters: t.function?.parameters ?? {},
  }));
  const multimodalMessages: ChatHistoryItem[] = request.messages.map((m) => mapMessageToHistoryItem(m));

  const { streamChatEvents } = await import('./cloud-direct/index.js');

  const requestedMaxTokens =
    typeof request.max_tokens === 'number' && request.max_tokens > 0
      ? request.max_tokens
      : 128_000;

  let collected = '';
  let finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' = 'stop';
  let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null = null;
  // tool_calls in non-streaming responses get fully assembled (id+name+args)
  // before serialization. opencode-side, ai-sdk's non-stream consumer reads
  // these from `choices[0].message.tool_calls`, so dropping them used to
  // make `stream: false` requests effectively return empty assistant turns
  // when the model wanted to call a tool. Now they round-trip.
  type CollectedToolCall = { id: string; name: string; args: string };
  const collectedToolCalls: CollectedToolCall[] = [];
  let currentToolCall: CollectedToolCall | null = null;
  const toolConfig = resolveToolConfig(request.providerOptions);
  const useTranslator = !!resolved.textOnly && tools.length > 0;
  const translator = useTranslator ? getToolCallTranslatorModel(request.providerOptions) : undefined;
  const opusMessages = resolved.textOnly
    ? buildToolResultMessages(multimodalMessages, toolConfig)
    : multimodalMessages;

  const eventSource = async function* (): AsyncGenerator<CloudChatEvent> {
    const common = {
      apiKey: credentials.apiKey,
      apiServerUrl: credentials.apiServerUrl,
      completionOpts: { maxOutputTokens: requestedMaxTokens },
      // Propagate the caller's abort so a client disconnect during a
      // non-streaming title-gen / summary call actually stops the upstream
      // cloud request and the billable token usage with it.
      signal,
    };

    if (!useTranslator || !translator) {
      yield* streamChatEvents({
        ...common,
        modelUid: resolved.modelUid,
        messages: opusMessages,
        tools: tools.length > 0 ? tools : undefined,
      });
      return;
    }

    const opusEvents: CloudChatEvent[] = [];
    let opusDraft = '';
    for await (const ev of streamChatEvents({
      ...common,
      modelUid: resolved.modelUid,
      messages: buildOpusToolPlanningMessages(opusMessages, tools),
    })) {
      opusEvents.push(ev);
      if (ev.kind === 'text') opusDraft += ev.text;
    }

    if (!shouldCallToolTranslator(opusDraft, toolConfig.toolIntentDetection)) {
      for (const ev of opusEvents) yield ev;
      return;
    }

    let fallbackSawTool = false;
    const fallbackEvents: CloudChatEvent[] = [];
    for await (const ev of streamChatEvents({
      ...common,
      modelUid: translator.modelUid,
      messages: buildToolCallTranslatorMessages(multimodalMessages, opusDraft, toolConfig.toolTranslatorContextMessages),
      tools,
    })) {
      fallbackEvents.push(ev);
      if (ev.kind === 'tool_call_start') fallbackSawTool = true;
    }

    if (fallbackSawTool) {
      for (const ev of fallbackEvents) {
        if (ev.kind === 'tool_call_start') {
          storePlannerDraft(ev.id, { draft: opusDraft, modelUid: resolved.modelUid });
        }
        if (ev.kind === 'text' || ev.kind === 'reasoning') continue;
        yield ev;
      }
      return;
    }

    for (const ev of opusEvents) yield ev;
  };

  for await (const ev of eventSource()) {
    if (ev.kind === 'text') {
      collected += ev.text;
    } else if (ev.kind === 'tool_call_start') {
      currentToolCall = { id: ev.id, name: ev.name, args: '' };
      collectedToolCalls.push(currentToolCall);
    } else if (ev.kind === 'tool_call_args') {
      if (currentToolCall) currentToolCall.args += ev.argsDelta;
    } else if (ev.kind === 'finish') {
      finishReason = ev.reason;
    } else if (ev.kind === 'usage') {
      usage = {
        promptTokens: ev.promptTokens,
        completionTokens: ev.completionTokens,
        totalTokens: ev.totalTokens,
      };
    }
    // Reasoning events are intentionally dropped for the non-streaming
    // path — opencode only consumes visible content from a synchronous
    // completion (title generation, etc).
  }
  // Promote "I emitted tool calls" to a tool_calls finish reason so the
  // downstream consumer routes us through the tool-execution loop.
  if (collectedToolCalls.length > 0 && finishReason === 'stop') {
    finishReason = 'tool_calls';
  }

  const created = Math.floor(Date.now() / 1000);
  // Build the assistant message, attaching tool_calls if any were collected
  // during the stream. Shape matches OpenAI's chat.completion response.
  const assistantMessage:
    | { role: 'assistant'; content: string }
    | {
        role: 'assistant';
        content: string;
        tool_calls: Array<{
          id: string;
          type: 'function';
          function: { name: string; arguments: string };
        }>;
      } =
    collectedToolCalls.length > 0
      ? {
          role: 'assistant',
          content: collected,
          tool_calls: collectedToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.args },
          })),
        }
      : { role: 'assistant', content: collected };
  const response: ChatCompletionResponse & { usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } = {
    id: responseId,
    object: 'chat.completion',
    created,
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: assistantMessage,
        finish_reason: finishReason,
      },
    ],
  };
  if (usage) {
    response.usage = {
      prompt_tokens: usage.promptTokens ?? 0,
      completion_tokens: usage.completionTokens ?? 0,
      total_tokens: usage.totalTokens ?? ((usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)),
    };
  }
  return response;
}

// ============================================================================
// Local Proxy Server
// ============================================================================
//
// Security model:
//
//   1. We bind a FIXED loopback port (42100) and document it in the user's
//      opencode config. opencode constructs its @ai-sdk/openai-compatible
//      SDK with that static `baseURL` — chat.params can't change baseURL
//      after construction (it goes into `requestBodyValues`, not the actual
//      URL), so we have to live at a predictable port.
//   2. At plugin load we generate a 256-bit per-process shared secret
//      (PROXY_SECRET). The `chat.params` hook sets it as `options.apiKey`;
//      opencode's @ai-sdk/openai-compatible adapter wires it through to
//      `Authorization: Bearer <secret>` on every call.
//   3. The proxy rejects any /v1/* request whose Authorization header
//      doesn't match the in-process secret. Hostile local processes and
//      DNS-rebinding browser tabs lose access because they don't know it.
//   4. We also Origin-gate browser-shaped requests: any Origin header that
//      isn't a loopback origin is rejected with 403. opencode itself runs
//      server-side and omits Origin, so this only fires for hostile pages.
//   5. /health stays unauthenticated but returns only `{ok: true}` — no
//      pid, no oauth status, no build marker (nothing to spoof).
//   6. On EADDRINUSE we refuse to adopt OR fall back. The fixed port is
//      load-bearing for opencode-side routing; if it's taken, the squatter
//      either IS a healthy peer plugin (in which case we share their
//      process state via the version-suffixed global slot — same Bun
//      runtime, two plugin loads) or it's hostile (in which case we MUST
//      not let the user's secret leak to them by sending requests). We
//      throw a typed error and let opencode surface it.
//   7. Trust on first bind: an attacker who race-binds 42100 BEFORE
//      opencode starts can MITM. Mitigated by `lsof -i :42100` failing
//      loud at user-visible startup — they'll see the wrong process and
//      know to investigate. This is the same risk model as any
//      loopback-bound CLI bridge.

const WINDSURF_PROXY_HOST = '127.0.0.1';
const WINDSURF_PROXY_PORT = 42100;

/**
 * 256-bit hex secret minted once per plugin-host process. Lives in module
 * scope so every call into the proxy from the same opencode runtime sees
 * the same value. Subprocesses and outside attackers can't observe it.
 */
const PROXY_SECRET: string = crypto.randomBytes(32).toString('hex');

/**
 * Per-process proxy registry slot. Stashed on `globalThis` so concurrent
 * plugin loads in the same Node/Bun process share one proxy server instead of
 * racing to bind the same port. `startup` holds the in-flight promise during
 * the initial bind so concurrent callers await the same outcome. The key is
 * version-suffixed so two coexisting plugin versions (e.g. in a monorepo)
 * don't share each other's proxy.
 */
interface ProxyRegistrySlot {
  baseURL: string;
  startup?: Promise<string>;
}
interface WindsurfPluginGlobals {
  /** Bun runtime detection — undefined under vanilla Node. */
  Bun?: { serve(opts: unknown): { port: number } };
}
const globals = globalThis as unknown as WindsurfPluginGlobals;
const slotRegistry = globalThis as unknown as Record<string, ProxyRegistrySlot | undefined>;

const PLUGIN_VERSION: string = (() => {
  // Read once at module load — used to namespace the global slot key so
  // multiple plugin versions in the same process don't fight (e.g. two
  // entries in a monorepo's lockfile resolving to different
  // opencode-windsurf-auth versions). Probe several paths because
  // __dirname differs between dev (src/) and dist/ (dist/src/),
  // and installed packages place package.json at varying relative depths.
  const candidates = [
    path.join(MODULE_DIR, '..', '..', 'package.json'),       // src/plugin.ts → repo root
    path.join(MODULE_DIR, '..', '..', '..', 'package.json'), // dist/src/plugin.js → package root
    path.join(MODULE_DIR, '..', 'package.json'),             // edge: tsc output alongside
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { name?: string; version?: string };
      // Sanity-check the name so we don't pick up an unrelated package.json
      // up the tree (e.g. a monorepo's root).
      if (pkg.name === 'opencode-windsurf-auth' && typeof pkg.version === 'string') {
        return pkg.version;
      }
    } catch { /* try next */ }
  }
  return 'cloud-direct.1';
})();

function getGlobalKey(): string {
  return `__opencode_windsurf_proxy_server__${PLUGIN_VERSION}`;
}

/**
 * Validate an incoming request. We have two layered defenses:
 *
 *   - Origin gate (HARD). If the request carries an `Origin` header that
 *     isn't loopback, reject 403. This is the only defense against DNS-
 *     rebinding browser tabs; opencode's server-side fetch omits Origin
 *     entirely, so legitimate requests pass.
 *
 *   - Bearer gate (HARD). The Authorization header MUST match the
 *     Windsurf api_key from the user's persisted credentials. opencode
 *     pulls the stored api_key (returned from our authorize() callback
 *     as `{type:'success', key}`) and wires it through to
 *     `Authorization: Bearer <api_key>` automatically on every request.
 *     A local attacker without read access to `credentials.json` (mode
 *     0600) can't observe the key, so they can't forge this header.
 *
 *     We also accept the in-process PROXY_SECRET so callers that go
 *     through `chat.params` (e.g. unit tests, programmatic callers)
 *     still work.
 *
 *     If NO Authorization is supplied at all, we reject — opencode always
 *     supplies one when auth is set up. The "no auth, accept anyway"
 *     fallback was removed because it left the proxy completely open to
 *     any local process.
 *
 * Net trust model: a local attacker needs to either read 0600-protected
 * `credentials.json` (same risk envelope as Codeium's own
 * `~/.codeium/config.json`) or know the per-process PROXY_SECRET (only
 * in our heap). DNS-rebinding browser tabs are blocked by Origin check.
 */
/**
 * Async auth gate. Both the Bearer-validation path AND the chat handler's
 * `resolveCredentials()` call now read through the SAME cache layer
 * (`resolveCache` in credentials-resolver.ts), guaranteeing that the
 * apiKey we validate the Bearer against and the apiKey we forward
 * upstream are the same snapshot. Previously these were two independent
 * 2s caches that could diverge across an external credential rotation,
 * letting a request authenticated against key-A get forwarded with key-B.
 */
async function authorizeProxyRequest(req: Request): Promise<Response | null> {
  // 1. Origin gate (HARD) — block browser tabs claiming a foreign origin.
  const origin = req.headers.get('origin');
  if (origin) {
    let url: URL | null = null;
    try { url = new URL(origin); } catch { /* fall through */ }
    const allowed =
      url &&
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
    if (!allowed) {
      return openAIError(403, `Forbidden: cross-origin requests are not allowed (Origin=${origin}).`);
    }
  }

  // 2. Bearer gate (HARD) — Authorization must match either the persisted
  //    Windsurf api_key (opencode's normal flow) or the in-process
  //    PROXY_SECRET (chat.params fallback).
  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return openAIError(401, 'Unauthorized: missing or malformed Authorization header.');
  }
  const presented = authHeader.slice('Bearer '.length);
  // Encode to bytes ONCE. `string.length` returns UTF-16 code-unit count;
  // `Buffer.from(str)` returns the UTF-8 byte representation. A bearer
  // made of 32 emoji has .length===64 (would match a 64-char hex secret
  // by code-unit count) but Buffer.from yields 128 bytes; passing
  // mismatched-length buffers to crypto.timingSafeEqual throws
  // RangeError, which previously escaped as a 500 instead of the
  // intended 401. Comparing byte lengths first fixes both correctness
  // and the auth-gate fail-open shape.
  const presentedBuf = Buffer.from(presented, 'utf8');

  // Accept the per-process secret first (cheapest check).
  const secretBuf = Buffer.from(PROXY_SECRET, 'utf8');
  if (
    presentedBuf.length === secretBuf.length &&
    crypto.timingSafeEqual(presentedBuf, secretBuf)
  ) {
    return null;
  }

  // Otherwise, validate against the persisted credentials' apiKey. We
  // route through `resolveCredentials()` (shared with the chat handler)
  // so the Bearer we authenticate against is THE SAME snapshot the chat
  // handler will forward upstream — no TOCTOU between the auth gate and
  // the chat path even under external file rotation.
  try {
    const creds = await resolveCredentials();
    if (creds.apiKey && creds.apiKey.length > 0) {
      const credBuf = Buffer.from(creds.apiKey, 'utf8');
      if (
        presentedBuf.length === credBuf.length &&
        crypto.timingSafeEqual(presentedBuf, credBuf)
      ) {
        return null;
      }
    }
  } catch { /* not authenticated / missing creds → fall through to 401 */ }

  return openAIError(401, 'Unauthorized: Authorization header did not match the expected credential.');
}

function openAIError(status: number, message: string, details?: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: details ? `${message}\n${details}` : message,
        type: 'windsurf_error',
        param: null,
        code: null,
      },
    }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

async function ensureWindsurfProxyServer(): Promise<string> {
  const key = getGlobalKey();

  // Return existing server URL if already started.
  const slot = slotRegistry[key];
  if (slot && typeof slot.baseURL === 'string' && slot.baseURL.length > 0) {
    return slot.baseURL;
  }
  // If a startup is in flight, share its promise so concurrent callers don't
  // race into duplicate Bun.serve() calls or split across two random ports.
  if (slot && slot.startup instanceof Promise) {
    return slot.startup;
  }

  const handler = async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);

      // /health is unauthenticated by design — it's only meant to be a
      // "yes, the proxy is up" probe. It carries no PID, no oauth state,
      // no version marker — there is nothing here for an attacker to
      // observe or spoof. (The previous build-marker-based adoption was
      // removed; see the security-model block at the top of this file.)
      if (url.pathname === '/health') {
        return new Response(
          JSON.stringify({ ok: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Every other endpoint requires the per-process Bearer secret +
      // loopback origin.
      const blocked = await authorizeProxyRequest(req);
      if (blocked) return blocked;

      // Models endpoint
      if (url.pathname === '/v1/models' || url.pathname === '/models') {
        const models = getCanonicalModels();
        return new Response(
          JSON.stringify({
            object: 'list',
            data: models.map((id) => {
              const variants = getModelVariants(id);
              const resolved = resolveModel(id);
              const supportsTools = !resolved.textOnly;
              return {
                id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'windsurf',
                capabilities: { tools: supportsTools },
                text_only: !supportsTools,
                ...(variants
                  ? {
                      variants: Object.entries(variants).map(([name, meta]) => ({
                        id: name,
                        description: meta.description,
                      })),
                    }
                  : {}),
              };
            }),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Chat completions endpoint
      if (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions') {
        try {
          // Method gate — only POST.
          if (req.method !== 'POST') {
            return openAIError(405, `Method ${req.method} not allowed; use POST.`);
          }
          // Content-Type gate — refuse anything that isn't JSON. (Useful
          // defense-in-depth against confused-deputy attacks where an
          // attacker tricks the local proxy into parsing form-encoded
          // junk as a chat request.)
          const ct = (req.headers.get('content-type') ?? '').toLowerCase();
          if (!ct.startsWith('application/json')) {
            return openAIError(415, `Unsupported Content-Type: ${ct || '(empty)'}; expected application/json.`);
          }
          // Body size gate — opencode never sends >5MB request bodies
          // (system prompts top out around 200KB). Reject anything 32MB+
          // before we even try to parse it. Defense against accidental or
          // hostile request-body floods.
          // Content-Length pre-check. Number.isFinite filters out NaN
          // (which `Number('abc')` and missing/malformed headers produce)
          // — otherwise an attacker setting `Content-Length: oops` would
          // bypass the cap because `NaN > MAX === false`.
          const rawLen = req.headers.get('content-length');
          const declaredLen = rawLen !== null ? Number(rawLen) : 0;
          if (Number.isFinite(declaredLen) && declaredLen > 32 * 1024 * 1024) {
            return openAIError(413, `Request body too large: ${declaredLen} bytes (max 32 MB).`);
          }
          if (rawLen !== null && !Number.isFinite(declaredLen)) {
            return openAIError(400, `Malformed Content-Length: ${rawLen}.`);
          }
          // resolveCredentials prefers OAuth (no Windsurf required) and falls
          // back to scraping the running Windsurf process. It throws a
          // descriptive WindsurfError if neither is available.
          const credentials = await resolveCredentials();
          if (debugLog.enabled) {
            debugLog.log(`[windsurf-plugin] mode=${credentials.cloudDirect ? 'cloud-direct' : 'local-ls'} api=${credentials.apiServerUrl ?? '(default)'}`);
          }
          // Reject malformed JSON cleanly (used to coerce to {} and 500
          // when downstream .messages.map blew up).
          let requestBody: ChatCompletionRequest;
          try {
            requestBody = (await req.json()) as ChatCompletionRequest;
          } catch (parseErr) {
            return openAIError(
              400,
              'Malformed request body — expected JSON.',
              parseErr instanceof Error ? parseErr.message : String(parseErr),
            );
          }
          if (!requestBody || typeof requestBody !== 'object' || !Array.isArray(requestBody.messages)) {
            return openAIError(400, 'Malformed request body — `messages` must be an array.');
          }
          const isStreaming = requestBody.stream === true;

          if (debugLog.enabled) {
            debugLog.log(`[windsurf-plugin] /v1/chat/completions: model=${requestBody.model} stream=${isStreaming} tools=${Array.isArray(requestBody.tools) ? requestBody.tools.length : 0} msgs=${requestBody.messages?.length ?? 0}`);
            for (const m of requestBody.messages ?? []) {
              const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
              debugLog.log(`  msg[${m.role}] (${txt.length}B): ${txt.slice(0, 180).replace(/\n/g, '\\n')}`);
            }
            if (Array.isArray(requestBody.tools)) {
              const names = requestBody.tools.map((t: ToolDef) => t?.function?.name);
              debugLog.log(`  tool names (all ${names.length}): ${names.join(', ')}`);
              // Dump full tool definitions for the first 3 + any whose
              // parameters look suspicious ($ref / discriminator / oneOf)
              try {
                const dumpPath = path.join(os.tmpdir(), 'opencode-windsurf-auth-debug', 'tools-dump.json');
                // Tighten parent dir + file mode to 0700 / 0600 so the
                // dumped tool schemas (which can include user file paths
                // in descriptions) aren't world-readable on shared hosts.
                // O_EXCL+O_NOFOLLOW on the write so a pre-planted symlink
                // can't redirect us elsewhere (same hardening as
                // saveCredentials).
                fs.mkdirSync(path.dirname(dumpPath), { recursive: true, mode: 0o700 });
                try { fs.unlinkSync(dumpPath); } catch { /* not there, fine */ }
                const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
                const fd = fs.openSync(
                  dumpPath,
                  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
                  0o600,
                );
                try {
                  fs.writeSync(fd, JSON.stringify(requestBody.tools, null, 2));
                } finally {
                  fs.closeSync(fd);
                }
                debugLog.log(`  full tools dumped to ${dumpPath}`);
              } catch (e) {
                debugLog.log(`  tools dump failed: ${(e as Error).message}`);
              }
            }
          }

          if (debugLog.enabled) {
            debugLog.log(`[windsurf-plugin] cloudDirect=${credentials.cloudDirect}`);
            // Dump first 500 chars of every message so we can see what opencode actually sends
            for (const m of requestBody.messages ?? []) {
              const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
              debugLog.log(`  msg[${m.role}]: ${txt.slice(0, 200)}`);
            }
          }

          if (isStreaming) {
            const stream = createStreamingResponse(credentials, requestBody);
            return new Response(stream, {
              status: 200,
              headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
              },
            });
          }

          // Pass the incoming Request's abort signal so a client-disconnect
          // mid-call propagates through to the cloud-direct stream.
          const responseData = await createNonStreamingResponse(credentials, requestBody, req.signal);
          return new Response(JSON.stringify(responseData), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (chatError) {
          if (chatError instanceof WindsurfError) {
            // Auth/discovery failures are 401/503-ish, not 500 — surface them
            // with the same JSON shape so the OpenCode CLI prints something
            // actionable instead of a generic "Chat completion failed".
            return openAIError(503, chatError.message);
          }
          const errMsg = chatError instanceof Error ? chatError.message : String(chatError);
          return openAIError(500, 'Chat completion failed', errMsg);
        }
      }

      return openAIError(404, `Unsupported path: ${url.pathname}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return openAIError(500, 'Proxy error', message);
    }
  };

  // Detect Bun and prefer Bun.serve when available (lower latency); fall back
  // to Node http.createServer otherwise so we run in vanilla Node hosts too.
  const bunServe = globals.Bun?.serve.bind(globals.Bun);
  const hasBunServe = typeof bunServe === 'function';

  const startup = (async (): Promise<string> => {
    if (debugLog.enabled) {
      debugLog.log(`[windsurf-plugin] ensureWindsurfProxyServer (hasBunServe=${hasBunServe})`);
    }

    const startBunServer = (port: number) =>
      bunServe!({
        hostname: WINDSURF_PROXY_HOST,
        port,
        fetch: handler,
        // Cascade chat can go silent for >100s during slow-model thinking
        // before the first token. Bun's idleTimeout is capped at 255s; we
        // disable it (0 = no limit) since this is a localhost-only proxy.
        idleTimeout: 0,
        // Match the Node-path streaming cap (32 MB). Without this, Bun's
        // default ~128 MB ceiling lets a chunked-transfer request without
        // Content-Length buffer that much before our handler ever sees it,
        // even though /v1/chat/completions itself does a `content-length`
        // pre-check on the headers (which is missing on chunked uploads).
        maxRequestBodySize: 32 * 1024 * 1024,
      });

    const startNodeServer = (port: number): Promise<{ port: number }> =>
      new Promise((resolve, reject) => {
        // Node's http needs a slightly different handler — adapt our Request→Response
        // handler. We collect headers + body then re-wrap as a WHATWG Request.
        // Lazy-import to keep the module's top-level imports clean.
        import('http').then((nodeHttp) => {
          const srv = nodeHttp.createServer(async (req, res) => {
            // 32 MB hard cap on inbound request bodies. opencode's largest
            // legitimate request (huge system prompt + 100+ tools) maxes
            // around 500 KB. A hostile localhost peer streaming a multi-GB
            // body used to be able to drive us OOM via Buffer.concat.
            const MAX_REQ_BODY_BYTES = 32 * 1024 * 1024;
            // Per-request AbortController so we can propagate client-close
            // through into our downstream handler (cloud-direct fetch).
            const abort = new AbortController();
            req.on('close', () => {
              if (!res.writableEnded) abort.abort();
            });
            try {
              // Collect body bytes with a size cap. We track total size as
              // we go and reject overruns immediately instead of buffering
              // first and counting later.
              const chunks: Buffer[] = [];
              let total = 0;
              let aborted = false;
              await new Promise<void>((r, rej) => {
                req.on('data', (c) => {
                  if (aborted) return;
                  const buf = Buffer.from(c);
                  total += buf.length;
                  if (total > MAX_REQ_BODY_BYTES) {
                    aborted = true;
                    // Actively destroy the request socket so the attacker
                    // can't keep streaming bytes we just ignore. Without
                    // this, the previous "set aborted=true and return"
                    // path let the client hold the connection open and
                    // pour data through until the OS-level idle timeout.
                    try { req.destroy(new Error('request body exceeded cap')); } catch { /* */ }
                    rej(Object.assign(new Error('request body too large'), { httpStatus: 413 }));
                    return;
                  }
                  chunks.push(buf);
                });
                req.on('end', r);
                req.on('error', rej);
                req.on('aborted', () => rej(Object.assign(new Error('client aborted'), { httpStatus: 499 })));
              });
              const url = `http://${req.headers.host ?? WINDSURF_PROXY_HOST}${req.url ?? '/'}`;
              const headers = new Headers();
              for (const [k, v] of Object.entries(req.headers)) {
                if (typeof v === 'string') headers.set(k, v);
                else if (Array.isArray(v)) headers.set(k, v.join(', '));
              }
              const init: RequestInit = {
                method: req.method,
                headers,
                body: chunks.length ? Buffer.concat(chunks) : undefined,
                signal: abort.signal,
              };
              const r0 = new Request(url, init);
              const r1 = await handler(r0);
              res.statusCode = r1.status;
              r1.headers.forEach((v, k) => res.setHeader(k, v));
              if (r1.body) {
                const reader = r1.body.getReader();
                try {
                  while (true) {
                    if (abort.signal.aborted) {
                      try { await reader.cancel(); } catch { /* */ }
                      break;
                    }
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (value) {
                      // res.write returns false on backpressure — wait for drain
                      const ok = res.write(Buffer.from(value));
                      if (!ok) await new Promise<void>((r) => res.once('drain', r));
                    }
                  }
                } finally {
                  try { reader.releaseLock(); } catch { /* */ }
                }
              } else {
                const txt = await r1.text();
                res.write(txt);
              }
              res.end();
            } catch (e) {
              const err = e as Error & { httpStatus?: number };
              try {
                res.statusCode = err.httpStatus ?? 500;
                res.end(`error: ${err.message}`);
              } catch { /* socket already dead */ }
            }
          });
          srv.on('error', reject);
          srv.listen(port, WINDSURF_PROXY_HOST, () => {
            const addr = srv.address();
            if (!addr || typeof addr === 'string') reject(new Error('bad node http address'));
            else resolve({ port: addr.port });
          });
        }).catch(reject);
      });

    const startServer = async (port: number): Promise<{ port: number }> => {
      if (hasBunServe) {
        debugLog.log(`[windsurf-plugin] calling Bun.serve port=${port}`);
        try {
          const s = startBunServer(port);
          debugLog.log(`[windsurf-plugin] Bun.serve returned, port=${s.port}`);
          return { port: s.port };
        } catch (e) {
          debugLog.log(`[windsurf-plugin] Bun.serve threw: ${(e as Error).message}`);
          throw e;
        }
      }
      debugLog.log(`[windsurf-plugin] using Node http server`);
      return startNodeServer(port);
    };

    // Bind the fixed 42100 port. If something's already there we DON'T
    // adopt it — that's the spoof vector — but we DO check whether it's
    // ourselves (another plugin instance in the same Bun runtime, which
    // shares the global slot below) by validating our own Bearer secret
    // against it. If the in-process slot already exists, the early-return
    // at the top of ensureWindsurfProxyServer fired before we got here.
    // Reaching this point with EADDRINUSE means a foreign process holds
    // the port — surface a clear error so the user can investigate.
    try {
      const server = await startServer(WINDSURF_PROXY_PORT);
      if (debugLog.enabled) {
        debugLog.log(`[windsurf-plugin] proxy listening on http://${WINDSURF_PROXY_HOST}:${server.port}/v1 (secret-gated)`);
      }
      return `http://${WINDSURF_PROXY_HOST}:${server.port}/v1`;
    } catch (err) {
      const code =
        err instanceof Error && 'code' in err
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      if (code === 'EADDRINUSE') {
        throw new Error(
          `opencode-windsurf-auth: port ${WINDSURF_PROXY_PORT} is already in use by another process. ` +
          `Identify the squatter with \`lsof -nP -iTCP:${WINDSURF_PROXY_PORT} -sTCP:LISTEN\` and kill it, then re-run opencode. ` +
          `(This port is the documented baseURL for the Windsurf provider; we refuse to silently adopt a foreign listener since it would be able to capture your prompts.)`,
        );
      }
      throw err;
    }
  })();

  slotRegistry[key] = { baseURL: '', startup };
  try {
    const baseURL = await startup;
    slotRegistry[key] = { baseURL };
    return baseURL;
  } catch (err) {
    delete slotRegistry[key];
    throw err;
  }
}

// ============================================================================
// Plugin Factory
// ============================================================================

// ChatParamsHook mirrors the opencode-plugin Hooks['chat.params'] signature
// (input + output shapes). We pull them off the public Hooks type so a future
// SDK bump automatically retypes us instead of silently drifting.
type ChatParamsHook = NonNullable<Hooks['chat.params']>;
type ChatParamsInput = Parameters<ChatParamsHook>[0];
type ChatParamsOutput = Parameters<ChatParamsHook>[1];

/**
 * Create the Windsurf plugin (follows cursor-auth pattern)
 */
export const createWindsurfPlugin =
  (providerId: string = PLUGIN_ID) =>
  async (context: PluginInput): Promise<Hooks> => {
    // PluginInput.client is the opencode-sdk OpencodeClient. We use it for
    // writing to opencode's auth.json store (mirror of antigravity's pattern).
    const { client } = context ?? ({} as PluginInput);
    // Start proxy server on plugin load
    const proxyBaseURL = await ensureWindsurfProxyServer();

    return {
      auth: {
        provider: providerId,

        /**
         * loader runs once at plugin load + whenever opencode wants to refresh
         * provider info. Two-way mirror with credentials.json:
         *
         *   - opencode auth has a key → mirror to credentials.json (if file is
         *     missing or stale)
         *   - opencode auth was CLEARED via `opencode auth logout windsurf` →
         *     clear credentials.json so we don't keep using a stale token
         *
         * The CLI flow (`npx opencode-windsurf-auth login`) doesn't touch
         * opencode's auth store, so we DON'T delete credentials.json just
         * because opencode's store happens to be empty — we check via the
         * `lastSyncedViaOpencode` marker.
         */
        async loader(getAuth: () => Promise<Auth>) {
          try {
            // Defensive: opencode can transiently return `undefined` from
            // getAuth() during its own auth-store refresh window. If we
            // believed that and immediately deleted credentials.json
            // (because the saved file has syncedViaOpencodeAuth=true), the
            // user would be silently logged out mid-session and the next
            // chat would 401 / quotaless-prompt.
            //
            // Mitigation: when getAuth() returns no key, try again after a
            // short delay before concluding the user actually logged out.
            // A real logout is monotonic (auth stays empty); a transient
            // returns a key on the retry.
            const readKey = async (): Promise<string | undefined> => {
              const auth = await getAuth();
              if (!auth || typeof auth !== 'object') return undefined;
              if (auth.type === 'oauth') return auth.access;
              return auth.key;
            };
            let opencodeKey = await readKey();
            if (!opencodeKey) {
              // Second look after 50ms — same order of magnitude as
              // opencode's internal refresh window.
              await new Promise((r) => setTimeout(r, 50));
              opencodeKey = await readKey();
            }
            const existing = (() => { try { return loadOAuthCredentials(); } catch { return null; } })();

            if (opencodeKey) {
              // opencode has a key. Sync into credentials.json if file is
              // missing or stale. Preserve `syncedViaOpencodeAuth` from the
              // existing file if explicitly set to `false` (CLI-managed
              // creds want to survive opencode logout). Default to `true`
              // when the file is new or had no flag.
              if (!existing || existing.apiKey !== opencodeKey) {
                const { saveCredentials } = await import('./oauth/storage.js');
                const { DEFAULT_REGION } = await import('./oauth/types.js');
                await saveCredentials({
                  apiKey: opencodeKey,
                  name: existing?.name ?? 'opencode-auth-stored',
                  apiServerUrl: existing?.apiServerUrl ?? 'https://server.codeium.com',
                  issuedAt: new Date().toISOString(),
                  oauthClientId: DEFAULT_REGION.oauthClientId,
                  syncedViaOpencodeAuth: existing?.syncedViaOpencodeAuth ?? true,
                });
              }
            } else if (existing?.syncedViaOpencodeAuth) {
              // opencode-managed key was confirmed-cleared on BOTH reads
              // (initial + 50ms retry). Mirror to credentials.json so the
              // chat path stops accepting the stale token.
              const { deleteCredentials } = await import('./oauth/storage.js');
              deleteCredentials();
              // Drop every layer of in-memory credential state so a
              // logout immediately stops authorizing requests:
              //  - JWT cache (would otherwise keep working for ~24min)
              //  - sessionId cache (server-side context tied to the key)
              //  - resolveCredentials memo (shared by auth gate + chat handler)
              try {
                const { clearCachedUserJwt } = await import('./cloud-direct/auth.js');
                clearCachedUserJwt();
                const { clearSessionIds } = await import('./cloud-direct/chat.js');
                clearSessionIds();
                const { clearCachedCatalog } = await import('./cloud-direct/catalog.js');
                clearCachedCatalog();
                const { clearResolveCache } = await import('./plugin/credentials-resolver.js');
                clearResolveCache();
              } catch { /* best-effort */ }
            }
            // (otherwise leave credentials.json alone — likely written by our
            // standalone CLI without opencode involvement.)
          } catch (loaderErr) {
            // The loader contract requires us not to throw — an exception
            // here would crash opencode's plugin host. But silently
            // swallowing storage failures used to mean a failed
            // `saveCredentials` or `deleteCredentials` left opencode
            // reporting "logged in" / "logged out" while credentials.json
            // disagreed (and the proxy auth gate then trusted the stale
            // state). Surface to debugLog so users running with
            // WINDSURF_PLUGIN_DEBUG=1 see the cause, AND emit a single
            // console.warn so the bare CLI also gets a visible hint.
            try {
              debugLog.log('[windsurf-plugin] loader credential-sync failed:', loaderErr instanceof Error ? loaderErr.message : loaderErr);
              process.stderr.write(`[opencode-windsurf-auth] credential sync failed: ${loaderErr instanceof Error ? loaderErr.message : String(loaderErr)}\n`);
            } catch { /* */ }
          }
          return {};
        },

        /**
         * `opencode auth login` enumerates these and shows them as choices
         * after the user picks the provider. The label is what opencode
         * renders next to the bullet point.
         */
        methods: [
          {
            type: 'oauth' as const,
            label: 'Sign in with Cognition (Windsurf)',
            // Explicit empty prompts array. Per @opencode-ai/plugin's
            // AuthHook type, `prompts` is optional — but opencode CLI
            // v1.15.6 (and possibly later) dereferences `method.prompts`
            // without a null-check in its login picker, crashing with
            // `undefined is not an object (evaluating 'C.prompts')`
            // when the field is absent. Providing an empty array is the
            // smallest workaround and is type-clean.
            //
            // GitHub issue: rsvedant/opencode-windsurf-auth#13
            prompts: [],
            async authorize() {
              // Two-stage: prepareLogin BINDS the loopback NOW and returns
              // the URL with the real port. Without this, our previous
              // implementation built the URL with port=0 (placeholder)
              // before binding, and opencode opened that broken URL —
              // user reported "Failed to authorize".
              const { prepareLogin } = await import('./oauth/login.js');
              const { saveCredentials } = await import('./oauth/storage.js');
              const { DEFAULT_REGION } = await import('./oauth/types.js');

              let prepared: Awaited<ReturnType<typeof prepareLogin>>;
              try {
                prepared = await prepareLogin({ region: DEFAULT_REGION });
              } catch (err) {
                debugLog.log('[windsurf-plugin] prepareLogin failed:', err instanceof Error ? err.message : err);
                // We have to return SOMETHING shaped like AuthOuathResult, so
                // surface the error via the callback.
                return {
                  url: 'https://windsurf.com/',
                  instructions: 'Failed to start loopback listener. Re-run `opencode auth login`.',
                  method: 'auto' as const,
                  callback: async () => ({ type: 'failed' as const }),
                };
              }

              return {
                url: prepared.url,
                instructions:
                  'A browser tab is opening on windsurf.com. Sign in with your Windsurf account; ' +
                  'this CLI is listening on a local port and will capture the token automatically.',
                method: 'auto' as const,
                async callback() {
                  // opencode swallows our thrown errors and prints a generic
                  // "Failed to authorize". Mirror the *cause* to a known
                  // tmpfile so the user can `cat` it after a failure without
                  // setting any env vars.
                  const errLogPath = path.join(os.tmpdir(), 'opencode-windsurf-auth-last-error.log');
                  const writeErr = (stage: string, err: unknown) => {
                    const detail =
                      err instanceof Error
                        ? `${err.name}: ${err.message}\n${err.stack ?? ''}`
                        : String(err);
                    try {
                      // 0600 + O_NOFOLLOW so a pre-planted symlink can't
                      // redirect the log elsewhere and the file isn't
                      // world-readable on shared hosts. Use openSync so
                      // we control the mode; writeFileSync's default
                      // mode is 0666 & ~umask (typically 0644).
                      try { fs.unlinkSync(errLogPath); } catch { /* not there, fine */ }
                      const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
                      const fd = fs.openSync(
                        errLogPath,
                        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
                        0o600,
                      );
                      try {
                        fs.writeSync(fd, `[${new Date().toISOString()}] stage=${stage}\n${detail}\n`);
                      } finally {
                        fs.closeSync(fd);
                      }
                    } catch { /* ok */ }
                  };

                  try {
                    let result;
                    try {
                      result = await prepared.awaitToken();
                    } catch (err) {
                      writeErr('awaitToken', err);
                      throw err;
                    }
                    try {
                      await saveCredentials({
                        apiKey: result.apiKey,
                        name: result.name,
                        apiServerUrl: result.apiServerUrl,
                        redirectUrl: result.redirectUrl,
                        issuedAt: new Date().toISOString(),
                        oauthClientId: DEFAULT_REGION.oauthClientId,
                        syncedViaOpencodeAuth: true,
                      });
                    } catch (err) {
                      writeErr('saveCredentials', err);
                      throw err;
                    }
                    try { fs.unlinkSync(errLogPath); } catch { /* ok */ }
                    return {
                      type: 'success' as const,
                      key: result.apiKey,
                    };
                  } catch (err) {
                    debugLog.log('[windsurf-plugin] OAuth flow failed:', err instanceof Error ? err.message : err);
                    return { type: 'failed' as const };
                  }
                },
              };
            },
          },
        ],
      },

      // Dynamic baseURL injection (key pattern from cursor-auth)
      async 'chat.params'(input: ChatParamsInput, output: ChatParamsOutput) {
        if (input.model?.providerID !== providerId) {
          return;
        }

        // Inject the proxy server URL + the per-process Bearer secret.
        // opencode's @ai-sdk/openai-compatible adapter forwards
        // `options.apiKey` as `Authorization: Bearer <key>`, which is
        // exactly the shape our proxy's authorizeProxyRequest expects.
        // Anyone else attempting to hit 127.0.0.1:<port> without the
        // secret gets a 401. `output.options` is typed
        // `Record<string, any>` on the Hooks side, but we only ever set two
        // string fields — keep the writes narrow.
        output.options = output.options || {};
        output.options.baseURL = proxyBaseURL;
        output.options.apiKey = PROXY_SECRET;
      },
    };
    // `client` is available for future direct auth.set/get operations.
    void client;
  };

/**
 * Default Windsurf plugin export. opencode discovers this via the default
 * export and registers a single provider with id `windsurf`. (We previously
 * also exported a CodeiumPlugin alias that registered a second provider id
 * `codeium`; that surfaced as a duplicate entry in `opencode auth login`'s
 * picker and has been removed.)
 */
export const WindsurfPlugin = createWindsurfPlugin();

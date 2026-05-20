/**
 * Cascade RPC client.
 *
 * Windsurf 2.x rejects RawGetChatMessage with "Cascade session error, please
 * update your editor" unless the request belongs to a Cascade trajectory the
 * language_server already knows about. This module drives the same RPC flow
 * the IDE uses to start a fresh Cascade for each chat:
 *
 *   1. InitializeCascadePanelState(metadata)       — once per process
 *   2. StartCascade(metadata, source, type)        — per conversation
 *   3. SendUserCascadeMessage(cascade_id, items,
 *                             metadata, cascade_config)
 *   4. GetCascadeTranscriptForTrajectoryId(cascade_id)
 *      — polled until `num_total_steps` stops growing
 *
 * The transcript already comes back as a flat text dump with explicit
 * `=== MESSAGE N - Assistant ===` headers, so we can extract the assistant
 * reply by splitting on those headers — no CortexTrajectory parsing required.
 */

import * as http2 from 'http2';
import * as crypto from 'crypto';
import { WindsurfCredentials, WindsurfError, WindsurfErrorCode } from './auth.js';
import { getMetadataFields } from './discovery.js';
import {
  encodeBoolField,
  encodeMessage,
  encodeString,
  encodeVarintField,
} from './protobuf.js';

function encodeTimestampBody(): number[] {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const nanos = (now % 1000) * 1_000_000;
  const bytes: number[] = [...encodeVarintField(1, seconds)];
  if (nanos > 0) bytes.push(...encodeVarintField(2, nanos));
  return bytes;
}

function osString(): string {
  switch (process.platform) {
    case 'darwin':
      return 'darwin';
    case 'linux':
      return 'linux';
    case 'win32':
      return 'windows';
    default:
      return String(process.platform);
  }
}

// Module-scoped monotonic request_id, matches what MetadataProvider does in extension.js.
let nextRequestId = BigInt(Date.now());

/**
 * Build a Metadata message body matching what MetadataProvider.getMetadata()
 * ships in the bundled Windsurf extension. Fields populated:
 *   1 ide_name, 2 extension_version, 3 api_key, 4 locale, 5 os, 7 ide_version,
 *   9 request_id, 10 session_id, 12 extension_name, 16 ls_timestamp,
 *   17 extension_path (empty), 24 device_fingerprint (empty), 25 trigger_id,
 *   26 plan_name, 28 ide_type.
 */
function buildMetadata(creds: WindsurfCredentials, sessionId: string): number[] {
  const fields = getMetadataFields();
  const requestId = nextRequestId++;
  const triggerId = crypto.randomUUID();
  return [
    ...encodeString(fields.ide_name, 'windsurf'),
    ...encodeString(fields.extension_version, creds.version),
    ...encodeString(fields.api_key, creds.apiKey),
    ...encodeString(fields.locale, 'en'),
    ...encodeString(fields.os, osString()),
    ...encodeString(fields.ide_version, creds.version),
    ...encodeVarintField(fields.request_id, requestId),
    ...encodeString(fields.session_id, sessionId),
    ...encodeString(fields.extension_name, 'windsurf'),
    ...encodeMessage(fields.ls_timestamp, encodeTimestampBody()),
    ...encodeString(fields.extension_path, ''),
    ...encodeString(fields.device_fingerprint, ''),
    ...encodeString(fields.trigger_id, triggerId),
    ...encodeString(fields.plan_name, 'Unset'),
    ...encodeString(fields.ide_type, 'windsurf'),
  ];
}

// ============================================================================
// gRPC unary helper
// ============================================================================

function unaryRpc(
  creds: WindsurfCredentials,
  rpcName: string,
  payload: Buffer,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WindsurfError(`${rpcName} aborted`, WindsurfErrorCode.STREAM_ERROR));
      return;
    }
    const client = http2.connect(`http://localhost:${creds.port}`);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () =>
      finish(() => reject(new WindsurfError(`${rpcName} aborted`, WindsurfErrorCode.STREAM_ERROR)));
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal) signal.removeEventListener('abort', onAbort);
      client.close();
      fn();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    client.on('error', (err) => finish(() => reject(wrapError(rpcName, err))));

    const req = client.request({
      ':method': 'POST',
      ':path': `/exa.language_server_pb.LanguageServerService/${rpcName}`,
      'content-type': 'application/grpc',
      te: 'trailers',
      'x-codeium-csrf-token': creds.csrfToken,
    });

    const frame = Buffer.alloc(5 + payload.length);
    frame[0] = 0;
    frame.writeUInt32BE(payload.length, 1);
    payload.copy(frame, 5);

    let received = Buffer.alloc(0);
    let grpcStatus: string | null = null;
    let grpcMessage = '';

    req.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
    });

    req.on('trailers', (trailers) => {
      grpcStatus = String(trailers['grpc-status'] ?? '');
      const msg = trailers['grpc-message'];
      if (typeof msg === 'string') grpcMessage = decodeURIComponent(msg);
    });

    req.on('end', () => {
      finish(() => {
        if (grpcStatus !== null && grpcStatus !== '0') {
          reject(
            new WindsurfError(
              `${rpcName} gRPC error ${grpcStatus}: ${grpcMessage}`,
              WindsurfErrorCode.STREAM_ERROR
            )
          );
          return;
        }
        // Strip 5-byte gRPC frame header.
        resolve(received.length >= 5 ? received.subarray(5) : received);
      });
    });

    req.on('error', (err) => finish(() => reject(wrapError(rpcName, err))));

    req.write(frame);
    req.end();

    timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new WindsurfError(
              `${rpcName} timed out after ${timeoutMs}ms`,
              WindsurfErrorCode.STREAM_ERROR
            )
          )
        ),
      timeoutMs
    );
  });
}

function wrapError(rpcName: string, err: Error): WindsurfError {
  return new WindsurfError(
    `${rpcName} failed: ${err.message}`,
    WindsurfErrorCode.CONNECTION_FAILED,
    err
  );
}

// ============================================================================
// Protobuf field walker (response decoding)
// ============================================================================

import { decodeVarint as decodeVarintAt } from './protobuf.js';

function walkFields(
  buf: Buffer,
  visit: (field: number, wire: number, value: Buffer | bigint) => void
): void {
  let off = 0;
  while (off < buf.length) {
    const [tag, tagN] = decodeVarintAt(buf, off);
    off += tagN;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 0x7n);
    if (wire === 0) {
      const [val, vn] = decodeVarintAt(buf, off);
      visit(field, wire, val);
      off += vn;
    } else if (wire === 2) {
      const [len, ln] = decodeVarintAt(buf, off);
      off += ln;
      const L = Number(len);
      visit(field, wire, buf.subarray(off, off + L));
      off += L;
    } else if (wire === 1) {
      off += 8;
    } else if (wire === 5) {
      off += 4;
    } else {
      return; // unknown wire — give up rather than mis-parse the rest
    }
  }
}

// ============================================================================
// Cascade RPCs
// ============================================================================

/**
 * Called once per plugin process. Without this, subsequent RPCs from a
 * non-IDE client get rejected by the language_server's session check.
 *
 * The InitializeCascadePanelStateResponse is empty; we just want grpc-status 0.
 */
export async function initializeCascadePanelState(
  creds: WindsurfCredentials,
  signal?: AbortSignal
): Promise<void> {
  const meta = buildMetadata(creds, crypto.randomUUID());
  const payload = Buffer.from(encodeMessage(1, meta));
  await unaryRpc(creds, 'InitializeCascadePanelState', payload, 10_000, signal);
}

/**
 * StartCascade creates a fresh Cascade trajectory.
 *
 * We intentionally omit `base_trajectory_identifier`. Passing
 * `last_active_doc=true` attaches us to whichever Cascade the IDE is currently
 * showing, and we end up appending into that conversation — not what an
 * automated client wants. The empty identifier reliably creates a new one.
 *
 * Constants from `exa.cortex_pb`:
 *   - CortexTrajectorySource.CASCADE_CLIENT = 1
 *   - CortexTrajectoryType.CASCADE          = 4
 */
export async function startCascade(
  creds: WindsurfCredentials,
  signal?: AbortSignal
): Promise<string> {
  const meta = buildMetadata(creds, crypto.randomUUID());
  const payload = Buffer.from([
    ...encodeMessage(1, meta),
    ...encodeVarintField(4, 1), // source
    ...encodeVarintField(5, 4), // trajectory_type
  ]);

  const body = await unaryRpc(creds, 'StartCascade', payload, 10_000, signal);

  let cascadeId = '';
  walkFields(body, (field, wire, value) => {
    // StartCascadeResponse.cascade_id is field 1 (string).
    if (field === 1 && wire === 2 && Buffer.isBuffer(value)) {
      cascadeId = value.toString('utf8');
    }
  });

  if (!cascadeId) {
    throw new WindsurfError(
      'StartCascade returned without a cascade_id',
      WindsurfErrorCode.STREAM_ERROR
    );
  }
  return cascadeId;
}

/**
 * Send the user's prompt into a cascade. `modelUid` is the proto enum name
 * exactly as it appears in `exa.codeium_common_pb.Model`, e.g.
 * "MODEL_CLAUDE_4_5_OPUS". The IDE itself passes it the same way (via
 * enumToString in extension.js).
 *
 * The cascade_config bundles two minimum-viable selections:
 *   - planner_type_config.conversational = {}  (use the chat-style planner)
 *   - planner_config.requested_model_uid = <modelUid>
 * Without these the server returns
 *   "neither PlanModel nor RequestedModel specified"
 * and the cascade does not run.
 */
export async function sendUserCascadeMessage(
  creds: WindsurfCredentials,
  cascadeId: string,
  text: string,
  modelUid: string,
  signal?: AbortSignal
): Promise<void> {
  const meta = buildMetadata(creds, crypto.randomUUID());

  // TextOrScopeItem { text: string }  (field 1 of oneof "chunk")
  const item = encodeString(1, text);

  // CascadePlannerConfig body {
  //   conversational: {} (field 2 oneof "planner_type_config"),
  //   requested_model_uid: <modelUid> (field 35),
  // }
  const plannerConfigBody: number[] = [
    ...encodeMessage(2, []),
    ...encodeString(35, modelUid),
  ];

  // CascadeConfig body { planner_config: plannerConfigBody (field 1) }
  const cascadeConfigBody: number[] = encodeMessage(1, plannerConfigBody);

  // SendUserCascadeMessageRequest:
  //   field 1: cascade_id (string)
  //   field 2: items (repeated TextOrScopeItem)
  //   field 3: metadata
  //   field 5: cascade_config
  //   field 8: blocking (bool)
  const payload = Buffer.from([
    ...encodeString(1, cascadeId),
    ...encodeMessage(2, item),
    ...encodeMessage(3, meta),
    ...encodeMessage(5, cascadeConfigBody),
    ...encodeBoolField(8, false),
  ]);

  await unaryRpc(creds, 'SendUserCascadeMessage', payload, 30_000, signal);
}

interface Transcript {
  transcript: string;
  numTotalSteps: number;
}

/**
 * Returns the cascade's current transcript as a single human-readable string,
 * with each step prefixed by "=== MESSAGE N - <Role> ===" headers — exactly
 * the same format the IDE renders into the chat panel.
 *
 * Polling this is much simpler than parsing CortexTrajectory steps and
 * extracting CortexStepPlannerResponse.response by hand.
 */
export async function getCascadeTranscript(
  creds: WindsurfCredentials,
  cascadeId: string,
  stepOffset = 0,
  signal?: AbortSignal
): Promise<Transcript> {
  // GetCascadeTranscriptForTrajectoryIdRequest:
  //   field 1: cascade_id (string)
  //   field 2: step_offset (uint32) — only send if non-zero (proto3 default)
  const body = await unaryRpc(
    creds,
    'GetCascadeTranscriptForTrajectoryId',
    Buffer.from([
      ...encodeString(1, cascadeId),
      ...(stepOffset > 0 ? encodeVarintField(2, stepOffset) : []),
    ]),
    10_000,
    signal
  );

  let transcript = '';
  let numTotalSteps = 0;
  walkFields(body, (field, wire, value) => {
    if (field === 1 && wire === 2 && Buffer.isBuffer(value)) {
      transcript = value.toString('utf8');
    } else if (field === 2 && wire === 0) {
      numTotalSteps = Number(value as bigint);
    }
  });
  return { transcript, numTotalSteps };
}

/**
 * Parse the Windsurf-style transcript into role-tagged segments, in order.
 *
 * The transcript looks like:
 *   === MESSAGE 0 - Tool ===
 *   [CORTEX_STEP_TYPE_RETRIEVE_MEMORY]
 *
 *   === MESSAGE 1 - User ===
 *   <user prompt>
 *
 *   === MESSAGE 2 - Assistant ===
 *   <assistant reply...>
 *
 *   === MESSAGE 3 - Tool ===
 *   [CORTEX_STEP_TYPE_CHECKPOINT]
 */
const MESSAGE_HEADER_RE = /^=== MESSAGE (\d+) - (\w+) ===$/;

export interface TranscriptMessage {
  index: number;
  role: 'User' | 'Assistant' | 'Tool' | 'System';
  text: string;
}

export function parseTranscript(transcript: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  const lines = transcript.split(/\r?\n/);
  let current: TranscriptMessage | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current) {
      current.text = buffer.join('\n').trim();
      messages.push(current);
    }
    buffer = [];
  };
  for (const line of lines) {
    const m = MESSAGE_HEADER_RE.exec(line);
    if (m) {
      flush();
      const role = m[2] as TranscriptMessage['role'];
      current = { index: Number(m[1]), role, text: '' };
    } else if (current) {
      buffer.push(line);
    }
  }
  flush();
  return messages;
}

// ============================================================================
// High-level streaming chat
// ============================================================================

/**
 * Cached InitializeCascadePanelState calls keyed by CSRF token.
 *
 * The language_server resets its panel state when Windsurf restarts, and the
 * restart also rotates the CSRF token — so keying by token self-heals across
 * restarts without needing to detect them explicitly. We store the in-flight
 * Promise (not just a boolean) so concurrent first-callers share a single RPC.
 */
const panelInitPromises = new Map<string, Promise<void>>();

// Returns the exact Promise stored in the map (NOT an async-wrapper around
// it) so callers can capture it and later compare-and-delete safely.
//
// The signal is intentionally NOT applied to the cached promise — the panel
// init is shared across concurrent callers and aborting it for one would
// cancel it for all of them. Callers should check their own signal after
// awaiting this.
function ensurePanelInitialized(creds: WindsurfCredentials, _signal?: AbortSignal): Promise<void> {
  let p = panelInitPromises.get(creds.csrfToken);
  if (!p) {
    p = initializeCascadePanelState(creds).catch((err) => {
      panelInitPromises.delete(creds.csrfToken);
      throw err;
    });
    panelInitPromises.set(creds.csrfToken, p);
  }
  return p;
}

/**
 * Track in-flight archive RPCs so a graceful shutdown can wait for them.
 * Without this the parent process could exit while archives are mid-flight,
 * leaving a leaked .pb file behind. Bounded only by how many concurrent
 * `streamCascadeChat` calls were in progress.
 */
const inFlightArchives = new Set<Promise<void>>();

/**
 * Best-effort cleanup so we don't leak ~20MB .pb files into
 * ~/.codeium/windsurf/cascade/ on every chat. Errors are swallowed; the
 * archive is purely housekeeping and the user-visible response is already
 * complete by the time this runs.
 */
function archiveCascade(creds: WindsurfCredentials, cascadeId: string): Promise<void> {
  const p = (async () => {
    try {
      const payload = Buffer.from(encodeString(1, cascadeId));
      await unaryRpc(creds, 'ArchiveCascadeTrajectory', payload, 5_000);
    } catch {
      /* best effort — leftover .pb files are not user-visible */
    }
  })();
  inFlightArchives.add(p);
  void p.finally(() => inFlightArchives.delete(p));
  return p;
}

/**
 * Wait for any outstanding `archiveCascade` calls to settle. Call this from a
 * process-exit hook in callers that care about disk hygiene (the plugin
 * itself doesn't currently install one — opencode is long-lived).
 */
export async function flushPendingArchives(): Promise<void> {
  await Promise.allSettled([...inFlightArchives]);
}

/**
 * Map a canonical model id (claude-4.5-opus, swe-1.5, …) to the
 * `MODEL_*` proto enum name Windsurf's PlannerConfig wants.
 *
 * Lookup table maintained in models.ts. We accept the raw enum number as a
 * fallback for callers that already resolved it.
 */
export function modelEnumNameFromId(canonical: string, fallbackEnumName?: string): string {
  if (canonical.startsWith('MODEL_')) return canonical;
  if (fallbackEnumName) return fallbackEnumName;
  // Final fallback: best-effort transform "claude-4.5-opus" → "MODEL_CLAUDE_4_5_OPUS"
  return `MODEL_${canonical
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')}`;
}

/**
 * One-shot Cascade run. Yields the assistant reply in chunks as the
 * transcript grows. Resolves when the cascade reports no new steps for
 * `STEADY_TICKS_BEFORE_DONE` consecutive polls.
 *
 * The transcript carries the entire conversation; we yield just the delta of
 * the *latest* Assistant message between polls, so callers see streaming text.
 */
export interface CascadeChatOptions {
  prompt: string;
  modelUid: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /**
   * Abort the run mid-poll. The async generator throws a `WindsurfError`
   * tagged "aborted" so the caller's `for await` loop exits promptly. The
   * cascade trajectory is still archived via the `finally` block. Wire this
   * up via `ReadableStream.cancel()` so client-disconnects don't leave a
   * 5-minute zombie poll loop running on the server.
   */
  signal?: AbortSignal;
}

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const STEADY_TICKS_BEFORE_DONE = 4;
// Sliding window for poll-error tracking. A flapping language_server
// (e.g. mid-restart) used to alternate error/success forever because the
// counter reset on every successful poll. Now we keep a count of failures
// in the *last MAX_POLL_ERROR_WINDOW polls* and bail if it crosses the limit.
const MAX_CONSECUTIVE_POLL_ERRORS = 3;
const MAX_POLL_ERRORS_PER_WINDOW = 5;
const POLL_ERROR_WINDOW_SIZE = 15;

export async function* streamCascadeChat(
  creds: WindsurfCredentials,
  options: CascadeChatOptions
): AsyncGenerator<string, void, unknown> {
  const { signal } = options;
  const abortError = () =>
    new WindsurfError('Cascade run aborted by caller', WindsurfErrorCode.STREAM_ERROR);
  if (signal?.aborted) throw abortError();

  // Snapshot the panel-init promise we observed so the retry path can
  // compare-and-delete safely under concurrent callers (see below).
  const panelInitPromiseSnapshot = ensurePanelInitialized(creds);
  await panelInitPromiseSnapshot;
  if (signal?.aborted) throw abortError();

  let cascadeId: string;
  try {
    cascadeId = await startCascade(creds, signal);
  } catch (err) {
    // If the panel cache went stale (e.g. language_server lost state), clear
    // the cache and retry once. We accept several phrasings the LS uses for
    // session-gate errors, since the exact string varies across builds.
    const sessionish =
      err instanceof WindsurfError &&
      /cascade session|panel.*not.*initialized|session expired|panel state/i.test(err.message);
    if (sessionish) {
      // Compare-and-delete so we don't evict a *different* concurrent caller's
      // valid init promise that just happens to share our CSRF token.
      const current = panelInitPromises.get(creds.csrfToken);
      const captured = panelInitPromiseSnapshot;
      if (current === captured) panelInitPromises.delete(creds.csrfToken);
      await ensurePanelInitialized(creds, signal);
      cascadeId = await startCascade(creds, signal);
    } else {
      throw err;
    }
  }

  try {
    await sendUserCascadeMessage(creds, cascadeId, options.prompt, options.modelUid, signal);

    const start = Date.now();
    const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const pollTimeout = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;

    let lastSteps = -1;
    let steadyTicks = 0;
    let consecutivePollErrors = 0;
    let lastPollError: unknown = null;
    let bytesEmittedTotal = 0;
    let sawCheckpoint = false; // CORTEX_STEP_TYPE_CHECKPOINT — cascade is done

    // Sliding window of recent poll outcomes (true = error, false = ok).
    const recentPollOutcomes: boolean[] = [];
    const recordPollOutcome = (errored: boolean) => {
      recentPollOutcomes.push(errored);
      if (recentPollOutcomes.length > POLL_ERROR_WINDOW_SIZE) recentPollOutcomes.shift();
    };
    const errorsInWindow = () => recentPollOutcomes.filter(Boolean).length;

    // Per-Assistant-message-index state. Multi-step planner runs produce
    // multiple Assistant messages (interleaved with Tool steps); we need to
    // stream every one in order rather than only the latest. We track the
    // *exact text we've already emitted* per index so we can detect genuine
    // forward growth vs server-side rewrites (Cascade does rewrite earlier
    // text after checkpoint/redaction).
    interface AssistantStreamState {
      emittedText: string;
    }
    const emittedByIndex = new Map<number, AssistantStreamState>();
    let lastEmittedIndex = -1;

    while (Date.now() - start < pollTimeout) {
      // Abortable sleep — resolves immediately on signal.abort so client
      // disconnects don't have to wait a full pollInterval before bailing.
      //
      // We remove the abort listener on BOTH the timeout-fires-normally and
      // the signal-aborts paths so a long poll loop doesn't accumulate stale
      // listeners on the same AbortSignal across hundreds of iterations.
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        let onAbort: (() => void) | null = null;
        const t = setTimeout(() => {
          if (onAbort && signal) signal.removeEventListener('abort', onAbort);
          resolve();
        }, pollInterval);
        if (signal) {
          onAbort = () => {
            clearTimeout(t);
            resolve();
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      if (signal?.aborted) throw abortError();

      let snapshot: Transcript;
      try {
        // step_offset stays at 0 deliberately. The field is plumbed through
        // getCascadeTranscript so future versions can opt in, but the server
        // appears to respect it by truncating the transcript output — which
        // would re-index our Assistant messages and break the per-index
        // delta tracking. Re-fetching the full transcript every poll is
        // cheap on localhost (~240KB per poll) and correctness wins.
        snapshot = await getCascadeTranscript(creds, cascadeId, 0, signal);
        consecutivePollErrors = 0;
        recordPollOutcome(false);
      } catch (err) {
        consecutivePollErrors++;
        recordPollOutcome(true);
        lastPollError = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (
          consecutivePollErrors >= MAX_CONSECUTIVE_POLL_ERRORS ||
          errorsInWindow() >= MAX_POLL_ERRORS_PER_WINDOW
        ) {
          throw new WindsurfError(
            `Cascade transcript polling failed (${consecutivePollErrors} consecutive, ` +
              `${errorsInWindow()} in last ${recentPollOutcomes.length} polls) — last error: ${msg}`,
            WindsurfErrorCode.STREAM_ERROR,
            err
          );
        }
        steadyTicks = 0;
        continue;
      }

      const messages = parseTranscript(snapshot.transcript);
      const bytesBefore = bytesEmittedTotal;

      // The transcript dump is *usually* monotonic by index, but the Cascade
      // server doesn't guarantee it (planner branches/checkpoint rewrites can
      // insert a smaller-indexed Assistant message later). Sort just the
      // Assistant entries by index so streaming deltas stay in user-visible
      // order regardless.
      const assistantMessages = messages
        .filter((m) => m.role === 'Assistant')
        .sort((a, b) => a.index - b.index);
      for (const m of messages) {
        if (m.role === 'Tool' && m.text.includes('CORTEX_STEP_TYPE_CHECKPOINT')) {
          sawCheckpoint = true;
        }
      }

      for (const msg of assistantMessages) {
        const state = emittedByIndex.get(msg.index) ?? { emittedText: '' };
        const currentText = msg.text;
        if (currentText === state.emittedText) continue;

        // Forward growth = current text strictly extends what we already
        // emitted. Anything else is a rewrite/backfill — we resync state
        // silently rather than risk double-emitting bytes that the consumer
        // (typically OpenCode SSE) already rendered.
        const grewForward =
          currentText.length > state.emittedText.length &&
          currentText.startsWith(state.emittedText);

        if (grewForward) {
          // Only emit the inter-message separator when we're *also* about to
          // emit actual text — otherwise a silent rewrite resync would leak
          // a blank `\n\n` into the consumer's stream.
          if (msg.index !== lastEmittedIndex && lastEmittedIndex !== -1) {
            yield '\n\n';
          }
          const delta = currentText.slice(state.emittedText.length);
          if (delta) {
            yield delta;
            bytesEmittedTotal += delta.length;
          }
          lastEmittedIndex = msg.index;
        }
        // In both forward-growth and rewrite cases, resync our stored state
        // so future deltas are computed from the latest server text.
        state.emittedText = currentText;
        emittedByIndex.set(msg.index, state);
      }

      const grewBytes = bytesEmittedTotal !== bytesBefore;
      const grewSteps = snapshot.numTotalSteps !== lastSteps;

      if (grewSteps || grewBytes) {
        // Text is still flowing or steps still being added — keep polling.
        steadyTicks = 0;
        lastSteps = snapshot.numTotalSteps;
      } else {
        steadyTicks++;
        // Only declare done when EITHER the assistant has actually emitted
        // text OR a CHECKPOINT step has appeared signalling Cascade is done.
        // The previous looser `sawNonUserMessage` gate would let Tool-only
        // transcripts (e.g. the initial RETRIEVE_MEMORY/MEMORY pair before
        // the planner kicks in) terminate the loop with empty output.
        const cascadeFinished = bytesEmittedTotal > 0 || sawCheckpoint;
        if (steadyTicks >= STEADY_TICKS_BEFORE_DONE && cascadeFinished) {
          return;
        }
      }
    }

    const tail =
      lastPollError instanceof Error ? ` (last poll error: ${lastPollError.message})` : '';
    throw new WindsurfError(
      `Cascade timed out after ${pollTimeout}ms (cascade_id=${cascadeId})${tail}`,
      WindsurfErrorCode.STREAM_ERROR
    );
  } finally {
    void archiveCascade(creds, cascadeId);
  }
}

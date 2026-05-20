/**
 * gRPC Client for Windsurf Language Server
 * 
 * Implements HTTP/2-based gRPC communication with the local Windsurf language server.
 * Uses manual protobuf encoding (no external protobuf library needed).
 */

import * as http2 from 'http2';
import * as crypto from 'crypto';
import { ChatMessageSource } from './types.js';
import { resolveModel } from './models.js';
import { WindsurfCredentials, WindsurfError, WindsurfErrorCode } from './auth.js';

// ============================================================================
// Types
// ============================================================================

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
}

export interface StreamChatOptions {
  model: string;
  messages: ChatMessage[];
  onChunk?: (text: string) => void;
  onComplete?: (fullText: string) => void;
  onError?: (error: Error) => void;
  variantOverride?: string;
}

// ============================================================================
// Protobuf Encoding Helpers
// ============================================================================
//
// Shared in src/plugin/protobuf.ts so production code and the diagnostic
// scripts in tests/live/ use exactly the same implementation. The previous
// inline copy here used a single-byte tag (`(fieldNum << 3) | 2`) which
// silently corrupted any field with number >= 16 — see protobuf.ts for the
// historical context.
import {
  encodeString,
  encodeMessage,
  encodeVarintField,
} from './protobuf.js';

// ============================================================================
// Request Building
// ============================================================================

/**
 * Generate a UUID for message and conversation IDs
 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Encode a google.protobuf.Timestamp
 * Field 1: seconds (int64)
 * Field 2: nanos (int32)
 */
function encodeTimestamp(): number[] {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const nanos = (now % 1000) * 1_000_000;

  const bytes: number[] = [];
  bytes.push(...encodeVarintField(1, seconds));
  if (nanos > 0) {
    bytes.push(...encodeVarintField(2, nanos));
  }
  return bytes;
}

/**
 * Encode IntentGeneric message
 * Field 1: text (string)
 */
function encodeIntentGeneric(text: string): number[] {
  return encodeString(1, text);
}

/**
 * Encode ChatMessageIntent message
 * Field 1: generic (IntentGeneric, oneof)
 * Field 12: num_tokens (int32)
 */
function encodeChatMessageIntent(text: string): number[] {
  const generic = encodeIntentGeneric(text);
  return encodeMessage(1, generic);
}

/**
 * Encode a ChatMessage for the RawGetChatMessageRequest
 * 
 * ChatMessage structure (from reverse engineering):
 * Field 1: message_id (string, required)
 * Field 2: source (enum: 1=USER, 2=SYSTEM, 3=ASSISTANT)
 * Field 3: timestamp (google.protobuf.Timestamp, required)
 * Field 4: conversation_id (string, required)
 * Field 5: For USER/SYSTEM/TOOL: intent (ChatMessageIntent)
 *          For ASSISTANT: text (string)
 */
function encodeChatMessage(content: string, source: number, conversationId: string): number[] {
  const messageId = generateUUID();
  const bytes: number[] = [];

  // Field 1: message_id (required)
  bytes.push(...encodeString(1, messageId));

  // Field 2: source
  bytes.push(...encodeVarintField(2, source));

  // Field 3: timestamp (required)
  const timestamp = encodeTimestamp();
  bytes.push(...encodeMessage(3, timestamp));

  // Field 4: conversation_id (required)
  bytes.push(...encodeString(4, conversationId));

  // Field 5: content
  if (source === ChatMessageSource.ASSISTANT) {
    // Assistant replies use plain text field
    bytes.push(...encodeString(5, content));
  } else {
    const intent = encodeChatMessageIntent(content);
    bytes.push(...encodeMessage(5, intent));
  }

  return bytes;
}

import { getMetadataFields } from './discovery.js';

/**
 * Monotonic per-process request_id (uint64 varint).
 * Windsurf increments this for every Metadata it emits and the server uses it
 * to correlate the call with the Cascade session that owns the API key.
 */
let nextRequestId = BigInt(Date.now());

/**
 * Map process.platform → the OS string Windsurf reports.
 * Windsurf uses "darwin"/"linux"/"windows" with no architecture suffix.
 */
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

/** Encode a google.protobuf.Timestamp body (seconds + nanos). */
function encodeTimestampBody(): number[] {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const nanos = (now % 1000) * 1_000_000;
  const bytes: number[] = [...encodeVarintField(1, seconds)];
  if (nanos > 0) bytes.push(...encodeVarintField(2, nanos));
  return bytes;
}

/**
 * Build the Metadata message Windsurf expects.
 *
 * Mirrors what `MetadataProvider.getMetadata()` ships in the bundled extension
 * (extension.js): ide_name, ide_version, extension_name, extension_version,
 * extension_path, api_key, session_id, request_id (BigInt), locale,
 * device_fingerprint, plan_name, trigger_id, os, ide_type, ls_timestamp.
 *
 * Without the request_id / trigger_id / extension_name / os fields the server
 * returns `failed_precondition: Cascade session error` for every chat model the
 * user is otherwise allowed to use.
 */
function encodeMetadata(apiKey: string, version: string, sessionId: string): number[] {
  const fields = getMetadataFields();
  const requestId = nextRequestId++;
  const triggerId = generateUUID();

  const parts: number[] = [];
  parts.push(...encodeString(fields.ide_name, 'windsurf'));
  parts.push(...encodeString(fields.extension_version, version));
  parts.push(...encodeString(fields.api_key, apiKey));
  parts.push(...encodeString(fields.locale, 'en'));
  parts.push(...encodeString(fields.os, osString()));
  parts.push(...encodeString(fields.ide_version, version));
  parts.push(...encodeVarintField(fields.request_id, requestId));
  parts.push(...encodeString(fields.session_id, sessionId));
  parts.push(...encodeString(fields.extension_name, 'windsurf'));
  parts.push(...encodeMessage(fields.ls_timestamp, encodeTimestampBody()));
  parts.push(...encodeString(fields.extension_path, ''));
  parts.push(...encodeString(fields.device_fingerprint, ''));
  parts.push(...encodeString(fields.trigger_id, triggerId));
  parts.push(...encodeString(fields.plan_name, 'Unset'));
  parts.push(...encodeString(fields.ide_type, 'windsurf'));
  return parts;
}

/**
 * Map role string to ChatMessageSource enum value
 */
function roleToSource(role: string): number {
  switch (role) {
    case 'user':
      return ChatMessageSource.USER;
    case 'assistant':
      return ChatMessageSource.ASSISTANT;
    case 'system':
      return ChatMessageSource.SYSTEM;
    case 'tool':
      return ChatMessageSource.TOOL;
    default:
      return ChatMessageSource.USER;
  }
}

/**
 * Build the complete chat request buffer using RawGetChatMessageRequest format
 * 
 * RawGetChatMessageRequest structure:
 * Field 1: metadata (Metadata message)
 * Field 2: chat_messages (repeated ChatMessage)
 * Field 3: system_prompt_override (string) - optional
 * Field 4: chat_model (enum: Model)
 * Field 5: chat_model_name (string) - optional
 */
function buildChatRequest(
  apiKey: string,
  version: string,
  modelEnum: number,
  messages: ChatMessage[],
  modelName?: string
): Buffer {
  const sessionId = generateUUID();
  const metadata = encodeMetadata(apiKey, version, sessionId);
  const conversationId = generateUUID();

  // Build the request with all messages
  const request: number[] = [];

  // Field 1: metadata
  request.push(...encodeMessage(1, metadata));

  // Field 2: chat_messages (repeated ChatMessage)
  // Extract system message if present and handle separately
  let systemPrompt = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt = msg.content;
    } else {
      // Encode each message as ChatMessage with ChatMessageIntent
      const source = roleToSource(msg.role);
      const chatMsg = encodeChatMessage(msg.content, source, conversationId);
      request.push(...encodeMessage(2, chatMsg));
    }
  }

  // Field 3: system_prompt_override (if we have a system message)
  if (systemPrompt) {
    request.push(...encodeString(3, systemPrompt));
  }

  // Field 4: model enum
  request.push(...encodeVarintField(4, modelEnum));

  // Field 5: chat_model_name (string) if provided
  if (modelName) {
    request.push(...encodeString(5, modelName));
  }

  const payload = Buffer.from(request);

  // gRPC framing: 1 byte compression flag (0) + 4 bytes length + payload
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0; // No compression
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);

  return frame;
}

// ============================================================================
// Response Parsing (Protobuf Decoding)
// ============================================================================

// decodeVarint comes from the shared protobuf module too.
import { decodeVarint } from './protobuf.js';

/**
 * Parse a protobuf field from buffer
 * @returns { fieldNum, wireType, value, bytesConsumed } or null if can't parse
 */
function parseProtobufField(buffer: Buffer, offset: number): {
  fieldNum: number;
  wireType: number;
  value: Buffer | bigint;
  bytesConsumed: number
} | null {
  if (offset >= buffer.length) return null;

  const [tag, tagBytes] = decodeVarint(buffer, offset);
  const fieldNum = Number(tag >> 3n);
  const wireType = Number(tag & 0x7n);

  let bytesConsumed = tagBytes;
  let value: Buffer | bigint;

  switch (wireType) {
    case 0: // Varint
      const [varintValue, varintBytes] = decodeVarint(buffer, offset + bytesConsumed);
      value = varintValue;
      bytesConsumed += varintBytes;
      break;

    case 2: // Length-delimited (string, bytes, embedded message)
      const [length, lengthBytes] = decodeVarint(buffer, offset + bytesConsumed);
      bytesConsumed += lengthBytes;
      const len = Number(length);
      if (offset + bytesConsumed + len > buffer.length) {
        // Not enough data
        return null;
      }
      value = buffer.subarray(offset + bytesConsumed, offset + bytesConsumed + len);
      bytesConsumed += len;
      break;

    case 1: // 64-bit (fixed64, sfixed64, double)
      if (offset + bytesConsumed + 8 > buffer.length) return null;
      value = buffer.subarray(offset + bytesConsumed, offset + bytesConsumed + 8);
      bytesConsumed += 8;
      break;

    case 5: // 32-bit (fixed32, sfixed32, float)
      if (offset + bytesConsumed + 4 > buffer.length) return null;
      value = buffer.subarray(offset + bytesConsumed, offset + bytesConsumed + 4);
      bytesConsumed += 4;
      break;

    default:
      // Unknown wire type, can't parse
      return null;
  }

  return { fieldNum, wireType, value, bytesConsumed };
}

/**
 * Extract text from RawChatMessage protobuf
 * 
 * RawChatMessage structure:
 * Field 1: message_id (string)
 * Field 2: source (enum)
 * Field 3: timestamp (message)
 * Field 4: conversation_id (string)
 * Field 5: text (string) ← What we want
 * Field 6: in_progress (bool)
 * Field 7: is_error (bool)
 */
function extractTextFromRawChatMessage(buffer: Buffer): string {
  let offset = 0;

  while (offset < buffer.length) {
    const field = parseProtobufField(buffer, offset);
    if (!field) break;

    offset += field.bytesConsumed;

    // Field 5 is the text content
    if (field.fieldNum === 5 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      return field.value.toString('utf8');
    }
  }

  return '';
}

/**
 * Extract text from RawGetChatMessageResponse protobuf
 * 
 * RawGetChatMessageResponse structure:
 * Field 1: delta_message (RawChatMessage)
 */
function extractTextFromResponse(buffer: Buffer): string {
  let offset = 0;

  while (offset < buffer.length) {
    const field = parseProtobufField(buffer, offset);
    if (!field) break;

    offset += field.bytesConsumed;

    // Field 1 is delta_message (RawChatMessage)
    if (field.fieldNum === 1 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      const text = extractTextFromRawChatMessage(field.value);
      if (text) return text;
    }
  }

  return '';
}

/**
 * Extract readable text from a gRPC response chunk
 * 
 * The response is gRPC-framed: 1 byte compression + 4 bytes length + protobuf payload
 * We parse the protobuf to extract the text field from RawChatMessage.
 */
function extractTextFromChunk(chunk: Buffer): string {
  // gRPC frame: 1 byte compression flag + 4 bytes message length + message
  // Multiple messages may be concatenated in a single chunk

  const results: string[] = [];
  let offset = 0;

  while (offset + 5 <= chunk.length) {
    const compressed = chunk[offset];
    const messageLength = chunk.readUInt32BE(offset + 1);

    if (compressed !== 0) {
      // Compressed data not supported, skip
      offset += 5 + messageLength;
      continue;
    }

    if (offset + 5 + messageLength > chunk.length) {
      // Not enough data for the full message, try as raw protobuf
      break;
    }

    const messageData = chunk.subarray(offset + 5, offset + 5 + messageLength);
    const text = extractTextFromResponse(messageData);

    if (text) {
      results.push(text);
    }

    offset += 5 + messageLength;
  }

  // If we extracted text from proper protobuf parsing, return it
  if (results.length > 0) {
    return results.join('');
  }

  // Fallback: try parsing the entire chunk as protobuf (in case framing was already stripped)
  const fallbackText = extractTextFromResponse(chunk);
  if (fallbackText) {
    return fallbackText;
  }

  // Last resort: heuristic extraction for edge cases
  return extractTextHeuristic(chunk);
}

/**
 * Fallback heuristic text extraction - DISABLED
 * The proper protobuf parsing should handle all cases.
 * If it fails, we return empty rather than risk returning garbage.
 */
function extractTextHeuristic(_chunk: Buffer): string {
  // Heuristic extraction is too unreliable and returns garbage metadata.
  // The proper protobuf parsing (extractTextFromResponse) should work.
  // If it doesn't, we return empty string rather than corrupted output.
  return '';
}

// ============================================================================
// Streaming API
// ============================================================================

/**
 * Stream chat completion using Promise-based API
 * 
 * @param credentials - Windsurf credentials (csrf, port, apiKey, version)
 * @param options - Chat options including model, messages, and callbacks
 * @returns Promise that resolves to the full response text
 */
export function streamChat(
  credentials: WindsurfCredentials,
  options: StreamChatOptions
): Promise<string> {
  const { csrfToken, port, apiKey, version } = credentials;
  const resolved = resolveModel(options.model);
  const modelEnum = resolved.enumValue;
  const modelName = resolved.variant ? `${resolved.modelId}:${resolved.variant}` : resolved.modelId;
  const body = buildChatRequest(apiKey, version, modelEnum, options.messages, modelName);

  return new Promise((resolve, reject) => {
    const client = http2.connect(`http://localhost:${port}`);
    const chunks: string[] = [];

    client.on('error', (err) => {
      options.onError?.(err);
      reject(new WindsurfError(
        `Connection failed: ${err.message}`,
        WindsurfErrorCode.CONNECTION_FAILED,
        err
      ));
    });

    client.on('connect', () => {
      const req = client.request({
        ':method': 'POST',
        ':path': '/exa.language_server_pb.LanguageServerService/RawGetChatMessage',
        'content-type': 'application/grpc',
        'te': 'trailers',
        'x-codeium-csrf-token': csrfToken,
      });

      req.on('data', (chunk: Buffer) => {
        const text = extractTextFromChunk(chunk);
        if (text) {
          chunks.push(text);
          options.onChunk?.(text);
        }
      });

      req.on('trailers', (trailers) => {
        const status = trailers['grpc-status'];
        if (status !== '0') {
          const message = trailers['grpc-message'];
          const err = new WindsurfError(
            `gRPC error ${status}: ${message ? decodeURIComponent(message as string) : 'Unknown error'}`,
            WindsurfErrorCode.STREAM_ERROR
          );
          options.onError?.(err);
          reject(err);
        }
      });

      req.on('end', () => {
        client.close();
        const fullText = chunks.join('');
        options.onComplete?.(fullText);
        resolve(fullText);
      });

      req.on('error', (err) => {
        client.close();
        options.onError?.(err);
        reject(new WindsurfError(
          `Request failed: ${err.message}`,
          WindsurfErrorCode.STREAM_ERROR,
          err
        ));
      });

      req.write(body);
      req.end();
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      client.close();
      const fullText = chunks.join('');
      options.onComplete?.(fullText);
      resolve(fullText);
    }, 120000);
  });
}

/**
 * Stream chat completion using async generator
 * 
 * Yields text chunks as they arrive, for use with SSE streaming.
 * 
 * @param credentials - Windsurf credentials
 * @param options - Chat options (model and messages)
 * @yields Text chunks as they arrive
 */
export async function* streamChatGenerator(
  credentials: WindsurfCredentials,
  options: Pick<StreamChatOptions, 'model' | 'messages'>
): AsyncGenerator<string, void, unknown> {
  const { csrfToken, port, apiKey, version } = credentials;
  const resolved = resolveModel(options.model);
  const modelEnum = resolved.enumValue;
  const modelName = resolved.variant ? `${resolved.modelId}:${resolved.variant}` : resolved.modelId;
  const body = buildChatRequest(apiKey, version, modelEnum, options.messages, modelName);

  const client = http2.connect(`http://localhost:${port}`);

  const chunkQueue: string[] = [];
  let done = false;
  let error: Error | null = null;
  let resolveWait: (() => void) | null = null;

  client.on('error', (err) => {
    error = new WindsurfError(
      `Connection failed: ${err.message}`,
      WindsurfErrorCode.CONNECTION_FAILED,
      err
    );
    done = true;
    resolveWait?.();
  });

  const req = client.request({
    ':method': 'POST',
    ':path': '/exa.language_server_pb.LanguageServerService/RawGetChatMessage',
    'content-type': 'application/grpc',
    'te': 'trailers',
    'x-codeium-csrf-token': csrfToken,
  });

  req.on('data', (chunk: Buffer) => {
    const text = extractTextFromChunk(chunk);
    if (text) {
      chunkQueue.push(text);
      resolveWait?.();
    }
  });

  req.on('trailers', (trailers) => {
    const status = trailers['grpc-status'];
    if (status !== '0') {
      const message = trailers['grpc-message'];
      error = new WindsurfError(
        `gRPC error ${status}: ${message ? decodeURIComponent(message as string) : 'Unknown error'}`,
        WindsurfErrorCode.STREAM_ERROR
      );
    }
  });

  req.on('end', () => {
    done = true;
    client.close();
    resolveWait?.();
  });

  req.on('error', (err) => {
    error = new WindsurfError(
      `Request failed: ${err.message}`,
      WindsurfErrorCode.STREAM_ERROR,
      err
    );
    done = true;
    client.close();
    resolveWait?.();
  });

  req.write(body);
  req.end();

  // Yield chunks as they arrive
  while (!done || chunkQueue.length > 0) {
    if (chunkQueue.length > 0) {
      yield chunkQueue.shift()!;
    } else if (!done) {
      await new Promise<void>((resolve) => {
        resolveWait = resolve;
      });
      resolveWait = null;
    }
  }

  if (error) {
    throw error;
  }
}

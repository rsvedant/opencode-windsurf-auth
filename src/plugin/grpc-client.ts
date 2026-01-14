/**
 * gRPC Client for Windsurf Language Server
 * 
 * Implements HTTP/2-based gRPC communication with the local Windsurf language server.
 * Uses manual protobuf encoding (no external protobuf library needed).
 */

import * as http2 from 'http2';
import * as crypto from 'crypto';
import { ChatMessageSource } from './types.js';
import { modelNameToEnum } from './models.js';
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
}

// ============================================================================
// Protobuf Encoding Helpers
// ============================================================================

/**
 * Encode a number as a varint (variable-length integer)
 */
function encodeVarint(value: number | bigint): number[] {
  const bytes: number[] = [];
  let v = BigInt(value);
  while (v > 127n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return bytes;
}

/**
 * Encode a string field (wire type 2: length-delimited)
 */
function encodeString(fieldNum: number, str: string): number[] {
  const strBytes = Buffer.from(str, 'utf8');
  return [(fieldNum << 3) | 2, ...encodeVarint(strBytes.length), ...strBytes];
}

/**
 * Encode a nested message field (wire type 2: length-delimited)
 */
function encodeMessage(fieldNum: number, data: number[]): number[] {
  return [(fieldNum << 3) | 2, ...encodeVarint(data.length), ...data];
}

/**
 * Encode a varint field (wire type 0)
 */
function encodeVarintField(fieldNum: number, value: number | bigint): number[] {
  return [(fieldNum << 3) | 0, ...encodeVarint(value)];
}

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
 * Field 2: source (enum: 1=USER, 2=SYSTEM)
 * Field 3: timestamp (google.protobuf.Timestamp, required)
 * Field 4: conversation_id (string, required)
 * Field 5: intent (ChatMessageIntent, oneof content)
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
  
  // Field 5: intent (ChatMessageIntent)
  const intent = encodeChatMessageIntent(content);
  bytes.push(...encodeMessage(5, intent));
  
  return bytes;
}

/**
 * Build the metadata message for the request
 * 
 * Metadata structure:
 * Field 1: ide_name (string)
 * Field 2: extension_version (string)
 * Field 3: api_key (string, required)
 * Field 4: locale (string)
 * Field 7: ide_version (string)
 * Field 12: extension_name (string)
 */
function encodeMetadata(apiKey: string, version: string): number[] {
  return [
    ...encodeString(1, 'windsurf'),             // ide_name
    ...encodeString(2, version),                // extension_version
    ...encodeString(3, apiKey),                 // api_key (required)
    ...encodeString(4, 'en'),                   // locale
    ...encodeString(7, version),                // ide_version
    ...encodeString(12, 'windsurf'),            // extension_name
  ];
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
  messages: ChatMessage[]
): Buffer {
  const metadata = encodeMetadata(apiKey, version);
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

/**
 * Decode a varint from a buffer starting at offset
 * @returns [value, bytesRead]
 */
function decodeVarint(buffer: Buffer, offset: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let bytesRead = 0;
  
  while (offset + bytesRead < buffer.length) {
    const byte = buffer[offset + bytesRead];
    bytesRead++;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7n;
  }
  
  return [result, bytesRead];
}

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
 * Fallback heuristic text extraction for edge cases
 */
function extractTextHeuristic(chunk: Buffer): string {
  // Convert to string, filtering out non-printable characters
  const readable = chunk
    .toString('utf8')
    .replace(/[^\x20-\x7E\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Look for text content that doesn't look like UUIDs or binary artifacts
  const parts = readable.split(/\s{2,}/);
  for (const part of parts) {
    const cleaned = part.trim();
    if (
      cleaned.length > 2 &&
      !cleaned.match(/^[a-f0-9-]{8,}$/i) && // Not a UUID
      !cleaned.match(/^[\x00-\x1f\x7f-\xff]+$/) // Not binary
    ) {
      return cleaned;
    }
  }

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
  const modelEnum = modelNameToEnum(options.model);
  const body = buildChatRequest(apiKey, version, modelEnum, options.messages);

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
  const modelEnum = modelNameToEnum(options.model);
  const body = buildChatRequest(apiKey, version, modelEnum, options.messages);

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

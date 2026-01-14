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
 * Build the metadata message for the request
 */
function encodeMetadata(apiKey: string, version: string): number[] {
  const requestId = BigInt(Date.now());
  const sessionId = crypto.randomUUID();

  return [
    ...encodeString(1, 'windsurf-next'),      // ide_name
    ...encodeString(2, version),               // ide_version
    ...encodeString(3, apiKey),                // api_key
    ...encodeString(4, 'en'),                  // locale
    ...encodeString(7, version),               // extension_version
    ...encodeVarintField(9, requestId),        // request_id
    ...encodeString(10, sessionId),            // session_id
    ...encodeString(12, 'windsurf'),           // client_name
  ];
}

/**
 * Encode a FormattedChatMessage for the RawGetChatMessageRequest
 * 
 * Based on reverse engineering:
 * Field 1: role (enum: ChatMessageSource)
 * Field 2: header (string)
 * Field 3: content (string)
 * Field 4: footer (string)
 */
function encodeFormattedChatMessage(role: number, content: string, header: string = '', footer: string = ''): number[] {
  const result: number[] = [];
  result.push(...encodeVarintField(1, role));      // role
  if (header) {
    result.push(...encodeString(2, header));       // header
  }
  result.push(...encodeString(3, content));        // content
  if (footer) {
    result.push(...encodeString(4, footer));       // footer
  }
  return result;
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
 * Based on reverse engineering, RawGetChatMessageRequest uses:
 * Field 1: metadata (Metadata message)
 * Field 2: chat_messages (repeated FormattedChatMessage)
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

  // Build the request with all messages
  const request: number[] = [];
  
  // Field 1: metadata
  request.push(...encodeMessage(1, metadata));
  
  // Field 2: chat_messages (repeated)
  // Extract system message if present and handle separately
  let systemPrompt = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt = msg.content;
    } else {
      // Encode each message as FormattedChatMessage
      const source = roleToSource(msg.role);
      const formattedMsg = encodeFormattedChatMessage(source, msg.content);
      request.push(...encodeMessage(2, formattedMsg));
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
// Response Parsing
// ============================================================================

/**
 * Extract readable text from a gRPC response chunk
 * 
 * The response is in protobuf format, but we do a simple heuristic extraction
 * since we don't need full protobuf decoding for text content.
 */
function extractTextFromChunk(chunk: Buffer): string {
  // Convert to string, filtering out non-printable characters
  const readable = chunk
    .toString('utf8')
    .replace(/[^\x20-\x7E\n]/g, ' ')
    .trim();

  // Try to extract text after asterisk marker
  const textMatch = readable.match(/\*\s*([^0]+)/);
  if (textMatch) {
    return textMatch[1].trim();
  }

  // Fallback: split on multiple spaces and find meaningful content
  const parts = readable.split(/\s{2,}/);
  for (const part of parts) {
    if (
      part.length > 0 &&
      !part.includes('-') &&
      !part.match(/^[a-f0-9-]+$/i)
    ) {
      const cleaned = part.replace(/^[\s\d*]+/, '').trim();
      if (cleaned.length > 0) {
        return cleaned;
      }
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

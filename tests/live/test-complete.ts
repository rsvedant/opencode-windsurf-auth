#!/usr/bin/env bun
/**
 * Test RawGetChatMessage with complete correct message structure:
 * - Real API key from Keychain
 * - ChatMessage with timestamp (google.protobuf.Timestamp)
 * - ChatMessageIntent with IntentGeneric
 */

import * as http2 from "http2";
import { execSync } from "child_process";

interface Credentials {
  csrfToken: string;
  port: number;
  version: string;
  apiKey: string;
}

function getCredentials(): Credentials | null {
  try {
    const psOutput = execSync("ps aux | grep language_server_macos | grep -v grep", {
      encoding: "utf8",
    });
    const csrfMatch = psOutput.match(/--csrf_token\s+([a-f0-9-]+)/);
    const portMatch = psOutput.match(/--extension_server_port\s+(\d+)/);
    const versionMatch = psOutput.match(/--windsurf_version\s+([\d.]+)/);

    if (!csrfMatch || !portMatch) return null;

    // Get API key from VSCode state database
    const apiKey = execSync(
      `sqlite3 ~/Library/Application\\ Support/Windsurf/User/globalStorage/state.vscdb "SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus';" 2>/dev/null`,
      { encoding: "utf8" }
    ).trim();
    
    const parsed = JSON.parse(apiKey);
    
    return {
      csrfToken: csrfMatch[1],
      port: parseInt(portMatch[1], 10) + 2,
      version: versionMatch?.[1] || "1.48.2",
      apiKey: parsed.apiKey,
    };
  } catch (e) {
    console.error("Error getting credentials:", e);
    return null;
  }
}

// Protobuf encoding helpers
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

function encodeString(fieldNum: number, str: string): number[] {
  const strBytes = Buffer.from(str, "utf8");
  return [(fieldNum << 3) | 2, ...encodeVarint(strBytes.length), ...strBytes];
}

function encodeVarintField(fieldNum: number, value: number | bigint): number[] {
  return [(fieldNum << 3) | 0, ...encodeVarint(value)];
}

function encodeMessage(fieldNum: number, bytes: number[]): number[] {
  return [(fieldNum << 3) | 2, ...encodeVarint(bytes.length), ...bytes];
}

function grpcFrame(payload: Buffer): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

/**
 * google.protobuf.Timestamp:
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
 * IntentGeneric (field 1 = text)
 */
function encodeIntentGeneric(text: string): number[] {
  return encodeString(1, text);
}

/**
 * ChatMessageIntent:
 * Field 1: generic (IntentGeneric, oneof)
 * Field 12: num_tokens (int32)
 */
function encodeChatMessageIntent(text: string): number[] {
  const generic = encodeIntentGeneric(text);
  return encodeMessage(1, generic);
}

/**
 * ChatMessage:
 * Field 1: message_id (string, required)
 * Field 2: source (enum: 1=USER, 2=SYSTEM)
 * Field 3: timestamp (google.protobuf.Timestamp, required)
 * Field 4: conversation_id (string, required - min 1 char)
 * Field 5: intent (ChatMessageIntent, oneof content)
 */
function encodeChatMessage(text: string, messageId: string, conversationId: string): number[] {
  const bytes: number[] = [];
  
  // Field 1: message_id (required)
  bytes.push(...encodeString(1, messageId));
  
  // Field 2: source = USER (1)
  bytes.push(...encodeVarintField(2, 1));
  
  // Field 3: timestamp (required)
  const timestamp = encodeTimestamp();
  bytes.push(...encodeMessage(3, timestamp));
  
  // Field 4: conversation_id (required)
  bytes.push(...encodeString(4, conversationId));
  
  // Field 5: intent (ChatMessageIntent)
  const intent = encodeChatMessageIntent(text);
  bytes.push(...encodeMessage(5, intent));
  
  return bytes;
}

/**
 * Metadata:
 * Field 1: ide_name (string)
 * Field 2: extension_version (string)
 * Field 3: api_key (string, required)
 * Field 4: locale (string)
 * Field 7: ide_version (string)
 * Field 12: extension_name (string)
 */
function encodeMetadata(apiKey: string, version: string): number[] {
  const bytes: number[] = [];
  bytes.push(...encodeString(1, "windsurf"));           // ide_name
  bytes.push(...encodeString(2, version));              // extension_version
  bytes.push(...encodeString(3, apiKey));               // api_key
  bytes.push(...encodeString(4, "en"));                 // locale
  bytes.push(...encodeString(7, version));              // ide_version
  bytes.push(...encodeString(12, "windsurf"));          // extension_name
  return bytes;
}

async function testRequest(
  creds: Credentials,
  name: string,
  payload: Buffer
): Promise<void> {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Test: ${name}`);
  console.log(`Payload: ${payload.length} bytes`);
  console.log(`${"=".repeat(70)}`);

  const framedRequest = grpcFrame(payload);

  return new Promise((resolve) => {
    const client = http2.connect(`http://localhost:${creds.port}`);
    let responseData = Buffer.alloc(0);

    client.on("error", (err) => {
      console.log(`Connection error: ${err.message}`);
      resolve();
    });

    const req = client.request({
      ":method": "POST",
      ":path": "/exa.language_server_pb.LanguageServerService/RawGetChatMessage",
      "content-type": "application/grpc",
      "te": "trailers",
      "x-codeium-csrf-token": creds.csrfToken,
    });

    req.on("response", (headers) => {
      console.log(`HTTP status: ${headers[":status"]}`);
    });

    req.on("data", (chunk: Buffer) => {
      responseData = Buffer.concat([responseData, chunk]);
      
      // Try to extract text from chunk
      const text = chunk.toString("utf8").replace(/[^\x20-\x7e\n\r]/g, "").trim();
      if (text.length > 0) {
        console.log(`Chunk (${chunk.length}b): ${text.slice(0, 200)}`);
      } else {
        console.log(`Chunk: ${chunk.length} bytes (binary)`);
      }
    });

    req.on("trailers", (trailers) => {
      const status = trailers["grpc-status"];
      const message = trailers["grpc-message"];
      console.log(`\ngRPC status: ${status}`);
      if (message) {
        console.log(`gRPC message: ${decodeURIComponent(message as string)}`);
      }
    });

    req.on("end", () => {
      if (responseData.length > 5) {
        console.log(`\nTotal response: ${responseData.length} bytes`);
        
        // Extract readable text
        const readable = responseData.toString("utf8").replace(/[^\x20-\x7e\n\r]/g, " ").replace(/\s+/g, " ").trim();
        if (readable.length > 10) {
          console.log(`\nReadable: ${readable.slice(0, 1000)}`);
        }
      }
      client.close();
      resolve();
    });

    req.on("error", (err) => {
      console.log(`Request error: ${err.message}`);
      client.close();
      resolve();
    });

    req.write(framedRequest);
    req.end();

    setTimeout(() => {
      console.log("\nTimeout - closing connection");
      client.close();
      resolve();
    }, 30000);
  });
}

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

async function main() {
  console.log("=== RawGetChatMessage Complete Test ===\n");

  const creds = getCredentials();
  if (!creds) {
    console.error("Windsurf not running or couldn't get credentials");
    process.exit(1);
  }

  console.log(`Port: ${creds.port}`);
  console.log(`Version: ${creds.version}`);
  console.log(`CSRF: ${creds.csrfToken.slice(0, 8)}...`);
  console.log(`API Key: ${creds.apiKey.slice(0, 15)}...`);

  // Build the complete request
  const messageId = generateUUID();
  console.log(`Message ID: ${messageId}`);
  
  const metadata = encodeMetadata(creds.apiKey, creds.version);
  const conversationId = generateUUID();
  const chatMessage = encodeChatMessage("Say hello in exactly 5 words.", messageId, conversationId);
  console.log(`Conversation ID: ${conversationId}`);
  
  /**
   * RawGetChatMessageRequest:
   * Field 1: metadata (Metadata)
   * Field 2: chat_messages (repeated ChatMessage)
   * Field 3: system_prompt_override (string)
   * Field 4: chat_model (enum Model)
   * Field 5: chat_model_name (string)
   */
  
  // Test with gpt-4o (109) - should be widely available
  const payload = Buffer.from([
    ...encodeMessage(1, metadata),            // Field 1: metadata
    ...encodeMessage(2, chatMessage),         // Field 2: chat_messages[0]
    ...encodeVarintField(4, 109),             // Field 4: chat_model = 109 (GPT_4O_2024_08_06)
  ]);

  await testRequest(creds, "GPT-4o (109)", payload);

  console.log("\n\n=== Testing with GPT-4.1 ===\n");
  
  // Try with GPT-4.1 (259)
  const payload2 = Buffer.from([
    ...encodeMessage(1, metadata),
    ...encodeMessage(2, encodeChatMessage("Say hello in exactly 3 words.", generateUUID(), generateUUID())),
    ...encodeVarintField(4, 259),             // GPT_4_1_2025_04_14
  ]);
  
  await testRequest(creds, "GPT-4.1 (259)", payload2);
  
  console.log("\n\n=== Testing with Claude 3.5 Sonnet ===\n");
  
  // Try with Claude 3.5 Sonnet (166)
  const payload3 = Buffer.from([
    ...encodeMessage(1, metadata),
    ...encodeMessage(2, encodeChatMessage("Reply with just 'Hello!'", generateUUID(), generateUUID())),
    ...encodeVarintField(4, 166),             // CLAUDE_3_5_SONNET_20241022
  ]);
  
  await testRequest(creds, "Claude 3.5 Sonnet (166)", payload3);

  console.log("\n\nDone!");
}

main().catch(console.error);


import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const VSCODE_STATE_PATHS = {
    darwin: path.join(os.homedir(), 'Library/Application Support/Windsurf/User/globalStorage/state.vscdb'),
    linux: path.join(os.homedir(), '.config/Windsurf/User/globalStorage/state.vscdb'),
    win32: path.join(os.homedir(), 'AppData/Roaming/Windsurf/User/globalStorage/state.vscdb'),
} as const;

function getApiKeyFromStateParam(): { raw: string, parsed: any } | null {
    const platform = process.platform as keyof typeof VSCODE_STATE_PATHS;
    const statePath = VSCODE_STATE_PATHS[platform];

    if (!statePath || !fs.existsSync(statePath)) {
        console.log(`State DB not found at: ${statePath}`);
        return null;
    }

    console.log(`Reading state DB from: ${statePath}`);

    try {
        const result = execSync(
            `sqlite3 "${statePath}" "SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus';"`,
            { encoding: 'utf8', timeout: 5000 }
        ).trim();

        if (!result) {
            console.log("Empty result from sqlite query");
            return null;
        }

        try {
            const parsed = JSON.parse(result);
            return { raw: result, parsed };
        } catch (e) {
            console.log("Failed to JSON parse result");
            return { raw: result, parsed: null };
        }
    } catch (error) {
        console.error("Error reading state DB:", error);
        return null;
    }
}

function mask(s: string) {
    if (!s || s.length < 10) return '***';
    return s.substring(0, 4) + '...' + s.substring(s.length - 4);
}

async function main() {
    console.log("--- Windsurf Auth Debug ---");

    // 1. Check Process
    try {
        const ps = execSync('ps aux | grep language_server_macos | grep -v grep', { encoding: 'utf8' });
        console.log("Language Server Process Found:");
        console.log(ps.split('\n').filter(l => l.trim()).map(l => l.substring(0, 100) + '...').join('\n'));
    } catch (e) {
        console.log("Language Server NOT found running.");
    }

    // 2. Check DB
    const dbResult = getApiKeyFromStateParam();
    if (dbResult) {
        console.log("\nDB Content for 'windsurfAuthStatus':");
        console.log("Raw length:", dbResult.raw.length);
        if (dbResult.parsed) {
            console.log("Parsed Keys:", Object.keys(dbResult.parsed));
            if (dbResult.parsed.apiKey) {
                console.log("apiKey found:", mask(dbResult.parsed.apiKey));
                console.log("apiKey length:", dbResult.parsed.apiKey.length);
                console.log("apiKey bytes:", Buffer.from(dbResult.parsed.apiKey).toString('hex').substring(0, 30) + "...");
                // Check if it looks like a UUID or something else
                if (dbResult.parsed.apiKey.includes('enc:')) {
                    console.log("WARNING: apiKey appears to be encrypted!");
                }
            } else {
                console.log("apiKey NOT found in JSON object");
            }
            if (dbResult.parsed.accessToken) {
                console.log("accessToken found:", mask(dbResult.parsed.accessToken));
            }
            if (dbResult.parsed.userStatusProtoBinaryBase64) {
                console.log("\nUser Status (Base64 decoded strings):");
                try {
                    const decoded = Buffer.from(dbResult.parsed.userStatusProtoBinaryBase64, 'base64');
                    // Simple strings extraction for debug
                    const diff = decoded.toString().replace(/[^\x20-\x7E]/g, '.');
                    console.log(diff.substring(0, 500));
                } catch (e) {
                    console.log("Failed to decode userStatus");
                }
            }
        } else {
            console.log("Raw content (first 100 chars):", dbResult.raw.substring(0, 100));
        }
    } else {
        console.log("\nCould not retrieve windsurfAuthStatus from DB");
    }
}

main().catch(console.error);

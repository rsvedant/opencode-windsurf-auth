
/**
 * Windsurf Extension Discovery & Analysis
 * 
 * dynamically analyzes the installed Windsurf extension.js to discover
 * Protobuf field numbers that may change between versions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Default metadata field numbers. These reflect what Windsurf 2.x ships
// (exa.codeium_common_pb.Metadata). The discovery routine below tries to
// parse them out of extension.js to handle future field renumbering.
export const DEFAULT_METADATA_FIELDS = {
    ide_name: 1,
    extension_version: 2,
    api_key: 3,
    locale: 4,
    os: 5,
    disable_telemetry: 6,
    ide_version: 7,
    hardware: 8,
    request_id: 9,
    session_id: 10,
    extension_name: 12,
    auth_source: 15,
    ls_timestamp: 16,
    extension_path: 17,
    user_id: 20,
    user_jwt: 21,
    device_fingerprint: 24,
    trigger_id: 25,
    plan_name: 26,
    ide_type: 28,
};

export type MetadataFields = typeof DEFAULT_METADATA_FIELDS;
type MetadataFieldKey = keyof MetadataFields;

let cachedFields: MetadataFields | null = null;

/**
 * Locate the Windsurf extension.js file
 */
function findExtensionFile(): string | null {
    const commonPaths = [
        // macOS
        '/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js',
        path.join(os.homedir(), 'Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js'),
        // Linux
        '/usr/share/windsurf/resources/app/extensions/windsurf/dist/extension.js',
        path.join(os.homedir(), '.local/share/windsurf/resources/app/extensions/windsurf/dist/extension.js'),
        // Windows
        'C:\\Program Files\\Windsurf\\resources\\app\\extensions\\windsurf\\dist\\extension.js',
        path.join(os.homedir(), 'AppData\\Local\\Programs\\Windsurf\\resources\\app\\extensions\\windsurf\\dist\\extension.js'),
    ];

    for (const p of commonPaths) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/**
 * Analyze extension.js content to find Metadata field numbers.
 * Pulls every field we know how to fill — falls back to defaults for any
 * not found.
 */
function parseMetadataFields(content: string): MetadataFields | null {
    // newFieldList(()=>[ {no:1,name:"ide_name",...}, ... ])
    const fieldLists = [...content.matchAll(/newFieldList\(\(\)=>\[(.*?)\]\)/g)];

    for (const match of fieldLists) {
        const listContent = match[1];

        // Identify the Metadata message: it has both api_key and ide_name,
        // but is NOT a telemetry message (which carries event_name).
        if (
            listContent.includes('"api_key"') &&
            listContent.includes('"ide_name"') &&
            !listContent.includes('"event_name"')
        ) {
            const fields: MetadataFields = { ...DEFAULT_METADATA_FIELDS };

            const extractField = (name: string): number | null => {
                const regex = new RegExp(`\\{no:(\\d+),name:"${name}"`);
                const m = listContent.match(regex);
                return m ? parseInt(m[1], 10) : null;
            };

            const keys = Object.keys(fields) as MetadataFieldKey[];
            for (const key of keys) {
                const found = extractField(key);
                if (found) fields[key] = found;
            }

            // Only accept the parse if the two anchor fields were found.
            if (extractField('api_key') && extractField('ide_name')) {
                return fields;
            }
        }
    }

    return null;
}

/**
 * Get Metadata field mapping, using cached discovery or defaults
 */
export function getMetadataFields(): MetadataFields {
    if (cachedFields) return cachedFields;

    try {
        const extPath = findExtensionFile();
        if (extPath) {
            const content = fs.readFileSync(extPath, 'utf8');
            const discovered = parseMetadataFields(content);
            if (discovered) {
                cachedFields = discovered;
                return cachedFields;
            }
        }
    } catch {
        // A corrupted or partially-downloaded extension.js shouldn't take the
        // whole plugin down. Silently fall through to defaults — these are
        // current-spec values, so chat still works as long as Windsurf
        // hasn't renumbered any Metadata fields. No console output: this code
        // ships inside the opencode runtime where stray logs would surface in
        // the user's terminal.
    }

    cachedFields = DEFAULT_METADATA_FIELDS;
    return cachedFields;
}

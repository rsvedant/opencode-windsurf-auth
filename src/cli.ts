#!/usr/bin/env node
/**
 * opencode-windsurf-auth CLI entry point.
 *
 * Subcommands:
 *   login [--manual] [--signup] [--email <addr>] [--portal-url <https://...>]
 *       Browser-based OAuth flow. Defaults to the loopback callback strategy.
 *       Falls back to manual paste if --manual is set or the loopback bind fails.
 *   logout
 *       Delete the persisted credentials file.
 *   whoami
 *       Print the account name + apiServerUrl + credential path for the
 *       currently logged-in session.
 *   status
 *       Print credential path + diagnostic info (file exists? lifetime?).
 *   --help, -h
 *       Print usage.
 *
 * The CLI is intentionally dependency-free (no commander/yargs) — it's a tiny
 * surface area and we'd rather not add an npm dep for it.
 */

import { login, type LoginOptions } from './oauth/login.js';
import { deleteCredentials, getCredentialsPath, loadCredentials } from './oauth/storage.js';
import { DEFAULT_REGION, type WindsurfRegion } from './oauth/types.js';
import { WindsurfRegistrationError } from './oauth/register-user.js';

interface ParsedArgs {
  subcommand: string;
  manual: boolean;
  signup: boolean;
  email?: string;
  portalUrl?: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  // Treat a leading --help/-h as a top-level help request, not a subcommand.
  const first = argv[0] ?? '';
  const isHelpLeading = first === '--help' || first === '-h';
  const out: ParsedArgs = {
    subcommand: isHelpLeading ? 'help' : first,
    manual: false,
    signup: false,
    help: isHelpLeading,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--manual':
      case '-m':
        out.manual = true;
        break;
      case '--signup':
        out.signup = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--email':
        out.email = argv[++i];
        break;
      case '--portal-url':
        out.portalUrl = argv[++i];
        break;
      default:
        if (a.startsWith('--email=')) out.email = a.slice('--email='.length);
        else if (a.startsWith('--portal-url=')) out.portalUrl = a.slice('--portal-url='.length);
        else if (a === '--' || !a.startsWith('-')) {
          // Positional args ignored; we don't have any commands that take them.
        } else {
          throw new Error(`Unknown flag: ${a}`);
        }
    }
  }
  return out;
}

function regionFromArgs(args: ParsedArgs): WindsurfRegion {
  if (!args.portalUrl) return DEFAULT_REGION;
  // Enterprise / custom portal — mirror extension.js's _route/api_server pattern
  // for the register endpoint. The portal URL doubles as the website.
  const base = args.portalUrl.replace(/\/$/, '');
  return {
    website: base,
    registerApiServerUrl: `${base}/_route/api_server`,
    oauthClientId: DEFAULT_REGION.oauthClientId,
  };
}

function usage(): string {
  return `\
opencode-windsurf-auth — Windsurf OAuth login for the opencode plugin

Usage:
  opencode-windsurf-auth login [--manual] [--signup] [--email <addr>] [--portal-url <url>]
  opencode-windsurf-auth logout
  opencode-windsurf-auth whoami
  opencode-windsurf-auth status

Login options:
  --manual              Force manual-paste flow (no localhost callback).
  --signup              Send the user to /windsurf/signup instead of /signin.
  --email <addr>        Pre-fill the sign-in email field.
  --portal-url <url>    Custom enterprise portal (e.g. https://your-co.windsurf.com).

Credentials are stored at:
  ${getCredentialsPath()}
`;
}

async function cmdLogin(args: ParsedArgs): Promise<number> {
  const region = regionFromArgs(args);
  const opts: LoginOptions = {
    region,
    manualPaste: args.manual,
    signUp: args.signup,
    loginHint: args.email,
    onUrl: (url) => {
      // Print the URL even when the loopback path opens the browser
      // automatically — useful for SSH sessions where openBrowser is a no-op.
      console.log(`\nOpen this URL to sign in:\n  ${url}\n`);
    },
  };

  console.log(args.manual
    ? 'Starting Windsurf sign-in (manual-paste flow)…'
    : 'Starting Windsurf sign-in (loopback callback)…');

  try {
    const result = await login(opts);
    console.log(`\nSigned in as: ${result.name}`);
    console.log(`API server   : ${result.apiServerUrl}`);
    console.log(`Credentials  : ${getCredentialsPath()}`);
    return 0;
  } catch (err) {
    if (err instanceof WindsurfRegistrationError) {
      console.error(`\nRegisterUser failed (HTTP ${err.status}): ${err.message}`);
      if (err.connectCode) console.error(`  connect code: ${err.connectCode}`);
      if (err.traceId) console.error(`  trace id    : ${err.traceId}`);
      return 2;
    }
    console.error(`\nSign-in failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function cmdLogout(): number {
  const removed = deleteCredentials();
  if (removed) {
    console.log(`Removed credentials at ${getCredentialsPath()}`);
    return 0;
  }
  console.log('Already logged out — no credentials file found.');
  return 0;
}

function cmdWhoami(): number {
  const creds = loadCredentials();
  if (!creds) {
    console.error('Not logged in. Run `opencode-windsurf-auth login`.');
    return 1;
  }
  console.log(`Name       : ${creds.name}`);
  console.log(`API server : ${creds.apiServerUrl}`);
  console.log(`Issued at  : ${creds.issuedAt}`);
  console.log(`Credentials: ${getCredentialsPath()}`);
  return 0;
}

function cmdStatus(): number {
  const path = getCredentialsPath();
  let creds: ReturnType<typeof loadCredentials> = null;
  try {
    creds = loadCredentials();
  } catch (err) {
    console.error(`Credentials file present but malformed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!creds) {
    console.log(`Status     : not logged in`);
    console.log(`File path  : ${path} (does not exist)`);
    return 0;
  }
  console.log(`Status     : logged in`);
  console.log(`Name       : ${creds.name}`);
  console.log(`API server : ${creds.apiServerUrl}`);
  console.log(`Issued at  : ${creds.issuedAt}`);
  console.log(`File path  : ${path}`);
  return 0;
}

async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(usage());
    return 64;
  }

  if (args.help || args.subcommand === '' || args.subcommand === 'help') {
    console.log(usage());
    return 0;
  }

  switch (args.subcommand) {
    case 'login':
      return cmdLogin(args);
    case 'logout':
      return cmdLogout();
    case 'whoami':
      return cmdWhoami();
    case 'status':
      return cmdStatus();
    default:
      console.error(`Unknown subcommand: ${args.subcommand}`);
      console.error(usage());
      return 64;
  }
}

/**
 * Flush stdout/stderr fully before process.exit. Without this, the last few
 * lines of output (especially error messages on failed login) can be lost
 * on macOS when stdout is piped or redirected.
 */
async function flushStreams(): Promise<void> {
  const drain = (s: NodeJS.WriteStream): Promise<void> =>
    new Promise<void>((resolve) => {
      // .write returns false when buffered; wait for drain. If everything's
      // already flushed, resolve immediately on the next tick.
      if (s.writableLength === 0) { setImmediate(resolve); return; }
      s.once('drain', () => resolve());
      // Safety net so we never block forever on a closed pipe.
      setTimeout(resolve, 100).unref();
    });
  await Promise.all([drain(process.stdout), drain(process.stderr)]);
}

main().then(
  async (code) => { await flushStreams(); process.exit(code); },
  async (err) => {
    console.error('Fatal:', err);
    await flushStreams();
    process.exit(1);
  },
);

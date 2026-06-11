#!/usr/bin/env bun

import crypto from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import packageJson from "../package.json";
import { getConfigPath, loadConfig, type PlatterConfig, saveConfig } from "./config.js";
import { PlatterClientsStore } from "./oauth/clients-store.js";
import { type PendingAuthEvent, PlatterOAuthProvider } from "./oauth/provider.js";
import { ALL_TOOL_NAMES, type SandboxFsMode, type SecurityConfig, type ToolName } from "./security.js";
import { createServer } from "./server.js";
import { ActivityLog } from "./tray/activity-log.js";
import { ActivityMonitor } from "./tray/activity-monitor.js";
import { HttpController } from "./tray/http-controller.js";
import { loadFromKeyring, saveToKeyring } from "./tray/keyring.js";
import { runTray } from "./tray/tray.js";

const USAGE = `platter v${packageJson.version}

Your computer, served on a platter.

Usage: platter [options]

Options:
  -t, --transport <stdio|http>   Transport mode (default: stdio)
      --tray                     Run the HTTP server with a Linux system tray
                                 (implies --transport=http, persists state
                                 across restarts in ~/.config/platter)
  -p, --port <number>            HTTP port (default: 3100)
      --host <address>           HTTP bind address (default: 127.0.0.1)
      --cwd <path>               Working directory for tools (default: current directory)
      --cors-origin <origin>     Allowed CORS origin (default: *)
      --auth <mode>              Auth mode: oauth, bearer, jwks, none (default: oauth)
      --auth-token <token>       Bearer token for HTTP auth (auto-generated if omitted)
      --tls-cert <path>          TLS certificate file (PEM) — enables HTTPS
      --tls-key <path>           TLS private key file (PEM)

External JWKS / OIDC (--auth jwks — verify tokens from an external IdP):
      --oauth-issuer <url>       Issuer URL; OIDC-discovers the JWKS endpoint
      --jwks-url <url>           Explicit JWKS endpoint (overrides discovery)
      --oauth-audience <aud>     Expected token audience (strongly recommended)
      --jwks-scope-grants        Map tools:<name> token scopes to tool access
                                 (fail closed: a token with no tools:<name>
                                 scopes is granted no tools)

Process management:
      --max-processes <number>   Max concurrent bash processes per session (default: 20)
      --max-sessions <number>    Max concurrent HTTP sessions (default: unlimited)

Restrictions:
      --tools <list>             Comma-separated tools to enable (default: all)
                                 Valid: ${ALL_TOOL_NAMES.join(", ")}
      --allow-path <path>        Restrict read/write/edit/glob/grep to this path (repeatable)
                                 Does not restrict bash or js
      --allow-command <regex>    Allow bash commands matching this pattern (repeatable)
                                 Pattern must match the entire command string
                                 Applies to bash only; does not restrict js

Sandbox (applies to bash only; the js tool is never sandboxed):
      --sandbox                  Use just-bash sandbox instead of native bash
      --sandbox-fs <mode>        Filesystem backend: memory, overlay, readwrite (default: readwrite)
      --sandbox-allow-url <url>  Allow network access to URL prefix (repeatable)

  -h, --help                     Show this help message
  -v, --version                  Show version number`;

// Handle --help/-h and --version/-v before parseArgs
const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
  console.log(packageJson.version);
  process.exit(0);
}

const { values } = parseArgs({
  options: {
    transport: { type: "string", short: "t", default: "stdio" },
    tray: { type: "boolean", default: false },
    port: { type: "string", short: "p" },
    host: { type: "string" },
    cwd: { type: "string" },
    "cors-origin": { type: "string", default: "*" },
    auth: { type: "string", default: "oauth" },
    "auth-token": { type: "string" },
    "oauth-issuer": { type: "string" },
    "jwks-url": { type: "string" },
    "oauth-audience": { type: "string" },
    "jwks-scope-grants": { type: "boolean", default: false },
    tools: { type: "string" },
    "allow-path": { type: "string", multiple: true },
    "allow-command": { type: "string", multiple: true },
    sandbox: { type: "boolean", default: false },
    "sandbox-fs": { type: "string", default: "readwrite" },
    "sandbox-allow-url": { type: "string", multiple: true },
    "tls-cert": { type: "string" },
    "tls-key": { type: "string" },
    "max-processes": { type: "string", default: "20" },
    "max-sessions": { type: "string" },
  },
});

// Tray mode implies HTTP transport. Also load a persisted config so the
// auth token, tool state, and listen address survive restarts. CLI flags
// override the config file.
const trayMode = values.tray === true;
const transportExplicit =
  rawArgs.includes("--transport") || rawArgs.includes("-t") || rawArgs.some((a) => a.startsWith("--transport="));
let persistedConfig: PlatterConfig | null = null;
if (trayMode) {
  if (transportExplicit && values.transport !== "http") {
    console.error("Error: --tray requires --transport=http (or omit --transport).\n");
    process.exit(1);
  }
  values.transport = "http";
  const loaded = loadConfig();
  persistedConfig = loaded.config;
  if (loaded.created) {
    console.error(`Wrote default config to ${getConfigPath()}`);
  }
}

// Fall-backs for port/host/cwd: CLI flag > config file > hard-coded default.
if (!values.port) values.port = persistedConfig ? String(persistedConfig.port) : "3100";
if (!values.host) values.host = persistedConfig?.host ?? "127.0.0.1";
if (!values.cwd) values.cwd = persistedConfig?.cwd ?? process.cwd();

if (values.transport !== "stdio" && values.transport !== "http") {
  console.error(`Error: invalid transport "${values.transport}". Must be "stdio" or "http".\n`);
  console.error(USAGE);
  process.exit(1);
}

const VALID_AUTH_MODES = ["oauth", "bearer", "none", "jwks"];
const authMode = values.auth!;
if (!VALID_AUTH_MODES.includes(authMode)) {
  console.error(`Error: invalid --auth mode "${authMode}". Must be one of: ${VALID_AUTH_MODES.join(", ")}\n`);
  console.error(USAGE);
  process.exit(1);
}

if (values["auth-token"] && authMode === "none") {
  console.error("Error: --auth-token and --auth none are mutually exclusive.\n");
  console.error(USAGE);
  process.exit(1);
}

// External JWKS / OIDC mode validation. These checks (and warnings) run at
// module load, before any server binds, so the CLI fails fast and tests don't
// need a live socket.
function assertUrl(flag: string, value: string): void {
  try {
    new URL(value);
  } catch {
    console.error(`Error: ${flag} must be a valid URL, got "${value}".\n`);
    console.error(USAGE);
    process.exit(1);
  }
}

if (authMode === "jwks") {
  if (!values["oauth-issuer"] && !values["jwks-url"]) {
    console.error("Error: --auth jwks requires --oauth-issuer <url> (or --jwks-url <url>).\n");
    console.error(USAGE);
    process.exit(1);
  }
  if (values["oauth-issuer"]) assertUrl("--oauth-issuer", values["oauth-issuer"]);
  if (values["jwks-url"]) assertUrl("--jwks-url", values["jwks-url"]);

  // No static fallback in jwks mode — the external IdP is the sole token source.
  if (values["auth-token"]) {
    console.error("Error: --auth-token is not used in jwks mode (the external IdP issues tokens).\n");
    console.error(USAGE);
    process.exit(1);
  }

  if (!values["oauth-audience"]) {
    console.error(
      "Warning: --auth jwks without --oauth-audience disables audience validation.\n" +
        "  Any valid token from the issuer is accepted, including tokens minted for OTHER\n" +
        "  resource servers (confused-deputy risk). Set --oauth-audience to your MCP server's\n" +
        "  API identifier.\n",
    );
  }

  // An http issuer is insecure (JWKS fetched in the clear). Allowed for local
  // dev (e.g. a localhost Keycloak), but warn. This is platter's own warning and
  // is unrelated to MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL, which only gates
  // platter's OWN issuer in `--auth oauth` mode.
  const issuerForScheme = values["oauth-issuer"] ?? values["jwks-url"];
  if (issuerForScheme?.startsWith("http://")) {
    console.error(`Warning: external issuer "${issuerForScheme}" uses http — JWKS is fetched insecurely. Use https.\n`);
  }
} else if (values["oauth-issuer"] || values["jwks-url"] || values["oauth-audience"] || values["jwks-scope-grants"]) {
  console.error(
    `Warning: --oauth-issuer/--jwks-url/--oauth-audience/--jwks-scope-grants have no effect with --auth ${authMode}.\n`,
  );
}

if ((values["tls-cert"] && !values["tls-key"]) || (!values["tls-cert"] && values["tls-key"])) {
  console.error("Error: --tls-cert and --tls-key must be used together.\n");
  console.error(USAGE);
  process.exit(1);
}

// --- Process management ---

const maxProcesses = parseInt(values["max-processes"]!, 10);

if (Number.isNaN(maxProcesses) || maxProcesses <= 0) {
  console.error(`Error: invalid --max-processes value "${values["max-processes"]}". Must be a positive number.\n`);
  process.exit(1);
}

const maxSessions = values["max-sessions"] ? parseInt(values["max-sessions"], 10) : undefined;

if (maxSessions !== undefined && (Number.isNaN(maxSessions) || maxSessions <= 0)) {
  console.error(`Error: invalid --max-sessions value "${values["max-sessions"]}". Must be a positive number.\n`);
  process.exit(1);
}

// --- Security restrictions ---

const security: SecurityConfig = {};

if (values.tools) {
  const names = values.tools.split(",").map((t) => t.trim().toLowerCase());
  for (const name of names) {
    if (!(ALL_TOOL_NAMES as readonly string[]).includes(name)) {
      console.error(`Error: unknown tool "${name}". Valid tools: ${ALL_TOOL_NAMES.join(", ")}\n`);
      console.error(USAGE);
      process.exit(1);
    }
  }
  security.allowedTools = new Set(names as ToolName[]);
}

if (values["allow-path"]?.length) {
  security.allowedPaths = values["allow-path"].map((p) => resolve(p));
}

if (values["allow-command"]?.length) {
  // The CLI patterns form a single group (the global restriction). A per-client
  // grant adds further groups at session-build time; see buildSessionSecurity.
  const globalGroup: RegExp[] = [];
  for (const pattern of values["allow-command"]) {
    try {
      globalGroup.push(new RegExp(`^(?:${pattern})$`));
    } catch (e: any) {
      console.error(`Error: invalid --allow-command regex "${pattern}": ${e.message}\n`);
      process.exit(1);
    }
  }
  security.allowedCommands = [globalGroup];
}

const VALID_SANDBOX_FS_MODES = ["memory", "overlay", "readwrite"];
if (values.sandbox) {
  const fsMode = values["sandbox-fs"]!;
  if (!VALID_SANDBOX_FS_MODES.includes(fsMode)) {
    console.error(`Error: invalid --sandbox-fs "${fsMode}". Must be one of: ${VALID_SANDBOX_FS_MODES.join(", ")}\n`);
    console.error(USAGE);
    process.exit(1);
  }
  security.sandbox = {
    enabled: true,
    fsMode: fsMode as SandboxFsMode,
    allowedUrls: values["sandbox-allow-url"]?.length ? values["sandbox-allow-url"] : undefined,
  };
}

const bashEnabled = !security.allowedTools || security.allowedTools.has("bash");
if (security.allowedPaths && bashEnabled && !security.allowedCommands && !security.sandbox?.enabled) {
  console.error(
    "Warning: bash tool is enabled with --allow-path but no --allow-command restrictions.\n" +
      "  Bash commands can access paths outside the allowed list.\n" +
      "  Consider --tools (without bash) or adding --allow-command to restrict commands.\n",
  );
}

const cwd = values.cwd!;
const serverOpts = { maxProcesses };

function logRestrictions() {
  if (security.allowedTools) {
    console.error(`Tools: ${[...security.allowedTools].join(", ")}`);
  }
  if (security.allowedPaths) {
    console.error(`Allowed paths: ${security.allowedPaths.join(", ")}`);
  }
  if (security.allowedCommands) {
    console.error(`Allowed commands: ${values["allow-command"]!.join(", ")}`);
  }
  if (maxSessions !== undefined) {
    console.error(`Max sessions: ${maxSessions}`);
  }
  if (security.sandbox?.enabled) {
    console.error(`Sandbox: enabled (fs: ${security.sandbox.fsMode})`);
    if (security.sandbox.allowedUrls) {
      console.error(`Sandbox allowed URLs: ${security.sandbox.allowedUrls.join(", ")}`);
    }
  }
}

async function runStdio() {
  const { server, registry, runtime } = createServer(cwd, security, serverOpts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`platter MCP server running on stdio (cwd: ${cwd})`);
  logRestrictions();

  const cleanup = () => {
    setTimeout(() => process.exit(1), 10_000).unref();
    if (runtime) runtime.dispose();
    registry.killAll().finally(() => {
      registry.dispose();
      process.exit(0);
    });
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
}

async function resolveAuthToken(): Promise<string | null> {
  if (authMode === "none") return null;
  // jwks mode accepts only externally-issued JWTs — no static bearer at all.
  if (authMode === "jwks") return null;
  if (values["auth-token"]) return values["auth-token"]!;

  // Try the system keyring first, then fall back to the config file.
  const fromKeyring = await loadFromKeyring();
  if (fromKeyring) return fromKeyring;
  if (persistedConfig?.authToken) return persistedConfig.authToken;

  // Generate a fresh token and try to store it in the keyring.
  const token = crypto.randomBytes(32).toString("base64url");
  try {
    await saveToKeyring(token);
  } catch {
    // Keyring unavailable — fall back to config file.
    if (persistedConfig) {
      persistedConfig.authToken = token;
      saveConfig(persistedConfig);
    }
  }
  return token;
}

async function runHttp() {
  const port = parseInt(values.port!, 10);
  const host = values.host!;
  const corsOrigin = values["cors-origin"]!;
  const token = await resolveAuthToken();

  // In tray mode, sync security.allowedTools from the persisted config
  // unless an explicit --tools flag was given.
  if (persistedConfig && !values.tools) {
    security.allowedTools = new Set(persistedConfig.enabledTools);
  }

  // External JWKS / OIDC — enabled in "jwks" auth mode. Platter acts as a pure
  // resource server; the issuer/JWKS resolution and verification live in the
  // HttpController. Mutually exclusive with the OAuth provider below.
  const externalAuth =
    authMode === "jwks"
      ? {
          issuer: values["oauth-issuer"],
          jwksUrl: values["jwks-url"],
          audience: values["oauth-audience"],
          scopeGrants: values["jwks-scope-grants"],
        }
      : undefined;

  // OAuth 2.1 Authorization Code + PKCE — enabled in "oauth" auth mode.
  let oauthProvider: PlatterOAuthProvider | undefined;
  if (authMode === "oauth") {
    const store = new PlatterClientsStore();
    oauthProvider = new PlatterOAuthProvider(store);

    // In non-tray mode, print the confirmation code to stderr so the
    // operator can enter it on the consent page. In tray mode, the tray
    // shows it as a desktop notification instead.
    if (!trayMode) {
      oauthProvider.on("pending", ({ clientName, confirmationCode }: PendingAuthEvent) => {
        console.error(`[oauth] Authorization request from "${clientName}" — confirmation code: ${confirmationCode}`);
      });
    }
  }

  // Only build an ActivityMonitor when the tray is going to consume it —
  // stdio/headless HTTP have no UI to update, so there's no point paying
  // for invocation bookkeeping.
  const activity = trayMode ? new ActivityMonitor() : undefined;
  const activityLog = activity ? new ActivityLog(activity) : null;

  const http = new HttpController({
    cwd,
    security,
    serverOpts,
    port,
    host,
    corsOrigin,
    authToken: token,
    oauthProvider,
    externalAuth,
    maxSessions,
    tlsCert: values["tls-cert"],
    tlsKey: values["tls-key"],
    activity,
  });

  await http.start();

  console.error(`platter MCP server running on ${http.url()} (cwd: ${cwd})`);
  console.error(`Auth mode: ${authMode}`);
  if (oauthProvider) {
    console.error("OAuth 2.1 + PKCE enabled (dynamic client registration at /register)");
  }
  if (externalAuth) {
    if (externalAuth.issuer) console.error(`External issuer: ${externalAuth.issuer}`);
    if (externalAuth.jwksUrl) console.error(`JWKS URL: ${externalAuth.jwksUrl}`);
    console.error(
      externalAuth.audience
        ? `Expected audience: ${externalAuth.audience}`
        : "Expected audience: (none — audience validation disabled)",
    );
    if (externalAuth.scopeGrants) console.error("Scope grants: tools:<name> token scopes narrow tool access");
  }
  if (token) {
    if (values["auth-token"]) {
      console.error("Bearer token: provided via --auth-token");
    } else if (persistedConfig?.authToken) {
      console.error(`Bearer token: ${token} (persisted in ${getConfigPath()})`);
    } else if (persistedConfig) {
      console.error(`Bearer token: ${token} (stored in system keyring)`);
    } else {
      console.error(`Bearer token: ${token}`);
    }
  }
  logRestrictions();

  let tray: { dispose: () => Promise<void> } | null = null;
  if (trayMode && persistedConfig) {
    try {
      tray = await runTray({
        http,
        security,
        config: persistedConfig,
        activity,
        oauthProvider,
        onQuit: async () => {
          oauthProvider?.dispose();
          await http.dispose();
          activityLog?.dispose();
        },
      });
      console.error("System tray registered.");
    } catch (err: any) {
      console.error(`[tray] failed to register: ${err?.message ?? err}`);
    }
  }

  const cleanup = () => {
    setTimeout(() => process.exit(1), 10_000).unref();
    (async () => {
      if (tray) await tray.dispose().catch(() => {});
      oauthProvider?.dispose();
      await http.dispose().catch(() => {});
      activityLog?.dispose();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
}

if (values.transport === "http") {
  runHttp().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
} else {
  runStdio().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

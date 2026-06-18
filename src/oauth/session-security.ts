import { resolve, sep } from "node:path";
import { ALL_TOOL_NAMES, type SecurityConfig, type ToolName } from "../security.js";
import type { ClientGrant } from "./provider.js";

/**
 * Narrow a global security config by a per-client grant. Grants can only
 * narrow (never widen), with one exception: if the global config doesn't
 * enable the sandbox, a grant CAN turn it on for that client. Commands are
 * narrowed by ANDing the grant's patterns with the global ones as separate
 * groups (see SecurityConfig.allowedCommands), so a broad grant pattern can't
 * escape the global `--allow-command` ceiling.
 *
 * When `grant` is null (legacy bearer token), the global config is returned
 * as-is minus the `onToolsChanged` hook — runtime toggles reach per-session
 * tools via `broadcastToolToggle`, not via each session's own hook.
 *
 * Kept free of any HTTP/express dependency so it can be unit-tested in
 * isolation (importing the express-laden HTTP controller into the test runner
 * is fragile).
 */
export function buildSessionSecurity(global: SecurityConfig, grant: ClientGrant | null): SecurityConfig {
  if (!grant) {
    const { onToolsChanged: _drop, ...rest } = global;
    return { ...rest };
  }

  const sessionSecurity: SecurityConfig = {};

  // Tools: intersection of global enabled and grant-requested.
  const grantTools = new Set<ToolName>(grant.tools);
  const globalTools = global.allowedTools ?? new Set<ToolName>(ALL_TOOL_NAMES);
  const intersected = new Set<ToolName>();
  for (const t of grantTools) {
    if (globalTools.has(t)) intersected.add(t);
  }
  sessionSecurity.allowedTools = intersected;

  // Paths: grant paths must be subpaths of at least one global allowed path
  // (if the global config has a restriction). Otherwise the grant paths apply
  // directly. Grant paths are resolved to absolute form.
  if (grant.allowedPaths?.length) {
    const grantResolved = grant.allowedPaths.map((p) => resolve(p));
    if (global.allowedPaths?.length) {
      const globalPaths = global.allowedPaths;
      sessionSecurity.allowedPaths = grantResolved.filter((g) =>
        globalPaths.some((allowed) => g === allowed || g.startsWith(allowed + sep)),
      );
    } else {
      sessionSecurity.allowedPaths = grantResolved;
    }
  } else if (global.allowedPaths) {
    sessionSecurity.allowedPaths = global.allowedPaths;
  }

  // Commands: enforce the global ceiling AND the grant as a conjunction of
  // groups (see SecurityConfig.allowedCommands / validateCommand). The global
  // patterns stay as their own group(s); the grant's consent-page patterns are
  // compiled into an additional group. A command must satisfy every group, so
  // a grant can only narrow — never widen — the global restriction, even if the
  // operator types a broad pattern like `.*` on the consent page.
  const commandGroups: RegExp[][] = [];
  if (global.allowedCommands?.length) {
    commandGroups.push(...global.allowedCommands);
  }
  if (grant.allowedCommands?.length) {
    const grantGroup = grant.allowedCommands.flatMap((pat) => {
      try {
        return [new RegExp(`^(?:${pat})$`)];
      } catch {
        return [];
      }
    });
    if (grantGroup.length) commandGroups.push(grantGroup);
  }
  if (commandGroups.length) {
    sessionSecurity.allowedCommands = commandGroups;
  }

  // Sandbox: the global config wins whenever it's on (clients can't weaken).
  // Otherwise, if the grant opts in, use the grant's sandbox config.
  if (global.sandbox?.enabled) {
    sessionSecurity.sandbox = global.sandbox;
  } else if (grant.sandbox?.enabled) {
    sessionSecurity.sandbox = {
      enabled: true,
      fsMode: grant.sandbox.fsMode,
      allowedUrls: grant.sandbox.allowedUrls,
    };
  } else if (global.sandbox) {
    sessionSecurity.sandbox = global.sandbox;
  }

  return sessionSecurity;
}

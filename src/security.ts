import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export const ALL_TOOL_NAMES = ["read", "write", "edit", "bash", "glob", "grep", "js"] as const;
export type ToolName = (typeof ALL_TOOL_NAMES)[number];

export type SandboxFsMode = "memory" | "overlay" | "readwrite";

export interface SandboxConfig {
  enabled: boolean;
  fsMode: SandboxFsMode;
  allowedUrls?: string[];
}

export interface SecurityConfig {
  allowedTools?: Set<ToolName>;
  allowedPaths?: string[];
  /**
   * Allowed bash commands, modelled as a conjunction of disjunctions: a list
   * of pattern groups where a command must match at least one pattern in
   * *every* group. The global `--allow-command` patterns form one group; a
   * per-client OAuth grant adds another. Requiring all groups to match is what
   * lets a grant only narrow (never widen) the global restriction.
   */
  allowedCommands?: RegExp[][];
  sandbox?: SandboxConfig;
  /**
   * Notified when allowedTools is mutated at runtime via setToolEnabled.
   * Used by the tray to broadcast enable/disable to every active session's
   * RegisteredTool handles and to persist the new state to the config file.
   */
  onToolsChanged?: (tool: ToolName, enabled: boolean) => void;
}

/**
 * Mutate `allowedTools` and fire the change hook. If `allowedTools` is
 * unset, it is initialised to the full tool set before applying the change
 * so that "disable one tool" is distinguishable from "all tools allowed".
 */
export function setToolEnabled(config: SecurityConfig, tool: ToolName, enabled: boolean): void {
  if (!config.allowedTools) {
    config.allowedTools = new Set(ALL_TOOL_NAMES);
  }
  const was = config.allowedTools.has(tool);
  if (was === enabled) return;
  if (enabled) {
    config.allowedTools.add(tool);
  } else {
    config.allowedTools.delete(tool);
  }
  config.onToolsChanged?.(tool, enabled);
}

export function isToolEnabled(config: SecurityConfig, tool: ToolName): boolean {
  return !config.allowedTools || config.allowedTools.has(tool);
}

/**
 * Resolve a path to its real (symlink-resolved) location.
 * For non-existing paths (e.g. write targets), walks up to the nearest
 * existing ancestor, resolves it, then appends the remaining segments.
 */
async function resolveRealPath(targetPath: string): Promise<string> {
  const absolute = resolve(targetPath);

  if (existsSync(absolute)) {
    return realpath(absolute);
  }

  let current = absolute;
  const remaining: string[] = [];

  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    remaining.unshift(current.slice(parent.length + 1));
    current = parent;
  }

  const realAncestor = await realpath(current);
  return resolve(realAncestor, ...remaining);
}

/**
 * Validate that an absolute path falls within one of the allowed paths.
 * Resolves symlinks on both sides to prevent escaping via symlinked directories.
 */
export async function validatePath(absolutePath: string, allowedPaths: string[]): Promise<void> {
  const realTarget = await resolveRealPath(absolutePath);

  for (const allowed of allowedPaths) {
    const realAllowed = await resolveRealPath(allowed);
    if (realTarget === realAllowed || realTarget.startsWith(realAllowed + sep)) {
      return;
    }
  }

  throw new Error(`Access denied: "${absolutePath}" is outside allowed paths`);
}

/**
 * Validate a bash command against a conjunction of pattern groups: the command
 * must match at least one pattern in *every* group. Each group is a disjunction
 * (any pattern matches); the groups are ANDed together. Patterns are fully
 * anchored — the entire command string must match.
 *
 * A single global group reproduces the old "match any allowed pattern"
 * behaviour. A second group from a per-client grant can only narrow access,
 * since a command now has to satisfy the global group as well.
 *
 * An empty `commandGroups` array is unrestricted: with no groups to satisfy,
 * every command passes. To enforce any restriction, pass at least one group;
 * to block everything, pass a group with no matching patterns.
 */
export function validateCommand(command: string, commandGroups: RegExp[][]): void {
  for (const group of commandGroups) {
    if (!group.some((pattern) => pattern.test(command))) {
      throw new Error("Command not allowed. Must match one of the allowed command patterns.");
    }
  }
}

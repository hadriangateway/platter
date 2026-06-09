import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import packageJson from "../package.json";
import { ProcessRegistry } from "./process-registry.js";
import type { SecurityConfig, ToolName } from "./security.js";
import { isToolEnabled, validateCommand, validatePath } from "./security.js";
import { bashTool } from "./tools/bash.js";
import { editTool } from "./tools/edit.js";
import { globTool } from "./tools/glob.js";
import { grepTool } from "./tools/grep.js";
import { JsRuntime } from "./tools/js.js";
import { readTool } from "./tools/read.js";
import { createSandboxBash } from "./tools/sandbox-bash.js";
import { writeTool } from "./tools/write.js";
import type { ActivityMonitor } from "./tray/activity-monitor.js";
import { resolvePath } from "./utils.js";

export interface CreateServerOpts {
  maxProcesses?: number;
  /** Optional sink for tool-invocation + session events. */
  activity?: ActivityMonitor;
  /** Session identifier recorded on each invocation when `activity` is set. */
  sessionId?: string | null;
}

export interface CreateServerResult {
  server: McpServer;
  registry: ProcessRegistry;
  runtime: JsRuntime | null;
  /**
   * Handles for every registered tool. Tools not currently allowed by
   * `security.allowedTools` are registered in a disabled state so the tray
   * can flip them at runtime via `.enable()` / `.disable()` (which also
   * broadcasts `tools/list_changed`).
   */
  registeredTools: Map<ToolName, RegisteredTool>;
}

export function createServer(cwd: string, security: SecurityConfig = {}, opts?: CreateServerOpts): CreateServerResult {
  const server = new McpServer(
    {
      name: "platter",
      version: packageJson.version,
    },
    {
      instructions: [
        "Platter gives you controlled access to this computer's files and shell.",
        "Prefer the dedicated file tools (read, write, edit, glob, grep) over bash equivalents (cat, sed, find, grep), since they validate paths against the server's security policy and produce consistent output.",
        "Access may be restricted: file operations can be limited to allowed directories, bash commands checked against a whitelist, and individual tools enabled or disabled at runtime, so the available tool list can change mid-session. A rejected path or command is a policy decision; adjust your approach rather than retrying it verbatim.",
      ].join("\n"),
    },
  );

  const registry = new ProcessRegistry({ maxConcurrent: opts?.maxProcesses ?? 20 });
  const registeredTools = new Map<ToolName, RegisteredTool>();
  const activity = opts?.activity;
  const sessionId = opts?.sessionId ?? null;

  const register = (name: ToolName, handle: RegisteredTool) => {
    registeredTools.set(name, handle);
    if (!isToolEnabled(security, name)) {
      handle.disable();
    }
  };

  /**
   * Wrap a tool handler so start/end are reported to the ActivityMonitor.
   * Result type is preserved; errors thrown by the handler still bubble, but
   * the common case (handlers returning `{ isError: true }` on caught errors)
   * is recognised via the result shape.
   */
  function withActivity<A, R extends { isError?: boolean; content: Array<{ type: string; text?: string }> }>(
    name: ToolName,
    fn: (args: A, extra: any) => Promise<R>,
  ): (args: A, extra: any) => Promise<R> {
    if (!activity) return fn;
    return async (args, extra) => {
      const id = activity.invocationStarted(name, sessionId);
      try {
        const result = await fn(args, extra);
        if (result?.isError) {
          const msg = result.content?.[0]?.text;
          activity.invocationEnded(id, "error", typeof msg === "string" ? msg : undefined);
        } else {
          activity.invocationEnded(id, "ok");
        }
        return result;
      } catch (err: any) {
        activity.invocationEnded(id, "error", err?.message ?? String(err));
        throw err;
      }
    };
  }

  async function checkPath(path: string): Promise<void> {
    if (security.allowedPaths) {
      await validatePath(resolvePath(path, cwd), security.allowedPaths);
    }
  }

  function checkCommand(command: string): void {
    if (security.allowedCommands) {
      validateCommand(command, security.allowedCommands);
    }
  }

  {
    const handle = server.registerTool(
      "read",
      {
        title: "Read",
        description:
          "Read the contents of a file. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files.",
        inputSchema: {
          path: z.string().describe("Path to the file to read (relative or absolute)"),
          offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
          limit: z.number().optional().describe("Maximum number of lines to read"),
        },
        annotations: {
          readOnlyHint: true,
        },
      },
      withActivity("read", async (args, extra) => {
        if (extra.signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }], isError: true };
        try {
          await checkPath(args.path);
          const result = await readTool(args, cwd);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      }),
    );
    register("read", handle);
  }

  {
    const handle = server.registerTool(
      "write",
      {
        title: "Write",
        description:
          "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
        inputSchema: {
          path: z.string().describe("Path to the file to write (relative or absolute)"),
          content: z.string().describe("Content to write to the file"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
        },
      },
      withActivity("write", async (args, extra) => {
        if (extra.signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }], isError: true };
        try {
          await checkPath(args.path);
          const result = await writeTool(args, cwd);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      }),
    );
    register("write", handle);
  }

  {
    const handle = server.registerTool(
      "edit",
      {
        title: "Edit",
        description:
          "Edit a file by replacing exact text. The old_text must match exactly (including whitespace). Supports fuzzy matching for minor Unicode/whitespace differences. The match must be unique in the file.",
        inputSchema: {
          path: z.string().describe("Path to the file to edit (relative or absolute)"),
          old_text: z.string().describe("Exact text to find and replace (must match exactly)"),
          new_text: z.string().describe("New text to replace the old text with"),
          replace_all: z.boolean().optional().describe("Replace all occurrences of old_text (default false)"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
        },
      },
      withActivity("edit", async (args, extra) => {
        if (extra.signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }], isError: true };
        try {
          await checkPath(args.path);
          const result = await editTool(args, cwd);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      }),
    );
    register("edit", handle);
  }

  {
    const sandboxEnabled = security.sandbox?.enabled === true;
    const sandboxBashFn = sandboxEnabled ? createSandboxBash(security.sandbox!, security.allowedPaths, cwd) : null;

    const bashDescription = sandboxEnabled
      ? "Execute a bash command in a sandboxed environment (just-bash). Returns stdout and stderr combined. Output is truncated to the last 2000 lines or 50KB. Optionally provide a timeout in seconds. Note: sandbox does not support native binaries — only bash builtins and just-bash built-in commands."
      : `Execute a bash command, or manage a running process.

Call in one of two modes — do not mix them:
  1. Start a command: pass 'command' (and optional 'timeout'). Omit 'pid' and 'kill'.
  2. Manage a running process: pass 'pid' (and optional 'kill'). Omit 'command'.

Returns stdout/stderr combined, truncated to last 2000 lines or 50KB.

If a timeout is set and the command hasn't finished, partial output is returned with the process pid.
Use bash({ pid }) to wait for more output, or bash({ pid, kill: true }) to terminate it.`;

    const destructiveHint = sandboxEnabled ? security.sandbox!.fsMode === "readwrite" : true;

    let handle: RegisteredTool;
    if (sandboxEnabled) {
      handle = server.registerTool(
        "bash",
        {
          title: "Bash",
          description: bashDescription,
          inputSchema: {
            command: z.string().describe("Bash command to execute"),
            timeout: z.number().optional().describe("Timeout in seconds (optional, no default timeout)"),
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint,
          },
        },
        withActivity("bash", async (args, extra) => {
          try {
            checkCommand(args.command);
            const result = await sandboxBashFn!(args, cwd, { signal: extra.signal });
            return { content: [{ type: "text", text: result }] };
          } catch (err: any) {
            return { content: [{ type: "text", text: err.message }], isError: true };
          }
        }),
      );
    } else {
      handle = server.registerTool(
        "bash",
        {
          title: "Bash",
          description: bashDescription,
          inputSchema: {
            command: z
              .string()
              .optional()
              .describe(
                "Bash command to execute. Provide this to start a new process; omit when managing an existing one via 'pid'.",
              ),
            pid: z
              .number()
              .optional()
              .describe(
                "PID of a running process to reattach to or kill. Omit (do not pass 0) when starting a new command via 'command'.",
              ),
            timeout: z
              .number()
              .optional()
              .describe(
                "Timeout in seconds. If the command hasn't finished by then, partial output is returned with the process pid.",
              ),
            kill: z
              .boolean()
              .optional()
              .describe(
                "Kill the process specified by 'pid'. Only valid together with 'pid'; omit when starting a new command.",
              ),
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint,
          },
        },
        withActivity("bash", async (args, extra) => {
          try {
            if (args.command) checkCommand(args.command);
            const result = await bashTool(args, cwd, {
              registry,
              signal: extra.signal,
            });
            return { content: [{ type: "text", text: result }] };
          } catch (err: any) {
            return { content: [{ type: "text", text: err.message }], isError: true };
          }
        }),
      );
    }
    register("bash", handle);
  }

  {
    const handle = server.registerTool(
      "glob",
      {
        title: "Glob",
        description:
          "Fast file pattern matching. Returns file paths matching a glob pattern, sorted alphabetically. Supports patterns like '**/*.ts', 'src/**/*.tsx', '*.json'.",
        inputSchema: {
          pattern: z.string().describe("Glob pattern to match files against (e.g. '**/*.ts')"),
          path: z
            .string()
            .optional()
            .describe("Directory to search in (relative or absolute). Defaults to working directory."),
        },
        annotations: {
          readOnlyHint: true,
        },
      },
      withActivity("glob", async (args, extra) => {
        if (extra.signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }], isError: true };
        try {
          await checkPath(args.path ?? cwd);
          const result = await globTool(args, cwd);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      }),
    );
    register("glob", handle);
  }

  {
    const handle = server.registerTool(
      "grep",
      {
        title: "Grep",
        description:
          "Search file contents using ripgrep. Supports regex patterns, file filtering, and multiple output modes. Requires ripgrep (rg) to be installed.",
        inputSchema: {
          pattern: z.string().describe("Regular expression pattern to search for"),
          path: z
            .string()
            .optional()
            .describe("File or directory to search in (relative or absolute). Defaults to working directory."),
          glob: z.string().optional().describe("Glob pattern to filter files (e.g. '*.js', '*.{ts,tsx}')"),
          output_mode: z
            .enum(["content", "files_with_matches", "count"])
            .optional()
            .describe(
              "Output mode: 'content' shows matching lines, 'files_with_matches' shows file paths (default), 'count' shows match counts per file",
            ),
          context: z
            .number()
            .optional()
            .describe("Number of lines to show before and after each match (content mode only)"),
          before_context: z
            .number()
            .optional()
            .describe("Number of lines to show before each match (content mode only)"),
          after_context: z.number().optional().describe("Number of lines to show after each match (content mode only)"),
          case_insensitive: z.boolean().optional().describe("Case insensitive search (default false)"),
          fixed_strings: z
            .boolean()
            .optional()
            .describe("Treat pattern as a literal string, not a regex (default false)"),
        },
        annotations: {
          readOnlyHint: true,
        },
      },
      withActivity("grep", async (args, extra) => {
        try {
          await checkPath(args.path ?? cwd);
          const result = await grepTool(args, cwd, extra.signal);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      }),
    );
    register("grep", handle);
  }

  const runtime: JsRuntime = new JsRuntime();
  {
    const handle = server.registerTool(
      "js",
      {
        title: "JavaScript",
        description:
          'Evaluate JavaScript/TypeScript code in a persistent runtime. State persists across calls within the session.\n\nUse assignment (`x = 42`) or `var` to persist values between calls. `function` and `class` declarations also persist. `let`/`const` are scoped to the current evaluation.\n\nSupports `await` for async operations: `data = await fetch(url)`.\nLoad packages with `await load("lodash")` (fetches from unpkg.com) or `await load("https://cdn.example.com/lib.js")`.\n\nReturns the result of the last expression, plus any console output.',
        inputSchema: {
          code: z.string().describe("JavaScript or TypeScript code to evaluate"),
          timeout: z.number().optional().describe("Timeout in seconds (default: 30)"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
        },
      },
      withActivity("js", async (args, extra) => {
        try {
          const timeoutMs = args.timeout ? args.timeout * 1000 : 30000;
          const result = await runtime!.evaluate(args.code, timeoutMs, extra.signal);
          return { content: [{ type: "text", text: result }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
      }),
    );
    register("js", handle);
  }

  return { server, registry, runtime, registeredTools };
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { MAX_BYTES, resolvePath } from "../utils.js";

const MAX_RESULTS = 500;

type OutputMode = "content" | "files_with_matches" | "count";

export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: OutputMode;
  context?: number;
  before_context?: number;
  after_context?: number;
  case_insensitive?: boolean;
  fixed_strings?: boolean;
}

function buildRgArgs(args: GrepArgs, searchPath: string): string[] {
  const rgArgs: string[] = [];

  const mode: OutputMode = args.output_mode ?? "files_with_matches";

  if (mode === "files_with_matches") {
    rgArgs.push("--files-with-matches");
  } else if (mode === "count") {
    rgArgs.push("--count");
  } else {
    // content mode
    rgArgs.push("--line-number");

    if (args.before_context !== undefined) {
      rgArgs.push("-B", String(args.before_context));
    }
    if (args.after_context !== undefined) {
      rgArgs.push("-A", String(args.after_context));
    }
    if (args.context !== undefined) {
      rgArgs.push("-C", String(args.context));
    }
  }

  if (args.case_insensitive) {
    rgArgs.push("--ignore-case");
  }

  if (args.fixed_strings) {
    rgArgs.push("--fixed-strings");
  }

  if (args.glob) {
    rgArgs.push("--glob", args.glob);
  }

  rgArgs.push("--", args.pattern, searchPath);

  return rgArgs;
}

export async function grepTool(args: GrepArgs, cwd: string, signal?: AbortSignal): Promise<string> {
  const searchPath = args.path ? resolvePath(args.path, cwd) : cwd;

  if (!existsSync(searchPath)) {
    throw new Error(`Path not found: ${searchPath}`);
  }

  const rgArgs = buildRgArgs(args, searchPath);

  return new Promise<string>((resolve, reject) => {
    const child = spawn("rg", rgArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (signal) {
      const onAbort = () => child.kill("SIGTERM");
      if (signal.aborted) {
        child.kill("SIGTERM");
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        child.on("close", () => signal.removeEventListener("abort", onAbort));
      }
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let truncatedByBytes = false;

    child.stdout?.on("data", (data: Buffer) => {
      if (truncatedByBytes) return;
      totalBytes += data.length;
      if (totalBytes > MAX_BYTES) {
        truncatedByBytes = true;
        // Keep what we have so far
        chunks.push(data.subarray(0, data.length - (totalBytes - MAX_BYTES)));
        child.kill("SIGTERM");
      } else {
        chunks.push(data);
      }
    });

    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
    });

    child.on("error", (err: any) => {
      if (err.code === "ENOENT") {
        reject(
          new Error("ripgrep (rg) is not installed. Install it with: apt install ripgrep, brew install ripgrep, etc."),
        );
      } else {
        reject(err);
      }
    });

    child.on("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf-8");

      // rg exit code 1 = no matches, 2 = error
      if (code === 2) {
        reject(new Error(stderr.trim() || "ripgrep encountered an error"));
        return;
      }

      if (code === 1 || !output.trim()) {
        resolve(`No matches found for pattern: ${args.pattern}`);
        return;
      }

      // Truncate by line count
      const lines = output.split("\n");
      // Remove trailing empty line from split
      if (lines[lines.length - 1] === "") lines.pop();

      const truncatedByLines = lines.length > MAX_RESULTS;
      if (truncatedByLines) {
        lines.length = MAX_RESULTS;
      }

      let result = lines.join("\n");

      if (truncatedByBytes || truncatedByLines) {
        result += `\n\n[Results truncated. Narrow your search pattern or use glob to filter files.]`;
      }

      resolve(result);
    });
  });
}

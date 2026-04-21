import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ProcessRegistry, WaitResult } from "../process-registry.js";
import { formatSize, killProcessTree, MAX_BYTES, truncateTail } from "../utils.js";

function getShellConfig(): { shell: string; args: string[] } {
  const shell = process.env.SHELL || "/bin/bash";
  return { shell, args: ["-c"] };
}

export interface BashArgs {
  command?: string;
  pid?: number;
  timeout?: number;
  kill?: boolean;
}

export interface BashOpts {
  registry?: ProcessRegistry;
  signal?: AbortSignal;
}

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${s}s`;
}

function formatCompletedOutput(result: WaitResult): string {
  const truncation = truncateTail(result.output);
  let outputText = truncation.content || "(no output)";

  if (truncation.truncated) {
    const startLine = truncation.totalLines - truncation.outputLines + 1;
    const endLine = truncation.totalLines;
    outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(MAX_BYTES)} limit)]`;
  }

  return outputText;
}

export async function bashTool(args: BashArgs, cwd: string, opts?: BashOpts): Promise<string> {
  // Validation
  const hasCommand = args.command !== undefined && args.command !== "";
  const hasPid = args.pid !== undefined && args.pid > 0;

  if (hasCommand && hasPid) {
    throw new Error("Provide 'command' or 'pid', not both.");
  }
  if (!hasCommand && !hasPid) {
    throw new Error("Provide 'command' to start a new process or 'pid' to manage an existing one.");
  }
  if (args.kill && !hasPid) {
    throw new Error("'kill' requires 'pid'.");
  }

  // Kill mode
  if (hasPid && args.kill) {
    if (!opts?.registry) throw new Error("Process management requires a registry.");
    await opts.registry.kill(args.pid!);
    const output = opts.registry.readNewOutput(args.pid!);
    const truncation = truncateTail(output);
    let outputText = truncation.content || "(no output)";
    if (truncation.truncated) {
      const startLine = truncation.totalLines - truncation.outputLines + 1;
      const endLine = truncation.totalLines;
      outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(MAX_BYTES)} limit)]`;
    }
    outputText += `\n\nProcess ${args.pid} terminated.`;
    return outputText;
  }

  // Reattach mode
  if (hasPid) {
    if (!opts?.registry) throw new Error("Process management requires a registry.");
    const timeoutMs = args.timeout ? args.timeout * 1000 : undefined;
    const result = await opts.registry.waitForOutput(args.pid!, timeoutMs, opts.signal);
    return formatWaitResult(result);
  }

  // Spawn mode — no registry: use legacy blocking behavior
  if (!opts?.registry) {
    return legacySpawn({ command: args.command!, timeout: args.timeout }, cwd);
  }

  // Spawn mode — with registry
  if (!existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }

  const { shell, args: shellArgs } = getShellConfig();
  const child = spawn(shell, [...shellArgs, args.command!], {
    cwd,
    detached: true,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const timeoutMs = args.timeout ? args.timeout * 1000 : undefined;
  const pid = opts.registry.register(child, args.command!);
  const result = await opts.registry.waitForOutput(pid, timeoutMs, opts.signal);
  return formatWaitResult(result);
}

function formatWaitResult(result: WaitResult): string {
  if (!result.done) {
    // Soft timeout — return partial output with continuation hint
    const truncation = truncateTail(result.output);
    let outputText = truncation.content || "";
    if (truncation.truncated) {
      const startLine = truncation.totalLines - truncation.outputLines + 1;
      const endLine = truncation.totalLines;
      outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(MAX_BYTES)} limit)]`;
    }
    if (outputText) outputText += "\n\n";
    outputText += `[Process still running (pid: ${result.pid}, elapsed: ${formatElapsed(result.elapsed)}). Call bash with pid to continue waiting, or with pid + kill to terminate.]`;
    return outputText;
  }

  const outputText = formatCompletedOutput(result);

  if (result.exitSignal) {
    throw new Error(`Process was killed by ${result.exitSignal}\n\n${outputText}`);
  }
  if (result.exitCode !== 0 && result.exitCode !== null) {
    throw new Error(`Command exited with code ${result.exitCode}\n\n${outputText}`);
  }

  return outputText;
}

function legacySpawn(args: { command: string; timeout?: number }, cwd: string): Promise<string> {
  if (!existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }

  const { shell, args: shellArgs } = getShellConfig();

  return new Promise<string>((resolve, reject) => {
    const child = spawn(shell, [...shellArgs, args.command], {
      cwd,
      detached: true,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    if (args.timeout !== undefined && args.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (child.pid) killProcessTree(child.pid);
      }, args.timeout * 1000);
    }

    const chunks: Buffer[] = [];

    child.stdout?.on("data", (data: Buffer) => chunks.push(data));
    child.stderr?.on("data", (data: Buffer) => chunks.push(data));

    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const fullOutput = Buffer.concat(chunks).toString("utf-8");

      if (timedOut) {
        let output = fullOutput;
        if (output) output += "\n\n";
        output += `Command timed out after ${args.timeout} seconds`;
        reject(new Error(output));
        return;
      }

      const truncation = truncateTail(fullOutput);
      let outputText = truncation.content || "(no output)";

      if (truncation.truncated) {
        const startLine = truncation.totalLines - truncation.outputLines + 1;
        const endLine = truncation.totalLines;
        outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(MAX_BYTES)} limit)]`;
      }

      if (signal) {
        reject(new Error(`Process was killed by ${signal}\n\n${outputText}`));
      } else if (code !== 0 && code !== null) {
        reject(new Error(`Command exited with code ${code}\n\n${outputText}`));
      } else {
        resolve(outputText);
      }
    });
  });
}

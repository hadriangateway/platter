import { open } from "node:fs/promises";
import { Bash, type IFileSystem, InMemoryFs, MountableFs, type NetworkConfig, OverlayFs, ReadWriteFs } from "just-bash";
import type { SandboxConfig } from "../security.js";
import { formatSize, MAX_BYTES, resolveTimeout, truncateTail } from "../utils.js";

// Bun 1.4+ creates a FinalizationRegistry the first time a FileHandle is
// constructed. just-bash blocks that constructor while a script runs, so a
// first open() from inside exec() fails and real files look missing. Opening
// one handle up front lets Bun do that setup outside the sandbox.
let fileHandlesReady: Promise<void> | undefined;
function warmFileHandles(): Promise<void> {
  fileHandlesReady ??= open(process.execPath, "r")
    .then((handle) => handle.close())
    .catch(() => {});
  return fileHandlesReady;
}

function buildFilesystem(
  config: SandboxConfig,
  allowedPaths: string[] | undefined,
  cwd: string,
): { fs: IFileSystem; cwd: string } {
  const { fsMode } = config;

  if (fsMode === "memory") {
    return { fs: new InMemoryFs(), cwd: "/home/user" };
  }

  if (fsMode === "readwrite") {
    // ReadWriteFs has no mountPoint — always wrap in MountableFs so absolute paths map naturally
    const base = new InMemoryFs();
    const mountable = new MountableFs({ base });
    if (allowedPaths?.length) {
      let cwdCovered = false;
      for (const p of allowedPaths) {
        mountable.mount(p, new ReadWriteFs({ root: p }));
        if (cwd === p || cwd.startsWith(`${p}/`)) {
          cwdCovered = true;
        }
      }
      if (!cwdCovered) {
        mountable.mount(cwd, new ReadWriteFs({ root: cwd }));
      }
    } else {
      mountable.mount(cwd, new ReadWriteFs({ root: cwd }));
    }
    return { fs: mountable, cwd };
  }

  // overlay — OverlayFs has mountPoint so can be used directly for single-mount case
  if (!allowedPaths?.length) {
    const overlay = new OverlayFs({ root: cwd, mountPoint: cwd });
    return { fs: overlay, cwd };
  }
  const base = new InMemoryFs();
  const mountable = new MountableFs({ base });
  let cwdCovered = false;
  for (const p of allowedPaths) {
    mountable.mount(p, new OverlayFs({ root: p, mountPoint: p }));
    if (cwd === p || cwd.startsWith(`${p}/`)) {
      cwdCovered = true;
    }
  }
  if (!cwdCovered) {
    mountable.mount(cwd, new OverlayFs({ root: cwd, mountPoint: cwd }));
  }
  return { fs: mountable, cwd };
}

function buildNetwork(config: SandboxConfig): NetworkConfig | undefined {
  if (!config.allowedUrls?.length) {
    return undefined;
  }
  return {
    allowedUrlPrefixes: config.allowedUrls,
    allowedMethods: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"],
    denyPrivateRanges: true,
  };
}

export function createSandboxBash(
  config: SandboxConfig,
  allowedPaths: string[] | undefined,
  cwd: string,
  defaultTimeout?: number,
  maxTimeout?: number,
): (args: { command: string; timeout?: number }, execCwd: string, opts?: { signal?: AbortSignal }) => Promise<string> {
  const { fs, cwd: virtualCwd } = buildFilesystem(config, allowedPaths, cwd);
  const network = buildNetwork(config);

  const bash = new Bash({
    fs,
    cwd: virtualCwd,
    network,
  });

  return async (args, _execCwd, opts?) => {
    const timeout = resolveTimeout(args.timeout, defaultTimeout, maxTimeout);
    const timeoutMs = timeout !== undefined ? timeout * 1000 : undefined;
    const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;

    // Combine MCP cancellation signal with timeout signal
    let signal: AbortSignal | undefined;
    if (timeoutSignal && opts?.signal) {
      signal = AbortSignal.any([timeoutSignal, opts.signal]);
    } else {
      signal = timeoutSignal ?? opts?.signal;
    }

    await warmFileHandles();

    let result: Awaited<ReturnType<typeof bash.exec>>;
    try {
      result = await bash.exec(args.command, { signal });
    } catch (err: any) {
      if (opts?.signal?.aborted) {
        throw new Error("Cancelled");
      }
      if (err.name === "TimeoutError" || timeoutSignal?.aborted) {
        throw new Error(`Command timed out after ${timeout} seconds`);
      }
      throw err;
    }

    // Check cancellation first
    if (opts?.signal?.aborted) {
      throw new Error("Cancelled");
    }

    // Check if timeout signal aborted after exec returned
    if (timeoutSignal?.aborted) {
      let output = result.stdout + (result.stderr ? (result.stdout ? "\n" : "") + result.stderr : "");
      if (output) output += "\n\n";
      output += `Command timed out after ${timeout} seconds`;
      throw new Error(output);
    }

    const fullOutput = result.stdout + (result.stderr ? (result.stdout ? "\n" : "") + result.stderr : "");

    const truncation = truncateTail(fullOutput);
    let outputText = truncation.content || "(no output)";

    if (truncation.truncated) {
      const startLine = truncation.totalLines - truncation.outputLines + 1;
      const endLine = truncation.totalLines;
      outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(MAX_BYTES)} limit)]`;
    }

    if (result.exitCode !== 0) {
      outputText += `\n\nCommand exited with code ${result.exitCode}`;
      throw new Error(outputText);
    }

    return outputText;
  };
}

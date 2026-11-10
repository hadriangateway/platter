import { open } from "node:fs/promises";
import { Bash, type IFileSystem, InMemoryFs, MountableFs, type NetworkConfig, OverlayFs, ReadWriteFs } from "just-bash";
import type { SandboxConfig } from "../security.js";
import { formatSize, MAX_BYTES, resolveTimeout, timerMs, truncateTail } from "../utils.js";
import { type BashArgs, stillRunningNotice, validateBashArgs } from "./bash.js";

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

type ExecResult = Awaited<ReturnType<Bash["exec"]>>;

interface SandboxJob {
  pid: number;
  startedAt: number;
  controller: AbortController;
  deadline?: NodeJS.Timeout;
  timedOutAfter?: number;
  killed: boolean;
  done: boolean;
  completedAt?: number;
  result?: ExecResult;
  error?: unknown;
  settled: Promise<void>;
}

export interface SandboxBashOpts {
  /** Timeout in seconds applied when a new command does not specify one. */
  defaultTimeout?: number;
  /** Upper bound in seconds on how long a command may run, whatever the call asks for. */
  maxTimeout?: number;
  /** Max commands running at once (default: 20). */
  maxConcurrent?: number;
}

export type SandboxBash = ((args: BashArgs, execCwd: string, opts?: { signal?: AbortSignal }) => Promise<string>) & {
  /** Abort every running command, for use when the session shuts down. */
  killAll(): Promise<void>;
};

const STALE_KEEP_MS = 5 * 60 * 1000;

function combineOutput(result: ExecResult | undefined): string {
  if (!result) return "";
  return result.stdout + (result.stderr ? (result.stdout ? "\n" : "") + result.stderr : "");
}

function truncateOutput(fullOutput: string, emptyText: string): string {
  const truncation = truncateTail(fullOutput);
  let outputText = truncation.content || emptyText;

  if (truncation.truncated) {
    const startLine = truncation.totalLines - truncation.outputLines + 1;
    const endLine = truncation.totalLines;
    outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(MAX_BYTES)} limit)]`;
  }
  return outputText;
}

export function createSandboxBash(
  config: SandboxConfig,
  allowedPaths: string[] | undefined,
  cwd: string,
  sandboxOpts: SandboxBashOpts = {},
): SandboxBash {
  const { fs, cwd: virtualCwd } = buildFilesystem(config, allowedPaths, cwd);
  const network = buildNetwork(config);

  const bash = new Bash({
    fs,
    cwd: virtualCwd,
    network,
  });

  // The sandbox spawns no OS processes, so "pid" here is a job number that
  // plays the same role as a real pid does for native bash.
  const jobs = new Map<number, SandboxJob>();
  const maxConcurrent = sandboxOpts.maxConcurrent ?? 20;
  let nextPid = 1;

  const getJob = (pid: number): SandboxJob => {
    const job = jobs.get(pid);
    if (!job) throw new Error(`No tracked process with pid ${pid}`);
    return job;
  };

  const setDeadline = (job: SandboxJob, seconds: number, maxLifetimeSeconds?: number) => {
    if (job.done) return;
    const elapsed = (Date.now() - job.startedAt) / 1000;
    let remaining = seconds;
    if (maxLifetimeSeconds !== undefined && maxLifetimeSeconds > 0) {
      remaining = Math.min(remaining, Math.max(0, maxLifetimeSeconds - elapsed));
    }
    const delay = timerMs(remaining);
    const lifetime = Math.round((elapsed + delay / 1000) * 10) / 10;

    clearTimeout(job.deadline);
    job.deadline = setTimeout(() => {
      if (job.done) return;
      job.timedOutAfter = lifetime;
      job.controller.abort();
    }, delay);
    job.deadline.unref();
  };

  const start = (command: string): SandboxJob => {
    const now = Date.now();
    let running = 0;
    for (const [pid, job] of jobs) {
      if (!job.done) running++;
      else if (job.completedAt && now - job.completedAt > STALE_KEEP_MS) jobs.delete(pid);
    }
    if (running >= maxConcurrent) {
      throw new Error(`Process limit reached (${maxConcurrent} concurrent processes). Kill a running process first.`);
    }

    const controller = new AbortController();
    const job: SandboxJob = {
      pid: nextPid++,
      startedAt: now,
      controller,
      killed: false,
      done: false,
      settled: Promise.resolve(),
    };
    job.settled = warmFileHandles()
      .then(() => bash.exec(command, { signal: controller.signal }))
      .then(
        (result) => {
          job.result = result;
        },
        (err) => {
          job.error = err;
        },
      )
      .then(() => {
        clearTimeout(job.deadline);
        job.done = true;
        job.completedAt = Date.now();
      });
    jobs.set(job.pid, job);
    return job;
  };

  const finish = (job: SandboxJob): string => {
    jobs.delete(job.pid);
    const fullOutput = combineOutput(job.result);

    if (job.timedOutAfter !== undefined) {
      let output = truncateOutput(fullOutput, "");
      if (output) output += "\n\n";
      throw new Error(`${output}Command timed out after ${job.timedOutAfter} seconds`);
    }
    if (job.killed) {
      throw new Error(`Process was killed\n\n${truncateOutput(fullOutput, "(no output)")}`);
    }
    if (job.error) throw job.error;

    let outputText = truncateOutput(fullOutput, "(no output)");
    if (job.result && job.result.exitCode !== 0) {
      outputText += `\n\nCommand exited with code ${job.result.exitCode}`;
      throw new Error(outputText);
    }
    return outputText;
  };

  const kill = (job: SandboxJob) => {
    if (job.done) return;
    job.killed = true;
    job.controller.abort();
  };

  const run = async (args: BashArgs, _execCwd: string, opts?: { signal?: AbortSignal }): Promise<string> => {
    const { hasPid } = validateBashArgs(args);

    if (hasPid && args.kill) {
      const job = getJob(args.pid!);
      kill(job);
      await job.settled;
      jobs.delete(job.pid);
      return `${truncateOutput(combineOutput(job.result), "(no output)")}\n\nProcess ${job.pid} terminated.`;
    }

    let job: SandboxJob;
    if (hasPid) {
      job = getJob(args.pid!);
      if (args.timeout !== undefined && args.timeout > 0) {
        setDeadline(job, args.timeout, sandboxOpts.maxTimeout);
      }
    } else {
      job = start(args.command!);
      const timeout = resolveTimeout(args.timeout, sandboxOpts.defaultTimeout, sandboxOpts.maxTimeout);
      if (timeout !== undefined) setDeadline(job, timeout);
    }

    const racers: Promise<"done" | "warn" | "aborted">[] = [job.settled.then(() => "done" as const)];
    let warnTimer: NodeJS.Timeout | undefined;
    if (args.warn !== undefined && args.warn > 0) {
      const warnMs = timerMs(args.warn);
      racers.push(
        new Promise((resolve) => {
          warnTimer = setTimeout(() => resolve("warn"), warnMs);
        }),
      );
    }
    const signal = opts?.signal;
    if (signal) {
      racers.push(
        new Promise((resolve) => {
          if (signal.aborted) resolve("aborted");
          else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
        }),
      );
    }

    const reason = await Promise.race(racers);
    clearTimeout(warnTimer);

    if (reason === "aborted") {
      kill(job);
      await job.settled;
      jobs.delete(job.pid);
      throw new Error("Cancelled");
    }
    if (reason === "warn" && !job.done) {
      // just-bash only hands back output when the command ends, so there is
      // nothing partial to show yet.
      return stillRunningNotice(job.pid, Date.now() - job.startedAt);
    }
    return finish(job);
  };

  const killAll = async () => {
    const all = [...jobs.values()];
    jobs.clear();
    for (const job of all) kill(job);
    await Promise.all(all.map((job) => job.settled));
  };

  return Object.assign(run, { killAll });
}

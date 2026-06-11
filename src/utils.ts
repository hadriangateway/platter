import { createHash, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/**
 * Constant-time string equality for secrets (bearer tokens). Hashing both
 * inputs to fixed-length SHA-256 digests first means `timingSafeEqual` never
 * throws on a length mismatch and the comparison leaks neither the value nor
 * the length of the expected secret.
 */
export function safeStrEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function killProcessTree(pid: number): void {
  try {
    // Kill entire process group
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already dead
    }
  }
}

export function resolvePath(path: string, cwd: string): string {
  let p = path;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) p = homedir() + p.slice(1);
  return isAbsolute(p) ? p : resolve(cwd, p);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;

/**
 * Truncate from the tail (keep last N lines/bytes), suitable for bash
 * output where errors/final results appear at the end.
 */
export function truncateTail(content: string): {
  content: string;
  truncated: boolean;
  totalLines: number;
  outputLines: number;
} {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(content, "utf-8");

  if (totalLines <= MAX_LINES && totalBytes <= MAX_BYTES) {
    return { content, truncated: false, totalLines, outputLines: totalLines };
  }

  // Work backwards
  const outputLinesArr: string[] = [];
  let outputBytes = 0;

  for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < MAX_LINES; i--) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0);

    if (outputBytes + lineBytes > MAX_BYTES) break;

    outputLinesArr.unshift(line);
    outputBytes += lineBytes;
  }

  return {
    content: outputLinesArr.join("\n"),
    truncated: true,
    totalLines,
    outputLines: outputLinesArr.length,
  };
}

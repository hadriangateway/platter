import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxBash } from "../src/tools/sandbox-bash.js";

describe("sandbox-bash (memory mode)", () => {
  it("runs a basic command", async () => {
    const bash = createSandboxBash({ enabled: true, fsMode: "memory" }, undefined, "/tmp");
    const result = await bash({ command: "echo hello" }, "/tmp");
    expect(result).toContain("hello");
  });

  it("persists files across calls", async () => {
    const bash = createSandboxBash({ enabled: true, fsMode: "memory" }, undefined, "/tmp");
    await bash({ command: "echo 'hello world' > /home/user/test.txt" }, "/tmp");
    const result = await bash({ command: "cat /home/user/test.txt" }, "/tmp");
    expect(result).toContain("hello world");
  });

  it("cannot access host filesystem", async () => {
    const bash = createSandboxBash({ enabled: true, fsMode: "memory" }, undefined, "/tmp");
    await expect(bash({ command: "cat /etc/hostname" }, "/tmp")).rejects.toThrow();
  });

  it("returns non-zero exit codes as errors", async () => {
    const bash = createSandboxBash({ enabled: true, fsMode: "memory" }, undefined, "/tmp");
    await expect(bash({ command: "exit 42" }, "/tmp")).rejects.toThrow("exited with code 42");
  });

  it("truncates large output", async () => {
    const bash = createSandboxBash({ enabled: true, fsMode: "memory" }, undefined, "/tmp");
    const result = await bash({ command: "seq 1 5000" }, "/tmp");
    expect(result).toContain("Showing lines");
  });
});

describe("sandbox-bash (default timeout)", () => {
  it("applies the default timeout when none is given", async () => {
    const bash = createSandboxBash({ enabled: true, fsMode: "memory" }, undefined, "/tmp", 0.2);
    await expect(bash({ command: "sleep 5" }, "/tmp")).rejects.toThrow("timed out after 0.2 seconds");
  });

  it("explicit timeout overrides the default", async () => {
    const bash = createSandboxBash({ enabled: true, fsMode: "memory" }, undefined, "/tmp", 0.1);
    const result = await bash({ command: "sleep 0.5; echo done", timeout: 5 }, "/tmp");
    expect(result).toContain("done");
  });
});

describe("sandbox-bash (max timeout)", () => {
  it("caps an explicit timeout at the maximum", async () => {
    const bash = createSandboxBash({ enabled: true, fsMode: "memory" }, undefined, "/tmp", undefined, 0.2);
    await expect(bash({ command: "sleep 5", timeout: 60 }, "/tmp")).rejects.toThrow("timed out after 0.2 seconds");
  });
});

describe("sandbox-bash (readwrite mode)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "platter-sandbox-rw-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("reads real files in cwd", async () => {
    await writeFile(join(dir, "hello.txt"), "from disk");
    const bash = createSandboxBash({ enabled: true, fsMode: "readwrite" }, undefined, dir);
    const result = await bash({ command: `cat ${dir}/hello.txt` }, dir);
    expect(result).toContain("from disk");
  });

  it("writes real files in cwd", async () => {
    const bash = createSandboxBash({ enabled: true, fsMode: "readwrite" }, undefined, dir);
    await bash({ command: `echo 'sandbox wrote this' > ${dir}/output.txt` }, dir);
    const content = await readFile(join(dir, "output.txt"), "utf-8");
    expect(content).toContain("sandbox wrote this");
  });

  it("cannot escape cwd", async () => {
    const bash = createSandboxBash({ enabled: true, fsMode: "readwrite" }, undefined, dir);
    await expect(bash({ command: "cat /etc/hostname" }, dir)).rejects.toThrow();
  });
});

describe("sandbox-bash (overlay mode)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "platter-sandbox-overlay-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("reads real files from disk", async () => {
    await writeFile(join(dir, "readme.txt"), "original content");
    const bash = createSandboxBash({ enabled: true, fsMode: "overlay" }, undefined, dir);
    const result = await bash({ command: `cat ${dir}/readme.txt` }, dir);
    expect(result).toContain("original content");
  });

  it("writes don't persist to disk", async () => {
    await writeFile(join(dir, "readme.txt"), "original content");
    const bash = createSandboxBash({ enabled: true, fsMode: "overlay" }, undefined, dir);
    await bash({ command: `echo 'modified' > ${dir}/readme.txt` }, dir);

    // Inside sandbox, reads the modified version
    const sandboxResult = await bash({ command: `cat ${dir}/readme.txt` }, dir);
    expect(sandboxResult).toContain("modified");

    // On disk, the original is untouched
    const diskContent = await readFile(join(dir, "readme.txt"), "utf-8");
    expect(diskContent).toBe("original content");
  });
});

describe("sandbox-bash (network)", () => {
  it("blocks network by default", async () => {
    const bash = createSandboxBash({ enabled: true, fsMode: "memory" }, undefined, "/tmp");
    await expect(bash({ command: "curl https://example.com" }, "/tmp")).rejects.toThrow();
  });
});

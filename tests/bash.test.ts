import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRegistry } from "../src/process-registry.js";
import { bashTool } from "../src/tools/bash.js";

describe("bashTool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "platter-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("runs a basic command", async () => {
    const result = await bashTool({ command: "echo hello" }, dir);
    expect(result).toContain("hello");
  });

  it("returns non-zero exit codes as errors", async () => {
    expect(bashTool({ command: "exit 42" }, dir)).rejects.toThrow("exited with code 42");
  });

  it("times out long commands", async () => {
    expect(bashTool({ command: "sleep 60", timeout: 1 }, dir)).rejects.toThrow("timed out");
  });

  it("uses specified cwd", async () => {
    const result = await bashTool({ command: "pwd" }, dir);
    expect(result).toContain(dir);
  });

  it("truncates large output", async () => {
    const result = await bashTool({ command: "seq 1 5000" }, dir);
    expect(result).toContain("Showing lines");
  });
});

describe("bashTool with registry", () => {
  let dir: string;
  let registry: ProcessRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "platter-test-"));
    registry = new ProcessRegistry();
  });

  afterEach(async () => {
    await registry.killAll();
    registry.dispose();
    await rm(dir, { recursive: true });
  });

  it("pid reattach workflow", async () => {
    // Start a long command with a short timeout so it returns partial output
    const result1 = await bashTool({ command: "echo start && sleep 2 && echo done", timeout: 0.2 }, dir, { registry });

    expect(result1).toContain("start");
    expect(result1).toContain("Process still running");

    // Extract pid from the message
    const pidMatch = result1.match(/pid: (\d+)/);
    expect(pidMatch).toBeTruthy();
    const pid = parseInt(pidMatch![1], 10);

    // Reattach and wait for completion
    const result2 = await bashTool({ pid, timeout: 5 }, dir, { registry });
    expect(result2).toContain("done");
  });

  it("pid kill workflow", async () => {
    // Start a long command with short timeout
    const result1 = await bashTool({ command: "sleep 60", timeout: 0.2 }, dir, { registry });

    expect(result1).toContain("Process still running");
    const pidMatch = result1.match(/pid: (\d+)/);
    const pid = parseInt(pidMatch![1], 10);

    // Kill it
    const result2 = await bashTool({ pid, kill: true }, dir, { registry });
    expect(result2).toContain("terminated");
  });

  it("validates command xor pid", async () => {
    await expect(bashTool({}, dir)).rejects.toThrow("Provide 'command'");
    await expect(bashTool({ command: "echo hi", pid: 1 }, dir)).rejects.toThrow("not both");
  });

  it("kill requires pid", async () => {
    await expect(bashTool({ command: "echo hi", kill: true }, dir)).rejects.toThrow("'kill' requires 'pid'");
  });

  it("spawn with registry completes normally for fast commands", async () => {
    const result = await bashTool({ command: "echo fast", timeout: 5 }, dir, { registry });
    expect(result).toContain("fast");
    expect(result).not.toContain("Process still running");
  });

  it("applies the default timeout when none is given", async () => {
    const result = await bashTool({ command: "echo start && sleep 5" }, dir, { registry, defaultTimeout: 0.2 });
    expect(result).toContain("start");
    expect(result).toContain("Process still running");
  });

  it("applies the default timeout when reattaching", async () => {
    const result1 = await bashTool({ command: "sleep 5" }, dir, { registry, defaultTimeout: 0.2 });
    const pid = parseInt(result1.match(/pid: (\d+)/)![1], 10);
    const result2 = await bashTool({ pid }, dir, { registry, defaultTimeout: 0.2 });
    expect(result2).toContain("Process still running");
  });

  it("explicit timeout overrides the default", async () => {
    const result = await bashTool({ command: "sleep 0.5 && echo done", timeout: 5 }, dir, {
      registry,
      defaultTimeout: 0.1,
    });
    expect(result).toContain("done");
    expect(result).not.toContain("Process still running");
  });

  it("caps an explicit timeout at the maximum", async () => {
    const result = await bashTool({ command: "sleep 5", timeout: 60 }, dir, { registry, maxTimeout: 0.2 });
    expect(result).toContain("Process still running");
  });

  it("applies the maximum when no timeout or default is given", async () => {
    const result = await bashTool({ command: "sleep 5" }, dir, { registry, maxTimeout: 0.2 });
    expect(result).toContain("Process still running");
  });
});

import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { formatSize, resolvePath, resolveTimeout, timerMs } from "../src/utils.js";

describe("resolvePath", () => {
  it("returns absolute paths as-is", () => {
    expect(resolvePath("/foo/bar", "/cwd")).toBe("/foo/bar");
  });

  it("resolves relative paths against cwd", () => {
    expect(resolvePath("foo/bar", "/cwd")).toBe(resolve("/cwd", "foo/bar"));
  });

  it("expands ~ to home directory", () => {
    expect(resolvePath("~", "/cwd")).toBe(homedir());
  });

  it("expands ~/ to home directory prefix", () => {
    expect(resolvePath("~/foo", "/cwd")).toBe(`${homedir()}/foo`);
  });
});

describe("formatSize", () => {
  it("formats bytes", () => {
    expect(formatSize(500)).toBe("500B");
  });

  it("formats kilobytes", () => {
    expect(formatSize(2048)).toBe("2.0KB");
  });

  it("formats megabytes", () => {
    expect(formatSize(1024 * 1024 * 3)).toBe("3.0MB");
  });
});

describe("resolveTimeout", () => {
  it("prefers the requested value, then the default", () => {
    expect(resolveTimeout(5, 10, 100)).toBe(5);
    expect(resolveTimeout(undefined, 10, 100)).toBe(10);
    expect(resolveTimeout(0, 10, 100)).toBe(10);
  });

  it("caps at the maximum", () => {
    expect(resolveTimeout(500, 10, 100)).toBe(100);
    expect(resolveTimeout(undefined, 500, 100)).toBe(100);
    expect(resolveTimeout(undefined, undefined, 100)).toBe(100);
  });

  it("returns undefined when nothing applies", () => {
    expect(resolveTimeout()).toBeUndefined();
    expect(resolveTimeout(0)).toBeUndefined();
  });
});

describe("timerMs", () => {
  it("converts seconds to milliseconds", () => {
    expect(timerMs(1.5)).toBe(1500);
  });

  it("clamps values setTimeout cannot represent", () => {
    expect(timerMs(1e12)).toBe(2 ** 31 - 1);
  });
});

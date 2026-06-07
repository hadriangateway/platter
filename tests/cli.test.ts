import { describe, expect, it } from "bun:test";

describe("CLI", () => {
  it("--help prints usage and exits 0", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("platter v");
    expect(stdout).toContain("Usage:");
  });

  it("-h prints usage and exits 0", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "-h"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  it("--version prints version and exits 0", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it("-v prints version and exits 0", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "-v"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it("invalid transport prints error and exits 1", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "-t", "invalid"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("invalid transport");
  });

  it("--auth jwks without issuer or jwks-url exits 1", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "--auth", "jwks"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("requires --oauth-issuer");
  });

  it("--auth jwks with a malformed issuer URL exits 1", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "--auth", "jwks", "--oauth-issuer", "not-a-url"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("must be a valid URL");
  });

  it("--auth jwks with --auth-token exits 1 (no static fallback)", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "src/index.ts",
        "--auth",
        "jwks",
        "--oauth-issuer",
        "https://idp.example.com/",
        "--auth-token",
        "x",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not used in jwks mode");
  });

  it("--auth jwks without --oauth-audience warns about audience validation", async () => {
    // Validation/warnings run at module load, before any server binds. In the
    // default (stdio) transport this config is accepted, so the process would
    // idle — spawn it, let the startup warning flush, then kill it.
    const proc = Bun.spawn(
      ["bun", "run", "src/index.ts", "--auth", "jwks", "--oauth-issuer", "https://idp.example.com/"],
      { stdout: "ignore", stderr: "pipe", stdin: "ignore" },
    );
    await Bun.sleep(1200);
    proc.kill();
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("audience");
  }, 8000);
});

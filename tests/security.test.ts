import { describe, expect, it } from "bun:test";
import type { ClientGrant } from "../src/oauth/provider.js";
import { buildSessionSecurity } from "../src/oauth/session-security.js";
import { type SecurityConfig, validateCommand } from "../src/security.js";

function anchored(...patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp(`^(?:${p})$`));
}

describe("validateCommand (conjunction of groups)", () => {
  it("allows when a single global group matches any pattern", () => {
    const groups = [anchored("git .*", "ls")];
    expect(() => validateCommand("git status", groups)).not.toThrow();
    expect(() => validateCommand("ls", groups)).not.toThrow();
  });

  it("rejects when the single group matches nothing", () => {
    const groups = [anchored("git .*")];
    expect(() => validateCommand("rm -rf /", groups)).toThrow("Command not allowed");
  });

  it("requires a match in EVERY group (AND semantics)", () => {
    // group 1 = global ceiling (git only); group 2 = grant (anything).
    const groups = [anchored("git .*"), anchored(".*")];
    expect(() => validateCommand("git status", groups)).not.toThrow();
    // matches the broad grant group but not the global ceiling → rejected.
    expect(() => validateCommand("rm -rf /", groups)).toThrow("Command not allowed");
  });

  it("treats no groups as unrestricted", () => {
    expect(() => validateCommand("anything goes", [])).not.toThrow();
  });
});

describe("buildSessionSecurity command narrowing", () => {
  it("a broad grant cannot widen past the global --allow-command ceiling", () => {
    const global: SecurityConfig = { allowedCommands: [anchored("git .*")] };
    const grant: ClientGrant = { tools: ["bash"], allowedCommands: [".*"] };

    const session = buildSessionSecurity(global, grant);
    expect(session.allowedCommands).toBeDefined();
    // Two groups now: global ceiling + grant.
    expect(session.allowedCommands).toHaveLength(2);
    expect(() => validateCommand("git status", session.allowedCommands!)).not.toThrow();
    expect(() => validateCommand("rm -rf /", session.allowedCommands!)).toThrow("Command not allowed");
  });

  it("a grant narrows further within the global ceiling", () => {
    const global: SecurityConfig = { allowedCommands: [anchored("git .*")] };
    const grant: ClientGrant = { tools: ["bash"], allowedCommands: ["git status"] };

    const session = buildSessionSecurity(global, grant);
    expect(() => validateCommand("git status", session.allowedCommands!)).not.toThrow();
    // allowed by the global ceiling but not by the tighter grant → rejected.
    expect(() => validateCommand("git push", session.allowedCommands!)).toThrow("Command not allowed");
  });

  it("a grant can restrict commands when the global config has none", () => {
    const global: SecurityConfig = {};
    const grant: ClientGrant = { tools: ["bash"], allowedCommands: ["git .*"] };

    const session = buildSessionSecurity(global, grant);
    expect(() => validateCommand("git status", session.allowedCommands!)).not.toThrow();
    expect(() => validateCommand("rm -rf /", session.allowedCommands!)).toThrow("Command not allowed");
  });

  it("falls back to the global ceiling when the grant has no commands", () => {
    const global: SecurityConfig = { allowedCommands: [anchored("git .*")] };
    const grant: ClientGrant = { tools: ["bash"] };

    const session = buildSessionSecurity(global, grant);
    expect(session.allowedCommands).toHaveLength(1);
    expect(() => validateCommand("git status", session.allowedCommands!)).not.toThrow();
    expect(() => validateCommand("rm -rf /", session.allowedCommands!)).toThrow("Command not allowed");
  });

  it("leaves commands unrestricted when neither global nor grant set any", () => {
    const session = buildSessionSecurity({}, { tools: ["bash"] });
    expect(session.allowedCommands).toBeUndefined();
  });
});

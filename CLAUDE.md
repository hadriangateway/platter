# CLAUDE.md

## Project Overview

Platter is an MCP (Model Context Protocol) server that exposes file and bash tools over Stdio and StreamableHTTP transports. It gives AI agents controlled access to a computer's resources. Built with Bun, compiles to standalone executables.

## Commands

```bash
bun install              # install dependencies
bun run dev              # run from TypeScript directly
bun run build            # bundle to dist/
bun run compile          # standalone binary for current platform -> ./platter
bun run compile:all      # cross-compile for all platforms

bun run format           # format with Biome
bun run format:check     # check formatting only
bun run lint             # lint with Biome
bun run lint:fix         # lint and auto-fix
bun run typecheck        # TypeScript type checking

bun test                 # run all tests
bun test tests/edit.test.ts  # run a single test file
```

## Architecture

**Entry point:** `src/index.ts` — CLI argument parsing, transport selection (stdio/http/tray), server initialization.

**Server:** `src/server.ts` — Creates McpServer, registers 7 tools (read, write, edit, bash, glob, grep, js), wires up security validators.

**Security:** `src/security.ts` — Tool access control, path validation with symlink resolution, command regex whitelisting, sandbox configuration.

**Config:** `src/config.ts` — Persists settings to `~/.config/platter/config.json`.

**Process registry:** `src/process-registry.ts` — Tracks child processes with soft timeouts, output buffering, reattachment support, and automatic stale process cleanup.

**Tools** (`src/tools/`): Each tool has its own file. `sandbox-bash.ts` is an alternative bash implementation using `just-bash` (TypeScript bash reimplementation with virtual FS).

**Tray** (`src/tray/`): Linux system tray integration via DBus (SNI protocol + DBus menus). Also contains the HTTP controller for dynamic tool toggling and clipboard support.

### Key patterns

- All tool output is truncated to last 2000 lines or 50KB (errors tend to be at the end).
- Path validation resolves symlinks via `realpath()` before comparison.
- The edit tool uses fuzzy matching that normalizes smart quotes, dashes, and Unicode whitespace.
- Process reattachment: long-running bash commands can be paused and resumed by PID.
- The JS tool auto-returns the last expression and can load packages from unpkg.com.

## Tech Stack

- **Runtime/bundler:** Bun
- **Language:** TypeScript (strict mode, ES2022 target, ESM)
- **Linter/formatter:** Biome (120-char line width, 2-space indent)
- **Testing:** Bun's native test framework
- **Key deps:** `@modelcontextprotocol/sdk`, `express` (HTTP transport), `dbus-next` (Linux tray), `just-bash` (sandbox), `diff` (edit tool), `zod` (schema validation)

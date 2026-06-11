<p align="center">
  <img src="linux/platter.svg" width="128" height="128" alt="platter icon">
</p>

# platter

*Your computer, served on a platter.*

MCP server that exposes **Read**, **Write**, **Edit**, **Bash**, **Glob**, **Grep**, and **JS** tools over Stdio and StreamableHTTP transports. Built with [Bun](https://bun.sh), compiles to standalone executables.

Designed to be used by browser-based (or any MCP-compatible) agents, like [Hadrian](https://github.com/ScriptSmith/hadrian), to control a computer.

## Tools

| Tool | Description |
|------|-------------|
| **read** | Read file contents with pagination (offset/limit). Detects image files (JPEG, PNG, GIF, WebP) and returns metadata. Truncates text to 2000 lines or 50KB. |
| **write** | Create or overwrite files. Auto-creates parent directories. |
| **edit** | Find-and-replace with exact or fuzzy matching (normalizes smart quotes, dashes, and Unicode whitespace). Requires a unique match, or use `replace_all` for every occurrence (exact matches only). Returns a unified diff. |
| **bash** | Execute shell commands with optional timeout. Output truncated to last 2000 lines or 50KB. |
| **glob** | Fast file pattern matching. Returns up to 500 paths matching a glob pattern (e.g. `**/*.ts`). |
| **grep** | Search file contents using [ripgrep](https://github.com/BurntSushi/ripgrep). Supports regex, file filtering, context lines, and multiple output modes. Requires `rg` to be installed. |
| **js** | Evaluate JavaScript/TypeScript in a persistent Node.js `vm` context. State persists across calls within a session. Supports `await`, `console.log`, and loading packages from unpkg.com via `await load("package")`. Auto-returns the last expression. **Not a security sandbox** — see [Security](#security) below. |

## Quick start

### From a release binary

Download the latest binary for your platform from [Releases](https://github.com/hadriangateway/platter/releases), or grab it with `curl`:

```bash
# Download (replace the filename for your platform)
# Available: platter-linux-x64, platter-linux-arm64, platter-darwin-x64, platter-darwin-arm64
curl -fsSL https://github.com/hadriangateway/platter/releases/latest/download/platter-linux-x64 -o platter
chmod +x platter

./platter          # stdio mode
./platter -t http  # HTTP mode on :3100
```

### Docker

```bash
docker run --rm -i ghcr.io/hadriangateway/platter                                   # stdio mode
docker run --rm -p 3100:3100 ghcr.io/hadriangateway/platter -t http --host 0.0.0.0  # HTTP mode
```

See [Docker](#docker-1) below for mounting paths, networking, installing extra software, and building custom images.

### From source

```bash
bun install
bun run dev      # run directly from TypeScript
bun run compile  # build standalone binary for current platform
```

## Usage

```
platter v1.x.x

Your computer, served on a platter.

Usage: platter [options]

Options:
  -t, --transport <stdio|http>   Transport mode (default: stdio)
      --tray                     Run the HTTP server with a Linux system tray
                                 (implies --transport=http, persists state
                                 across restarts in ~/.config/platter)
  -p, --port <number>            HTTP port (default: 3100)
      --host <address>           HTTP bind address (default: 127.0.0.1)
      --cwd <path>               Working directory for tools (default: current directory)
      --cors-origin <origin>     Allowed CORS origin (default: *)
      --auth <mode>              Auth mode: oauth, bearer, jwks, none (default: oauth)
      --auth-token <token>       Bearer token for HTTP auth (auto-generated if omitted)
      --tls-cert <path>          TLS certificate file (PEM) — enables HTTPS
      --tls-key <path>           TLS private key file (PEM)

External JWKS / OIDC (--auth jwks — verify tokens from an external IdP):
      --oauth-issuer <url>       Issuer URL; OIDC-discovers the JWKS endpoint
      --jwks-url <url>           Explicit JWKS endpoint (overrides discovery)
      --oauth-audience <aud>     Expected token audience (strongly recommended)
      --jwks-scope-grants        Map tools:<name> token scopes to tool access
                                 (fail closed: a token with no tools:<name>
                                 scopes is granted no tools)

Process management:
      --max-processes <number>   Max concurrent bash processes per session (default: 20)
      --max-sessions <number>    Max concurrent HTTP sessions (default: unlimited)

Restrictions:
      --tools <list>             Comma-separated tools to enable (default: all)
                                 Valid: read, write, edit, bash, glob, grep, js
      --allow-path <path>        Restrict read/write/edit/glob/grep to this path (repeatable)
                                 Does not restrict bash or js
      --allow-command <regex>    Allow bash commands matching this pattern (repeatable)
                                 Pattern must match the entire command string
                                 Applies to bash only; does not restrict js

Sandbox (applies to bash only; the js tool is never sandboxed):
      --sandbox                  Use just-bash sandbox instead of native bash
      --sandbox-fs <mode>        Filesystem backend: memory, overlay, readwrite (default: readwrite)
      --sandbox-allow-url <url>  Allow network access to URL prefix (repeatable)

  -h, --help                     Show this help message
  -v, --version                  Show version number
```

### Restrictions

You can limit which tools are registered, which filesystem paths file tools can access, and which commands the bash tool can execute.

#### Tool selection

Only register specific tools. Unregistered tools are completely hidden from MCP clients:

```bash
platter --tools read,glob,grep    # read-only server
platter --tools read,write,edit   # no bash/search/js
```

#### Path restrictions

Restrict file-accessing tools (read, write, edit, glob, grep) to one or more directory trees. Paths are resolved to absolute form and symlinks are resolved via `realpath` to prevent escaping:

```bash
platter --allow-path /home/user/project
platter --allow-path /home/user/project --allow-path /tmp
```

#### Command restrictions

Only allow bash commands whose **entire** command string matches at least one regex pattern:

```bash
platter --allow-command "git( .*)?"                             # git only
platter --allow-command "git( .*)?" --allow-command "npm( .*)?" # git or npm
platter --allow-command "ls( .*)?" --allow-command "cat .*"     # ls or cat
```

Patterns are anchored: `--allow-command "git( .*)?"` compiles to `^(?:git( .*)?)$`, so `git status` matches but `rm -rf / && git status` does not.

#### Combined example

```bash
# Locked-down: read-only tools, scoped to one directory
platter --tools read,glob,grep --allow-path /home/user/project

# Full tools, but bash restricted to git/npm, files restricted to project
platter --allow-path ./my-project --allow-command "git( .*)?" --allow-command "npm( .*)?"
```

Active restrictions are logged to stderr at startup.

### Authentication

Controlled by `--auth <mode>`:

| Mode | Description |
|------|-------------|
| `oauth` (default) | OAuth 2.1 Authorization Code + PKCE, with a static bearer token as fallback |
| `bearer` | Static bearer token only |
| `jwks` | Resource-server mode: verifies JWT access tokens issued by an external OAuth/OIDC issuer (Auth0, Keycloak, Okta, Entra) via JWKS |
| `none` | No authentication |

#### OAuth 2.1 (`--auth oauth`)

MCP clients that support [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) (Protected Resource Metadata) can discover platter's OAuth endpoints automatically and authenticate without manual token copying.

The flow:

1. Client discovers `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp`
2. Client registers via `POST /register` ([RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591) dynamic client registration)
3. Client initiates Authorization Code + PKCE flow via `/authorize`
4. A **confirmation code** is displayed out-of-band (printed to stderr, or shown as a desktop notification in tray mode)
5. User sees a consent page, enters the confirmation code, selects which tools to grant, and approves or denies the request
6. Client exchanges the authorization code for tokens at `/token`
7. Subsequent requests use `Authorization: Bearer <access_token>`

The confirmation code proves that the person approving the request has access to the platter process — a remote attacker who can reach the consent page cannot approve without it. Codes are single-use and expire after 5 minutes, with a maximum of 5 attempts.

Access tokens expire after 1 hour and can be refreshed. Client registrations are persisted to `~/.config/platter/clients.json`. A static bearer token is also accepted as a fallback for clients that don't support OAuth.

#### Bearer token (`--auth bearer`)

A random bearer token is generated at startup and printed to stderr (or stored in the system keyring in tray mode). Every request must include `Authorization: Bearer <token>`. You can provide your own:

```bash
platter -t http --auth bearer --auth-token my-secret-token
```

#### No authentication (`--auth none`)

Disable authentication entirely (e.g. behind a reverse proxy that handles auth):

```bash
platter -t http --auth none
```

#### External JWKS / OIDC (`--auth jwks`)

In `jwks` mode platter acts as a pure **resource server**: it does not mint its own tokens. Instead it verifies JWT access tokens issued by an **external** OAuth/OIDC authorization server (Auth0, Keycloak, Okta, Microsoft Entra) — validating the signature against the issuer's JWKS, plus the `iss`, `aud`, and `exp` claims. This lets you put platter behind your existing IdP without a reverse proxy.

```bash
# Auth0 (root issuer)
platter -t http --auth jwks \
  --oauth-issuer https://YOUR_TENANT.auth0.com/ \
  --oauth-audience https://platter.example.com/mcp

# Keycloak (realm issuer)
platter -t http --auth jwks \
  --oauth-issuer https://kc.example.com/realms/myrealm \
  --oauth-audience platter-api

# Skip discovery / point at a JWKS endpoint directly
platter -t http --auth jwks \
  --jwks-url https://idp.example.com/.well-known/jwks.json \
  --oauth-audience platter-api
```

**Audience validation (strongly recommended).** Set `--oauth-audience` to the API identifier configured in your IdP. If you omit it, platter accepts *any* valid token from the issuer — including tokens minted for a different resource server (a confused-deputy risk). platter prints a warning at startup when audience validation is disabled.

**Discovery.** With `--oauth-issuer`, platter fetches the issuer's `/.well-known/openid-configuration` (falling back to `/.well-known/oauth-authorization-server`) at startup to find the `jwks_uri` and re-advertise the authorization server to RFC 9728-capable MCP clients (at `/.well-known/oauth-protected-resource/mcp`). Pass `--jwks-url` to skip discovery, or if the IdP isn't reachable at startup. If discovery fails but `--jwks-url` is set, token verification still works — only the RFC 9728 auto-advertisement is skipped.

**Authorization (what a token can do).** By default a verified token gets admin-level access, bounded only by the operator's CLI restrictions (`--tools`, `--allow-path`, `--allow-command`, `--sandbox`) — the IdP controls *who* gets in, the CLI flags control *what* they can do. Pass `--jwks-scope-grants` to additionally honor `tools:<name>` scopes in the token (e.g. `tools:read tools:bash`), which further narrow the granted tools (they can only narrow, never widen the operator's ceiling). The `scope` claim and Entra-style `scp` claim are both supported. In this mode access is **fail closed**: a token carrying no `tools:*` scope is granted no tools at all, so a token must explicitly request the tools it needs.

**No static fallback.** Unlike `oauth` mode, `jwks` mode accepts *only* externally-issued JWTs — `--auth-token` is rejected.

> **Note:** `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL` is unrelated to this mode. It only concerns platter serving its *own* issuer over http in `--auth oauth` mode. An external `https` issuer needs no such flag. If you point `--auth jwks` at a plain-`http` issuer (e.g. a localhost Keycloak), platter warns and skips RFC 9728 metadata advertisement, but token verification still works.

### TLS (HTTPS)

To serve over HTTPS, provide a PEM-encoded certificate and private key:

```bash
platter -t http --tls-cert cert.pem --tls-key key.pem
```

Both `--tls-cert` and `--tls-key` are required together. When provided, the server listens over HTTPS instead of plain HTTP.

To generate a self-signed certificate for development or trusted internal use:

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj '/CN=myserver'
platter -t http --tls-cert cert.pem --tls-key key.pem
```

### Stdio mode

For use with Claude Desktop, Cursor, and other MCP clients that spawn a subprocess:

```json
{
  "mcpServers": {
    "platter": {
      "command": "/path/to/platter"
    }
  }
}
```

### HTTP mode (StreamableHTTP)

For browser-based agents and remote connections:

```bash
platter -t http -p 3100
```

The server exposes a single endpoint at `/mcp` that handles:
- `POST /mcp` - JSON-RPC messages (initialize, tool calls)
- `GET /mcp` - SSE notification stream
- `DELETE /mcp` - session teardown

CORS is enabled for all origins by default (reflects the request `Origin`). To restrict to a specific origin:

```bash
platter -t http --cors-origin https://myapp.example.com
```

Sessions are managed via the `Mcp-Session-Id` header per the StreamableHTTP spec.

The server validates the `Host` header to prevent [DNS rebinding attacks](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-w48q-cv73-mx4w). When `--cors-origin` is set, the `Origin` header is also validated server-side (not just via CORS response headers).

### Tray mode (Linux)

Run platter as a persistent background service with a system tray icon:

```bash
platter --tray
```

This implies `--transport=http` and adds:

- **System tray icon** via DBus (StatusNotifierItem protocol), compatible with KDE, GNOME (with AppIndicator extension), and other desktop environments.
- **Persistent configuration** in `~/.config/platter/config.json` — auth token, enabled tools, port, host, and working directory survive restarts.
- **Dynamic tool toggling** — enable or disable individual tools at runtime from the tray menu. Changes are persisted and take effect immediately.
- **Auth token management** — copy the server URL or auth token to clipboard, or regenerate the token. Tokens are stored in the system keyring when available, falling back to the config file.
- **Server controls** — start, stop, and restart the HTTP server from the tray menu.

#### Linux installer

The `linux/install.sh` script performs a user-level install (no `sudo` required):

```bash
./linux/install.sh                  # install
./linux/install.sh --uninstall      # remove
```

This installs:
- `~/.local/bin/platter` — the binary
- `~/.local/share/applications/platter.desktop` — desktop launcher entry
- `~/.local/share/icons/hicolor/scalable/apps/platter.svg` — application icon
- `~/.config/systemd/user/platter.service` — systemd user unit for autostart

## Security

### Network (HTTP mode)

- **TLS (HTTPS)** - optional transport encryption via `--tls-cert` and `--tls-key`. Uses Node.js `https` module with PEM-encoded certificate and key files.
- **OAuth 2.1 + PKCE** (`--auth oauth`, default) - MCP clients authenticate via Authorization Code flow with PKCE ([RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636)). Supports dynamic client registration ([RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591)) and token revocation ([RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009)).
- **External JWKS / OIDC** (`--auth jwks`) - resource-server mode: platter verifies JWT access tokens from an external issuer (Auth0, Keycloak, Okta, Entra) against the issuer's JWKS, validating signature, `iss`, `aud`, and `exp`. Asymmetric algorithms only (`alg: none` and HMAC are rejected). See the **External JWKS / OIDC** section under [Authentication](#authentication) for configuration.
- **Out-of-band consent confirmation** - the OAuth consent page requires a confirmation code that is only displayed to the platter operator (via stderr or desktop notification). This prevents CSRF and cross-origin attacks from auto-approving authorization requests. The consent page is also protected with `X-Frame-Options: DENY`, `Sec-Fetch-Site` validation, and `Origin` header checking.
- **Bearer token authentication** - a static bearer token (RFC 6750) is available as a fallback in `oauth` mode and as the sole method in `bearer` mode. A random 256-bit token is generated at startup unless you provide `--auth-token` or set `--auth none`.
- **Host header validation** - prevents [DNS rebinding attacks](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-w48q-cv73-mx4w). Localhost binds accept only `127.0.0.1`, `localhost`, and `::1`; remote binds accept only the specified `--host`.
- **Origin validation** - when `--cors-origin` is set to a specific origin, requests with a mismatched `Origin` header are actively rejected with 403 (not just filtered by CORS response headers).

### Restrictions (best-effort)

`--tools`, `--allow-path`, and `--allow-command` are **defense-in-depth** controls. They raise the bar significantly but are not a sandbox. The limitations below should be understood before relying on them in a threat model.

#### What they do well

- **Tool selection** is enforced at registration time. Disabled tools are never exposed via the MCP protocol. There is no way for a client to invoke or discover them.
- **Path validation** resolves symlinks via `realpath()` on both the target and each allowed path before comparison, preventing traversal via `../` or symlinked directories. For write targets that don't exist yet, the nearest existing ancestor is resolved instead.
- **Command validation** anchors regex patterns to match the full command string, preventing trivial bypasses like appending `&& malicious-command`.

#### Known limitations and bypasses

- **Bash is inherently unrestricted.** When the bash tool is enabled, a sufficiently creative command can bypass `--allow-path` entirely (e.g. `cat /etc/passwd`). If you set `--allow-path` without also setting `--allow-command` or removing bash from `--tools`, a warning is printed at startup. For strong file-access control, either disable bash (`--tools read,write,edit,glob,grep`) or pair `--allow-path` with a tight `--allow-command` allowlist.
- **The `js` tool is not a security sandbox.** It runs code in a Node.js `vm` context, which [Node's own documentation](https://nodejs.org/api/vm.html#vm-executing-javascript) explicitly states is *not* a security mechanism — untrusted code can escape the context via known techniques. Even without an escape, the runtime exposes `fetch` (arbitrary network access, including private/loopback addresses), `Buffer`, and a `load()` helper that downloads and executes arbitrary code from `unpkg.com` or any other URL. None of `--allow-path`, `--allow-command`, `--sandbox`, or `--sandbox-allow-url` apply to the `js` tool — these flags only affect the file and bash tools. If the `js` tool is enabled, treat the server as having roughly the same blast radius as unrestricted bash. To disable it: `--tools read,write,edit,bash,glob,grep`. For strong isolation, run platter inside a container or VM.
- **Command regex operates on the raw string.** It does not parse shell syntax. Patterns like `--allow-command "git( .*)?"` block `rm && git status` (because the full string doesn't match), but a determined attacker could construct commands that the regex matches yet that execute unintended code, for example if an allowed pattern is too broad. Write patterns as narrowly as possible.
- **Symlink TOCTOU.** Path validation resolves symlinks at check time. If a symlink target is changed between the check and the actual file operation, the validation can be bypassed. This is a fundamental limitation of userspace path checking.
- **Glob/grep search scope.** `--allow-path` validates the search directory for glob and grep, but results within that directory tree may include symlinks pointing outside it. The content of those symlink targets could be returned in grep output or listed by glob.
- **No process-level sandboxing.** All restrictions are enforced in application code within the platter process. They do not use OS-level mechanisms (seccomp, namespaces, pledge, etc.). A vulnerability in platter itself, Bun, or a dependency could bypass all restrictions.

For stronger isolation, use the just-bash sandbox, a Docker container, or both.

### Sandbox mode (just-bash)

Opt into [just-bash](https://github.com/vercel-labs/just-bash), a TypeScript reimplementation of bash with a virtual filesystem, for sandboxed command execution. No native processes are spawned; the shell runs entirely in the Bun runtime.

```bash
platter --sandbox                                               # readwrite fs, no network
platter --sandbox --sandbox-fs memory                           # pure in-memory fs
platter --sandbox --sandbox-fs overlay                          # reads from disk, writes ephemeral
platter --sandbox --sandbox-allow-url "https://api.example.com" # allow network to prefix
```

#### Filesystem modes

| Mode | Reads | Writes | Use case |
|---|---|---|---|
| `memory` | Virtual only | Virtual only | Maximum isolation, no disk access at all |
| `readwrite` (default) | Real disk | Real disk | Sandboxed execution with real file access |
| `overlay` | Real disk | In-memory (ephemeral) | Explore files without risk of modification |

#### Network access

Network access is **disabled by default**. Use `--sandbox-allow-url` (repeatable) to allow access to specific URL prefixes. Private/loopback IPs are always denied.

```bash
platter --sandbox --sandbox-allow-url "https://api.github.com" --sandbox-allow-url "https://registry.npmjs.org"
```

#### Interaction with other restrictions

- **`--allow-path`**: In `readwrite` and `overlay` modes, each allowed path is mounted into the sandbox. In `memory` mode, `--allow-path` is ignored.
- **`--allow-command`**: Command regex validation still applies before the sandbox executes the command.
- **`--sandbox` suppresses the bash + `--allow-path` warning**, since the sandbox enforces filesystem boundaries.

#### Limitations

- **Not full bash.** just-bash is a TypeScript reimplementation; some edge cases may behave differently from GNU bash.
- **No native binaries.** Commands like `git`, `node`, `docker`, `rg`, `python` are not available. Only bash builtins and just-bash's built-in command set work.
- **Beta software.** just-bash is under active development. Test your workflows before relying on it in production.

### Container isolation (Docker)

Running platter inside a Docker container provides OS-level isolation via Linux namespaces and cgroups. The container boundary limits what the bash tool can access. Even unrestricted commands can only reach the filesystems and network that the container exposes.

```bash
# Minimal: no host filesystem, no network
docker run --rm -i --network none ghcr.io/hadriangateway/platter

# Read-only project access, no bash
docker run --rm -p 3100:3100 \
  -v /home/user/project:/work:ro \
  ghcr.io/hadriangateway/platter -t http --host 0.0.0.0 --tools read,glob,grep

# Full tools, scoped to a mounted directory
docker run --rm -p 3100:3100 \
  -v /home/user/project:/work \
  ghcr.io/hadriangateway/platter -t http --host 0.0.0.0 --allow-path /work
```

#### What the container enforces

- **Filesystem boundary.** Only explicitly mounted paths (`-v`) are visible. Even with bash enabled, commands cannot read or write host paths that aren't mounted.
- **Network boundary.** `--network none` completely disables networking. Without it, the container has outbound access but no access to host-only services unless `--network host` is used.
- **Process isolation.** Processes inside the container cannot see or signal host processes.
- **Resource limits.** Docker's `--memory`, `--cpus`, and `--pids-limit` flags can cap resource usage to prevent denial of service.

#### Containers vs VMs

Containers share the host kernel; isolation is enforced by kernel features (namespaces, cgroups, seccomp). A kernel vulnerability or a misconfigured container (e.g. `--privileged`) can break the boundary. VMs run a separate kernel on virtualised hardware, so a guest compromise does not directly expose the host. If your threat model includes untrusted code that may attempt kernel exploits, run platter inside a VM (or a VM-backed container runtime like [Kata Containers](https://katacontainers.io/) or [Firecracker](https://firecracker-microvm.github.io/)). For most use cases, like limiting blast radius from an AI agent, a properly configured container (non-root, capabilities dropped, `--network none`) is sufficient.

#### Combining sandbox and container

The just-bash sandbox and Docker container address different layers. Used together, they provide defense in depth:

| Layer | Protects against |
|---|---|
| **just-bash sandbox** | Arbitrary native process execution: no `git`, `curl`, `rm`, etc. Commands run in a TypeScript interpreter, not the OS shell. |
| **Docker container** | Host filesystem/network access: even if the sandbox has a bug or is bypassed, the container limits blast radius to mounted paths and allowed networks. |

```bash
# Maximum isolation: sandbox inside a container, overlay fs, no network
docker run --rm -i --network none \
  -v /home/user/project:/work:ro \
  ghcr.io/hadriangateway/platter --sandbox --sandbox-fs overlay

# Sandbox with controlled network access inside a container
docker run --rm -p 3100:3100 \
  -v /home/user/project:/work \
  ghcr.io/hadriangateway/platter -t http --host 0.0.0.0 \
    --sandbox --sandbox-allow-url "https://api.github.com"
```

For the highest security posture, also run the container as a non-root user (`--user`), drop all capabilities (`--cap-drop ALL`), and set the filesystem read-only (`--read-only`) with a tmpdir for any needed writes:

```bash
docker run --rm -p 3100:3100 \
  --user 1000:1000 \
  --cap-drop ALL \
  --read-only --tmpfs /tmp \
  -v /home/user/project:/work \
  ghcr.io/hadriangateway/platter -t http --host 0.0.0.0 --sandbox
```

See [Docker](#docker-1) for full usage instructions including mounting paths, networking, and building custom images.

## Docker

The Docker image is based on Debian Bookworm (slim) and includes ripgrep. Multi-arch images (`linux/amd64`, `linux/arm64`) are published to GitHub Container Registry on every tagged release.

```bash
docker pull ghcr.io/hadriangateway/platter        # latest release
docker pull ghcr.io/hadriangateway/platter:1.0.0  # specific version
```

### Running in stdio mode

Pipe JSON-RPC messages via stdin/stdout:

```bash
docker run --rm -i ghcr.io/hadriangateway/platter
```

### Running in HTTP mode

Bind to `0.0.0.0` inside the container so the port is reachable from the host:

```bash
docker run --rm -p 3100:3100 ghcr.io/hadriangateway/platter -t http --host 0.0.0.0
```

### Mounting paths

Mount host directories into the container and use `--cwd` or `--allow-path` to give platter access:

```bash
# Mount a project directory as the working directory
docker run --rm -p 3100:3100 \
  -v /home/user/project:/work \
  ghcr.io/hadriangateway/platter -t http --host 0.0.0.0

# Mount read-only
docker run --rm -p 3100:3100 \
  -v /home/user/project:/work:ro \
  ghcr.io/hadriangateway/platter -t http --host 0.0.0.0 --tools read,glob,grep

# Mount multiple directories with path restrictions
docker run --rm -p 3100:3100 \
  -v /home/user/project:/project \
  -v /tmp/scratch:/scratch \
  ghcr.io/hadriangateway/platter -t http --host 0.0.0.0 \
    --cwd /project \
    --allow-path /project --allow-path /scratch
```

### Networking

By default containers have full outbound network access. You can restrict this with Docker's network options:

```bash
# No network access (file-only tools)
docker run --rm --network none -i ghcr.io/hadriangateway/platter

# Access host services (e.g. a local database)
docker run --rm -p 3100:3100 --network host ghcr.io/hadriangateway/platter -t http --host 0.0.0.0
```

### Installing additional software at runtime

The image uses Debian, so you can install packages with `apt-get` at runtime. This is useful for quick experiments but adds startup latency. For production use, build a custom image instead (see below).

```bash
docker run --rm -p 3100:3100 ghcr.io/hadriangateway/platter \
  bash -c "apt-get update && apt-get install -y git nodejs && exec platter -t http --host 0.0.0.0"
```

Or interactively:

```bash
docker run --rm -it --entrypoint bash ghcr.io/hadriangateway/platter
# inside the container:
apt-get update && apt-get install -y git python3
platter -t http --host 0.0.0.0
```

### Building a custom image

Layer additional tools on top of the platter image for a ready-to-use environment:

```dockerfile
FROM ghcr.io/hadriangateway/platter:latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      curl \
      python3 \
      nodejs \
      npm \
 && rm -rf /var/lib/apt/lists/*
```

Build and run:

```bash
docker build -t my-platter .
docker run --rm -p 3100:3100 -v ~/project:/work my-platter -t http --host 0.0.0.0
```

### Building the image locally

```bash
docker build -t platter .
docker run --rm -i platter
```

## Build

```bash
bun install
bun run build        # bundle to dist/
bun run compile      # standalone binary for current platform -> ./platter
bun run compile:all  # cross-compile for linux-x64, linux-arm64, darwin-x64, darwin-arm64
bun run format       # format with Biome
bun run format:check # check formatting
bun run lint         # lint with Biome
bun run lint:fix     # lint and auto-fix with Biome
bun run typecheck    # typecheck with TypeScript
bun run test         # run tests
```

## License

MIT

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import dbus from "dbus-next";
import packageJson from "../../package.json";
import { getConfigDir, getConfigPath, getLogPath, type PlatterConfig, saveConfig } from "../config.js";
import { ALL_TOOL_NAMES, type SecurityConfig, setToolEnabled, type ToolName } from "../security.js";
import type { ActivityMonitor, InvocationRecord } from "./activity-monitor.js";
import { copyToClipboard } from "./clipboard.js";
import { DBusMenu, type MenuItem } from "./dbus-menu.js";
import type { HttpController } from "./http-controller.js";
import { PLATTER_ICON_SVG } from "./icon-data.js";
import { saveToKeyring } from "./keyring.js";
import { StatusNotifierItem } from "./sni.js";

const MENU_PATH = "/MenuBar";

const WEBAPP_URL = "https://app.hadriangateway.com";

const TOOL_LABELS: Record<ToolName, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  bash: "bash",
  glob: "glob",
  grep: "grep",
  js: "js",
};

// Menu item IDs — static so we can refresh them by id without a lookup.
const ID = {
  root: 0,
  status: 1,
  copyUrl: 12,
  copyToken: 10,
  regenToken: 11,
  toolsSubmenu: 20,
  toolBase: 100, // tool ids are 100 + index
  start: 30,
  stop: 31,
  restart: 32,
  openWebApp: 13,
  openConfig: 40,
  openLog: 41,
  about: 42,
  quit: 43,
  clientsRow: 50,
  runningSubmenu: 51,
  runningEmpty: 52,
  recentSubmenu: 53,
  recentEmpty: 54,
  activitySeparator: 55,
  runningSlotBase: 500,
  recentSlotBase: 600,
} as const;

const RUNNING_SLOT_COUNT = 10;
const RECENT_SLOT_COUNT = 15;

function toolId(tool: ToolName): number {
  return ID.toolBase + ALL_TOOL_NAMES.indexOf(tool);
}

function runningSlotId(i: number): number {
  return ID.runningSlotBase + i;
}

function recentSlotId(i: number): number {
  return ID.recentSlotBase + i;
}

export interface RunTrayOptions {
  http: HttpController;
  security: SecurityConfig;
  config: PlatterConfig;
  activity?: ActivityMonitor;
  oauthProvider?: import("../oauth/provider.js").PlatterOAuthProvider;
  onQuit: () => Promise<void> | void;
}

export async function runTray(opts: RunTrayOptions): Promise<{ dispose: () => Promise<void> }> {
  const { http, security, config, onQuit, activity } = opts;

  const menu = buildMenu(http, security, config);
  const dbusMenu = new DBusMenu(menu);
  const sni = new StatusNotifierItem({
    title: "Platter",
    tooltipTitle: "Platter",
    tooltipText: http.url(),
    menuPath: MENU_PATH,
  });

  const bus = dbus.sessionBus();
  bus.export(MENU_PATH, dbusMenu);
  const uniqueName = await sni.register(bus);

  // Wire the HTTP controller's tool-change hook so toggles initiated
  // elsewhere (e.g. future admin API) also refresh the menu.
  const prevHook = security.onToolsChanged;
  security.onToolsChanged = (tool, enabled) => {
    prevHook?.(tool, enabled);
    refreshToolCheckboxes(dbusMenu, security);
  };

  // Wire menu actions -------------------------------------------------------

  const handlers = buildHandlers({
    http,
    security,
    config,
    menu: dbusMenu,
    sni,
    onQuit: async () => {
      await sni.unregister(bus, uniqueName);
      try {
        bus.disconnect();
      } catch {
        // ignore
      }
      await onQuit();
    },
  });

  attachHandlers(menu, handlers);
  // Rebuild the index so the DBusMenu knows about the attached onClicked refs.
  dbusMenu.refreshLayout();

  // Expose a way to update the status header whenever HTTP state changes.
  const refreshStatus = () => {
    updateStatus(menu, http, dbusMenu);
    sni.setTitle("Platter", "Platter", http.isRunning() ? http.url() : "stopped");
  };

  // Poll HTTP state to keep Start/Stop enabled-ness in sync. Cheap — just
  // reads a boolean and maybe emits a property-change signal.
  let lastRunning = http.isRunning();
  const pollHandle = setInterval(() => {
    const running = http.isRunning();
    if (running !== lastRunning) {
      lastRunning = running;
      refreshStatus();
      refreshLifecycleButtons(menu, http, dbusMenu);
    }
    // Re-render elapsed times for running invocations every tick.
    if (activity && activity.activeCount > 0) {
      refreshActivity(dbusMenu, activity, sni);
    }
  }, 1000);
  pollHandle.unref();

  refreshStatus();
  refreshLifecycleButtons(menu, http, dbusMenu);

  // Subscribe to activity changes. Each event redraws the affected rows and
  // toggles the tray icon between idle and active.
  const onActivityChange = () => refreshActivity(dbusMenu, activity!, sni);
  if (activity) {
    activity.on("change", onActivityChange);
    refreshActivity(dbusMenu, activity, sni);
  }

  // When an OAuth authorization request arrives, notify the user via the
  // desktop notification system. The browser-based client that initiated
  // the flow is already being redirected to the consent page, so we do NOT
  // auto-open a second window here — that would cause a duplicate tab.
  const oauthProvider = opts.oauthProvider;
  if (oauthProvider) {
    oauthProvider.on(
      "pending",
      ({ clientName, confirmationCode }: { clientName: string; confirmationCode: string }) => {
        notify(
          "Authorization request",
          `${clientName} wants to connect to Platter\nConfirmation code: ${confirmationCode}`,
          {
            // Give the user longer to act on OAuth prompts than the usual
            // transient "copied" toast.
            expireMs: 30_000,
            actions: [
              {
                id: "copy-code",
                label: "Copy code",
                onSelected: () => {
                  copyToClipboard(confirmationCode).catch((err) => {
                    notify("Clipboard failed", err?.message ?? String(err));
                  });
                },
              },
            ],
          },
        );
      },
    );
  }

  return {
    dispose: async () => {
      clearInterval(pollHandle);
      if (activity) activity.off("change", onActivityChange);
      await sni.unregister(bus, uniqueName);
      try {
        bus.disconnect();
      } catch {
        // ignore
      }
    },
  };
}

// ---- Menu tree construction -------------------------------------------------

function buildMenu(http: HttpController, security: SecurityConfig, _config: PlatterConfig): MenuItem {
  const toolItems: MenuItem[] = ALL_TOOL_NAMES.map((name) => ({
    id: toolId(name),
    label: TOOL_LABELS[name],
    toggleType: "checkmark",
    toggleState: isToolOn(security, name) ? 1 : 0,
  }));

  // Pre-allocate hidden slots for running invocations + recent history so
  // we can update them via cheap property-change signals rather than
  // rebuilding the whole layout.
  const runningChildren: MenuItem[] = [
    { id: ID.runningEmpty, label: "(idle)", enabled: false },
    ...Array.from({ length: RUNNING_SLOT_COUNT }, (_, i) => ({
      id: runningSlotId(i),
      label: "",
      enabled: false,
      visible: false,
    })),
  ];

  const recentChildren: MenuItem[] = [
    { id: ID.recentEmpty, label: "(none yet)", enabled: false },
    ...Array.from({ length: RECENT_SLOT_COUNT }, (_, i) => ({
      id: recentSlotId(i),
      label: "",
      enabled: false,
      visible: false,
    })),
  ];

  return {
    id: ID.root,
    children: [
      {
        id: ID.status,
        label: http.isRunning() ? `● Running · ${http.url()}` : "○ Stopped",
        enabled: false,
      },
      { id: ID.clientsRow, label: "Clients: 0", enabled: false },
      {
        id: ID.runningSubmenu,
        label: "Running: 0",
        children: runningChildren,
      },
      {
        id: ID.recentSubmenu,
        label: "Recent activity",
        children: recentChildren,
      },
      { id: ID.activitySeparator, type: "separator" },
      { id: ID.openWebApp, label: "Open Hadrian Gateway" },
      { id: 6, type: "separator" },
      { id: ID.copyUrl, label: "Copy URL", enabled: http.isRunning() },
      { id: ID.copyToken, label: "Copy auth token" },
      { id: ID.regenToken, label: "Regenerate auth token" },
      { id: 3, type: "separator" },
      {
        id: ID.toolsSubmenu,
        label: "Tools",
        children: toolItems,
      },
      { id: 4, type: "separator" },
      { id: ID.start, label: "Start", enabled: !http.isRunning() },
      { id: ID.stop, label: "Stop", enabled: http.isRunning() },
      { id: ID.restart, label: "Restart" },
      { id: 5, type: "separator" },
      { id: ID.openConfig, label: "Open config folder" },
      { id: ID.openLog, label: "Open log file" },
      { id: ID.about, label: `About Platter ${packageJson.version}` },
      { id: ID.quit, label: "Quit" },
    ],
  };
}

function isToolOn(security: SecurityConfig, tool: ToolName): boolean {
  return !security.allowedTools || security.allowedTools.has(tool);
}

function walk(item: MenuItem, fn: (item: MenuItem) => void): void {
  fn(item);
  if (item.children) {
    for (const child of item.children) walk(child, fn);
  }
}

// ---- Handler wiring ---------------------------------------------------------

interface HandlerContext {
  http: HttpController;
  security: SecurityConfig;
  config: PlatterConfig;
  menu: DBusMenu;
  sni: StatusNotifierItem;
  onQuit: () => Promise<void>;
}

function buildHandlers(ctx: HandlerContext): Map<number, () => void | Promise<void>> {
  const h = new Map<number, () => void | Promise<void>>();

  h.set(ID.copyUrl, async () => {
    try {
      await copyToClipboard(ctx.http.url());
      notify("URL copied", ctx.http.url());
    } catch (err: any) {
      notify("Clipboard failed", err?.message ?? String(err));
    }
  });

  h.set(ID.copyToken, async () => {
    const token = ctx.http.getAuthToken();
    if (!token) {
      notify("Auth disabled", "Platter is running without a bearer token.");
      return;
    }
    try {
      await copyToClipboard(token);
      notify("Auth token copied", "The Platter bearer token is on your clipboard.");
    } catch (err: any) {
      notify("Clipboard failed", err?.message ?? String(err));
    }
  });

  h.set(ID.regenToken, async () => {
    const token = ctx.http.regenerateAuthToken();
    try {
      await saveToKeyring(token);
      delete ctx.config.authToken;
    } catch {
      // Keyring unavailable — fall back to config file.
      ctx.config.authToken = token;
    }
    saveConfig(ctx.config);
    try {
      await copyToClipboard(token);
      notify("New auth token", "A fresh token was generated and copied to your clipboard.");
    } catch {
      notify("New auth token", "Token regenerated. Copy it from the tray menu.");
    }
  });

  h.set(ID.start, async () => {
    try {
      await ctx.http.start();
      notify("Platter started", ctx.http.url());
    } catch (err: any) {
      notify("Start failed", err?.message ?? String(err));
    }
  });

  h.set(ID.stop, async () => {
    try {
      await ctx.http.stop();
      notify("Platter stopped", "");
    } catch (err: any) {
      notify("Stop failed", err?.message ?? String(err));
    }
  });

  h.set(ID.restart, async () => {
    try {
      await ctx.http.restart();
      notify("Platter restarted", ctx.http.url());
    } catch (err: any) {
      notify("Restart failed", err?.message ?? String(err));
    }
  });

  h.set(ID.openWebApp, () => {
    openWebApp(ctx.http.url());
  });

  h.set(ID.openConfig, () => {
    xdgOpen(getConfigDir());
  });

  h.set(ID.openLog, () => {
    xdgOpen(getLogPath());
  });

  h.set(ID.about, () => {
    showAbout(ctx.http);
  });

  h.set(ID.quit, async () => {
    await ctx.onQuit();
    process.exit(0);
  });

  for (const tool of ALL_TOOL_NAMES) {
    h.set(toolId(tool), () => {
      const currentlyOn = isToolOn(ctx.security, tool);
      setToolEnabled(ctx.security, tool, !currentlyOn);
      ctx.config.enabledTools = [...(ctx.security.allowedTools ?? new Set(ALL_TOOL_NAMES))];
      saveConfig(ctx.config);
      refreshToolCheckboxes(ctx.menu, ctx.security);
    });
  }

  return h;
}

function attachHandlers(root: MenuItem, handlers: Map<number, () => void | Promise<void>>): void {
  walk(root, (item) => {
    const handler = handlers.get(item.id);
    if (handler) {
      item.onClicked = () => {
        const result = handler();
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((err) => {
            console.error("[tray] handler error:", err);
          });
        }
      };
    }
  });
}

// ---- Live refresh helpers ---------------------------------------------------

function refreshToolCheckboxes(dbusMenu: DBusMenu, security: SecurityConfig): void {
  const root = (dbusMenu as unknown as { root: MenuItem }).root ?? null;
  // The root isn't exposed; instead iterate the known tool ids and patch
  // via the public refreshProperties helper.
  const patched: number[] = [];
  for (const tool of ALL_TOOL_NAMES) {
    const id = toolId(tool);
    const item = findById(dbusMenu, id);
    if (!item) continue;
    item.toggleState = isToolOn(security, tool) ? 1 : 0;
    patched.push(id);
  }
  if (patched.length > 0) {
    dbusMenu.refreshProperties(patched, ["toggle-state"]);
  }
  void root;
}

function refreshLifecycleButtons(_root: MenuItem, http: HttpController, dbusMenu: DBusMenu): void {
  const start = findById(dbusMenu, ID.start);
  const stop = findById(dbusMenu, ID.stop);
  const copyUrl = findById(dbusMenu, ID.copyUrl);
  if (start) start.enabled = !http.isRunning();
  if (stop) stop.enabled = http.isRunning();
  if (copyUrl) copyUrl.enabled = http.isRunning();
  dbusMenu.refreshProperties([ID.start, ID.stop, ID.copyUrl], ["enabled"]);
}

function updateStatus(_root: MenuItem, http: HttpController, dbusMenu: DBusMenu): void {
  const status = findById(dbusMenu, ID.status);
  if (!status) return;
  status.label = http.isRunning() ? `● Running · ${http.url()}` : "○ Stopped";
  dbusMenu.refreshProperties([ID.status], ["label"]);
}

function refreshActivity(dbusMenu: DBusMenu, activity: ActivityMonitor, sni: StatusNotifierItem): void {
  const active = activity.getActive();
  const recent = activity.getRecent();
  const patched: number[] = [];

  const clients = findById(dbusMenu, ID.clientsRow);
  if (clients) {
    const n = activity.sessionCount;
    clients.label = `Clients: ${n}`;
    patched.push(ID.clientsRow);
  }

  const runningSubmenu = findById(dbusMenu, ID.runningSubmenu);
  if (runningSubmenu) {
    runningSubmenu.label = `Running: ${active.length}`;
    patched.push(ID.runningSubmenu);
  }

  const runningEmpty = findById(dbusMenu, ID.runningEmpty);
  if (runningEmpty) {
    runningEmpty.visible = active.length === 0;
    patched.push(ID.runningEmpty);
  }

  for (let i = 0; i < RUNNING_SLOT_COUNT; i++) {
    const slot = findById(dbusMenu, runningSlotId(i));
    if (!slot) continue;
    const record = active[i];
    if (record) {
      slot.label = formatRunning(record);
      slot.visible = true;
    } else {
      slot.label = "";
      slot.visible = false;
    }
    patched.push(runningSlotId(i));
  }

  const recentEmpty = findById(dbusMenu, ID.recentEmpty);
  if (recentEmpty) {
    recentEmpty.visible = recent.length === 0;
    patched.push(ID.recentEmpty);
  }

  for (let i = 0; i < RECENT_SLOT_COUNT; i++) {
    const slot = findById(dbusMenu, recentSlotId(i));
    if (!slot) continue;
    const record = recent[i];
    if (record) {
      slot.label = formatRecent(record);
      slot.visible = true;
    } else {
      slot.label = "";
      slot.visible = false;
    }
    patched.push(recentSlotId(i));
  }

  dbusMenu.refreshProperties(patched, ["label", "visible"]);

  sni.setActive(active.length > 0);
}

function formatRunning(record: InvocationRecord): string {
  const elapsed = formatElapsed(Date.now() - record.startedAt);
  return `${record.tool} · ${elapsed}`;
}

function formatRecent(record: InvocationRecord): string {
  const duration = record.endedAt ? formatElapsed(record.endedAt - record.startedAt) : "?";
  const marker = record.status === "error" ? "✗" : "✓";
  return `${marker} ${record.tool} · ${duration}`;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m${remainder}s`;
}

function findById(dbusMenu: DBusMenu, id: number): MenuItem | undefined {
  // DBusMenu keeps a private `index` map. Reach in for direct access — the
  // tray is the sole owner of the menu tree so this is safe.
  const index = (dbusMenu as unknown as { index: Map<number, MenuItem> }).index;
  return index?.get(id);
}

// ---- Desktop notifications / xdg-open --------------------------------------

/**
 * Absolute path to a cached copy of the Platter SVG, materialized on first
 * use so `notify-send --icon=<path>` works even when the binary was run
 * without install.sh laying down the hicolor theme entry.
 */
let cachedIconPath: string | undefined;
function ensureIconPath(): string | undefined {
  if (cachedIconPath !== undefined) return cachedIconPath || undefined;
  try {
    const xdg = process.env.XDG_CACHE_HOME;
    const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".cache");
    const dir = join(base, "platter");
    const path = join(dir, "platter.svg");
    if (!existsSync(path)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, PLATTER_ICON_SVG);
    }
    cachedIconPath = path;
    return path;
  } catch {
    cachedIconPath = "";
    return undefined;
  }
}

interface NotifyAction {
  id: string;
  label: string;
  onSelected: () => void;
}

interface NotifyOptions {
  /** notify-send `--expire-time` in milliseconds. Defaults to 10s. */
  expireMs?: number;
  actions?: NotifyAction[];
}

const DEFAULT_NOTIFY_EXPIRE_MS = 10_000;

function notify(title: string, body: string, opts: NotifyOptions = {}): void {
  const icon = ensureIconPath();
  const expireMs = opts.expireMs ?? DEFAULT_NOTIFY_EXPIRE_MS;
  const actions = opts.actions ?? [];

  const args = ["--app-name=Platter", `--expire-time=${expireMs}`];
  if (icon) args.push(`--app-icon=${icon}`);
  for (const a of actions) args.push(`--action=${a.id}=${a.label}`);
  args.push(title, body);

  // `--action` implies `--wait`, so notify-send won't exit until the user
  // responds or the notification expires. Pipe stdout so we can dispatch the
  // chosen action; unref'd so a pending notification doesn't pin the tray.
  const wantsOutput = actions.length > 0;
  const child = spawn("notify-send", args, {
    stdio: wantsOutput ? ["ignore", "pipe", "ignore"] : "ignore",
    detached: !wantsOutput,
  });
  child.on("error", () => {
    console.error(`[tray] ${title}${body ? ` — ${body}` : ""}`);
  });
  if (wantsOutput) {
    let out = "";
    child.stdout?.on("data", (d) => {
      out += d.toString();
    });
    child.on("close", () => {
      const id = out.trim();
      if (!id) return;
      const match = actions.find((a) => a.id === id);
      match?.onSelected();
    });
  }
  child.unref();
}

const REPO_URL = "https://github.com/hadriangateway/platter";
const COPYRIGHT = "Copyright © 2026 Adam Smith";
const LICENSE = "MIT License";

/**
 * Pop an info dialog (zenity) with version, paths, license, and an
 * "Open repository" extra button that launches xdg-open on click. Falls
 * back to a notify-send notification if zenity isn't installed so the
 * menu item always does *something* visible.
 */
function showAbout(http: HttpController): void {
  const running = http.isRunning();
  const lines = [
    `Platter ${packageJson.version}`,
    "Your computer, served on a platter.",
    "",
    running ? `URL:    ${http.url()}` : "URL:    (server stopped)",
    `Config: ${getConfigPath()}`,
    `Log:    ${getLogPath()}`,
    "",
    `Repo:    ${REPO_URL}`,
    `License: ${LICENSE}`,
    COPYRIGHT,
  ];
  const body = lines.join("\n");

  const openRepoLabel = "Open repository";
  const zenity = spawn(
    "zenity",
    [
      "--info",
      "--title=About Platter",
      "--width=460",
      "--no-wrap",
      `--text=${body}`,
      `--extra-button=${openRepoLabel}`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let out = "";
  zenity.stdout?.on("data", (d) => {
    out += d.toString();
  });
  zenity.on("error", () => {
    // zenity missing — drop to a notification with the same content.
    notify(`Platter ${packageJson.version}`, body);
  });
  zenity.on("close", () => {
    if (out.trim() === openRepoLabel) xdgOpen(REPO_URL);
  });
}

function xdgOpen(target: string): void {
  const child = spawn("xdg-open", [target], { stdio: "ignore", detached: true });
  child.on("error", (err) => {
    console.error(`[tray] xdg-open ${target} failed:`, err.message);
  });
  child.unref();
}

/** Browser candidates that support `--app=<url>` for a chromeless window. */
const APP_BROWSERS = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];

const WEBAPP_WIDTH = 1280;
const WEBAPP_HEIGHT = 800;

function openWebApp(mcpServerUrl: string): void {
  const url = `${WEBAPP_URL}/chat?mcp_server_url=${encodeURIComponent(mcpServerUrl)}`;
  tryAppBrowser(0, url);
}

function getScreenCenter(): { x: number; y: number } | null {
  try {
    const output = execSync("xrandr 2>/dev/null", { encoding: "utf8" });
    const match = output.match(/(\d+)x(\d+)\+0\+0/);
    if (match) {
      const screenW = Number(match[1]);
      const screenH = Number(match[2]);
      return { x: Math.round((screenW - WEBAPP_WIDTH) / 2), y: Math.round((screenH - WEBAPP_HEIGHT) / 2) };
    }
  } catch {}
  return null;
}

function tryAppBrowser(index: number, url: string): void {
  if (index >= APP_BROWSERS.length) {
    // No app-mode browser found — fall back to xdg-open.
    xdgOpen(url);
    return;
  }

  const browser = APP_BROWSERS[index];
  const args = [
    `--app=${url}`,
    `--window-size=${WEBAPP_WIDTH},${WEBAPP_HEIGHT}`,
    "--ozone-platform=x11",
    "--disable-features=LocalNetworkAccessChecks",
  ];
  const center = getScreenCenter();
  if (center) {
    args.push(`--window-position=${center.x},${center.y}`);
  }
  const child = spawn(browser, args, { stdio: "ignore", detached: true });
  child.on("error", () => tryAppBrowser(index + 1, url));
  child.unref();
}

// Kept for the unused-imports check — they're re-exported so consumers don't
// have to import from the root config module just to know where state lives.
export { getConfigPath, getLogPath };

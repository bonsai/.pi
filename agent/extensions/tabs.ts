/**
 * tabs — herdr-like tab system, native to pi.
 *
 * Tabs are the sessions of the current working directory. A tab bar sits
 * below the editor; switching tabs switches pi sessions (full runtime rebind).
 * Only recent sessions show as tabs; the current tab is always kept visible.
 *
 * Commands:
 *   /tab                  open tab switcher
 *   /tab new [name]       new tab (optionally named)
 *   /tab <n>              switch to tab n (bar order)
 *   /tab <name>           switch to tab by name / first message
 *   /tab next | prev      switch to adjacent tab
 *   /tab close <n|name>   close a tab (trash session file; never the current one)
 *   /tab rename <name>    rename current tab
 *   /tab list             read-only tab list
 *
 * Shortcuts (prefill the editor, press Enter to run):
 *   alt+t       /tab
 *   alt+1..9    /tab <n>
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { unlink, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface Tab {
  info: SessionInfo;
  label: string;
}

let tabCache: Tab[] = [];
let tabCacheLoaded = 0;
let requestRender: (() => void) | undefined;
let trashAvailable: boolean | undefined;

const CACHE_TTL_MS = 3000;
const MAX_BAR_TABS = 10;
const RECENT_WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // 2 days — older sessions stay hidden

function labelFor(info: SessionInfo): string {
  if (info.name) return info.name;
  const first = info.firstMessage.replace(/\s+/g, " ").trim();
  if (first) return truncateToWidth(first, 22, "…");
  return info.id.slice(0, 8);
}

function recencyFilter(tabs: Tab[], current?: string): Tab[] {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const recent = tabs.filter((t) => t.info.modified.getTime() >= cutoff);
  // Keep the active tab even if stale, so the current one never vanishes.
  if (current && !recent.some((t) => t.info.path === current)) {
    const cur = tabs.find((t) => t.info.path === current);
    if (cur) recent.push(cur);
  }
  return recent;
}

async function loadTabs(cwd: string, force = false, current?: string): Promise<Tab[]> {
  const now = Date.now();
  if (!force && tabCacheLoaded > 0 && now - tabCacheLoaded < CACHE_TTL_MS) {
    return tabCache;
  }
  try {
    const infos = await SessionManager.list(cwd);
    // Stable bar order: oldest first, new tabs append at the end (editor-like).
    infos.sort((a, b) => a.created.getTime() - b.created.getTime());
    tabCache = recencyFilter(infos.map((info) => ({ info, label: labelFor(info) })), current);
  } catch {
    tabCache = [];
  }
  tabCacheLoaded = now;
  return tabCache;
}

function currentPath(ctx: ExtensionContext): string | undefined {
  return ctx.sessionManager.getSessionFile() ?? undefined;
}

function findTab(tabs: Tab[], target: string): Tab | undefined {
  if (/^\d+$/.test(target)) {
    return tabs[parseInt(target, 10) - 1];
  }
  const needle = target.toLowerCase();
  return (
    tabs.find((t) => t.label.toLowerCase() === needle) ??
    tabs.find((t) => t.label.toLowerCase().includes(needle))
  );
}

async function removeSessionFile(path: string): Promise<void> {
  if (trashAvailable === undefined) {
    try {
      await execFileAsync("which", ["trash"]);
      trashAvailable = true;
    } catch {
      trashAvailable = false;
    }
  }
  if (trashAvailable) {
    await execFileAsync("trash", [path]);
  } else {
    await unlink(path);
  }
}

function visibleTabs(current: string | undefined): Tab[] {
  // Window over tabCache so the current tab is always in the bar, even when
  // it falls beyond the first MAX_BAR_TABS entries.
  const idx = tabCache.findIndex((t) => t.info.path === current);
  if (idx >= MAX_BAR_TABS) {
    return tabCache.slice(idx - (MAX_BAR_TABS - 1), idx + 1);
  }
  if (idx < 0 && current) {
    return [...tabCache.slice(0, MAX_BAR_TABS - 1), { info: { path: current } as SessionInfo, label: "current" }];
  }
  return tabCache.slice(0, MAX_BAR_TABS);
}

function installTabBar(ctx: ExtensionContext): void {
  ctx.ui.setWidget(
    "tabs",
    (tui, theme) => {
      requestRender = () => tui.requestRender();
      return {
        invalidate() {},
        render(width: number): string[] {
          const current = currentPath(ctx);
          const parts: string[] = [];
          for (const [i, tab] of visibleTabs(current).entries()) {
            const n = i + 1;
            const name = truncateToWidth(tab.label, 20, "…");
            parts.push(
              tab.info.path === current
                ? theme.fg("accent", `▸${n}:${name}`)
                : theme.fg("muted", `${n}:${name}`),
            );
          }
          if (parts.length === 0) {
            parts.push(theme.fg("dim", "no tabs — /tab new"));
          }
          const line = `▍ ${parts.join("   ")}   ${theme.fg("dim", "+new")}`;
          return [truncateToWidth(line, width)];
        },
      };
    },
    { placement: "belowEditor" },
  );
}

function updateStatus(ctx: ExtensionContext): void {
  const current = currentPath(ctx);
  const idx = tabCache.findIndex((t) => t.info.path === current);
  ctx.ui.setStatus("tabs", idx >= 0 ? `tab ${idx + 1}/${tabCache.length}` : `tab -/${tabCache.length}`);
}

async function switchToTab(ctx: ExtensionCommandContext, tab: Tab): Promise<void> {
  if (!tab || tab.info.path === currentPath(ctx)) return;
  if (!ctx.isIdle()) {
    ctx.ui.notify("Agent is working — wait for it to finish", "warning");
    return;
  }
  await ctx.switchSession(tab.info.path, {
    withSession: async (newCtx) => {
      newCtx.ui.notify(`Tab ${tab.label}`, "info");
    },
  });
}

async function openSwitcher(ctx: ExtensionCommandContext): Promise<void> {
  const tabs = await loadTabs(ctx.cwd, true, currentPath(ctx));
  if (tabs.length === 0) {
    ctx.ui.notify("No tabs yet — /tab new", "info");
    return;
  }
  const current = currentPath(ctx);
  const options = tabs.map((t, i) => `${t.info.path === current ? "▸" : " "} ${i + 1} ${t.label}`);
  const choice = await ctx.ui.select("Tabs (switch)", options);
  if (!choice) return;
  const idx = options.indexOf(choice);
  await switchToTab(ctx, tabs[idx]!);
}

function forceFlush(sm: SessionManager): void {
  // pi writes session files only after the first assistant message. Flush
  // eagerly so an unused new tab still persists on disk (survives switching).
  (sm as unknown as { _rewriteFile?: () => void })._rewriteFile?.();
}

async function newTab(ctx: ExtensionCommandContext, name: string): Promise<void> {
  const parent = currentPath(ctx);
  const sm = SessionManager.create(ctx.cwd, undefined, parent ? { parentSession: parent } : undefined);
  if (name) sm.appendSessionInfo(name);
  forceFlush(sm);
  const path = sm.getSessionFile();
  if (!path) {
    ctx.ui.notify("Failed to create tab", "error");
    return;
  }
  await ctx.switchSession(path, {
    withSession: async (newCtx) => {
      newCtx.ui.notify(name ? `New tab: ${name}` : "New tab", "info");
    },
  });
}

async function closeTab(ctx: ExtensionCommandContext, target: string): Promise<void> {
  const tabs = await loadTabs(ctx.cwd, true, currentPath(ctx));
  const tab = target ? findTab(tabs, target) : undefined;
  if (!tab) {
    ctx.ui.notify(target ? `Tab not found: ${target}` : "Usage: /tab close <n|name>", "warning");
    return;
  }
  if (tab.info.path === currentPath(ctx)) {
    ctx.ui.notify("Can't close the current tab — switch first", "warning");
    return;
  }
  const ok = await ctx.ui.confirm("Close tab", `Delete session "${tab.label}"? (moved to trash)`);
  if (!ok) return;
  try {
    await removeSessionFile(tab.info.path);
    await loadTabs(ctx.cwd, true, currentPath(ctx));
    requestRender?.();
    updateStatus(ctx);
    ctx.ui.notify(`Closed tab: ${tab.label}`, "info");
  } catch (err) {
    ctx.ui.notify(`Failed to close tab: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

async function renameTab(pi: ExtensionAPI, ctx: ExtensionCommandContext, name: string): Promise<void> {
  if (!name) {
    const got = await ctx.ui.input("Rename tab", "new name");
    name = (got ?? "").trim();
  }
  if (!name) return;
  pi.setSessionName(name);
  await loadTabs(ctx.cwd, true, currentPath(ctx));
  requestRender?.();
  updateStatus(ctx);
  ctx.ui.notify(`Tab renamed: ${name}`, "info");
}

async function listTabs(ctx: ExtensionCommandContext): Promise<void> {
  const tabs = await loadTabs(ctx.cwd, true, currentPath(ctx));
  const current = currentPath(ctx);
  await ctx.ui.custom<null>((_tui, theme, _kb, done) => {
    const lines = tabs.length
      ? tabs.map((t, i) => {
          const active = t.info.path === current;
          const mark = active ? theme.fg("accent", "▸") : theme.fg("dim", " ");
          const num = theme.fg("muted", `${i + 1}.`);
          const label = active ? theme.fg("accent", t.label) : t.label;
          const meta = theme.fg(
            "dim",
            `  (${t.info.messageCount} msgs, ${t.info.modified.toLocaleTimeString()})`,
          );
          return `${mark} ${num} ${label}${meta}`;
        })
      : [theme.fg("dim", "No tabs yet. /tab new")];
    return {
      render: (width) => lines.map((l) => truncateToWidth(l, width)),
      invalidate() {},
      handleInput: () => done(null),
    };
  });
}

// --- Web UI (P1): local server to browse sessions in the browser ---

let webServer: Server | undefined;
let webCwd = "";

function sessionText(entry: Record<string, unknown>): string {
  const msg = entry.message as { content?: unknown[] } | undefined;
  if (!msg?.content) return "";
  return msg.content
    .filter((b) => (b as { type?: string })?.type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

async function readSessionEntries(path: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(path, "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const WEB_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>pi tabs</title>
<style>
:root{color-scheme:dark}body{font-family:ui-monospace,monospace;margin:0;background:#111;color:#ddd;display:flex;height:100vh}
#list{width:34%;min-width:260px;border-right:1px solid #333;overflow:auto;padding:12px}
#view{flex:1;overflow:auto;padding:16px;white-space:pre-wrap}
input{width:100%;box-sizing:border-box;padding:8px;background:#1c1c1c;border:1px solid #444;color:#ddd;margin-bottom:8px;border-radius:4px}
.item{padding:8px;border-radius:4px;cursor:pointer;border-bottom:1px solid #222}
.item:hover{background:#1c1c1c}.item.active{background:#224}
.item .label{color:#7cc}.item .meta{color:#666;font-size:12px}
.msg{margin-bottom:14px}.msg .u{color:#7cc}.msg .a{color:#c97}
</style></head><body>
<div id="list"><input id="q" placeholder="filter…"><div id="items"></div></div>
<div id="view">← session を選ぶ</div>
<script>
let sessions=[];let cur="";
const items=document.getElementById("items"),view=document.getElementById("view"),q=document.getElementById("q");
async function load(){
  sessions=await(await fetch("/api/sessions")).json();
  render();
}
function render(){
  const f=q.value.toLowerCase();
  items.innerHTML="";
  sessions.filter(function(s){return s.label.toLowerCase().indexOf(f)>=0;}).forEach(function(s,i){
    const d=document.createElement("div");
    d.className="item"+(s.path===cur?" active":"");
    const label=document.createElement("div");label.className="label";label.textContent=s.label;
    const meta=document.createElement("div");meta.className="meta";
    meta.textContent="#"+String(i+1)+" · "+s.count+" msgs · "+new Date(s.modified).toLocaleString();
    d.appendChild(label);d.appendChild(meta);
    d.onclick=function(){openSession(s);};
    items.appendChild(d);
  });
}
q.oninput=render;
async function openSession(s){
  cur=s.path;render();
  view.textContent="loading…";
  const msgs=await(await fetch("/api/session?path="+encodeURIComponent(s.path))).json();
  view.innerHTML=msgs.map(function(m){
    return '<div class="msg"><span class="'+(m.role==="user"?"u":"a")+'">['+m.role+'] '+new Date(m.ts).toLocaleTimeString()+'</span>'+esc(m.text)+'</div>';
  }).join("\\n")||"(no messages)";
}
function esc(s){return s.replace(/[&<>]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}
load();
</script></body></html>`;

function startWebServer(ctx: ExtensionCommandContext, port: number): void {
  if (webServer) {
    ctx.ui.notify("Web UI already running", "info");
    return;
  }
  webCwd = ctx.cwd;
  webServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/sessions") {
        const tabs = await loadTabs(webCwd, true, currentPath(ctx));
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            tabs.map((t) => ({
              path: t.info.path,
              label: t.label,
              count: t.info.messageCount,
              created: t.info.created.toISOString(),
              modified: t.info.modified.toISOString(),
            })),
          ),
        );
        return;
      }
      if (url.pathname === "/api/session") {
        const path = url.searchParams.get("path") ?? "";
        const tabs = await loadTabs(webCwd, true, currentPath(ctx));
        if (!tabs.some((t) => t.info.path === path)) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        const entries = await readSessionEntries(path);
        const items = entries
          .filter((e) => e.type === "message")
          .map((e) => ({
            role: (e.message as { role?: string })?.role ?? "?",
            text: sessionText(e).slice(0, 4000),
            ts: e.timestamp,
          }));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(items));
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(WEB_HTML);
    } catch (err) {
      res.statusCode = 500;
      res.end(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  webServer.on("error", (err) => {
    ctx.ui.notify(`Web UI failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    webServer = undefined;
  });
  webServer.listen(port, "127.0.0.1", () => {
    const addr = webServer!.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;
    ctx.ui.notify(`Web UI: ${url}`, "info");
    execFile("xdg-open", [url], () => {});
  });
}

function stopWebServer(ctx: ExtensionCommandContext): void {
  if (!webServer) {
    ctx.ui.notify("Web UI not running", "info");
    return;
  }
  webServer.close();
  webServer = undefined;
  ctx.ui.notify("Web UI stopped", "info");
}

function prefillCommand(ctx: ExtensionContext, text: string): void {
  ctx.ui.setEditorText(text);
  ctx.ui.setStatus("tabs", `${text} — Enter to run`);
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("tab", {
    description:
      "herdr-like tabs for pi sessions: /tab, /tab new [name], /tab <n|name>, /tab next|prev, /tab close <n|name>, /tab rename <name>, /tab list, /tab web [port|stop]",
    handler: async (args, ctx) => {
      ctx.ui.setStatus("tabs", undefined);
      await loadTabs(ctx.cwd, false, currentPath(ctx));
      const [cmd, ...rest] = args.trim().split(/\s+/);
      const arg = rest.join(" ").trim();

      switch (cmd ?? "") {
        case "":
          return openSwitcher(ctx);
        case "new":
          return newTab(ctx, arg);
        case "close":
          return closeTab(ctx, arg);
        case "rename":
          return renameTab(pi, ctx, arg);
        case "list":
          return listTabs(ctx);
        case "web": {
          if (arg === "stop") return stopWebServer(ctx);
          const port = parseInt(arg, 10) || 8765;
          return startWebServer(ctx, port);
        }
        case "next":
        case "prev": {
          const tabs = await loadTabs(ctx.cwd, true, currentPath(ctx));
          if (tabs.length === 0) return;
          const idx = tabs.findIndex((t) => t.info.path === currentPath(ctx));
          const dir = cmd === "next" ? 1 : -1;
          return switchToTab(ctx, tabs[(idx + dir + tabs.length) % tabs.length]!);
        }
        default: {
          const tab = findTab(tabCache, args.trim());
          if (!tab) {
            ctx.ui.notify(`Tab not found: ${args.trim()}`, "warning");
            return;
          }
          return switchToTab(ctx, tab);
        }
      }
    },
  });

  pi.registerShortcut("alt+t", {
    description: "Tab command mode (/tab)",
    handler: (ctx) => prefillCommand(ctx, "/tab "),
  });
  for (let n = 1; n <= 9; n++) {
    pi.registerShortcut(`alt+${n}`, {
      description: `Switch to tab ${n}`,
      handler: (ctx) => prefillCommand(ctx, `/tab ${n}`),
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    await loadTabs(ctx.cwd, true, currentPath(ctx));
    installTabBar(ctx);
    updateStatus(ctx);
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    await loadTabs(ctx.cwd, true, currentPath(ctx));
    requestRender?.();
  });
}

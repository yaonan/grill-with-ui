#!/usr/bin/env node
// grill-with-ui hub: one local page that lists every grill session on this machine and opens
// them as tabs. Personal-fork addition; nothing here is imported by server.mjs, and the hub
// never writes into a session folder (see docs/hub-design.md).
//
//   node hub.mjs [serve] [--port N] [--open] [--detach]   run the hub (loopback only)
//   node hub.mjs url                                      print the running hub's url, exit 1 if none
//   node hub.mjs stop                                     stop the running hub
//   node hub.mjs open <session-url>                       what hub-open.mjs does (see there)
//
// A live session is shown in an iframe pointed at the session's own serve port, so a Send still
// lands in that serve process (its stdout is what wakes the agent). A session whose server is
// not running is shown as a read-only summary rendered from state.json; the hub never starts a
// session server.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const HOME = process.env.GRILL_HOME || path.join(os.homedir(), ".grill-with-ui");
const SESSIONS = path.join(HOME, "sessions");
const HUB_FILE = path.join(HOME, "hub.json");
const HUB_LOG = path.join(HOME, "hub.log");
const DEFAULT_PORT = 47470;
const LISTENER_FRESH_MS = 30_000; // same window as server.mjs listenerOf
const PAGE_ACTIVE_MS = 6000;      // a hub page polls every 2s; older than this means no page is open
const THEMES = ["system", "light", "dark"];

const print = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (msg, code = 2) => { process.stderr.write(`grill hub: ${msg}\n`); process.exit(code); };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n"); fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readTheme = () => { const t = (readJson(path.join(HOME, "ui.json")) || {}).theme; return THEMES.includes(t) ? t : "system"; };

// ---- hub.json: the hub's own file (port, pid, hidden sessions, harness notes) ----
const readHub = () => { const h = readJson(HUB_FILE); return h && typeof h === "object" ? h : {}; };
function updateHub(fn) {
  fs.mkdirSync(HOME, { recursive: true });
  const h = readHub();
  fn(h);
  writeJson(HUB_FILE, h);
  return h;
}

// ---- session discovery and status ----
const isOpen = (q) => q.status === "open" || q.status === "reopened";
// A session id is "<project-key>/<folder>": two plain path segments under SESSIONS, nothing else.
const ID_RE = /^[^/\\]+\/[^/\\]+$/;
export function sessionDir(id, root = SESSIONS) {
  if (typeof id !== "string" || !ID_RE.test(id) || id.split("/").some((p) => p === "." || p === "..")) return null;
  const dir = path.join(root, ...id.split("/"));
  return fs.existsSync(path.join(dir, "state.json")) ? dir : null;
}
// The main status, in priority order (docs/hub-design.md, FR2 of the requirements draft).
export function classify(st, lastSeq) {
  const qs = Array.isArray(st.questions) ? st.questions : [];
  const agent = st.agent || {};
  if (st.finished) return "finished";
  if (agent.status === "waiting" && qs.some(isOpen)) return "waiting";
  if (agent.status === "working" || lastSeq > (Number(agent.handled) || 0)) return "working";
  return "idle";
}
// Only the tail is read: events.jsonl grows with the grill and only its last seq matters here.
export function lastSeqOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let max = 0;
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try { max = Math.max(max, Number(JSON.parse(line).seq) || 0); } catch { /* cut or corrupt line */ }
    }
    return max;
  } catch { return 0; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
const mtime = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };

const summaryCache = new Map(); // dir -> { stamp, row }
function summarize(id, dir) {
  const stateFile = path.join(dir, "state.json"), eventsFile = path.join(dir, "events.jsonl");
  const stamp = `${mtime(stateFile)}:${mtime(eventsFile)}`;
  const hit = summaryCache.get(dir);
  if (hit && hit.stamp === stamp) return hit.row;
  const st = readJson(stateFile);
  if (!st || typeof st !== "object") return null;
  const qs = Array.isArray(st.questions) ? st.questions : [];
  const seq = lastSeqOf(eventsFile);
  const row = {
    id, project: st.project || "", topic: st.topic || "", intent: st.intent || "", created: st.created || "",
    finished: !!st.finished, doc: (st.finished && st.finished.doc) || st.doc || "",
    open: qs.filter(isOpen).length, answered: qs.filter((q) => q.status === "answered").length,
    deferred: qs.filter((q) => q.status === "deferred").length, total: qs.length,
    status: classify(st, seq), stateMtime: mtime(stateFile),
  };
  summaryCache.set(dir, { stamp, row });
  return row;
}
// Same test as server.mjs runningServer: the pid is alive and the server at that url answers
// for this very session (a pid can be reused). Also says whether an agent is listening.
const liveCache = new Map(); // dir -> { at, value }
async function liveServer(dir) {
  const hit = liveCache.get(dir);
  if (hit && Date.now() - hit.at < 1500) return hit.value;
  let value = null;
  const info = readJson(path.join(dir, "server.json"));
  if (info && info.url && info.pid && alive(info.pid)) {
    try {
      const probe = new URL(info.url); probe.pathname = "/listener";
      const r = await fetch(probe, { signal: AbortSignal.timeout(1000) });
      const body = r.ok ? await r.json() : null;
      if (body && body.session === dir) value = { url: info.url, listening: !!body.listening };
    } catch { /* not answering */ }
  }
  liveCache.set(dir, { at: Date.now(), value });
  return value;
}
function offlineListening(dir) {
  const beat = Date.parse((readJson(path.join(dir, "listener.json")) || {}).at);
  const last = Math.max(Number.isFinite(beat) ? beat : 0, mtime(path.join(dir, "state.json")));
  return Date.now() - last <= LISTENER_FRESH_MS;
}
export async function scan(root = SESSIONS) {
  const found = [];
  let keys = [];
  try { keys = fs.readdirSync(root); } catch { /* no sessions yet */ }
  for (const key of keys) {
    let ids = [];
    try { ids = fs.readdirSync(path.join(root, key)); } catch { continue; }
    for (const name of ids) {
      const id = `${key}/${name}`, dir = path.join(root, key, name);
      const row = summarize(id, dir);
      if (row) found.push({ row, dir });
    }
  }
  const hub = readHub();
  const hidden = new Set(Array.isArray(hub.hidden) ? hub.hidden : []);
  const rows = await Promise.all(found.map(async ({ row, dir }) => {
    const live = await liveServer(dir);
    return {
      ...row, online: !!live, url: live ? live.url : null,
      listening: live ? live.listening : offlineListening(dir),
      hasVisual: fs.existsSync(path.join(dir, "visual.html")),
      hidden: hidden.has(row.id), harness: (hub.harness && hub.harness[row.id]) || null,
    };
  }));
  rows.sort((a, b) => (b.created < a.created ? -1 : b.created > a.created ? 1 : b.id.localeCompare(a.id)));
  return rows;
}

// ---- serve ----
function cmdServe(o) {
  if (o.detach) return serveDetached();
  const page = path.join(HERE, "hub.html");
  let selfHosts = [], selfOrigins = [];
  let lastPoll = 0;         // when a hub page last asked for the list
  const opens = [];         // { seq, id }: sessions hub-open asked the page to open
  let openSeq = 0;

  const send = (res, code, body, type, headers = {}) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...headers }); res.end(body); };
  const json = (res, code, obj) => send(res, code, JSON.stringify(obj), "application/json");
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > 64 * 1024) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
  // Same two guards as a session server: answer only to this server's own loopback names
  // (DNS rebinding), and reject a POST whose Origin is not this page. A POST with no Origin
  // (hub-open, curl) can only come from a local process.
  const hostOk = (req) => selfHosts.includes(String(req.headers.host || "").toLowerCase());
  const originOk = (req) => req.headers.origin === undefined || selfOrigins.includes(req.headers.origin);

  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const { pathname } = u;
    if (!hostOk(req)) return json(res, 403, { error: "unrecognized Host header" });
    try {
      if (req.method === "GET" && pathname === "/") return send(res, 200, fs.readFileSync(page, "utf8").replace("__GRILL_THEME__", readTheme()), "text/html; charset=utf-8");
      if (req.method === "GET" && pathname === "/api/ping") return json(res, 200, { hub: true, home: HOME, pageActive: Date.now() - lastPoll < PAGE_ACTIVE_MS });
      if (req.method === "GET" && pathname === "/api/sessions") {
        lastPoll = Date.now();
        return json(res, 200, { sessions: await scan(), opens, openSeq });
      }
      if (req.method === "GET" && pathname === "/api/session") {
        const dir = sessionDir(u.searchParams.get("id"));
        const st = dir && readJson(path.join(dir, "state.json"));
        return st ? json(res, 200, st) : json(res, 404, { error: "unknown session" });
      }
      if (req.method === "GET" && pathname === "/api/visual") {
        const dir = sessionDir(u.searchParams.get("id"));
        const visual = dir && path.join(dir, "visual.html");
        if (!visual || !fs.existsSync(visual)) return json(res, 404, { error: "no visual" });
        // Agent-written html with scripts: sandboxed so it never runs with the hub's origin.
        return send(res, 200, fs.readFileSync(visual), "text/html; charset=utf-8", { "content-security-policy": "sandbox allow-scripts" });
      }
      if (req.method === "POST" && (pathname === "/api/open" || pathname === "/api/hide")) {
        if (!originOk(req)) return json(res, 403, { error: "cross-origin request rejected" });
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "body must be JSON" }); }
        if (pathname === "/api/hide") {
          if (!sessionDir(body.id)) return json(res, 404, { error: "unknown session" });
          updateHub((h) => {
            const set = new Set(Array.isArray(h.hidden) ? h.hidden : []);
            if (body.hidden) set.add(body.id); else set.delete(body.id);
            h.hidden = [...set];
          });
          return json(res, 200, { ok: true });
        }
        // /api/open: hub-open names the session by the url its serve printed.
        const want = String(body.url || "").replace(/\/+$/, "");
        const row = want && (await scan()).find((s) => s.online && s.url.replace(/\/+$/, "") === want);
        if (!row) return json(res, 404, { error: "no running session at that url" });
        const hz = body.harness;
        if (hz && typeof hz === "object" && (hz.name || hz.session)) {
          updateHub((h) => { (h.harness ||= {})[row.id] = { name: String(hz.name || "").slice(0, 60), session: String(hz.session || "").slice(0, 120) }; });
        }
        const pageActive = Date.now() - lastPoll < PAGE_ACTIVE_MS;
        opens.push({ seq: ++openSeq, id: row.id });
        if (opens.length > 50) opens.shift();
        return json(res, 200, { ok: true, id: row.id, pageActive });
      }
      json(res, 404, { error: "not found" });
    } catch (e) { json(res, 500, { error: String(e && e.message || e) }); }
  });

  const explicit = o.port !== undefined && o.port !== true;
  const remembered = Number(readHub().port);
  let attempt = explicit ? Number(o.port) : (Number.isInteger(remembered) && remembered > 0 ? remembered : DEFAULT_PORT);
  srv.on("error", (e) => {
    if (!srv.listening && !explicit && attempt !== 0 && e.code === "EADDRINUSE") { attempt = 0; srv.listen(0, "127.0.0.1"); return; }
    die(`server error: ${e.message}`, 1);
  });
  srv.on("listening", () => {
    const { port } = srv.address();
    const url = `http://127.0.0.1:${port}/`;
    selfHosts = ["127.0.0.1", "localhost", "[::1]"].map((h) => `${h}:${port}`);
    selfOrigins = selfHosts.map((h) => `http://${h}`);
    updateHub((h) => Object.assign(h, { url, port, pid: process.pid, started: new Date().toISOString() }));
    print({ type: "ready", url });
    if (o.open) openBrowser(url);
  });
  srv.listen(attempt, "127.0.0.1");
  const bye = () => process.exit(0);
  process.on("SIGINT", bye); process.on("SIGTERM", bye); process.on("SIGHUP", bye);
}

function openBrowser(url) {
  const argv = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try { const c = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore" }); c.on("error", () => {}); c.unref(); } catch { /* best effort */ }
}

// The pid in hub.json may have been reused: trust it only if a hub for this GRILL_HOME answers.
export async function runningHub() {
  const h = readHub();
  if (!h.url || !h.pid || !alive(h.pid)) return null;
  try {
    const r = await fetch(new URL("/api/ping", h.url), { signal: AbortSignal.timeout(1500) });
    const body = r.ok ? await r.json() : null;
    return body && body.hub && body.home === HOME ? { url: h.url, pid: h.pid, pageActive: !!body.pageActive } : null;
  } catch { return null; }
}
async function startDetached(extra = []) {
  fs.mkdirSync(HOME, { recursive: true });
  const out = fs.openSync(HUB_LOG, "w");
  const child = spawn(process.execPath, [SELF, "serve", ...extra], { detached: true, stdio: ["ignore", out, out], windowsHide: true });
  fs.closeSync(out);
  let exited = null;
  child.on("exit", (code, signal) => { exited = signal || `exit ${code}`; });
  child.on("error", (e) => { exited = e.message; });
  const deadline = Date.now() + 10_000;
  for (;;) {
    const h = readHub();
    if (h.pid === child.pid && h.url) { child.unref(); return { url: h.url, pid: child.pid }; }
    if (exited) throw new Error(`the hub stopped before it was ready (${exited}); see ${HUB_LOG}`);
    if (Date.now() > deadline) { try { process.kill(child.pid); } catch { /* gone */ } throw new Error(`the hub did not start within 10s; see ${HUB_LOG}`); }
    await sleep(50);
  }
}
async function serveDetached() {
  const running = await runningHub();
  if (running) {
    // --open asked for a page: the running hub cannot be told to open one, so do it here.
    if (process.argv.includes("--open")) openBrowser(running.url);
    return print({ type: "ready", url: running.url, pid: running.pid, already: true });
  }
  const args = process.argv.slice(2).filter((a) => a !== "--detach" && a !== "serve");
  try { const h = await startDetached(args); print({ type: "ready", url: h.url, pid: h.pid, log: HUB_LOG }); } catch (e) { die(e.message, 1); }
}

async function cmdUrl() {
  const h = await runningHub();
  if (!h) die("no hub is running", 1);
  process.stdout.write(h.url + "\n");
}
async function cmdStop() {
  const h = await runningHub();
  if (!h) return print({ ok: true, running: false });
  process.kill(h.pid);
  print({ ok: true, stopped: h.pid });
}

// Which agent harness started this grill, as far as the environment says. Best effort: the
// variables differ per harness and version, so either field may be empty.
export function harnessFromEnv(env = process.env) {
  const first = (...keys) => { for (const k of keys) if (env[k]) return String(env[k]); return ""; };
  let name = "";
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) name = "claude-code";
  else if (Object.keys(env).some((k) => k.startsWith("CODEX_"))) name = "codex";
  else if (Object.keys(env).some((k) => k.startsWith("GEMINI_CLI"))) name = "gemini-cli";
  else if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) name = "cursor";
  const session = first("CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID");
  return name || session ? { name, session } : null;
}
// hub-open: make sure a hub runs, tell it to open this session, and open a browser only when
// no hub page is already polling. If anything fails, open the session page itself so the user
// is never left without a page.
export async function cmdOpen(sessionUrl) {
  if (!sessionUrl) die("open needs the session url");
  try {
    const hub = (await runningHub()) || (await startDetached());
    const r = await fetch(new URL("/api/open", hub.url), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: sessionUrl, harness: harnessFromEnv() }), signal: AbortSignal.timeout(5000),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || `hub answered ${r.status}`);
    if (!body.pageActive) openBrowser(`${hub.url}#s=${encodeURIComponent(body.id)}`);
  } catch (e) {
    process.stderr.write(`grill hub: ${e.message}; opening the session page instead\n`);
    openBrowser(sessionUrl);
  }
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { o._.push(a); continue; }
    const k = a.slice(2), v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) o[k] = true; else { o[k] = v; i++; }
  }
  return o;
}
const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { return false; } })();
if (isMain) {
  const o = parseArgs(process.argv.slice(2));
  const cmd = o._[0] || "serve";
  const USAGE = `usage:
  node hub.mjs [serve] [--port N] [--open] [--detach]   run the hub (loopback only)
  node hub.mjs url                                      print the running hub's url
  node hub.mjs stop                                     stop the running hub
  node hub.mjs open <session-url>                       open a running session in the hub
`;
  const unknown = Object.keys(o).filter((k) => !["_", "port", "open", "detach", "help"].includes(k));
  if (o.help || cmd === "help") process.stdout.write(USAGE);
  else if (unknown.length) die(`unknown option: --${unknown[0]}\n${USAGE}`);
  else if (cmd === "serve") cmdServe(o);
  else if (cmd === "url") await cmdUrl();
  else if (cmd === "stop") await cmdStop();
  else if (cmd === "open") await cmdOpen(o._[1]);
  else die(`unknown command: ${cmd}`);
}

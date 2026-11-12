// Tests for hub.mjs: status classification, session ids, discovery across projects, the HTTP
// guards (Host, Origin, unknown session), hiding, and hub-open's /api/open.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "server.mjs");
const HUB = join(here, "..", "hub.mjs");
const home = realpathSync(mkdtempSync(join(tmpdir(), "grill-hub-home-")));
process.env.GRILL_HOME = home; // before the import: hub.mjs reads it once
const { classify, sessionDir, lastSeqOf, harnessFromEnv } = await import("../hub.mjs");
const env = { ...process.env, GRILL_HOME: home };
const children = [];
after(() => { for (const c of children) c.kill(); });

const projA = realpathSync(mkdtempSync(join(tmpdir(), "grill-hub-a-")));
const projB = realpathSync(mkdtempSync(join(tmpdir(), "grill-hub-b-")));
const cli = (cwd, args, input) => execFileSync(process.execPath, [SERVER, ...args], { env, cwd, encoding: "utf8", input }).trim();
const newSession = (cwd, topic) => JSON.parse(cli(cwd, ["new", "--topic", topic]));
const patch = (s, value) => cli(projA, ["patch", "--session", s.session], JSON.stringify(value));
const Q = { id: "q1", round: 1, title: "Pick one", body: "b", options: [{ k: "A", text: "Alpha" }, { k: "B", text: "Beta" }], rec: { option: "A", why: "w" } };

function start(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) resolve({ child, ready: JSON.parse(buf.slice(0, i)) }); });
    child.on("exit", (c) => reject(new Error(`exited ${c}`)));
  });
}
const rawGet = (url, headers) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
  req.on("error", reject); req.end();
});
const postJson = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("classify: finished, waiting, working, idle in priority order", () => {
  const open = [{ status: "open" }], done = [{ status: "answered" }];
  assert.equal(classify({ finished: { doc: "x" }, agent: { status: "waiting" }, questions: open }, 0), "finished");
  assert.equal(classify({ agent: { status: "waiting", handled: 2 }, questions: open }, 2), "waiting");
  assert.equal(classify({ agent: { status: "waiting" }, questions: [{ status: "reopened" }] }, 0), "waiting");
  assert.equal(classify({ agent: { status: "working" }, questions: open }, 0), "working");
  assert.equal(classify({ agent: { status: "waiting", handled: 1 }, questions: done }, 3), "working"); // an unhandled send
  assert.equal(classify({ agent: { status: "waiting", handled: 3 }, questions: done }, 3), "idle");
  assert.equal(classify({}, 0), "idle");
});

test("sessionDir accepts only a discovered <key>/<id> under the sessions root", () => {
  const root = join(home, "sessions");
  const s = newSession(projA, "ids");
  const id = `${s.key}/${s.id}`;
  assert.equal(sessionDir(id, root), s.session);
  for (const bad of ["", "nope/nope", "../x", `${s.key}/..`, `${s.key}/${s.id}/..`, `/${id}`, s.session, null, 7]) assert.equal(sessionDir(bad, root), null, String(bad));
});

test("lastSeqOf reads the highest seq and survives a corrupt line", () => {
  const f = join(home, "ev.jsonl");
  writeFileSync(f, '{"seq":1}\n{"seq":4}\nnot json\n{"seq":3}\n');
  assert.equal(lastSeqOf(f), 4);
  assert.equal(lastSeqOf(join(home, "missing.jsonl")), 0);
});

test("harnessFromEnv is empty-handed when the environment says nothing", () => {
  assert.equal(harnessFromEnv({}), null);
  assert.deepEqual(harnessFromEnv({ CLAUDECODE: "1" }), { name: "claude-code", session: "" });
  assert.deepEqual(harnessFromEnv({ CODEX_THREAD_ID: "t1" }), { name: "codex", session: "t1" });
});

test("hub lists sessions of every project with status, and guards its endpoints", async () => {
  const a = newSession(projA, "Alpha topic"), b = newSession(projB, "Beta topic");
  patch(a, { agent: { status: "waiting" }, questions: [Q] });
  patch(b, { agent: { status: "waiting" }, finished: { doc: "docs/b.md" } });
  mkdirSync(join(home, "sessions", "junk", "empty"), { recursive: true }); // no state.json: skipped

  const { ready } = await start(HUB, ["serve", "--port", "0"]);
  const url = ready.url;
  const { sessions } = await (await fetch(url + "api/sessions")).json();
  const A = sessions.find((s) => s.topic === "Alpha topic"), B = sessions.find((s) => s.topic === "Beta topic");
  assert.equal(A.status, "waiting"); assert.equal(A.open, 1); assert.equal(A.online, false); assert.equal(A.project, projA);
  assert.equal(B.status, "finished"); assert.equal(B.project, projB);
  assert.ok(!sessions.some((s) => s.id.startsWith("junk/")));

  // read-only summary data, and only for a discovered session
  assert.equal((await (await fetch(`${url}api/session?id=${encodeURIComponent(A.id)}`)).json()).topic, "Alpha topic");
  assert.equal((await fetch(`${url}api/session?id=${encodeURIComponent("../../etc")}`)).status, 404);
  assert.equal((await fetch(`${url}api/visual?id=${encodeURIComponent(A.id)}`)).status, 404);
  writeFileSync(join(a.session, "visual.html"), "<p>v</p>");
  const vis = await fetch(`${url}api/visual?id=${encodeURIComponent(A.id)}`);
  assert.equal(vis.headers.get("content-security-policy"), "sandbox allow-scripts");

  // DNS rebinding and cross-origin guards
  assert.equal(await rawGet(url + "api/sessions", { host: "evil.example" }), 403);
  assert.equal((await postJson(url + "api/hide", { id: A.id, hidden: true }, { origin: "http://evil.example" })).status, 403);
  assert.equal((await postJson(url + "api/hide", { id: "nope/nope", hidden: true })).status, 404);

  // hide is the hub's own note: hub.json changes, the session folder does not
  const before = readFileSync(join(a.session, "state.json"), "utf8");
  assert.equal((await postJson(url + "api/hide", { id: A.id, hidden: true }, { origin: url.replace(/\/$/, "") })).status, 200);
  assert.equal((await (await fetch(url + "api/sessions")).json()).sessions.find((s) => s.id === A.id).hidden, true);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "hub.json"), "utf8")).hidden, [A.id]);
  assert.equal(readFileSync(join(a.session, "state.json"), "utf8"), before);
  await postJson(url + "api/hide", { id: A.id, hidden: false });

  // hub-open: a running session is named by its url; anything else is refused
  assert.equal((await postJson(url + "api/open", { url: "http://127.0.0.1:1/" })).status, 404);
  const serve = await start(SERVER, ["serve", "--session", a.session]);
  await new Promise((r) => setTimeout(r, 1600)); // past the hub's liveness cache
  const opened = await (await postJson(url + "api/open", { url: serve.ready.url, harness: { name: "claude-code", session: "abc" } })).json();
  assert.equal(opened.id, A.id);
  assert.equal(opened.pageActive, true); // this test polled /api/sessions a moment ago
  const list = await (await fetch(url + "api/sessions")).json();
  const live = list.sessions.find((s) => s.id === A.id);
  assert.equal(live.online, true); assert.equal(live.url, serve.ready.url);
  assert.deepEqual(live.harness, { name: "claude-code", session: "abc" });
  assert.deepEqual(list.opens.map((o) => o.id), [A.id]);
});

// Contract test for the DSH decision-center proxy (dsh-plugins #187/#188/#189).
//
// The plugin cannot know when this repo adds an endpoint: its proxy forwards a hand-written
// table of exact paths, and a page that starts fetching a new absolute path fails silently on
// a remote device. This test pins both directions of that table:
//
//   1. hub.html / page.html only reference paths inside the proxy tables, and every reference
//      is relative so it also resolves under the plugin's sub-path mount;
//   2. hub.mjs and server.mjs actually serve every path in those tables.
//
// The tables mirror packages/dsh-decision-center/src/host/proxy.ts in yaonan/dsh-plugins
// (HUB_PAGE_ENDPOINTS / LIVE_SESSION_ENDPOINTS). Both sides are self-proving: change a page's
// fetch prefix here and this test stays green only if the plugin table follows.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "server.mjs");
const HUB = join(here, "..", "hub.mjs");
const HUB_PAGE = join(here, "..", "hub.html");
const SESSION_PAGE = join(here, "..", "page.html");

// Relative to the mounted page path: "" is the page itself. Query strings are not part of
// the table; the proxy forwards them verbatim.
const HUB_PAGE_ENDPOINTS = ["", "api/sessions", "api/session", "api/visual", "api/hide"];
const LIVE_SESSION_ENDPOINTS = ["", "state", "listener", "send", "theme", "visual"];

const home = realpathSync(mkdtempSync(join(tmpdir(), "grill-contract-home-")));
const project = realpathSync(mkdtempSync(join(tmpdir(), "grill-contract-project-")));
const env = { ...process.env, GRILL_HOME: home };
const children = [];
after(() => {
  for (const child of children) child.kill();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

/** Start a script that prints one JSON ready line, and resolve with that line. */
function start(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      resolve({ child, ready: JSON.parse(buffer.slice(0, newline)) });
    });
    child.on("exit", (code) => reject(new Error(`exited ${code}`)));
  });
}

/** A session created by the real CLI, so state.json / events.jsonl are in their real shape. */
function newSession(topic) {
  const raw = execFileSync(process.execPath, [SERVER, "new", "--topic", topic], {
    env,
    cwd: project,
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

/**
 * Every same-origin path the pages reference: literal fetch / withToken arguments and literal
 * iframe src. Dynamic expressions (a session's own url from the API) are skipped — the plugin
 * rewrites those on the wire, not here.
 */
function referencedPaths(html) {
  const paths = new Set();
  const add = (raw) => {
    const path = String(raw).split("${")[0].split("?")[0].replace(/^\.\//, "");
    if (path !== "") paths.add(path);
  };
  for (const match of html.matchAll(/(?:fetch|withToken)\(\s*[`"']([^`"']+)[`"']/g)) add(match[1]);
  for (const match of html.matchAll(/\bsrc="([^"`]+)"/g)) add(match[1]);
  return paths;
}

/** A page mounted at `mount` keeps every relative reference inside that mount. */
function assertInsideMount(references, mount, page) {
  const base = new URL(mount, "http://dsh.internal");
  for (const reference of references) {
    const resolved = new URL(reference === "" ? "." : reference, base);
    assert.ok(
      resolved.pathname.startsWith(mount),
      `${page} references ${JSON.stringify(reference)}, which escapes the page mount ${mount}`,
    );
  }
}

test("hub.html only fetches paths inside the hub proxy table, relative to the page", () => {
  const references = referencedPaths(readFileSync(HUB_PAGE, "utf8"));
  assert.ok(references.size > 0, "hub.html: no fetch references found — did the parser drift?");
  for (const reference of references) {
    assert.ok(
      HUB_PAGE_ENDPOINTS.includes(reference),
      `hub.html references ${JSON.stringify(reference)}; the plugin hub table is ${JSON.stringify(HUB_PAGE_ENDPOINTS)}`,
    );
  }
  // Local direct open (mount "/") and the DSH proxy mount must both resolve.
  assertInsideMount(references, "/", "hub.html");
  assertInsideMount(references, "/api/decision-center/hub/", "hub.html");
});

test("page.html only fetches paths inside the live-session proxy table, relative to the page", () => {
  const references = referencedPaths(readFileSync(SESSION_PAGE, "utf8"));
  assert.ok(references.size > 0, "page.html: no fetch references found — did the parser drift?");
  for (const reference of references) {
    assert.ok(
      LIVE_SESSION_ENDPOINTS.includes(reference),
      `page.html references ${JSON.stringify(reference)}; the plugin live table is ${JSON.stringify(LIVE_SESSION_ENDPOINTS)}`,
    );
  }
  assertInsideMount(references, "/", "page.html");
  // A session id contains a slash (project key / session name); the trailing slash after it is
  // what keeps `state` inside the mounted page instead of climbing to the project segment.
  assertInsideMount(references, "/api/decision-center/live/Users-me-project/20260101-000000/", "page.html");
});

test("hub.mjs serves every endpoint in the hub proxy table", async () => {
  const session = newSession("contract hub");
  const id = `${session.key}/${session.id}`;
  const { ready } = await start(HUB, ["serve", "--port", "0"]);
  const url = ready.url;
  const status = (path, init) => fetch(new URL(path, url), init);

  const page = await status("");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);

  const sessions = await status("api/sessions");
  assert.equal(sessions.status, 200);
  assert.ok(Array.isArray((await sessions.json()).sessions));

  const one = await status(`api/session?id=${encodeURIComponent(id)}`);
  assert.equal(one.status, 200);
  assert.equal((await one.json()).topic, "contract hub");

  const missingVisual = await status(`api/visual?id=${encodeURIComponent(id)}`);
  assert.equal(missingVisual.status, 404); // the route exists; there is just no visual yet
  writeFileSync(join(session.session, "visual.html"), "<p>contract</p>");
  const visual = await status(`api/visual?id=${encodeURIComponent(id)}`);
  assert.equal(visual.status, 200);
  assert.equal(visual.headers.get("content-security-policy"), "sandbox allow-scripts");

  const hide = await status("api/hide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, hidden: true }),
  });
  assert.equal(hide.status, 200);
});

test("server.mjs serves every endpoint in the live-session proxy table", async () => {
  const session = newSession("contract live");
  writeFileSync(join(session.session, "visual.html"), "<p>contract</p>");
  const { ready } = await start(SERVER, ["serve", "--session", session.session]);
  const url = ready.url;
  const status = (path, init) => fetch(new URL(path, url), init);

  const page = await status("");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);

  assert.equal((await status("state")).status, 200);
  assert.equal((await status("listener")).status, 200);
  assert.equal((await status("visual")).status, 200);

  const send = await status("send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actions: [{ k: "answer" }] }),
  });
  assert.equal(send.status, 200);

  const theme = await status("theme", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ theme: "dark" }),
  });
  assert.equal(theme.status, 200);
});

/**
 * Drives the server over real stdio with a stub Tap2Cal API, so the protocol
 * handshake, the tool schemas and the request each tool sends are exercised
 * the way a client would exercise them.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = "t2c_TESTKEY123";
const event = { id: "summer-party", url: "https://tap2cal.com/summer-party", name: "Summer party" };
let reply = { status: 200, body: { event } };
let lastRequest = null;

const stub = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    lastRequest = {
      method: req.method,
      path: req.url,
      auth: req.headers.authorization,
      type: req.headers["content-type"],
      raw,
      body: req.headers["content-type"] === "application/json" ? JSON.parse(raw.toString() || "{}") : null,
    };
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(reply.body === null ? "" : JSON.stringify(reply.body));
  });
});
stub.listen(0);
await once(stub, "listening");

const child = spawn(process.execPath, ["index.js"], {
  env: { ...process.env, TAP2CAL_API_KEY: KEY, TAP2CAL_API_URL: `http://127.0.0.1:${stub.address().port}/v1` },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
let nextId = 1;
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 8000);
  });
const call = (name, args) => rpc("tools/call", { name, arguments: args });
const text = (r) => r.result?.content?.[0]?.text || "";

let pass = 0, fail = 0;
const t = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : "  " + detail}`);
};

try {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" },
  });
  t("initialize answers", init.result?.serverInfo?.name === "tap2cal", JSON.stringify(init).slice(0, 120));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc("tools/list", {});
  const names = (list.result?.tools || []).map((x) => x.name).sort();
  t("twelve tools", names.length === 12, JSON.stringify(names));
  const del = list.result.tools.find((x) => x.name === "delete_event");
  t("delete_event is marked destructive", del?.annotations?.destructiveHint === true);

  let r = await call("create_event", {
    name: "Summer party", startDate: "2027-07-05", startTime: "18:00", endTime: "22:00",
    timeZone: "Europe/Vienna", slug: "summer-party",
  });
  t("create: POST /v1/events", lastRequest.method === "POST" && lastRequest.path === "/v1/events");
  t("create: bearer key", lastRequest.auth === `Bearer ${KEY}`);
  t("create: fields and slug sent", lastRequest.body.slug === "summer-party" && lastRequest.body.timeZone === "Europe/Vienna");
  t("create: returns the event", /tap2cal\.com\/summer-party/.test(text(r)), text(r));

  r = await call("update_event", { event: "https://tap2cal.com/summer-party", location: null });
  t("update: PATCH with encoded URL", lastRequest.method === "PATCH" &&
    lastRequest.path === "/v1/events/https%3A%2F%2Ftap2cal.com%2Fsummer-party", lastRequest.path);
  t("update: only the passed field, null kept", JSON.stringify(lastRequest.body) === '{"location":null}',
    JSON.stringify(lastRequest.body));

  await call("disable_old_link", { event: "summer-party", link: "https://tap2cal.com/summer-party-x7k2" });
  t("disable: DELETE links/slug", lastRequest.method === "DELETE" &&
    lastRequest.path === "/v1/events/summer-party/links/summer-party-x7k2", lastRequest.path);

  reply = { status: 200, body: { rsvps: [{ name: "Anna", status: "yes", guests: 2 }] } };
  r = await call("list_rsvps", { event: "summer-party" });
  t("rsvps: GET and returned", lastRequest.path === "/v1/events/summer-party/rsvps" && /Anna/.test(text(r)));

  reply = { status: 201, body: { rsvp: { id: "host-abc", name: "Carla", status: "yes", guests: 1 } } };
  r = await call("add_rsvp", { event: "summer-party", name: "Carla", status: "yes", guests: 1 });
  t("add rsvp: POST with fields", lastRequest.method === "POST" && lastRequest.path === "/v1/events/summer-party/rsvps" &&
    JSON.stringify(lastRequest.body) === '{"name":"Carla","status":"yes","guests":1}', JSON.stringify(lastRequest));

  reply = { status: 200, body: { rsvp: { id: "abc", name: "Ben", status: "yes", guests: 0 } } };
  await call("update_rsvp", { event: "summer-party", rsvpId: "abc", guests: 0 });
  t("update rsvp: PATCH only guests", lastRequest.method === "PATCH" &&
    lastRequest.path === "/v1/events/summer-party/rsvps/abc" && JSON.stringify(lastRequest.body) === '{"guests":0}',
    JSON.stringify(lastRequest.body));

  reply = { status: 204, body: null };
  r = await call("delete_rsvp", { event: "summer-party", rsvpId: "abc" });
  t("delete rsvp: DELETE and confirms", lastRequest.method === "DELETE" &&
    lastRequest.path === "/v1/events/summer-party/rsvps/abc" && /deleted/.test(text(r)), text(r));

  reply = { status: 200, body: { event } };
  const dir = await mkdtemp(join(tmpdir(), "tap2cal-mcp-"));
  const file = join(dir, "flyer.png");
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  await call("set_flyer", { event: "summer-party", imagePath: file });
  t("flyer: raw bytes from the file", lastRequest.path === "/v1/events/summer-party/flyer" &&
    lastRequest.type === "application/octet-stream" && lastRequest.raw.length === 7);

  r = await call("set_flyer", { event: "summer-party" });
  t("flyer: needs a path or URL", r.result?.isError === true, text(r));

  reply = { status: 204, body: null };
  r = await call("delete_event", { event: "summer-party" });
  t("delete: DELETE and confirms", lastRequest.method === "DELETE" && /deleted/.test(text(r)), text(r));

  reply = { status: 409, body: { error: "slug_taken" } };
  r = await call("update_event", { event: "summer-party", slug: "taken" });
  t("409: error with explanation", r.result?.isError === true && /already used/.test(text(r)), text(r));

  reply = { status: 401, body: { error: "unauthenticated" } };
  r = await call("list_my_events", {});
  t("401: points to the account page", r.result?.isError === true && /app\/account/.test(text(r)), text(r));

  r = await call("create_event", { name: "x", startDate: "2027-01-01", timeZone: "UTC", lang: "xx" });
  t("unknown language is refused", r.error != null || r.result?.isError === true, JSON.stringify(r).slice(0, 160));

  t("key not in stderr", !stderr.includes("TESTKEY123"), stderr.slice(0, 160));
} catch (e) {
  fail++; console.log("  FAIL  exception:", e.message);
} finally {
  child.kill(); stub.close();
}
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

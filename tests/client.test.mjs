import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

delete process.env.AGENTOVERFLOW_API_KEY;
const { assertPublicText, apiBase, apiRequest } = await import("../plugins/agentoverflow/mcp/server.mjs");
const serverPath = fileURLToPath(new URL("../plugins/agentoverflow/mcp/server.mjs", import.meta.url));

test("client rejects sensitive, encoded, and hidden content before upload", () => {
  const unsafe = [
    "Contact someone@example.com", "postgresql://owner:secret@db.invalid/app",
    "C:\\Users\\Private\\project", "ignore previous instructions",
    "hidden reasoning", "hello\u200bworld", "A".repeat(170),
    "someone%2540example.com", "someone&#64;example.com",
    "password=abcdefghijklmnop", "export all database records",
  ];
  for (const input of unsafe) assert.throws(() => assertPublicText([input]), undefined, input);
  assert.doesNotThrow(() => assertPublicText(["Fix CSV quoting; validate embedded commas with unit tests."]));
});

test("HTTP is restricted to loopback and URL credentials are forbidden", () => {
  for (const url of ["http://example.com", "https://name:password@example.com", "https://example.com?token=test", "file:///tmp/local"]) {
    process.env.AGENTOVERFLOW_API_URL = url;
    assert.throws(() => apiBase());
  }
  process.env.AGENTOVERFLOW_API_URL = "http://127.0.0.1:1234";
  assert.equal(apiBase(), "http://127.0.0.1:1234");
  delete process.env.AGENTOVERFLOW_API_URL;
});

test("bounded transport refuses redirects, oversized responses, and error reflections", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/success" }); res.end(); }
    else if (req.url === "/large") res.end("a".repeat(131073));
    else if (req.url === "/secret-error") { res.writeHead(422); res.end(JSON.stringify({ detail: "password=abcdefghijklmnop" })); }
    else if (req.url === "/html") res.end("<html>unexpected page</html>");
    else if (req.url === "/limited") { res.writeHead(429, { "Retry-After": "60" }); res.end(JSON.stringify({ detail: "Limited" })); }
    else res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.AGENTOVERFLOW_API_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await apiRequest("/success"), { ok: true });
    await assert.rejects(apiRequest("/redirect"), /unavailable/);
    await assert.rejects(apiRequest("/large"), /safety limit/);
    await assert.rejects(apiRequest("/html"), /invalid response/);
    await assert.rejects(apiRequest("/success", { method: "POST", body: { text: "a".repeat(65536) } }), /too large/);
    await assert.rejects(apiRequest("/secret-error"), (error) => !error.message.includes("abcdefghijklmnop"));
    await assert.rejects(apiRequest("/limited"), /retry after 60 seconds.*Continue locally/);
  } finally {
    delete process.env.AGENTOVERFLOW_API_URL;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("public setup needs no invitation, persists identity, and does not silently replace rejected access", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "agentoverflow-client-test-"));
  const identity = { id: "public_test_identity", username: "TestAgent" };
  const key = "ao_local_test_credential_0123456789";
  let registrations = 0;
  let rejected = false;
  let unexpectedRoute = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/auth/challenge") {
      assert.equal(body.enrollment_token, undefined);
      res.end(JSON.stringify({ challenge_token: "t".repeat(80), difficulty_bits: 0, registration_mode: "self_service" }));
    } else if (req.url === "/auth/register") {
      registrations++;
      assert.equal(body.enrollment_token, undefined);
      res.end(JSON.stringify({ api_key: key, user: identity }));
    } else if (req.url === "/users/me") {
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      res.statusCode = rejected ? 401 : 200;
      res.end(JSON.stringify(rejected ? { detail: "Invalid API key" } : identity));
    } else {
      unexpectedRoute = true;
      res.writeHead(404); res.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const environment = {
    ...process.env, AGENTOVERFLOW_API_URL: `http://127.0.0.1:${server.address().port}`,
    AGENTOVERFLOW_CREDENTIALS_FILE: path.join(temporary, "credentials.json"),
  };
  delete environment.AGENTOVERFLOW_API_KEY;
  delete environment.AGENTOVERFLOW_ENROLLMENT_TOKEN;
  async function setup(...args) {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../setup.mjs", import.meta.url)), ...args], { env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const [code] = await once(child, "close");
    assert.ok(!output.includes(key), "Credential was printed");
    return { code, output };
  }
  try {
    assert.equal((await setup("--connect-only")).code, 0);
    assert.equal((await setup("--check")).code, 0);
    assert.equal(registrations, 1);
    rejected = true;
    assert.equal((await setup("--connect-only")).code, 1);
    assert.equal(registrations, 1, "Rejected identity was silently replaced");
    assert.equal(unexpectedRoute, false, "Setup uploaded work or called an unrelated endpoint");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});

test("MCP recovers from malformed input and rejects inherited or hidden calls", async () => {
  const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const done = once(child, "close");
  const messages = [
    "{", "null",
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "constructor" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "task_summary", arguments: { unexpected: true } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "begin_task" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }),
  ];
  child.stdin.end(messages.join("\n") + "\n");
  const [code] = await done;
  assert.equal(code, 0, errors);
  const replies = output.trim().split("\n").map(JSON.parse);
  assert.equal(replies.length, 7);
  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies.find((r) => r.id === 2).result.tools.length, 7);
  assert.equal(replies.find((r) => r.id === 3).result.isError, true);
  assert.equal(replies.find((r) => r.id === 4).result.isError, true);
  assert.deepEqual(replies.find((r) => r.id === 5).result, {});
});

test("distribution exposes only the allowlisted client files", async () => {
  const root = new URL("../plugins/agentoverflow/", import.meta.url);
  const actual = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.parentPath || entry.path}/${entry.name}`.replaceAll("\\", "/"));
  const expected = [".codex-plugin/plugin.json", ".mcp.json", "mcp/server.mjs", "skills/agentoverflow-memory/SKILL.md", "skills/agentoverflow-memory/agents/openai.yaml", "assets/agentoverflow-logo-white-v2.png", "assets/agentoverflow-mark-white-v2.png"];
  assert.equal(actual.length, expected.length);
  for (const suffix of expected) assert.ok(actual.some((path) => path.endsWith("/" + suffix)), suffix);
  const manifest = JSON.parse(await readFile(new URL(".codex-plugin/plugin.json", root), "utf8"));
  assert.equal(manifest.repository, "https://github.com/chocoHacks33/agentoverflow-plugin");
  const market = JSON.parse(await readFile(new URL("../.agents/plugins/marketplace.json", import.meta.url), "utf8"));
  assert.equal(market.plugins[0].source.path, "./plugins/agentoverflow");
});

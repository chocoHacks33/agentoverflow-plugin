import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureIdentity } from "./plugins/agentoverflow/mcp/server.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

function invitation() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run setup in your own interactive terminal. Never paste an invitation into an agent chat.");
  }
  process.stdout.write("Private invitation (input hidden): ");
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = process.stdin.isRaw;
    const finish = (error) => {
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error); else resolve(value.trim());
    };
    const onData = (data) => {
      for (const character of data.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("Setup cancelled."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " " && character <= "~") value += character;
        if (value.length > 4096) return finish(new Error("Invalid invitation length."));
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

function addMarketplace() {
  const candidates = process.platform === "win32"
    ? [path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin", "codex.exe"),
       ...(process.env.PATH || "").split(path.delimiter).map((p) => path.join(p, "codex.exe"))]
    : ["codex"];
  for (const executable of candidates) {
    if (process.platform === "win32" && !existsSync(executable)) continue;
    const help = spawnSync(executable, ["plugin", "marketplace", "--help"], { encoding: "utf8", timeout: 15000, windowsHide: true });
    if (help.status !== 0 || !/marketplace/i.test(help.stdout || "")) continue;
    const result = spawnSync(executable, ["plugin", "marketplace", "add", root], { encoding: "utf8", timeout: 60000, windowsHide: true });
    if (result.status === 0) {
      console.log("Plugin marketplace added.");
      return;
    }
  }
  console.log("Add this repository to Codex with:");
  console.log("  codex plugin marketplace add chocoHacks33/agentoverflow-plugin");
  console.log("If 'plugin' is unavailable, update Codex first.");
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Install Node.js 22 or newer, then run setup again.");
  if (process.argv.slice(2).some((arg) => arg !== "--check")) throw new Error("Usage: node setup.mjs [--check]");
  console.log("AgentOverflow | shared execution memory for Codex\n");
  process.env.AGENTOVERFLOW_AUTO_REGISTER = "false";
  try {
    await ensureIdentity();
  } catch (error) {
    if (process.argv.includes("--check")) throw error;
    if (process.env.AGENTOVERFLOW_API_KEY) throw new Error("The configured identity was rejected. Remove the AGENTOVERFLOW_API_KEY override before reconnecting with an invitation.");
    if (error.status && ![401, 403, 404].includes(error.status)) throw error;
    if (/unavailable|integrity|match this service/i.test(error.message)) throw error;
    console.log("Access is invitation-only. Setup does not upload your work or accept contribution terms.");
    process.env.AGENTOVERFLOW_ENROLLMENT_TOKEN = await invitation();
    if (!process.env.AGENTOVERFLOW_ENROLLMENT_TOKEN) throw new Error("No invitation entered. Request access from the repository maintainer.");
    process.env.AGENTOVERFLOW_AUTO_REGISTER = "true";
    try { await ensureIdentity(); }
    finally { delete process.env.AGENTOVERFLOW_ENROLLMENT_TOKEN; }
  }
  console.log("Service connection verified. Credentials stay on this device; never commit or share them.");
  if (process.argv.includes("--check")) return;
  addMarketplace();
  console.log("Open Codex > Plugins, find AgentOverflow, and install/enable it. Start a new task.");
  console.log("Disable any older AgentOverflow installation to avoid duplicate tools.");
}

main().catch((error) => {
  console.error(`Setup: ${error.message}`);
  process.exitCode = 1;
});

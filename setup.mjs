import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureIdentity } from "./plugins/agentoverflow/mcp/server.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

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
  if (process.argv.slice(2).some((arg) => !["--check", "--connect-only", "--reconnect"].includes(arg))) {
    throw new Error("Usage: node setup.mjs [--check | --connect-only | --reconnect]");
  }
  console.log("AgentOverflow | shared execution memory for coding agents\n");
  process.env.AGENTOVERFLOW_AUTO_REGISTER = process.argv.includes("--check") ? "false" : "true";
  console.log("Connecting this device. No invitation or manually supplied API key is needed.");
  console.log("Setup does not upload your work or accept contribution terms.");
  await ensureIdentity({ reconnect: process.argv.includes("--reconnect") && !process.argv.includes("--check") });
  console.log("Connected. Your device credential stays local; never commit or share it.");
  if (process.argv.includes("--check") || process.argv.includes("--connect-only")) return;
  addMarketplace();
  console.log("Open Codex > Plugins, find AgentOverflow, and install/enable it. Start a new task.");
  console.log("Disable any older AgentOverflow installation to avoid duplicate tools.");
}

main().catch((error) => {
  console.error(`Setup: ${error.message}`);
  process.exitCode = 1;
});

/**
 * The Getting started list: which setup steps are done, worked out from what is really there, so it ticks
 * itself. Used by the dashboard (GET /setup) and `memvault doctor`. Reads only; changes nothing.
 */

import fs from "fs";
import path from "path";
import { TOKEN_FILE, loadUserConfig } from "./config.mjs";
import { listLocalBackups } from "./storage.mjs";
import { deviceSettings, deviceStatus } from "./device-sync.mjs";
import { listDeviceKeys } from "./device-keys.mjs";
import { listApps } from "./connected-apps.mjs";

/** Is a backup passphrase set (in the environment, or in the private file Settings writes)? */
export function backupPassphraseState(uc) {
  if (process.env.MEMVAULT_BACKUP_PASSPHRASE) return { set: true, via: "env" };
  const f = uc.storage?.passphraseFile;
  if (f) { try { if (fs.readFileSync(f, "utf8").split(/\r?\n/)[0].trim()) return { set: true, via: "file" }; } catch { /* missing file */ } }
  return { set: false, via: null };
}

// Memories an AI app saved through MemVault's tools (not notes typed in the dashboard, imports or capture).
const FROM_AI = "source IN ('ai-memory', 'mcp', 'agent-handoff') OR source LIKE 'prompt-%' OR agent_id IS NOT NULL";

/**
 * @returns {{ steps: {id: string, done: boolean, optional?: boolean, [k: string]: any}[], done: number, total: number }}
 *   `done` / `total` count the main steps only; optional ones are extra.
 */
export function setupStatus({ vdb, userConfig = loadUserConfig(), dir = path.dirname(TOKEN_FILE) } = {}) {
  const apps = listApps({ dir });
  const fromAI = Number(vdb.query(`SELECT COUNT(*) AS n FROM items WHERE ${FROM_AI}`)[0]?.n || 0);
  const backups = listLocalBackups();
  const dev = deviceSettings(userConfig, { dir });
  let others = 0;
  if (dev.enabled) {
    const st = deviceStatus({ vdb, settings: dev, dir });
    if (st.passphraseSet) others = st.peers.filter((p) => p.inFolder && !p.error).length;
  }
  const phones = listDeviceKeys().length;
  const tied = apps.filter((a) => a.agent);

  const steps = [
    { id: "install", done: true },
    { id: "connect", done: apps.length > 0, apps: apps.map(({ label, agent, last_seen }) => ({ label, agent, last_seen })) },
    { id: "try", done: fromAI > 0, saved: fromAI },
    { id: "backup", done: backups.length > 0, last: backups[0]?.modified || null },
    { id: "passphrase", done: backupPassphraseState(userConfig).set },
    { id: "agents", optional: true, done: tied.length > 0, apps: tied.map(({ label, agent }) => ({ label, agent })) },
    { id: "devices", optional: true, done: others > 0, enabled: dev.enabled, others },
    { id: "phone", optional: true, done: phones > 0, phones },
  ];
  const main = steps.filter((s) => !s.optional);
  return { steps, done: main.filter((s) => s.done).length, total: main.length };
}

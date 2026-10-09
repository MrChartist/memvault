/**
 * config.mjs — MemVault Shared Configuration
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads user settings from ~/.memvaultrc.json, falls back to environment
 * variables, and provides cross-platform defaults.
 *
 * Sections:
 *   - vaultRoot / port / host     — core paths & the local web server
 *   - sync                        — which capture engines are enabled
 *   - ai                          — Gemini intelligence layer
 *   - storage                     — local + Google Drive backup backends
 *   - mcpBridges                  — outbound connections to OTHER AI MCP servers
 *   - projects                    — your own project names for auto-detection
 *   - server                      — extra allowed Host headers / browser origins
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import os from "os";
import { expandHome, resolveUserPath } from "./util.mjs";

const HOME = os.homedir();
export const CONFIG_FILE = path.join(HOME, ".memvaultrc.json");

/** Read (and re-read) the user config file fresh from disk. */
export function loadUserConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    }
  } catch (e) {
    // stderr only: stdout is reserved for the MCP protocol in mcp-server.mjs
    console.error(`⚠️ Could not read ${CONFIG_FILE}: ${e.message}`);
  }
  return {};
}

/**
 * Persist a config object back to ~/.memvaultrc.json (pretty-printed).
 * The file can hold API keys and OAuth secrets, so it is kept owner-only.
 */
export function saveUserConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* not supported on this FS (e.g. Windows) */ }
}

const userConfig = loadUserConfig();

// ─── VAULT_ROOT ─────────────────────────────────────────────────────────────
// Priority: 1. ENV, 2. ~/.memvaultrc.json, 3. Default (~/.memvault/data)
export const VAULT_ROOT = process.env.VAULT_ROOT
  ? resolveUserPath(process.env.VAULT_ROOT) // environment: relative to the cwd, "~" expanded
  : expandHome(userConfig.vaultRoot || path.join(HOME, ".memvault", "data")); // config file: relative to home

// ─── Web server ─────────────────────────────────────────────────────────────
const rawPort = Number(process.env.VAULT_PORT || process.env.PORT || userConfig.port || 7799);
export const PORT = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 7799;

// The server has NO authentication, so it only listens on the loopback
// interface unless you explicitly opt out (config "host" or VAULT_HOST).
export const HOST = process.env.VAULT_HOST || userConfig.host || "127.0.0.1";

export const API_URL = process.env.VAULT_API || userConfig.apiUrl || `http://127.0.0.1:${PORT}`;

const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : []);
export const SERVER_CONFIG = {
  // Extra Host header names to accept (default: localhost, 127.0.0.1, [::1]).
  allowedHosts: asList(userConfig.server?.allowedHosts),
  // Extra browser origins allowed to call the API cross-origin (default: none).
  allowedOrigins: asList(userConfig.server?.allowedOrigins),
};

// ─── Sync Configuration ─────────────────────────────────────────────────────
// Privacy-sensitive engines (browser history, clipboard, Antigravity) are OFF
// unless you turn them on. User settings are merged over these defaults.
export const SYNC_CONFIG = {
  gitDirs: [HOME],
  filesDirs: [path.join(HOME, "Documents"), path.join(HOME, "Desktop")],
  vscodeEnabled: true,
  systemEnabled: true,
  filesEnabled: true,
  clipboardEnabled: false,
  browserEnabled: false,
  antigravityEnabled: false,
  ...(userConfig.sync || {}),
};
// "~/code" in the config file means the user's home, not a folder named "~"
for (const key of ["gitDirs", "filesDirs"]) {
  SYNC_CONFIG[key] = (Array.isArray(SYNC_CONFIG[key]) ? SYNC_CONFIG[key] : [SYNC_CONFIG[key]])
    .filter((d) => typeof d === "string" && d.trim())
    .map((d) => expandHome(d));
}

// ─── AI Configuration ───────────────────────────────────────────────────────
export const AI_CONFIG = userConfig.ai || {};

// ─── Project detection ──────────────────────────────────────────────────────
// Optional: teach MemVault your project names.
//   "projects": [{ "name": "My App", "patterns": ["my-?app", "myapp\\.com"], "tags": "myapp,web" }]
export const USER_PROJECTS = Array.isArray(userConfig.projects) ? userConfig.projects : [];

// ─── Storage / Backup Configuration ─────────────────────────────────────────
// Local storage is ALWAYS on. Google Drive is opt-in via two methods:
//   1. folder — mirror the vault into your Google Drive for Desktop synced path
//   2. api    — upload backups via the Drive REST API (OAuth refresh token)
export const STORAGE_CONFIG = {
  local: { enabled: true, ...(userConfig.storage?.local || {}) },
  gdriveFolder: {
    enabled: false,
    // e.g. "C:/Users/you/My Drive/MemVault" or "/home/you/GoogleDrive/MemVault"
    path: "",
    ...(userConfig.storage?.gdriveFolder || {}),
  },
  gdriveApi: {
    enabled: false,
    clientId: "",
    clientSecret: "",
    refreshToken: "",
    // Optional Drive folder ID to upload into ("" = My Drive root)
    folderId: "",
    ...(userConfig.storage?.gdriveApi || {}),
  },
  // Keep at most N local timestamped backups (0 = unlimited)
  keepLocalBackups: userConfig.storage?.keepLocalBackups ?? 20,
};
if (STORAGE_CONFIG.gdriveFolder.path) STORAGE_CONFIG.gdriveFolder.path = expandHome(STORAGE_CONFIG.gdriveFolder.path);

// ─── MCP Bridges — connect OUT to other AI tools' MCP servers ────────────────
// Each entry describes an external MCP server that MemVault can connect to as a
// client, pull context from, and ingest into the vault.
//   { name, command, args?, env?, enabled?, importTool?, importArgs? }
export const MCP_BRIDGES = userConfig.mcpBridges || [];

// Ensure vault directory exists
export function ensureVaultDir() {
  if (!fs.existsSync(VAULT_ROOT)) {
    try {
      fs.mkdirSync(VAULT_ROOT, { recursive: true });
    } catch {
      // Ignore initial creation errors if happens concurrently
    }
  }
}

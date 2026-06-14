/**
 * config.mjs — MemVault Shared Configuration
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads user settings from ~/.memvaultrc.json, falls back to environment
 * variables, and provides cross-platform defaults.
 *
 * Sections:
 *   - vaultRoot / port / apiUrl   — core paths & endpoints
 *   - sync                        — which capture engines are enabled
 *   - ai                          — Gemini intelligence layer
 *   - storage                     — local + Google Drive backup backends
 *   - mcpBridges                  — outbound connections to OTHER AI MCP servers
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import os from "os";

const HOME = os.homedir();
export const CONFIG_FILE = path.join(HOME, ".memvaultrc.json");

/** Read (and re-read) the user config file fresh from disk. */
export function loadUserConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    }
  } catch (e) {
    console.error(`⚠️ Could not read ${CONFIG_FILE}: ${e.message}`);
  }
  return {};
}

/** Persist a config object back to ~/.memvaultrc.json (pretty-printed). */
export function saveUserConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

const userConfig = loadUserConfig();

// ─── VAULT_ROOT ─────────────────────────────────────────────────────────────
// Priority: 1. ENV, 2. ~/.memvaultrc.json, 3. Default (~/.memvault/data)
export const VAULT_ROOT =
  process.env.VAULT_ROOT || userConfig.vaultRoot || path.join(HOME, ".memvault", "data");

// ─── API endpoints ──────────────────────────────────────────────────────────
const port = process.env.PORT || process.env.VAULT_PORT || userConfig.port || 7799;
export const API_URL = process.env.VAULT_API || userConfig.apiUrl || `http://127.0.0.1:${port}`;
export const PORT = Number(port);

// ─── Sync Configuration ─────────────────────────────────────────────────────
export const SYNC_CONFIG = userConfig.sync || {
  gitDirs: [HOME],
  vscodeEnabled: true,
  clipboardEnabled: false,
  filesEnabled: true,
  systemEnabled: true,
  browserEnabled: true,
  antigravityEnabled: true,
};

// ─── AI Configuration ───────────────────────────────────────────────────────
export const AI_CONFIG = userConfig.ai || {};

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

/**
 * config.mjs — MemVault Shared Configuration
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads user settings from ~/.memvaultrc.json, falls back to environment
 * variables, and provides cross-platform defaults.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import os from "os";

const HOME = os.homedir();
const CONFIG_FILE = path.join(HOME, ".memvaultrc.json");

let userConfig = {};

try {
  if (fs.existsSync(CONFIG_FILE)) {
    userConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  }
} catch (e) {
  console.error(`⚠️ Could not read ${CONFIG_FILE}: ${e.message}`);
}

// ─── VAULT_ROOT ─────────────────────────────────────────────────────────────
// Priority: 1. ENV, 2. ~/.memvaultrc.json, 3. Default (~/.memvault)
export const VAULT_ROOT = process.env.VAULT_ROOT || userConfig.vaultRoot || path.join(HOME, ".memvault", "data");

// ─── API endpoints ──────────────────────────────────────────────────────────
const port = process.env.PORT || userConfig.port || 7799;
export const API_URL = process.env.VAULT_API || userConfig.apiUrl || `http://127.0.0.1:${port}`;
export const PORT = port;

// ─── Sync Configuration ─────────────────────────────────────────────────────
export const SYNC_CONFIG = userConfig.sync || {
  gitDirs: [HOME],
  vscodeEnabled: true,
  clipboardEnabled: true,
  filesEnabled: true,
  systemEnabled: true,
  browserEnabled: true,
  antigravityEnabled: true
};

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

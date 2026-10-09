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
import { expandHome, resolveUserPath } from "./paths.mjs";

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
  // May hold API keys and Drive credentials, so keep it private to this account.
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* non-POSIX */ }
}

const userConfig = loadUserConfig();

// ─── VAULT_ROOT ─────────────────────────────────────────────────────────────
// Priority: 1. ENV, 2. ~/.memvaultrc.json, 3. Default (~/.memvault/data)
export const VAULT_ROOT = process.env.VAULT_ROOT
  ? resolveUserPath(process.env.VAULT_ROOT) // environment: relative to the cwd, "~" expanded
  : expandHome(userConfig.vaultRoot || path.join(HOME, ".memvault", "data")); // config file: relative to home

// ─── API endpoints ──────────────────────────────────────────────────────────
const port = process.env.PORT || process.env.VAULT_PORT || userConfig.port || 7799;
export const API_URL = process.env.VAULT_API || userConfig.apiUrl || `http://127.0.0.1:${port}`;
export const PORT = Number(port);

// ─── Security Configuration ─────────────────────────────────────────────────
// Secure by default: loopback only, token required, secrets redacted on ingest.
export const SECURITY_CONFIG = {
  // Interface the API/web UI binds to. Anything other than loopback also needs
  // allowRemote: true — MemVault refuses to start otherwise.
  host: "127.0.0.1",
  allowRemote: false,
  // Extra Host headers / browser Origins to accept (e.g. a reverse proxy name).
  allowedHosts: [],
  allowedOrigins: [],
  // Strip API keys, tokens, PAN/Aadhaar, card numbers before storing (see redact.mjs).
  redact: true,
  redactDisable: [],
  // Record every MCP tool call / API write in the tamper-evident audit log.
  audit: true,
  ...(userConfig.security || {}),
};

// Where the API token lives. Deliberately OUTSIDE the vault data folder so that
// backups and Google Drive mirrors of the vault never contain it.
export const TOKEN_FILE =
  process.env.MEMVAULT_TOKEN_FILE || path.join(HOME, ".memvault", "api-token");

// ─── Sync Configuration ─────────────────────────────────────────────────────
// Privacy first: nothing is captured automatically until YOU turn it on
// (run `memvault init`, or add a "sync" block to ~/.memvaultrc.json). Your AI assistants can
// still save memories through MCP without any of this.
export const SYNC_CONFIG = userConfig.sync ? {
  // Older config files have no gitEnabled flag: they scanned git when folders were listed.
  gitEnabled: userConfig.sync.gitEnabled ?? (userConfig.sync.gitDirs?.length > 0),
  ...userConfig.sync,
} : {
  gitEnabled: false,
  gitDirs: [HOME],
  vscodeEnabled: false,
  clipboardEnabled: false,
  filesEnabled: false,
  systemEnabled: false,
  browserEnabled: false,
  antigravityEnabled: false,
};

// "~/code" in the config file means the user's home, not a folder named "~"
for (const key of ["gitDirs", "filesDirs"]) {
  if (SYNC_CONFIG[key] !== undefined) {
    SYNC_CONFIG[key] = (Array.isArray(SYNC_CONFIG[key]) ? SYNC_CONFIG[key] : [SYNC_CONFIG[key]])
      .filter((d) => typeof d === "string" && d.trim())
      .map((d) => expandHome(d));
  }
}

// ─── AI Configuration ───────────────────────────────────────────────────────
export const AI_CONFIG = userConfig.ai || {};

// ─── Storage / Backup Configuration ─────────────────────────────────────────
// Local storage is ALWAYS on. Google Drive is opt-in via two methods:
//   1. folder — mirror the vault into your Google Drive for Desktop synced path
//   2. api    — upload backups via the Drive REST API (OAuth refresh token)
export function buildStorageConfig(uc = userConfig) {
  const cfg = {
    local: { enabled: true, ...(uc.storage?.local || {}) },
    gdriveFolder: {
      enabled: false,
      // e.g. "C:/Users/you/My Drive/MemVault" or "/home/you/GoogleDrive/MemVault"
      path: "",
      ...(uc.storage?.gdriveFolder || {}),
    },
    gdriveApi: {
      enabled: false,
      clientId: "",
      clientSecret: "",
      refreshToken: "",
      // Optional Drive folder ID to upload into ("" = My Drive root)
      folderId: "",
      ...(uc.storage?.gdriveApi || {}),
    },
    // Keep at most N local timestamped backups (0 = unlimited)
    keepLocalBackups: uc.storage?.keepLocalBackups ?? 20,
    // Anything leaving this machine (Drive folder / Drive API) is encrypted with a
    // passphrase first. The passphrase is read from the MEMVAULT_BACKUP_PASSPHRASE env
    // var, or from the first line of the file named by `passphraseFile` — never from the
    // JSON config itself. Set allowPlaintextCloud only if you accept uploading an
    // unencrypted copy of your vault.
    encryptCloud: uc.storage?.encryptCloud ?? true,
    allowPlaintextCloud: uc.storage?.allowPlaintextCloud ?? false,
    passphraseFile: uc.storage?.passphraseFile || "",
  };
  // Paths in a config file: "~" means the home folder (see paths.mjs)
  if (cfg.gdriveFolder.path) cfg.gdriveFolder.path = expandHome(cfg.gdriveFolder.path);
  if (cfg.passphraseFile) cfg.passphraseFile = expandHome(cfg.passphraseFile);
  return cfg;
}
export const STORAGE_CONFIG = buildStorageConfig(userConfig);

// ─── Projects — YOUR named projects, used to auto-tag notes (none by default) ──
//   [{ "name": "Garden Shed", "match": ["shed", "garden build"], "tags": "garden,diy" }]
export const PROJECTS = Array.isArray(userConfig.projects) ? userConfig.projects : [];

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

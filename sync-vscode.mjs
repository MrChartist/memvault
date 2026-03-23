#!/usr/bin/env node
/**
 * sync-vscode.mjs — MemVault VS Code Project Sync
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads VS Code recent projects, installed extensions, and workspace settings
 * and syncs them into the vault as context for AI assistants.
 *
 * Usage:
 *   node sync-vscode.mjs              (sync all VS Code data)
 *   node sync-vscode.mjs --dry-run    (preview, no posts)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import os from "os";

import { API_URL as API } from "./config.mjs";
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

// ─── Paths ──────────────────────────────────────────────────────────────────

const HOME = os.homedir();

const VSCODE_PATHS = {
  win32: {
    storage: path.join(HOME, "AppData", "Roaming", "Code", "User", "globalStorage", "storage.json"),
    stateDb: path.join(HOME, "AppData", "Roaming", "Code", "User", "globalStorage", "state.vscdb"),
    extensions: path.join(HOME, ".vscode", "extensions"),
    settings: path.join(HOME, "AppData", "Roaming", "Code", "User", "settings.json"),
    recentFolders: path.join(HOME, "AppData", "Roaming", "Code", "storage.json"),
  },
  darwin: {
    storage: path.join(HOME, "Library", "Application Support", "Code", "User", "globalStorage", "storage.json"),
    extensions: path.join(HOME, ".vscode", "extensions"),
    settings: path.join(HOME, "Library", "Application Support", "Code", "User", "settings.json"),
    recentFolders: path.join(HOME, "Library", "Application Support", "Code", "storage.json"),
  },
  linux: {
    storage: path.join(HOME, ".config", "Code", "User", "globalStorage", "storage.json"),
    extensions: path.join(HOME, ".vscode", "extensions"),
    settings: path.join(HOME, ".config", "Code", "User", "settings.json"),
    recentFolders: path.join(HOME, ".config", "Code", "storage.json"),
  },
};

const paths = VSCODE_PATHS[process.platform] || VSCODE_PATHS.linux;

// ─── Helpers ────────────────────────────────────────────────────────────────

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch { return null; }
}

async function postToVault(entry) {
  if (DRY_RUN) {
    console.log(`  [DRY] ${entry.title}`);
    return true;
  }
  try {
    const res = await fetch(`${API}/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    });
    return (await res.json()).ok;
  } catch { return false; }
}

// ─── Extractors ─────────────────────────────────────────────────────────────

function getRecentProjects() {
  const projects = [];

  // Try main storage.json
  const storage = readJsonSafe(paths.recentFolders);
  if (storage) {
    // VS Code stores recent folders in various places
    const recentPaths = storage.openedPathsList?.entries ||
                        storage.openedPathsList?.workspaces3 ||
                        storage["history.recentlyOpenedPathsList"]?.entries ||
                        [];

    for (const entry of recentPaths) {
      const folderUri = entry.folderUri || entry.workspace?.configPath || entry;
      if (typeof folderUri === "string") {
        // Convert file URI to path
        const cleanPath = folderUri
          .replace("file:///", "")
          .replace(/\//g, path.sep)
          .replace(/%20/g, " ");

        projects.push({
          path: cleanPath,
          name: path.basename(cleanPath),
          label: entry.label || path.basename(cleanPath),
        });
      }
    }
  }

  return projects.slice(0, 30); // Limit to 30 most recent
}

function getInstalledExtensions() {
  const extDir = paths.extensions;
  if (!fs.existsSync(extDir)) return [];

  try {
    const dirs = fs.readdirSync(extDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith("."))
      .map(d => {
        const pkgPath = path.join(extDir, d.name, "package.json");
        const pkg = readJsonSafe(pkgPath);
        return {
          id: d.name,
          name: pkg?.displayName || d.name,
          description: pkg?.description || "",
          publisher: pkg?.publisher || "unknown",
          version: pkg?.version || "?",
          categories: (pkg?.categories || []).join(", "),
        };
      });

    return dirs;
  } catch { return []; }
}

function getUserSettings() {
  const settings = readJsonSafe(paths.settings);
  if (!settings) return null;

  // Extract only interesting settings (not all)
  const interesting = {};
  const keys = [
    "editor.fontSize", "editor.fontFamily", "editor.tabSize",
    "editor.theme", "workbench.colorTheme", "editor.formatOnSave",
    "terminal.integrated.shell.windows", "terminal.integrated.defaultProfile.windows",
    "files.autoSave", "editor.wordWrap",
  ];

  for (const key of keys) {
    if (settings[key] !== undefined) interesting[key] = settings[key];
  }

  return interesting;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  VS Code → MemVault Sync             ║");
  console.log(`║  ${DRY_RUN ? "DRY RUN                            " : "LIVE MODE                          "}║`);
  console.log("╚══════════════════════════════════════╝\n");

  if (!DRY_RUN) {
    try {
      const h = await fetch(`${API}/health`);
      if (!h.ok) throw new Error();
      console.log("✅ Vault API reachable\n");
    } catch {
      console.error("❌ Vault API not reachable at", API);
      process.exit(1);
    }
  }

  let totalSynced = 0;

  // 1. Recent Projects
  console.log("── Recent Projects ──────────────────────");
  const projects = getRecentProjects();
  console.log(`  📁 Found ${projects.length} recent projects`);

  if (projects.length > 0) {
    const projectList = projects.map((p, i) => `${i + 1}. **${p.name}** — \`${p.path}\``).join("\n");

    const synced = await postToVault({
      type: "worklog",
      source: "vscode",
      title: `[VS Code] Active Projects (${projects.length})`,
      content: `## VS Code Recent Projects\n\n${projectList}\n\n_Synced: ${new Date().toISOString()}_`,
      tags: "vscode,projects,workspace",
    });
    if (synced) totalSynced++;
  }

  // 2. Installed Extensions
  console.log("\n── Installed Extensions ─────────────────");
  const extensions = getInstalledExtensions();
  console.log(`  🧩 Found ${extensions.length} extensions`);

  if (extensions.length > 0) {
    const extList = extensions
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => `- **${e.name}** (${e.publisher}) v${e.version}${e.categories ? ` [${e.categories}]` : ""}`)
      .join("\n");

    const synced = await postToVault({
      type: "worklog",
      source: "vscode",
      title: `[VS Code] Installed Extensions (${extensions.length})`,
      content: `## VS Code Extensions\n\n${extList}\n\n_Synced: ${new Date().toISOString()}_`,
      tags: "vscode,extensions,tools",
    });
    if (synced) totalSynced++;
  }

  // 3. User Settings
  console.log("\n── User Settings ───────────────────────");
  const settings = getUserSettings();

  if (settings && Object.keys(settings).length > 0) {
    const settingsList = Object.entries(settings)
      .map(([k, v]) => `- **${k}**: \`${JSON.stringify(v)}\``)
      .join("\n");

    const synced = await postToVault({
      type: "worklog",
      source: "vscode",
      title: "[VS Code] User Preferences",
      content: `## VS Code Settings\n\n${settingsList}\n\n_Synced: ${new Date().toISOString()}_`,
      tags: "vscode,settings,preferences",
    });
    if (synced) totalSynced++;
    console.log(`  ⚙️  ${Object.keys(settings).length} settings captured`);
  } else {
    console.log("  ⚠️  No settings found or unreadable");
  }

  console.log(`\n═══════════════════════════════════════`);
  console.log(`✅ Synced: ${totalSynced} entries to vault`);
  console.log(`═══════════════════════════════════════\n`);
}

main().catch(console.error);

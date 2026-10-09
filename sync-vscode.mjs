#!/usr/bin/env node
/**
 * sync-vscode.mjs — MemVault VS Code Project Sync
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads VS Code recent projects, installed extensions, and a few editor
 * preferences and saves them as snapshots (each run replaces the previous one).
 *
 * Usage:
 *   node sync-vscode.mjs              (sync all VS Code data)
 *   node sync-vscode.mjs --dry-run    (preview, nothing is saved)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { saveEntries } from "./sync-lib.mjs";
import { isMainModule } from "./util.mjs";

// ─── Paths ──────────────────────────────────────────────────────────────────

const HOME = os.homedir();

function vscodePaths(platform = process.platform) {
  const userDir =
    platform === "win32" ? path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "Code")
    : platform === "darwin" ? path.join(HOME, "Library", "Application Support", "Code")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "Code");
  return {
    extensions: path.join(HOME, ".vscode", "extensions"),
    settings: path.join(userDir, "User", "settings.json"),
    storage: path.join(userDir, "User", "globalStorage", "storage.json"),
    legacyStorage: path.join(userDir, "storage.json"),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

/** VS Code stores folders as URIs ("file:///C:/x", "vscode-remote://..."); turn them into something readable. */
export function uriToPath(uri) {
  if (typeof uri !== "string") return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) return uri; // already a plain path
  try {
    if (uri.startsWith("file://")) return fileURLToPath(new URL(uri));
  } catch { /* fall through */ }
  try { return decodeURIComponent(uri); } catch { return uri; }
}

export function getRecentProjects(p = vscodePaths()) {
  const uris = [];
  for (const file of [p.legacyStorage, p.storage]) {
    const storage = readJsonSafe(file);
    if (!storage) continue;
    // Several shapes exist across VS Code versions — read what is present.
    const legacy = storage.openedPathsList?.entries || storage.openedPathsList?.workspaces3 || [];
    for (const e of legacy) uris.push(e?.folderUri || e?.workspace?.configPath || e);
    for (const f of storage.backupWorkspaces?.folders || []) uris.push(f?.folderUri);
    uris.push(...Object.keys(storage.profileAssociations?.workspaces || {}));
  }

  const seen = new Set();
  const projects = [];
  for (const uri of uris) {
    const p2 = uriToPath(uri);
    if (!p2 || seen.has(p2)) continue;
    seen.add(p2);
    projects.push({ path: p2, name: path.basename(p2) || p2 });
  }
  return projects.slice(0, 30);
}

export function getInstalledExtensions(extDir = vscodePaths().extensions) {
  if (!fs.existsSync(extDir)) return [];
  try {
    return fs
      .readdirSync(extDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => {
        const pkg = readJsonSafe(path.join(extDir, d.name, "package.json"));
        return {
          id: d.name,
          name: pkg?.displayName && !pkg.displayName.startsWith("%") ? pkg.displayName : d.name,
          publisher: pkg?.publisher || "unknown",
          version: pkg?.version || "?",
          categories: (pkg?.categories || []).join(", "),
        };
      });
  } catch {
    return [];
  }
}

function getUserSettings(settingsFile = vscodePaths().settings) {
  const settings = readJsonSafe(settingsFile); // note: settings.json may contain comments (JSONC) → null → skipped
  if (!settings) return null;
  const keys = [
    "editor.fontSize", "editor.fontFamily", "editor.tabSize", "workbench.colorTheme",
    "editor.formatOnSave", "files.autoSave", "editor.wordWrap",
    "terminal.integrated.defaultProfile.windows", "terminal.integrated.defaultProfile.linux", "terminal.integrated.defaultProfile.osx",
  ];
  const picked = {};
  for (const key of keys) if (settings[key] !== undefined) picked[key] = settings[key];
  return picked;
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function main(args = process.argv.slice(2)) {
  const dryRun = args.includes("--dry-run");
  const stamp = `_Synced: ${new Date().toISOString()}_`;
  const entries = [];

  const projects = getRecentProjects();
  console.log(`📁 ${projects.length} recent projects`);
  if (projects.length) {
    entries.push({
      type: "worklog", source: "vscode", upsert: true,
      title: "[VS Code] Active Projects",
      content: `## VS Code Recent Projects\n\n${projects.map((p, i) => `${i + 1}. **${p.name}** — \`${p.path}\``).join("\n")}\n\n${stamp}`,
      tags: "vscode,projects,workspace",
    });
  }

  const extensions = getInstalledExtensions();
  console.log(`🧩 ${extensions.length} extensions`);
  if (extensions.length) {
    const list = extensions
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => `- **${e.name}** (${e.publisher}) v${e.version}${e.categories ? ` [${e.categories}]` : ""}`)
      .join("\n");
    entries.push({
      type: "worklog", source: "vscode", upsert: true,
      title: "[VS Code] Installed Extensions",
      content: `## VS Code Extensions (${extensions.length})\n\n${list}\n\n${stamp}`,
      tags: "vscode,extensions,tools",
    });
  }

  const settings = getUserSettings();
  if (settings && Object.keys(settings).length) {
    console.log(`⚙️  ${Object.keys(settings).length} preferences`);
    entries.push({
      type: "worklog", source: "vscode", upsert: true,
      title: "[VS Code] User Preferences",
      content: `## VS Code Settings\n\n${Object.entries(settings).map(([k, v]) => `- **${k}**: \`${JSON.stringify(v)}\``).join("\n")}\n\n${stamp}`,
      tags: "vscode,settings,preferences",
    });
  }

  if (entries.length === 0) console.log("ℹ️  No VS Code data found (is VS Code installed for this user?).");
  const result = saveEntries(entries, { dryRun });
  console.log(`✅ ${entries.length} VS Code snapshot(s) ${dryRun ? "found (dry run, nothing saved)" : "saved"}\n`);
  return result;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}

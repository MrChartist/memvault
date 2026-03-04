#!/usr/bin/env node
/**
 * sync-antigravity.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Automatically reads ALL Antigravity conversation artifacts from the brain
 * directory on Windows and syncs them into the Knowledge Vault.
 *
 * What it does:
 *   1. Clears all existing data from the vault (fresh start)
 *   2. Scans every conversation folder in the brain directory
 *   3. Reads walkthrough.md, task.md, implementation_plan.md + their metadata
 *   4. POSTs each artifact as a structured entry to the vault API
 *   5. Prints a summary of what was synced
 *
 * Usage:
 *   node sync-antigravity.mjs
 *   node sync-antigravity.mjs --no-clear   (skip clearing existing data)
 *   node sync-antigravity.mjs --dry-run    (preview without posting)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";

const API = "http://127.0.0.1:7799";

// Windows path to Antigravity brain directory (accessible from WSL as /mnt/c/...)
const BRAIN_DIR = process.env.BRAIN_DIR || "/mnt/c/Users/rohit/.gemini/antigravity/brain";

// Conversation summary file (updated per session by conversation_summaries)
const CONV_SUMMARY_FILE = process.env.CONV_SUMMARY ||
  "/mnt/c/Users/rohit/.gemini/antigravity/.system_generated/conversation_summaries.json";

// Parse flags
const args = process.argv.slice(2);
const DRY_RUN  = args.includes("--dry-run");
const NO_CLEAR = args.includes("--no-clear");

// Artifact types we care about
const ARTIFACT_TYPES = [
  { file: "walkthrough.md",         type: "worklog",      label: "Walkthrough" },
  { file: "task.md",                type: "worklog",      label: "Task"        },
  { file: "implementation_plan.md", type: "conversation", label: "Plan"        },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return null; }
}

function readFileSafe(filePath) {
  try { return fs.readFileSync(filePath, "utf8").trim(); }
  catch { return null; }
}

async function apiPost(endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function clearAllData() {
  console.log("🗑️  Clearing existing vault data...");
  try {
    const res = await fetch(`${API}/clear`, { method: "POST" });
    if (res.ok) {
      console.log("   ✅ Cleared.");
    } else {
      // Endpoint may not exist, do it manually via the reset endpoint
      console.log("   ⚠️  /clear not available, trying /reset...");
      const r2 = await fetch(`${API}/reset`, { method: "POST" });
      if (r2.ok) {
        console.log("   ✅ Reset done.");
      } else {
        console.log("   ⚠️  Could not clear via API — will still sync.");
      }
    }
  } catch (e) {
    console.log(`   ⚠️  Clear failed: ${e.message}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  Antigravity → Vault Auto-Sync       ║");
  console.log(`║  ${DRY_RUN ? "DRY RUN — no data will be written" : "LIVE MODE"}`);
  console.log("╚══════════════════════════════════════╝\n");

  // 1. Check vault is reachable
  try {
    const health = await fetch(`${API}/health`);
    if (!health.ok) throw new Error("not ok");
    const hj = await health.json();
    console.log(`✅ Vault online — ${hj.vault}\n`);
  } catch {
    console.error("❌ Cannot reach Vault API at", API);
    console.error("   Start the server first: node server.mjs");
    process.exit(1);
  }

  // 2. Clear old data
  if (!NO_CLEAR && !DRY_RUN) {
    await clearAllData();
    console.log();
  }

  // 3. Read brain directory
  if (!fs.existsSync(BRAIN_DIR)) {
    console.error(`❌ Brain directory not found: ${BRAIN_DIR}`);
    process.exit(1);
  }

  // Try loading conversation summaries for richer titles
  const convSummaries = {};
  if (fs.existsSync(CONV_SUMMARY_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONV_SUMMARY_FILE, "utf8"));
      for (const conv of (Array.isArray(raw) ? raw : Object.values(raw))) {
        if (conv.id || conv.conversationId) {
          const id = conv.id || conv.conversationId;
          convSummaries[id] = conv;
        }
      }
      console.log(`📋 Loaded ${Object.keys(convSummaries).length} conversation summaries.\n`);
    } catch {}
  }

  const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
  const convFolders = entries.filter(
    (e) => e.isDirectory() && /^[0-9a-f-]{36}$/i.test(e.name)
  );

  console.log(`📁 Found ${convFolders.length} conversation folders.\n`);

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  for (const folder of convFolders) {
    const convId = folder.name;
    const convDir = path.join(BRAIN_DIR, convId);
    const convMeta = convSummaries[convId] || {};
    const convTitle = convMeta.title || convMeta.name || `Conversation ${convId.slice(0, 8)}`;

    let anyFound = false;

    for (const art of ARTIFACT_TYPES) {
      const filePath = path.join(convDir, art.file);
      const metaPath = path.join(convDir, `${art.file}.metadata.json`);

      const content = readFileSafe(filePath);
      if (!content) continue; // File doesn't exist in this conversation

      anyFound = true;
      const meta = readJsonSafe(metaPath) || {};

      const title = `[${art.label}] ${convTitle}`;
      const createdAt = meta.updatedAt || new Date().toISOString();
      const tags = `antigravity,${art.type},${art.label.toLowerCase()},conv:${convId.slice(0,8)}`;
      const summary = meta.summary || "";

      // Combine summary + content (cap at 8000 chars to avoid huge entries)
      const fullContent = summary
        ? `${summary}\n\n---\n\n${content}`.slice(0, 8000)
        : content.slice(0, 8000);

      if (DRY_RUN) {
        console.log(`  [DRY] Would sync: ${title} (${art.type})`);
        synced++;
        continue;
      }

      try {
        const result = await apiPost("/add", {
          type: art.type,
          source: "antigravity",
          title,
          content: fullContent,
          tags,
          created_at: createdAt,
        });

        if (result.ok) {
          synced++;
          process.stdout.write(".");
        } else {
          errors++;
          process.stdout.write("✗");
        }
      } catch (e) {
        errors++;
        process.stdout.write("!");
      }
    }

    if (!anyFound) skipped++;
  }

  console.log(`\n\n═══════════════════════════════════════`);
  console.log(`✅ Synced : ${synced} entries`);
  console.log(`⏭  Skipped: ${skipped} folders (no artifacts)`);
  if (errors) console.log(`❌ Errors : ${errors}`);
  console.log(`═══════════════════════════════════════\n`);
  console.log(`🌐 Open http://127.0.0.1:7799 to view your vault.`);
}

main().catch(console.error);

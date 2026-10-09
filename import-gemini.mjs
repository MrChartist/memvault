#!/usr/bin/env node
/**
 * import-gemini.mjs — Import Google Gemini Conversations into MemVault
 * ═════════════════════════════════════════════════════════════════════
 * Parses the MyActivity.json from Google Takeout (Gemini Apps).
 *
 * Usage:
 *   node import-gemini.mjs <path-to-takeout-folder-or-json>
 *
 * Google Takeout Gemini export:
 *   MyActivity.json → Array of activity objects:
 *     { header, title, time, subtitles: [{ name }], products: ["Gemini Apps"] }
 */

import fs from "fs";
import path from "path";
import { importConversations } from "./import-lib.mjs";
import { isMainModule } from "./util.mjs";

// ─── Helpers ────────────────────────────────────────────────────────────────

function findGeminiFile(inputPath) {
  if (fs.statSync(inputPath).isFile()) return inputPath;

  // Google Takeout paths
  const candidates = [
    path.join(inputPath, "MyActivity.json"),
    path.join(inputPath, "My Activity", "Gemini Apps", "MyActivity.json"),
    path.join(inputPath, "Takeout", "My Activity", "Gemini Apps", "MyActivity.json"),
    path.join(inputPath, "Gemini Apps", "MyActivity.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Recursive search for MyActivity.json
  function findRecursive(dir, depth = 0) {
    if (depth > 4) return null;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name === "MyActivity.json") {
          return path.join(dir, entry.name);
        }
        if (entry.isDirectory()) {
          const result = findRecursive(path.join(dir, entry.name), depth + 1);
          if (result) return result;
        }
      }
    } catch { /* skip unreadable dirs */ }
    return null;
  }

  return findRecursive(inputPath);
}

function formatGeminiActivity(activity) {
  const title = activity.title || "Gemini Conversation";
  const time = activity.time || new Date().toISOString();

  // Extract the response text from subtitles
  const subtitles = (activity.subtitles || [])
    .map((s) => s.name || s)
    .filter(Boolean);

  // Build content
  const lines = [`# ${title}`, ""];

  // The title usually contains the user's prompt
  if (activity.title && activity.title !== "Gemini Apps") {
    lines.push("### 👤 User");
    lines.push(activity.title.replace(/^Used Gemini Apps?\s*/, ""));
    lines.push("");
  }

  if (subtitles.length > 0) {
    lines.push("### 🤖 Gemini");
    lines.push(subtitles.join("\n"));
    lines.push("");
  }

  const content = lines.join("\n");
  if (content.trim().length < 20) return null; // Too short to be useful

  return {
    title: title.slice(0, 200),
    content,
    tags: ["import", "gemini", "conversation", "ai-history"].join(","),
    created_at: time,
  };
}

// ─── Main Import ────────────────────────────────────────────────────────────

export async function importGemini(inputPath, options = {}) {
  const filePath = findGeminiFile(inputPath);
  if (!filePath) {
    console.error("❌ Could not find Gemini MyActivity.json in:", inputPath);
    return { imported: 0, skipped: 0, errors: 0 };
  }

  console.log(`📂 Reading: ${filePath}`);
  let activities;

  try {
    activities = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error("❌ Invalid JSON:", e.message);
    return { imported: 0, skipped: 0, errors: 0 };
  }

  if (!Array.isArray(activities)) {
    console.error("❌ Expected an array of activity objects");
    return { imported: 0, skipped: 0, errors: 0 };
  }

  // Filter for Gemini Apps activities only
  const geminiActivities = activities.filter((a) =>
    (a.products || []).some((p) => p.toLowerCase().includes("gemini"))
    || (a.header || "").toLowerCase().includes("gemini")
  );

  console.log(`📊 Found ${geminiActivities.length} Gemini activities (out of ${activities.length} total)`);

  return importConversations(geminiActivities.map(formatGeminiActivity), {
    label: "Gemini",
    source: "gemini-import",
    dryRun: options.dryRun || false,
  });
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.log(`
  📥 Google Gemini Importer for MemVault

  Usage:
    node import-gemini.mjs <path-to-takeout-folder>
    node import-gemini.mjs <path-to-MyActivity.json> --dry-run

  How to export from Gemini:
    1. Go to takeout.google.com
    2. Deselect all, then select "My Activity"
    3. Click "Multiple formats" → Set Activity records to JSON
    4. Under "All activity", select only "Gemini Apps"
    5. Create export, download the ZIP
    6. Unzip and point this script at the folder
    `);
    process.exit(1);
  }

  const dryRun = process.argv.includes("--dry-run");
  importGemini(inputPath, { dryRun }).catch(console.error);
}

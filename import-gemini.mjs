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
import { createIngestQueue } from "./ingest.mjs";
import { runImport, toIso } from "./import-common.mjs";

const queue = createIngestQueue({ actor: "gemini-import" });

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

const decodeEntities = (t) => t.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const htmlToText = (h) => decodeEntities(String(h).replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6])>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/\n{3,}/g, "\n\n").trim();

function formatGeminiActivity(activity) {
  if (!activity || typeof activity !== "object") return null;
  // Takeout writes "Prompted <what you asked>"; older files say "Used Gemini Apps".
  const prompt = String(activity.title || "").replace(/^(?:Prompted|Used Gemini Apps?)\s*/i, "").trim();
  const answers = [
    ...(Array.isArray(activity.subtitles) ? activity.subtitles.map((s) => (typeof s === "string" ? s : s?.name)) : []),
    ...(Array.isArray(activity.safeHtmlItem) ? activity.safeHtmlItem.map((x) => htmlToText(x?.html ?? "")) : []),
  ].map((x) => String(x || "").trim()).filter(Boolean);
  if (!prompt && !answers.length) return null; // nothing was said, only a header

  const title = (prompt || "Gemini Conversation").slice(0, 200);
  const lines = [`# ${title}`, ""];
  if (prompt) lines.push("### 👤 User", prompt, "");
  if (answers.length) lines.push("### 🤖 Gemini", answers.join("\n\n"), "");

  return {
    title,
    content: lines.join("\n"),
    tags: ["import", "gemini", "conversation", "ai-history"].join(","),
    created_at: toIso(activity.time),
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
    (Array.isArray(a?.products) ? a.products : []).some((p) => typeof p === "string" && p.toLowerCase().includes("gemini"))
    || String(a?.header || "").toLowerCase().includes("gemini")
  );

  console.log(`📊 Found ${geminiActivities.length} Gemini activities (out of ${activities.length} total)`);

  const dryRun = options.dryRun || false;
  const { imported, skipped, duplicates, errors } = await runImport({
    source: "gemini-import", queue, items: geminiActivities, format: formatGeminiActivity, dryRun,
  });
  if (!dryRun && errors === 0 && imported === 0 && duplicates === 0 && skipped === 0) console.log("Nothing found to import.");
  console.log(`\n🎉 Gemini Import Complete!`);
  console.log(`   ✅ Imported: ${imported}`);
  if (duplicates) console.log(`   ♻️  Already in your vault: ${duplicates} (not added again)`);
  console.log(`   ⏭️  Skipped:  ${skipped}`);
  if (errors) console.log(`   ❌ Errors:   ${errors}`);

  return { imported, skipped, duplicates, errors };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith("import-gemini.mjs")) {
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

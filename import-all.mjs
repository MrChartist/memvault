#!/usr/bin/env node
/**
 * import-all.mjs — Auto-detect and Import All AI Conversations
 * ═════════════════════════════════════════════════════════════════
 * Point it at a folder containing exports from multiple AI platforms
 * and it will automatically detect and import everything.
 *
 * Usage:
 *   node import-all.mjs <path-to-exports-folder>
 *   memvault import <path>
 */

import fs from "fs";
import path from "path";
import { importChatGPT } from "./import-chatgpt.mjs";
import { importClaude } from "./import-claude.mjs";
import { importGemini } from "./import-gemini.mjs";
import { importPerplexity } from "./import-perplexity.mjs";

// ─── Platform Detection ────────────────────────────────────────────────────

/** Which service wrote this export? Looks at the first real record, so an empty or null first entry does not confuse it. */
export function classifyJson(data) {
  if (data && !Array.isArray(data) && data.chat_conversations) return "claude";
  const first = Array.isArray(data) ? data.find((x) => x && typeof x === "object") : null;
  if (!first) return null;
  if (first.mapping) return "chatgpt";
  if (first.chat_messages) return "claude";
  if (first.products || first.header) return "gemini";
  return null;
}

function detectPlatforms(inputPath) {
  const detected = [];

  if (!fs.existsSync(inputPath)) {
    console.error(`❌ Path not found: ${inputPath}`);
    return detected;
  }

  const isFile = fs.statSync(inputPath).isFile();

  if (isFile) {
    // Single file — try to detect platform from content
    try {
      const raw = fs.readFileSync(inputPath, "utf8");
      const data = JSON.parse(raw);
      detected.push({ platform: classifyJson(data) || "perplexity", path: inputPath });
    } catch {
      console.error(`⚠️ Could not parse: ${inputPath}`);
    }
    return detected;
  }

  // Folder — scan for known files
  const files = fs.readdirSync(inputPath);

  // Look at every .json file in the folder: ChatGPT (also split into several files), Claude, whatever order they come in.
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    try {
      const kind = classifyJson(JSON.parse(fs.readFileSync(path.join(inputPath, f), "utf8")));
      if (kind === "chatgpt" || kind === "claude") detected.push({ platform: kind, path: path.join(inputPath, f) });
    } catch { /* not an export file */ }
  }

  // Gemini: MyActivity.json or nested Takeout structure
  const geminiPaths = [
    path.join(inputPath, "MyActivity.json"),
    path.join(inputPath, "My Activity", "Gemini Apps", "MyActivity.json"),
    path.join(inputPath, "Takeout", "My Activity", "Gemini Apps", "MyActivity.json"),
  ];
  for (const gp of geminiPaths) {
    if (fs.existsSync(gp)) {
      detected.push({ platform: "gemini", path: inputPath });
      break;
    }
  }

  // Perplexity: search_history.json or perplexity_export.json
  const perplexityFiles = ["perplexity_export.json", "search_history.json"];
  for (const pf of perplexityFiles) {
    if (files.includes(pf)) {
      detected.push({ platform: "perplexity", path: inputPath });
      break;
    }
  }

  // If we found a conversations.json but it's not ChatGPT, try Claude
  if (detected.length === 0 && files.includes("conversations.json")) {
    detected.push({ platform: "claude", path: inputPath });
  }

  return detected;
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function importAll(inputPath, options = {}) {
  console.log(`\n🔍 Scanning: ${inputPath}\n`);

  const platforms = detectPlatforms(inputPath);

  if (platforms.length === 0) {
    console.log("❌ No AI export files detected in this folder.");
    console.log("   Supported: ChatGPT, Claude, Gemini, Perplexity");
    console.log("   Make sure you've unzipped the export file first.\n");
    return;
  }

  console.log(`📋 Detected ${platforms.length} platform(s):\n`);
  for (const p of platforms) {
    console.log(`   • ${p.platform.charAt(0).toUpperCase() + p.platform.slice(1)}`);
  }
  console.log("");

  const results = {};

  for (const { platform, path: pPath } of platforms) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  📥 Importing from: ${platform.toUpperCase()}`);
    console.log(`${"═".repeat(60)}\n`);

    let result;
    switch (platform) {
      case "chatgpt":
        result = await importChatGPT(pPath, options);
        break;
      case "claude":
        result = await importClaude(pPath, options);
        break;
      case "gemini":
        result = await importGemini(pPath, options);
        break;
      case "perplexity":
        result = await importPerplexity(pPath, options);
        break;
    }
    results[platform] = result;
  }

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log("  🎉 IMPORT SUMMARY");
  console.log(`${"═".repeat(60)}\n`);

  let totalImported = 0;
  for (const [platform, result] of Object.entries(results)) {
    const icon = result.imported > 0 ? "✅" : "⏭️";
    console.log(`  ${icon} ${platform}: ${result.imported} imported, ${result.skipped} skipped`);
    totalImported += result.imported;
  }
  console.log(`\n  📊 Total: ${totalImported} conversations imported into MemVault\n`);

  return results;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith("import-all.mjs")) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.log(`
  📥 MemVault Universal AI Importer

  Usage:
    node import-all.mjs <path-to-exports-folder>
    node import-all.mjs <path> --dry-run

  Auto-detects and imports from:
    • ChatGPT (conversations.json)
    • Claude (chat_conversations JSON)
    • Google Gemini (Google Takeout MyActivity.json)
    • Perplexity (search_history.json)

  Example:
    node import-all.mjs ~/Downloads/ai-exports/
    `);
    process.exit(1);
  }

  const dryRun = process.argv.includes("--dry-run");
  importAll(inputPath, { dryRun }).catch(console.error);
}

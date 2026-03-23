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

      if (Array.isArray(data) && data[0]?.mapping) {
        detected.push({ platform: "chatgpt", path: inputPath });
      } else if (data.chat_conversations || (Array.isArray(data) && data[0]?.chat_messages)) {
        detected.push({ platform: "claude", path: inputPath });
      } else if (Array.isArray(data) && data[0]?.products) {
        detected.push({ platform: "gemini", path: inputPath });
      } else {
        detected.push({ platform: "perplexity", path: inputPath });
      }
    } catch {
      console.error(`⚠️ Could not parse: ${inputPath}`);
    }
    return detected;
  }

  // Folder — scan for known files
  const files = fs.readdirSync(inputPath);

  // ChatGPT: conversations.json with mapping field
  if (files.includes("conversations.json")) {
    try {
      const sample = fs.readFileSync(path.join(inputPath, "conversations.json"), "utf8");
      const parsed = JSON.parse(sample);
      if (Array.isArray(parsed) && parsed[0]?.mapping) {
        detected.push({ platform: "chatgpt", path: inputPath });
      }
    } catch { /* skip */ }
  }

  // Claude: look for chat_conversations key
  for (const f of files.filter(f => f.endsWith(".json") && f !== "conversations.json")) {
    try {
      const sample = fs.readFileSync(path.join(inputPath, f), "utf8");
      const parsed = JSON.parse(sample);
      if (parsed.chat_conversations) {
        detected.push({ platform: "claude", path: path.join(inputPath, f) });
        break;
      }
    } catch { /* skip */ }
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

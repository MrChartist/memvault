#!/usr/bin/env node
/**
 * import-perplexity.mjs — Import Perplexity Conversations into MemVault
 * ═══════════════════════════════════════════════════════════════════════
 * Parses the exported JSON from Perplexity AI.
 *
 * Usage:
 *   node import-perplexity.mjs <path-to-export>
 */

import fs from "fs";
import path from "path";
import { API_URL } from "./config.mjs";

// ─── Helpers ────────────────────────────────────────────────────────────────

function findPerplexityFile(inputPath) {
  if (fs.statSync(inputPath).isFile()) return inputPath;

  const candidates = [
    path.join(inputPath, "perplexity_export.json"),
    path.join(inputPath, "conversations.json"),
    path.join(inputPath, "search_history.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Try any JSON in folder
  const files = fs.readdirSync(inputPath).filter((f) => f.endsWith(".json"));
  if (files.length === 1) return path.join(inputPath, files[0]);
  return null;
}

function formatPerplexityConversation(conv) {
  const title = conv.title || conv.query || "Perplexity Search";
  const lines = [`# ${title}`, ""];

  // Handle different Perplexity export structures
  if (conv.query) {
    lines.push("### 👤 Query");
    lines.push(conv.query);
    lines.push("");
  }

  if (conv.answer) {
    lines.push("### 🔍 Perplexity");
    lines.push(conv.answer);
    lines.push("");
  }

  // If has messages array
  if (Array.isArray(conv.messages)) {
    for (const msg of conv.messages) {
      const role = msg.role === "user" ? "👤 User" : "🔍 Perplexity";
      const text = msg.content || msg.text || "";
      if (text.trim()) {
        lines.push(`### ${role}`);
        lines.push(text.trim());
        lines.push("");
      }
    }
  }

  // If has query_results / search_results
  if (Array.isArray(conv.search_results || conv.sources)) {
    const sources = conv.search_results || conv.sources;
    lines.push("### 📚 Sources");
    for (const src of sources.slice(0, 5)) {
      const srcTitle = src.title || src.name || src.url;
      lines.push(`- [${srcTitle}](${src.url || "#"})`);
    }
    lines.push("");
  }

  const content = lines.join("\n");
  if (content.trim().length < 30) return null;

  return {
    title: title.slice(0, 200),
    content,
    tags: ["import", "perplexity", "conversation", "ai-history", "search"].join(","),
    created_at: conv.created_at || conv.timestamp || new Date().toISOString(),
  };
}

// ─── Main Import ────────────────────────────────────────────────────────────

export async function importPerplexity(inputPath, options = {}) {
  const filePath = findPerplexityFile(inputPath);
  if (!filePath) {
    console.error("❌ Could not find Perplexity export in:", inputPath);
    return { imported: 0, skipped: 0, errors: 0 };
  }

  console.log(`📂 Reading: ${filePath}`);
  let data;

  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error("❌ Invalid JSON:", e.message);
    return { imported: 0, skipped: 0, errors: 0 };
  }

  const conversations = Array.isArray(data) ? data : data.conversations || data.threads || data.searches || [];

  if (conversations.length === 0) {
    console.error("❌ No conversations found in Perplexity export");
    return { imported: 0, skipped: 0, errors: 0 };
  }

  console.log(`📊 Found ${conversations.length} Perplexity conversations`);

  let imported = 0, skipped = 0, errors = 0;
  const dryRun = options.dryRun || false;

  for (const conv of conversations) {
    const formatted = formatPerplexityConversation(conv);
    if (!formatted) { skipped++; continue; }

    if (dryRun) {
      console.log(`  📝 [DRY RUN] "${formatted.title.slice(0, 60)}..."`);
      imported++;
      continue;
    }

    try {
      const res = await fetch(`${API_URL}/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "conversation",
          source: "perplexity-import",
          title: formatted.title,
          content: formatted.content,
          tags: formatted.tags,
        }),
      });
      const result = await res.json();
      if (result.ok) {
        imported++;
        if (imported % 10 === 0) console.log(`  ✅ Imported ${imported}...`);
      } else { errors++; }
    } catch (e) {
      errors++;
      if (errors <= 3) console.error(`  ⚠️ Error: ${e.message}`);
    }
  }

  console.log(`\n🎉 Perplexity Import Complete!`);
  console.log(`   ✅ Imported: ${imported}`);
  console.log(`   ⏭️  Skipped:  ${skipped}`);
  if (errors) console.log(`   ❌ Errors:   ${errors}`);

  return { imported, skipped, errors };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith("import-perplexity.mjs")) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.log(`
  📥 Perplexity Importer for MemVault

  Usage:
    node import-perplexity.mjs <path-to-export>
    node import-perplexity.mjs <path-to-export> --dry-run

  How to export from Perplexity:
    1. Go to perplexity.ai → Settings → Account
    2. Click "Export Data"
    3. Download the file
    4. Point this script at the downloaded file/folder
    `);
    process.exit(1);
  }

  const dryRun = process.argv.includes("--dry-run");
  importPerplexity(inputPath, { dryRun }).catch(console.error);
}

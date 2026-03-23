#!/usr/bin/env node
/**
 * import-claude.mjs — Import Claude Conversations into MemVault
 * ══════════════════════════════════════════════════════════════════
 * Parses the exported JSON from Claude (Anthropic).
 *
 * Usage:
 *   node import-claude.mjs <path-to-claude-export.json-or-folder>
 *
 * Claude export structure:
 *   JSON with: { chat_conversations: [ { uuid, name, created_at, updated_at,
 *     chat_messages: [ { uuid, text, sender, created_at, attachments, content } ] } ] }
 */

import fs from "fs";
import path from "path";
import { API_URL } from "./config.mjs";

// ─── Helpers ────────────────────────────────────────────────────────────────

function findClaudeFile(inputPath) {
  if (fs.statSync(inputPath).isFile()) return inputPath;

  // Look for common Claude export filenames
  const candidates = [
    path.join(inputPath, "claude_conversations.json"),
    path.join(inputPath, "conversations.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Try any JSON file in the folder
  const files = fs.readdirSync(inputPath).filter((f) => f.endsWith(".json"));
  if (files.length === 1) return path.join(inputPath, files[0]);

  return null;
}

function extractClaudeMessages(chatMessages) {
  if (!Array.isArray(chatMessages)) return [];

  return chatMessages.map((msg) => {
    // Claude content can be array of objects or string
    let text = "";
    if (typeof msg.text === "string") {
      text = msg.text;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    } else if (typeof msg.content === "string") {
      text = msg.content;
    }

    return {
      role: msg.sender || "unknown",
      text: text.trim(),
      timestamp: msg.created_at || null,
    };
  }).filter((m) => m.text.length > 0);
}

function formatClaudeConversation(conv) {
  const messages = extractClaudeMessages(conv.chat_messages);
  if (messages.length === 0) return null;

  const title = conv.name || "Untitled Claude Conversation";
  const lines = [`# ${title}`, ""];

  for (const msg of messages) {
    const roleLabel =
      msg.role === "human" ? "👤 User" :
      msg.role === "assistant" ? "🤖 Claude" :
      `📎 ${msg.role}`;

    lines.push(`### ${roleLabel}`);
    lines.push(msg.text);
    lines.push("");
  }

  return {
    title,
    content: lines.join("\n"),
    tags: ["import", "claude", "conversation", "ai-history"].join(","),
    created_at: conv.created_at || new Date().toISOString(),
    messageCount: messages.length,
  };
}

// ─── Main Import ────────────────────────────────────────────────────────────

export async function importClaude(inputPath, options = {}) {
  const filePath = findClaudeFile(inputPath);
  if (!filePath) {
    console.error("❌ Could not find Claude export in:", inputPath);
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

  // Claude exports have chat_conversations array
  const conversations = data.chat_conversations || data.conversations || (Array.isArray(data) ? data : []);

  if (conversations.length === 0) {
    console.error("❌ No conversations found in Claude export");
    return { imported: 0, skipped: 0, errors: 0 };
  }

  console.log(`📊 Found ${conversations.length} Claude conversations`);

  let imported = 0, skipped = 0, errors = 0;
  const dryRun = options.dryRun || false;

  for (const conv of conversations) {
    const formatted = formatClaudeConversation(conv);
    if (!formatted) { skipped++; continue; }

    if (dryRun) {
      console.log(`  📝 [DRY RUN] "${formatted.title}" (${formatted.messageCount} messages)`);
      imported++;
      continue;
    }

    try {
      const res = await fetch(`${API_URL}/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "conversation",
          source: "claude-import",
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

  console.log(`\n🎉 Claude Import Complete!`);
  console.log(`   ✅ Imported: ${imported}`);
  console.log(`   ⏭️  Skipped:  ${skipped}`);
  if (errors) console.log(`   ❌ Errors:   ${errors}`);

  return { imported, skipped, errors };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith("import-claude.mjs")) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.log(`
  📥 Claude Importer for MemVault

  Usage:
    node import-claude.mjs <path-to-export>
    node import-claude.mjs <path-to-export> --dry-run

  How to export from Claude:
    1. Go to claude.ai → Settings → Privacy
    2. Click "Export Data"
    3. Download the ZIP from your email
    4. Unzip and point this script at the folder
    `);
    process.exit(1);
  }

  const dryRun = process.argv.includes("--dry-run");
  importClaude(inputPath, { dryRun }).catch(console.error);
}

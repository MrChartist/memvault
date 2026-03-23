#!/usr/bin/env node
/**
 * import-chatgpt.mjs — Import ChatGPT Conversations into MemVault
 * ═══════════════════════════════════════════════════════════════════
 * Parses the `conversations.json` file from a ChatGPT data export.
 *
 * Usage:
 *   node import-chatgpt.mjs <path-to-conversations.json-or-export-folder>
 *
 * ChatGPT export structure:
 *   conversations.json → Array of conversation objects:
 *     { title, create_time, update_time, mapping: { nodeId: { message: { author: { role }, content: { parts } } } } }
 */

import fs from "fs";
import path from "path";
import { API_URL } from "./config.mjs";

// ─── Helpers ────────────────────────────────────────────────────────────────

function findConversationsFile(inputPath) {
  if (fs.statSync(inputPath).isFile()) {
    return inputPath;
  }
  // Look inside folder for conversations.json
  const candidates = [
    path.join(inputPath, "conversations.json"),
    path.join(inputPath, "chatgpt", "conversations.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function extractMessages(mapping) {
  if (!mapping) return [];

  const messages = [];
  for (const nodeId of Object.keys(mapping)) {
    const node = mapping[nodeId];
    const msg = node?.message;
    if (!msg || !msg.content?.parts) continue;

    const role = msg.author?.role || "unknown";
    const textParts = msg.content.parts
      .filter((p) => typeof p === "string")
      .join("\n");

    if (textParts.trim()) {
      messages.push({
        role,
        text: textParts.trim(),
        timestamp: msg.create_time
          ? new Date(msg.create_time * 1000).toISOString()
          : null,
      });
    }
  }

  // Sort by timestamp
  messages.sort((a, b) => {
    if (!a.timestamp || !b.timestamp) return 0;
    return new Date(a.timestamp) - new Date(b.timestamp);
  });

  return messages;
}

function formatConversation(conv) {
  const messages = extractMessages(conv.mapping);
  if (messages.length === 0) return null;

  const lines = [`# ${conv.title || "Untitled Conversation"}`, ""];

  for (const msg of messages) {
    const roleLabel =
      msg.role === "user" ? "👤 User" :
      msg.role === "assistant" ? "🤖 ChatGPT" :
      msg.role === "system" ? "⚙️ System" : `📎 ${msg.role}`;

    lines.push(`### ${roleLabel}`);
    lines.push(msg.text);
    lines.push("");
  }

  return {
    title: conv.title || "Untitled ChatGPT Conversation",
    content: lines.join("\n"),
    tags: ["import", "chatgpt", "conversation", "ai-history"].join(","),
    created_at: conv.create_time
      ? new Date(conv.create_time * 1000).toISOString()
      : new Date().toISOString(),
    messageCount: messages.length,
  };
}

// ─── Main Import ────────────────────────────────────────────────────────────

export async function importChatGPT(inputPath, options = {}) {
  const filePath = findConversationsFile(inputPath);
  if (!filePath) {
    console.error("❌ Could not find conversations.json in:", inputPath);
    return { imported: 0, skipped: 0, errors: 0 };
  }

  console.log(`📂 Reading: ${filePath}`);
  const raw = fs.readFileSync(filePath, "utf8");
  let conversations;

  try {
    conversations = JSON.parse(raw);
  } catch (e) {
    console.error("❌ Invalid JSON:", e.message);
    return { imported: 0, skipped: 0, errors: 0 };
  }

  if (!Array.isArray(conversations)) {
    console.error("❌ Expected an array of conversations");
    return { imported: 0, skipped: 0, errors: 0 };
  }

  console.log(`📊 Found ${conversations.length} ChatGPT conversations`);

  let imported = 0, skipped = 0, errors = 0;
  const dryRun = options.dryRun || false;

  for (const conv of conversations) {
    const formatted = formatConversation(conv);
    if (!formatted) {
      skipped++;
      continue;
    }

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
          source: "chatgpt-import",
          title: formatted.title,
          content: formatted.content,
          tags: formatted.tags,
        }),
      });
      const result = await res.json();
      if (result.ok) {
        imported++;
        if (imported % 10 === 0) {
          console.log(`  ✅ Imported ${imported} conversations...`);
        }
      } else {
        errors++;
      }
    } catch (e) {
      errors++;
      if (errors <= 3) console.error(`  ⚠️ Error: ${e.message}`);
    }
  }

  console.log(`\n🎉 ChatGPT Import Complete!`);
  console.log(`   ✅ Imported: ${imported}`);
  console.log(`   ⏭️  Skipped:  ${skipped} (empty conversations)`);
  if (errors) console.log(`   ❌ Errors:   ${errors}`);

  return { imported, skipped, errors };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith("import-chatgpt.mjs")) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.log(`
  📥 ChatGPT Importer for MemVault

  Usage:
    node import-chatgpt.mjs <path-to-export>
    node import-chatgpt.mjs <path-to-export> --dry-run

  How to export from ChatGPT:
    1. Go to chat.openai.com → Settings → Data Controls
    2. Click "Export Data" → Confirm
    3. Download the ZIP from your email
    4. Unzip and point this script at the folder

  Example:
    node import-chatgpt.mjs ~/Downloads/chatgpt-export/
    `);
    process.exit(1);
  }

  const dryRun = process.argv.includes("--dry-run");
  importChatGPT(inputPath, { dryRun }).catch(console.error);
}

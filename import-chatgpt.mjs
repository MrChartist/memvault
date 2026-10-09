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
import { importConversations } from "./import-lib.mjs";
import { isMainModule } from "./util.mjs";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * The export is either one `conversations.json` or — for larger accounts — numbered
 * shards (`conversations-000.json`, `conversations-001.json`, ...). Returns every file to read.
 */
export function findConversationFiles(inputPath) {
  if (fs.statSync(inputPath).isFile()) return [inputPath];

  for (const dir of [inputPath, path.join(inputPath, "chatgpt")]) {
    if (!fs.existsSync(dir)) continue;
    const single = path.join(dir, "conversations.json");
    if (fs.existsSync(single)) return [single];
    const shards = fs.readdirSync(dir).filter((f) => /^conversations-\d+\.json$/.test(f)).sort();
    if (shards.length) return shards.map((f) => path.join(dir, f));
  }
  return [];
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
  const filePaths = findConversationFiles(inputPath);
  if (filePaths.length === 0) {
    console.error("❌ Could not find conversations.json (or conversations-000.json ...) in:", inputPath);
    return { imported: 0, skipped: 0, errors: 0 };
  }

  console.log(`📂 Reading: ${filePaths.length === 1 ? filePaths[0] : `${filePaths.length} files (${path.basename(filePaths[0])} ...)`}`);
  const conversations = [];
  for (const filePath of filePaths) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      console.error(`❌ Invalid JSON in ${path.basename(filePath)}:`, e.message);
      return { imported: 0, skipped: 0, errors: 0 };
    }
    if (!Array.isArray(parsed)) {
      console.error(`❌ Expected an array of conversations in ${path.basename(filePath)}`);
      return { imported: 0, skipped: 0, errors: 0 };
    }
    conversations.push(...parsed);
  }

  console.log(`📊 Found ${conversations.length} ChatGPT conversations`);

  return importConversations(conversations.map(formatConversation), {
    label: "ChatGPT",
    source: "chatgpt-import",
    dryRun: options.dryRun || false,
  });
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
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

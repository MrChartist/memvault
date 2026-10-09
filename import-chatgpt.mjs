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
import { createIngestQueue } from "./ingest.mjs";
import { runImport, toIso } from "./import-common.mjs";

const queue = createIngestQueue({ actor: "chatgpt-import" });

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * The export is one `conversations.json`, or — for larger accounts — numbered shards
 * (`conversations-000.json`, `conversations-001.json`, ...). Returns every file to read.
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

/** The messages in the order the user actually saw them: from the first message to the one the chat ended on. */
function orderedNodes(conv) {
  const mapping = conv.mapping;
  if (!mapping || typeof mapping !== "object") return [];
  if (conv.current_node && mapping[conv.current_node]) {
    // Follow parent links from the last message back to the start. This leaves out answers the user
    // regenerated and abandoned, which are also stored in the mapping.
    const chain = [];
    const seen = new Set();
    let id = conv.current_node;
    while (id && mapping[id] && !seen.has(id)) { seen.add(id); chain.push(mapping[id]); id = mapping[id].parent; }
    return chain.reverse();
  }
  // No marker for the last message: keep export order, and let a message with no time follow the one before it.
  let last = 0;
  return Object.values(mapping)
    .map((node, index) => { const t = node?.message?.create_time; if (t) last = t; return { node, index, t: t || last }; })
    .sort((a, b) => a.t - b.t || a.index - b.index)
    .map((x) => x.node);
}

function extractMessages(conv) {
  const messages = [];
  for (const node of orderedNodes(conv)) {
    const msg = node?.message;
    if (!msg || !Array.isArray(msg.content?.parts)) continue;
    const role = msg.author?.role || "unknown";
    if (role === "tool") continue; // tool output is noise, not conversation
    const text = msg.content.parts
      .map((p) => (typeof p === "string" ? p : p && /image/i.test(p.content_type || "") ? "[image]" : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) messages.push({ role, text, timestamp: toIso(msg.create_time) });
  }
  return messages;
}

function formatConversation(conv) {
  if (!conv || typeof conv !== "object") return null;
  const messages = extractMessages(conv);
  if (messages.length === 0) return null;

  const lines = [`# ${conv.title || "Untitled ChatGPT Conversation"}`, ""];

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
    created_at: toIso(conv.create_time),
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

  const dryRun = options.dryRun || false;
  const { imported, skipped, duplicates, errors } = await runImport({
    source: "chatgpt-import", queue, items: conversations, format: formatConversation, dryRun,
  });
  if (!dryRun && errors === 0 && imported === 0 && duplicates === 0 && skipped === 0) console.log("Nothing found to import.");
  console.log(`\n🎉 ChatGPT Import Complete!`);
  console.log(`   ✅ Imported: ${imported}`);
  if (duplicates) console.log(`   ♻️  Already in your vault: ${duplicates} (not added again)`);
  console.log(`   ⏭️  Skipped:  ${skipped} (empty conversations)`);
  if (errors) console.log(`   ❌ Errors:   ${errors}`);

  return { imported, skipped, duplicates, errors };
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

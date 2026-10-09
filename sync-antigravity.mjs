#!/usr/bin/env node
/**
 * sync-antigravity.mjs   (OFF by default)
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads Antigravity conversation artifacts (walkthrough.md, task.md,
 * implementation_plan.md) from its "brain" directory and saves them to the vault.
 * Nothing is ever deleted: re-running updates each artifact in place.
 *
 * Default location: ~/.gemini/antigravity/brain   (on WSL the Windows-side
 * profile is detected automatically). Override with BRAIN_DIR / CONV_SUMMARY.
 *
 * Enable in sync-all with  "sync": { "antigravityEnabled": true }.
 *
 * Usage:
 *   node sync-antigravity.mjs
 *   node sync-antigravity.mjs --dry-run    (preview, nothing is saved)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import { candidateHomes, saveEntries, describeResult } from "./sync-lib.mjs";
import { isMainModule, resolveUserPath } from "./util.mjs";

const ARTIFACT_TYPES = [
  { file: "walkthrough.md", type: "worklog", label: "Walkthrough" },
  { file: "task.md", type: "worklog", label: "Task" },
  { file: "implementation_plan.md", type: "conversation", label: "Plan" },
];

function resolveLocations() {
  if (process.env.BRAIN_DIR) {
    return { brain: resolveUserPath(process.env.BRAIN_DIR), summaries: process.env.CONV_SUMMARY ? resolveUserPath(process.env.CONV_SUMMARY) : null };
  }
  for (const home of candidateHomes()) {
    const base = path.join(home, ".gemini", "antigravity");
    if (fs.existsSync(path.join(base, "brain"))) {
      return {
        brain: path.join(base, "brain"),
        summaries: process.env.CONV_SUMMARY || path.join(base, ".system_generated", "conversation_summaries.json"),
      };
    }
  }
  return { brain: null, summaries: null };
}

const readJsonSafe = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const readFileSafe = (f) => { try { return fs.readFileSync(f, "utf8").trim(); } catch { return null; } };

export async function main(args = process.argv.slice(2)) {
  const dryRun = args.includes("--dry-run");
  const { brain, summaries } = resolveLocations();

  if (!brain || !fs.existsSync(brain)) {
    console.log("ℹ️  Antigravity brain directory not found (looked in ~/.gemini/antigravity/brain). Set BRAIN_DIR to point at it.\n");
    return { inserted: 0, duplicates: 0 };
  }
  console.log(`🧠 Antigravity sync from ${brain}${dryRun ? " (dry run)" : ""}`);

  // Conversation summaries give nicer titles
  const convSummaries = {};
  const raw = summaries && fs.existsSync(summaries) ? readJsonSafe(summaries) : null;
  for (const conv of Array.isArray(raw) ? raw : Object.values(raw || {})) {
    const id = conv?.id || conv?.conversationId;
    if (id) convSummaries[id] = conv;
  }

  const folders = fs.readdirSync(brain, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9a-f-]{36}$/i.test(e.name));
  console.log(`📁 ${folders.length} conversation folders`);

  const entries = [];
  for (const folder of folders) {
    const convId = folder.name;
    const convDir = path.join(brain, convId);
    const meta = convSummaries[convId] || {};
    const convTitle = meta.title || meta.name || "Conversation";

    for (const art of ARTIFACT_TYPES) {
      const filePath = path.join(convDir, art.file);
      const content = readFileSafe(filePath);
      if (!content) continue;

      const artMeta = readJsonSafe(`${filePath}.metadata.json`) || {};
      const summary = artMeta.summary || "";
      entries.push({
        type: art.type,
        source: "antigravity",
        upsert: true, // the latest version of an artifact replaces the previous one
        title: `[${art.label}] ${convTitle} · ${convId.slice(0, 8)}`,
        content: (summary ? `${summary}\n\n---\n\n${content}` : content).slice(0, 8000),
        tags: `antigravity,${art.type},${art.label.toLowerCase()},conv:${convId.slice(0, 8)}`,
        created_at: artMeta.updatedAt || fs.statSync(filePath).mtime.toISOString(),
      });
    }
  }

  const result = saveEntries(entries, { dryRun });
  console.log(`✅ ${entries.length} artifacts — ${describeResult(result)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}

#!/usr/bin/env node
/**
 * import-wispr.mjs — Import Wispr Flow notes into MemVault
 * ═══════════════════════════════════════════════════════════════════════
 * Wispr Flow turns speech into text. This brings notes and meeting summaries you saved from it into the vault,
 * so MemVault can learn your vocabulary and how you phrase requests (see `memvault profile learn`) and your
 * AI apps can find what you said.
 *
 * Reads, from a file or a folder:
 *   • JSON: a list of records, or an object holding one (notes / meetings / items / transcripts / history / data);
 *   • Markdown or text files: one note per file.
 *
 * Each record's text comes from the first of: notes, summary, content, text, transcript, formatted_text, body,
 * content_excerpt. Its title comes from title / name, and its date from start / created_at / timestamp / date.
 *
 * Left out ON PURPOSE: attendee names and e-mail addresses, and share links (a share link opens the note for
 * anyone who has it). Secrets and ID numbers are masked as for every other import.
 *
 * Needs verification: the file the Wispr Flow app itself exports. Those field names are not confirmed here, which is
 * why unknown shapes are skipped and counted rather than guessed.
 *
 * Usage:
 *   node import-wispr.mjs <file-or-folder> [--dry-run]
 */

import fs from "fs";
import path from "path";
import { createIngestQueue } from "./ingest.mjs";
import { runImport, toIso } from "./import-common.mjs";
import { isMain } from "./is-main.mjs";

const SOURCE = "wispr";
const TEXT_FIELDS = ["notes", "summary", "content", "text", "transcript", "formatted_text", "body", "content_excerpt"];
const DATE_FIELDS = ["start", "created_at", "createdAt", "timestamp", "date", "modified_at"];
const LIST_FIELDS = ["notes", "meetings", "items", "transcripts", "history", "dictations", "data"];
const MAX_CHARS = 20000;
const MAX_FILES = 2000;

const asText = (v) => (typeof v === "string" ? v : "");

/** One record → the item to store, or null when there is nothing to keep. */
export function formatWisprRecord(rec) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  let text = "";
  for (const f of TEXT_FIELDS) {
    text = asText(rec[f]).trim();
    if (text) break;
  }
  if (text.length < 8 || /^(no meaningful audio|transcript too short)/i.test(text)) return null;
  text = text.slice(0, MAX_CHARS);

  const title = (asText(rec.title) || asText(rec.name)).trim() || text.replace(/\s+/g, " ").slice(0, 60);
  let created = null;
  for (const f of DATE_FIELDS) {
    created = toIso(rec[f]);
    if (created) break;
  }
  const meeting = Array.isArray(rec.attendees) || rec.start !== undefined;
  return {
    title: title.slice(0, 200),
    content: text,
    tags: ["import", SOURCE, meeting ? "meeting" : "dictation"].join(","),
    created_at: created,
  };
}

/** Every record found in one parsed JSON value. */
export function recordsFromJson(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const f of LIST_FIELDS) if (Array.isArray(data[f])) return data[f];
    return [data]; // a single note
  }
  return [];
}

/** Read a file or folder into a list of raw records. Unreadable files are reported, never fatal. */
export function readRecords(inputPath) {
  const files = [];
  const st = fs.statSync(inputPath);
  if (st.isFile()) files.push(inputPath);
  else {
    const walk = (dir, depth) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (files.length >= MAX_FILES) return;
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 2 && !e.name.startsWith(".") && e.name !== "node_modules") walk(p, depth + 1);
        else if (e.isFile() && /\.(json|md|markdown|txt)$/i.test(e.name)) files.push(p);
      }
    };
    walk(inputPath, 0);
  }
  const records = [];
  const problems = [];
  for (const f of files) {
    try {
      if (/\.json$/i.test(f)) {
        records.push(...recordsFromJson(JSON.parse(fs.readFileSync(f, "utf8"))));
      } else {
        const stat = fs.statSync(f);
        if (stat.size > 2_000_000) { problems.push(`${path.basename(f)}: too large`); continue; }
        records.push({ title: path.basename(f).replace(/\.[^.]+$/, ""), content: fs.readFileSync(f, "utf8"), created_at: stat.mtime.toISOString() });
      }
    } catch (e) {
      problems.push(`${path.basename(f)}: ${e.message}`);
    }
  }
  return { records, problems, files: files.length };
}

export async function importWispr(inputPath, { dryRun = false } = {}) {
  let found;
  try {
    found = readRecords(inputPath);
  } catch (e) {
    console.error(`❌ Could not read ${inputPath}: ${e.message}`);
    return { imported: 0, skipped: 0, duplicates: 0, errors: 1 };
  }
  console.log(`📂 Read ${found.files} file(s), ${found.records.length} record(s)`);
  for (const p of found.problems.slice(0, 5)) console.error(`  ⚠️ ${p}`);
  const queue = createIngestQueue({ actor: "wispr-import" });
  const r = await runImport({ source: SOURCE, queue, items: found.records, format: formatWisprRecord, dryRun });
  console.log(`\n🎙️  Wispr import complete`);
  console.log(`   ✅ Imported: ${r.imported}`);
  if (r.duplicates) console.log(`   ♻️  Already in your vault: ${r.duplicates} (not added again)`);
  console.log(`   ⏭️  Skipped (empty, too short or an unknown shape): ${r.skipped}`);
  if (r.errors) console.log(`   ❌ Errors: ${r.errors}`);
  if (!dryRun && r.imported) console.log(`\nNext: memvault profile learn      (preview what MemVault can learn from your dictation)`);
  return { ...r, problems: found.problems.length };
}

if (isMain(import.meta.url)) {
  const input = process.argv[2];
  if (!input || input.startsWith("--")) {
    console.log(`
  🎙️  Wispr Flow importer for MemVault

  Usage:
    node import-wispr.mjs <file-or-folder>
    node import-wispr.mjs <file-or-folder> --dry-run

  Accepts JSON (a list of notes or meetings) and Markdown or text files.
  Attendee names, e-mail addresses and share links are not imported.
`);
    process.exit(1);
  }
  importWispr(input, { dryRun: process.argv.includes("--dry-run") })
    .then((r) => process.exit(r.errors ? 1 : 0))
    .catch((e) => { console.error(e.message); process.exit(1); });
}

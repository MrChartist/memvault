#!/usr/bin/env node
/**
 * vault.mjs — tiny CLI for adding to and searching the vault from a terminal.
 *
 *   memvault vault diary "text..."
 *   memvault vault convo "<source>" "<title>" "<content...>"
 *   memvault vault worklog "<title>" "<content...>" "<tags(optional)>"
 *   memvault vault search "<query>"
 */
import fs from "fs";
import path from "path";
import { VAULT_ROOT } from "./config.mjs";
import { addItems, searchItems } from "./db.mjs";
import { isoDate } from "./util.mjs";

function usage() {
  console.log(`
Usage:
  memvault vault diary "text..."
  memvault vault convo "<source>" "<title>" "<content...>"
  memvault vault worklog "<title>" "<content...>" "<tags(optional)>"
  memvault vault search "<query>"

Vault location: ${VAULT_ROOT}   (override with VAULT_ROOT or ~/.memvaultrc.json)
`);
  process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) usage();

if (cmd === "diary") {
  const text = args.join(" ").trim();
  if (!text) usage();

  const day = isoDate();
  const dir = path.join(VAULT_ROOT, "entries", day.slice(0, 4), day.slice(5, 7));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${day}.md`);
  fs.appendFileSync(file, `\n## ${new Date().toISOString()}\n${text}\n`);

  addItems([{ type: "diary", source: "manual", title: `Diary ${day}`, content: text, file_path: file, tags: "diary" }]);
  console.log(`OK: wrote diary -> ${file}`);
} else if (cmd === "convo") {
  const [source, title, ...rest] = args;
  const content = rest.join(" ").trim();
  if (!source || !title || !content) usage();
  addItems([{ type: "conversation", source, title, content, tags: `conversation,${source}` }]);
  console.log("OK: conversation saved");
} else if (cmd === "worklog") {
  const [title, content, tags] = args;
  if (!title || !content) usage();
  addItems([{ type: "worklog", source: "manual", title, content, tags: tags || "worklog" }]);
  console.log("OK: worklog saved");
} else if (cmd === "search") {
  const query = args.join(" ").trim();
  if (!query) usage();
  const rows = searchItems({ terms: [query], limit: 10, snippet: 160 });
  if (rows.length === 0) console.log("No results.");
  for (const r of rows) {
    console.log(`\n[${r.type}] ${r.title || "Untitled"}  (${r.created_at?.slice(0, 10)})\n  ${(r.snippet || "").replace(/\s+/g, " ")}`);
  }
} else {
  usage();
}

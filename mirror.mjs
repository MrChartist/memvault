/**
 * mirror.mjs — the readable Markdown copy kept for notes saved by an AI app.
 *
 * Each copy carries its memory's id in the file name, so that when the memory is deleted or edited its
 * copy is removed or rewritten too (deleting a note while leaving its words on disk is not deleting it).
 * Copies written by earlier versions have no id in the name; they are found by their title and time.
 * Only the masked text is ever written here (callers pass the item as it was stored).
 */
import fs from "fs";
import path from "path";

const DIRS = { diary: "entries", conversation: "conversations", worklog: "worklogs" };
const ALL_DIRS = Object.values(DIRS);
const idTail = (id) => String(id).split("_").pop();
const safeTitle = (t) => String(t || "").normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "note";

function body(i) {
  return `# ${i.title}\n\n${i.content ?? ""}\n\n---\nSource: ${i.source ?? ""}\nTags: ${i.tags ?? ""}\nCreated: ${i.created_at}\n`;
}

/** Write the copy; returns its path. */
export function writeMirror(root, item) {
  const dir = path.join(root, DIRS[item.type] || "entries", String(item.created_at).slice(0, 4), String(item.created_at).slice(5, 7));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(item.created_at).slice(0, 10)}_${safeTitle(item.title)}_${idTail(item.id)}.md`);
  fs.writeFileSync(file, body(item), { mode: 0o600 });
  return file;
}

function* markdownFiles(root) {
  for (const d of ALL_DIRS) {
    const base = path.join(root, d);
    if (!fs.existsSync(base)) continue;
    let names;
    try { names = fs.readdirSync(base, { recursive: true }); } catch { continue; }
    for (const n of names) if (String(n).endsWith(".md")) yield path.join(base, String(n));
  }
}

/** Remove the copies of these memories ({ id, title, created_at }). Returns how many files were removed. */
export function removeMirrors(root, items) {
  if (!items.length) return 0;
  const tails = new Set(items.map((i) => `_${idTail(i.id)}.md`));
  const legacy = new Set(items.map((i) => `# ${i.title}\n\n\u0000${i.created_at}`));
  let removed = 0;
  for (const f of markdownFiles(root)) {
    let hit = [...tails].some((t) => f.endsWith(t));
    if (!hit) {
      try {
        const text = fs.readFileSync(f, "utf8");
        const title = text.split("\n", 1)[0];
        const created = /\nCreated: ([^\n]+)\n?$/.exec(text)?.[1];
        hit = created !== undefined && legacy.has(`${title}\n\n\u0000${created}`);
      } catch { /* unreadable: leave it */ }
    }
    if (hit) { try { fs.rmSync(f, { force: true }); removed++; } catch { /* ignore */ } }
  }
  return removed;
}

/** Remove every copy (used by "delete everything"). */
export function removeAllMirrors(root) {
  let removed = 0;
  for (const f of [...markdownFiles(root)]) { try { fs.rmSync(f, { force: true }); removed++; } catch { /* ignore */ } }
  return removed;
}

/** If this memory has a copy, rewrite it with the new text. Returns true if one existed. */
export function updateMirror(root, item) {
  for (const f of markdownFiles(root)) {
    if (f.endsWith(`_${idTail(item.id)}.md`)) { fs.writeFileSync(f, body(item), { mode: 0o600 }); return true; }
  }
  return false;
}

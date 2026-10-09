/**
 * import-common.mjs — the loop every chat importer shares.
 *   • keeps the conversation's own date (not the day you imported it)
 *   • skips conversations that are already in the vault, so running an import twice adds nothing
 *   • one broken record is counted and skipped; it never loses the good ones before it
 *   • always writes what it has collected, even after an error
 * Everything still goes through ingest (mask → atomic write → audit).
 */
import crypto from "crypto";
import { getVaultDb } from "./db.mjs";

/** Accepts epoch seconds/milliseconds or a date string. Returns an ISO string, or null if missing or nonsense. */
export function toIso(v) {
  if (v === null || v === undefined || v === "") return null;
  const d = typeof v === "number" ? new Date(v < 1e11 ? v * 1000 : v) : new Date(v);
  const t = d.getTime();
  return Number.isNaN(t) || t <= 0 ? null : d.toISOString();
}

/** A short fingerprint of one conversation: same export → same key. Stored as an `imp:` tag. */
export const importKey = (source, createdAt, title, content) =>
  "imp:" + crypto.createHash("sha1").update([source, createdAt || "undated", title, content].join("\u241f")).digest("hex").slice(0, 16);

function storedKeys(source) {
  const keys = new Set();
  for (const r of getVaultDb().query("SELECT tags FROM items WHERE source = ?", [source])) {
    for (const t of String(r.tags || "").split(",")) if (t.startsWith("imp:")) keys.add(t);
  }
  return keys;
}

/**
 * @param {object}   o
 * @param {string}   o.source   e.g. "chatgpt-import"
 * @param {object}   o.queue    from createIngestQueue()
 * @param {Array}    o.items    the records in the export
 * @param {Function} o.format   record → { title, content, tags, created_at|null, messageCount? } or null to skip
 * @param {boolean}  [o.dryRun]
 */
export async function runImport({ source, queue, items, format, dryRun = false, every = 10 }) {
  const have = dryRun ? new Set() : storedKeys(source);
  let imported = 0, skipped = 0, duplicates = 0, errors = 0;
  try {
    for (const item of items) {
      try {
        if (item === null || typeof item !== "object") { skipped++; continue; }
        const f = format(item);
        if (!f) { skipped++; continue; }
        const key = importKey(source, f.created_at, f.title, f.content);
        if (have.has(key)) { duplicates++; continue; }
        if (dryRun) {
          console.log(`  📝 [DRY RUN] "${f.title.slice(0, 60)}"${f.messageCount ? ` (${f.messageCount} messages)` : ""}`);
          imported++;
          continue;
        }
        queue.add({ type: "conversation", source, title: f.title, content: f.content, tags: `${f.tags},${key}`, created_at: f.created_at || undefined });
        have.add(key);
        imported++;
        if (imported % every === 0) console.log(`  ✅ Collected ${imported}...`);
      } catch (e) {
        errors++;
        if (errors <= 3) console.error(`  ⚠️ Skipped one item: ${e.message}`);
      }
    }
  } finally {
    if (!dryRun) queue.done();
  }
  return { imported, skipped, duplicates, errors };
}

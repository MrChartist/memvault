/**
 * import-lib.mjs — shared bookkeeping for the AI-export importers
 * ─────────────────────────────────────────────────────────────────────────────
 * Each importer turns an export file into vault entries; this module saves
 * them. Because every imported conversation carries its original timestamp,
 * importing the same export twice adds nothing new.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { saveEntries } from "./sync-lib.mjs";

/**
 * @param {object[]} formatted  output of an importer's format function (null = skipped)
 * @param {object}   o
 * @param {string}   o.label    "ChatGPT", "Claude", ...
 * @param {string}   o.source   vault `source` value, e.g. "chatgpt-import"
 * @param {boolean} [o.dryRun]
 * @returns {{imported:number, skipped:number, errors:number, duplicates:number}}
 */
export function importConversations(formatted, { label, source, dryRun = false }) {
  const skipped = formatted.filter((f) => !f).length;
  const entries = formatted.filter(Boolean).map((f) => ({
    type: "conversation",
    source,
    title: f.title,
    content: f.content,
    tags: f.tags,
    created_at: f.created_at, // keeps the original date and makes re-imports idempotent
  }));

  if (dryRun) {
    for (const f of formatted.filter(Boolean)) {
      console.log(`  📝 [DRY RUN] "${f.title.slice(0, 60)}"${f.messageCount ? ` (${f.messageCount} messages)` : ""}`);
    }
    return { imported: entries.length, skipped, errors: 0, duplicates: 0 };
  }

  let imported = 0;
  let duplicates = 0;
  let errors = 0;
  const CHUNK = 50;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    try {
      const r = saveEntries(chunk);
      imported += r.inserted;
      duplicates += r.duplicates;
    } catch (e) {
      errors += chunk.length;
      if (errors <= CHUNK) console.error(`  ⚠️ Error: ${e.message}`);
    }
    if ((i / CHUNK) % 4 === 3) console.log(`  … ${Math.min(i + CHUNK, entries.length)}/${entries.length}`);
  }

  console.log(`\n🎉 ${label} import complete`);
  console.log(`   ✅ New:        ${imported}`);
  if (duplicates) console.log(`   ♻️  Already in vault: ${duplicates}`);
  console.log(`   ⏭️  Skipped:    ${skipped} (empty)`);
  if (errors) console.log(`   ❌ Errors:     ${errors}`);

  return { imported, skipped, errors, duplicates };
}

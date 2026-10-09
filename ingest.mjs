/**
 * ingest.mjs — the one door into the vault
 * ═══════════════════════════════════════════════════════════════════════════════
 * Every way of adding memory — the web API, MCP tools, importers, sync engines,
 * MCP bridges, the CLI — goes through here, so every one of them gets the same
 * treatment:   redact secrets  →  ONE atomic batched write  →  audit record.
 *
 * Scripts write straight to the database (db.mjs is safe for many processes), so
 * they no longer need the web server running or an API token, and a batch of N
 * items costs one database rewrite instead of N.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { VAULT_ROOT, SECURITY_CONFIG } from "./config.mjs";
import { getVaultDb } from "./db.mjs";
import { redactItem, summarizeFindings } from "./redact.mjs";
import { audit } from "./audit.mjs";

function mergeFindings(into, findings) {
  for (const f of findings) into.set(f.type, (into.get(f.type) || 0) + f.count);
}

const toList = (m) => [...m].map(([type, count]) => ({ type, count }));

/**
 * Store one item or many in a single atomic write.
 * @param {object|object[]} items  { type, source?, title?, content?, tags?, created_at?, agent_id?, scope? }
 * @param {object} [opts]
 * @param {object} [opts.vdb]      database handle (default: this process's owner handle)
 * @param {string} [opts.actor]    who is writing, for the audit log
 * @returns {{ ids: string[], items: object[], redacted: Array<{type:string,count:number}> }}
 *          `items` are the items AS STORED (secrets already masked). Anything that
 *          mirrors an entry to a flat file must write from `items`, never from the
 *          original input, or the mirror would leak what the database does not.
 */
/** A usable timestamp as ISO text, or undefined (the database then uses "now"). Nothing odd is stored. */
export function cleanDate(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) return undefined;
  const d = new Date(t);
  if (d.getUTCFullYear() < 1990 || d.getTime() > Date.now() + 86400000) return undefined; // before the web, or in the future
  return d.toISOString();
}

export function ingest(items, { vdb = getVaultDb(), actor = "api", security = SECURITY_CONFIG, root = VAULT_ROOT } = {}) {
  const list = Array.isArray(items) ? items : [items];
  if (list.length === 0) return { ids: [], items: [], redacted: [] };

  const totals = new Map();
  const prepared =
    security.redact === false
      ? list
      : list.map((it) => {
          const r = redactItem(it, { disable: security.redactDisable });
          mergeFindings(totals, r.findings);
          return r.item;
        });

  for (const it of prepared) it.created_at = cleanDate(it.created_at);
  const ids = vdb.addItems(prepared);

  if (security.audit !== false) {
    // From the masked items: the audit log must never hold what the database masked.
    const sources = [...new Set(prepared.map((i) => i.source).filter(Boolean))];
    audit(
      {
        actor,
        action: list.length > 1 ? "add-many" : "add",
        detail: { count: ids.length, type: list[0].type, sources, redacted: summarizeFindings(toList(totals)) },
      },
      root
    );
  }
  return { ids, items: prepared, redacted: toList(totals) };
}

/**
 * Collect items and write them in batches. Use in loops:
 *     const q = createIngestQueue({ actor: "git" });
 *     for (...) q.add(entry);
 *     const { stored } = q.flush();
 * add() never touches the disk until a batch is full; flush() writes the rest.
 */
export function createIngestQueue({ batchSize = 200, actor = "sync", ...opts } = {}) {
  let buf = [];
  let stored = 0;
  const redacted = new Map();

  const write = () => {
    if (!buf.length) return;
    const batch = buf;
    buf = [];
    const r = ingest(batch, { actor, ...opts });
    stored += r.ids.length;
    mergeFindings(redacted, r.redacted);
  };

  return {
    add(entry) {
      buf.push(entry);
      if (buf.length >= batchSize) write();
      return true;
    },
    flush() {
      write();
      return { stored, redacted: toList(redacted) };
    },
    /** flush() and tell the user (CLI scripts) if any secrets were masked on the way in. */
    done() {
      const r = this.flush();
      if (r.redacted.length) console.log(`🔒 Masked before storing: ${summarizeFindings(r.redacted)}`);
      return r;
    },
  };
}

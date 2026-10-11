// vault.mjs — add entries to your MemVault from the command line (no server needed)
import { VAULT_ROOT } from "./config.mjs";
import { ingest } from "./ingest.mjs";
import { writeMirror } from "./mirror.mjs";
function isoDate() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

function usage() {
    console.log(`
Usage:
  memvault vault diary "text..."
  memvault vault convo "<source>" "<title>" "<content...>"
  memvault vault worklog "<title>" "<content...>" "<tags(optional)>"

To search, use the dashboard (memvault open) or ask your AI app.

Env:
  VAULT_ROOT=/path/to/vault/data    (default: ~/.memvault/data)
`);
    process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) usage();

if (cmd === "diary") {
    const text = args.join(" ").trim();
    if (!text) usage();

    const day = isoDate();
    const created_at = new Date().toISOString();
    const { ids, items } = ingest({
        type: "diary",
        source: "manual",
        title: `Diary ${day}`,
        content: text,
        tags: "diary",
        created_at,
    }, { actor: "cli" });

    // Mirror what was STORED (secrets masked), never the raw input, in a file named with the memory's id
    // so deleting or editing the memory also removes or rewrites it.
    const file = writeMirror(VAULT_ROOT, { ...items[0], id: ids[0], created_at });

    console.log(`OK: wrote diary -> ${file}`);
    process.exit(0);
}

if (cmd === "convo") {
    const [source, title, ...rest] = args;
    const content = rest.join(" ").trim();
    if (!source || !title || !content) usage();

    ingest({
        type: "conversation",
        source,
        title,
        content,
        tags: `conversation,${source}`,
    }, { actor: "cli" });

    console.log("OK: conversation saved");
    process.exit(0);
}

if (cmd === "worklog") {
    const [title, content, tags] = args;
    if (!title || !content) usage();

    ingest({
        type: "worklog",
        source: "antigravity",
        title,
        content,
        tags: tags || "worklog",
    }, { actor: "cli" });

    console.log("OK: worklog saved");
    process.exit(0);
}

usage();

// /mnt/d/AG/Vault/apps/vault/vault.mjs
import fs from "fs";
import path from "path";
import { VAULT_ROOT, API_URL as API } from "./config.mjs";
function isoDate() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

async function postJson(url, body) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

function usage() {
    console.log(`
Usage:
  node vault.mjs diary "text..."
  node vault.mjs convo "<source>" "<title>" "<content...>"
  node vault.mjs worklog "<title>" "<content...>" "<tags(optional)>"

Env:
  VAULT_ROOT=/mnt/d/AG/Vault
  VAULT_API=http://127.0.0.1:7799
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
    const stamp = new Date().toISOString();
    fs.appendFileSync(file, `\n## ${stamp}\n${text}\n`);

    await postJson(`${API}/add`, {
        type: "diary",
        source: "manual",
        title: `Diary ${day}`,
        content: text,
        file_path: file,
        tags: "diary",
    });

    console.log(`OK: wrote diary -> ${file}`);
    process.exit(0);
}

if (cmd === "convo") {
    const [source, title, ...rest] = args;
    const content = rest.join(" ").trim();
    if (!source || !title || !content) usage();

    await postJson(`${API}/add`, {
        type: "conversation",
        source,
        title,
        content,
        tags: `conversation,${source}`,
    });

    console.log("OK: conversation saved");
    process.exit(0);
}

if (cmd === "worklog") {
    const [title, content, tags] = args;
    if (!title || !content) usage();

    await postJson(`${API}/add`, {
        type: "worklog",
        source: "antigravity",
        title,
        content,
        tags: tags || "worklog",
    });

    console.log("OK: worklog saved");
    process.exit(0);
}

usage();

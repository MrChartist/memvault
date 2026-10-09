#!/usr/bin/env node
/**
 * sync-clipboard.mjs — MemVault Clipboard Capture   (OFF by default)
 * ─────────────────────────────────────────────────────────────────────────────
 * Polls the clipboard and saves interesting text to the vault. Runs as a
 * background daemon, so it is never started automatically by `memvault sync`.
 *
 * The clipboard is where passwords and tokens pass through, so anything that
 * looks like a secret (API keys, private keys, JWTs, card numbers, long
 * random-looking strings, "password=..." lines) is skipped and never stored.
 * This filter is best-effort — keep the daemon off while handling secrets.
 *
 * Needs: Windows (PowerShell), macOS (pbpaste) or Linux (wl-paste, xclip or xsel).
 *
 * Usage:
 *   node sync-clipboard.mjs              (start capturing, default 10s interval)
 *   node sync-clipboard.mjs --interval 5 (capture every 5 seconds)
 *   node sync-clipboard.mjs --once       (capture once and exit)
 *   node sync-clipboard.mjs --dry-run    (preview, nothing is saved)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { execFileSync } from "child_process";
import crypto from "crypto";
import { flagNumber, saveEntries } from "./sync-lib.mjs";
import { isMainModule } from "./util.mjs";

const MIN_LENGTH = 20;   // skip tiny copies
const MAX_LENGTH = 5000; // skip huge pastes

// ─── Sensitive-content filter ───────────────────────────────────────────────

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,                       // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,             // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,                  // OpenAI / Anthropic style keys
  /\bAIza[0-9A-Za-z_-]{30,}\b/,                 // Google API key
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,           // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./, // JWT
  /\b(pass(word|wd)?|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*\S{6,}/i,
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/i,
];

function luhnValid(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Best-effort check: does this text look like a credential or other secret? */
export function looksSensitive(text) {
  if (SECRET_PATTERNS.some((re) => re.test(text))) return true;

  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true; // payment card
  }

  // A single long token with no spaces that is not a URL or path is probably a key/hash.
  const t = text.trim();
  if (!/\s/.test(t) && t.length >= 24 && !/^(https?:|www\.)/i.test(t) && !/[\\/]/.test(t) && /[A-Za-z]/.test(t) && /\d/.test(t)) {
    return true;
  }
  return false;
}

// ─── Clipboard access ───────────────────────────────────────────────────────

const LINUX_READERS = [
  ["wl-paste", ["--no-newline"]],
  ["xclip", ["-selection", "clipboard", "-o"]],
  ["xsel", ["--clipboard", "--output"]],
];
let linuxReader = null; // remember which one works

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
}

export function getClipboard() {
  try {
    if (process.platform === "win32") return run("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]).trim();
    if (process.platform === "darwin") return run("pbpaste", []).trim();

    if (linuxReader) return run(...linuxReader).trim();
    for (const reader of LINUX_READERS) {
      try {
        const out = run(...reader).trim();
        linuxReader = reader;
        return out;
      } catch { /* try the next tool */ }
    }
    return "";
  } catch {
    return "";
  }
}

// ─── Classification ─────────────────────────────────────────────────────────

export function classifyContent(text) {
  if (/^(https?:\/\/|www\.)/i.test(text)) return { type: "url", tags: "clipboard,url" };
  if (/^(import |const |let |var |function |class |def |from )/m.test(text)) return { type: "code", tags: "clipboard,code" };
  if (/\{[\s\S]*\}/.test(text) && text.includes(":")) return { type: "json", tags: "clipboard,json,data" };
  if (/\.(js|ts|py|mjs|css|html|json|md)\b/.test(text)) return { type: "path", tags: "clipboard,path" };
  if (text.split("\n").length > 3) return { type: "multiline", tags: "clipboard,text,long" };
  return { type: "text", tags: "clipboard,text" };
}

const TITLE_PREFIX = {
  url: "🔗 URL", code: "💻 Code Snippet", json: "📋 JSON Data",
  path: "📁 File Path", multiline: "📝 Text Block", text: "📋 Clipboard",
};

function generateTitle(text, classification) {
  const preview = text.replace(/\s+/g, " ").slice(0, 60);
  return `${TITLE_PREFIX[classification.type] || "📋 Clipboard"}: ${preview}${text.length > 60 ? "..." : ""}`;
}

// ─── Capture ────────────────────────────────────────────────────────────────

const seenHashes = new Set();
let captureCount = 0;

export function captureClipboard({ dryRun = false } = {}) {
  const text = getClipboard();
  if (!text || text.length < MIN_LENGTH || text.length > MAX_LENGTH) return false;

  const hash = crypto.createHash("sha1").update(text).digest("hex");
  if (seenHashes.has(hash)) return false;
  seenHashes.add(hash);
  if (seenHashes.size > 500) for (const h of [...seenHashes].slice(0, 100)) seenHashes.delete(h);

  if (looksSensitive(text)) return false; // never store likely secrets

  const classification = classifyContent(text);
  const title = generateTitle(text, classification);
  saveEntries([{ type: "diary", source: "clipboard", title, content: text, tags: classification.tags }], { dryRun });

  captureCount++;
  console.log(`  ✅ [${new Date().toLocaleTimeString("en-IN")}] Captured: ${title.slice(0, 70)}`);
  return true;
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function main(args = process.argv.slice(2)) {
  const dryRun = args.includes("--dry-run");
  const once = args.includes("--once");
  const intervalSec = flagNumber(args, "--interval", 10);

  captureClipboard({ dryRun });
  if (once) {
    console.log(`Done. Captured: ${captureCount} entries.`);
    return;
  }

  console.log(`📋 Monitoring clipboard every ${intervalSec}s... (Ctrl+C to stop)\n`);
  setInterval(() => captureClipboard({ dryRun }), intervalSec * 1000);
  process.on("SIGINT", () => {
    console.log(`\n✅ Total captured: ${captureCount} entries`);
    process.exit(0);
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}

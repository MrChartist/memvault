#!/usr/bin/env node
/**
 * sync-clipboard.mjs — MemVault Clipboard Capture
 * ─────────────────────────────────────────────────────────────────────────────
 * Captures clipboard content periodically and saves interesting content to vault.
 * Runs as a background polling daemon.
 *
 * Usage:
 *   node sync-clipboard.mjs              (start capturing, default 10s interval)
 *   node sync-clipboard.mjs --interval 5 (capture every 5 seconds)
 *   node sync-clipboard.mjs --once       (capture once and exit)
 *   node sync-clipboard.mjs --dry-run    (preview, no posts)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { execSync } from "child_process";
import crypto from "crypto";

import { API_URL as API } from "./config.mjs";
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONCE = args.includes("--once");

const intervalIdx = args.indexOf("--interval");
const INTERVAL_SEC = intervalIdx !== -1 ? Number(args[intervalIdx + 1]) || 10 : 10;

// Minimum content length to save (skip tiny copies)
const MIN_LENGTH = 20;
// Maximum content length to save
const MAX_LENGTH = 5000;

// Track seen content to avoid duplicates
const seenHashes = new Set();
let captureCount = 0;

// ─── Helpers ────────────────────────────────────────────────────────────────

function getClipboard() {
  try {
    if (process.platform === "win32") {
      return execSync("powershell -command Get-Clipboard", {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } else if (process.platform === "darwin") {
      return execSync("pbpaste", { encoding: "utf8", timeout: 5000 }).trim();
    } else {
      return execSync("xclip -selection clipboard -o", { encoding: "utf8", timeout: 5000 }).trim();
    }
  } catch {
    return "";
  }
}

function hashContent(text) {
  return crypto.createHash("md5").update(text).digest("hex");
}

function classifyContent(text) {
  // Detect content type
  if (/^(https?:\/\/|www\.)/i.test(text)) return { type: "url", tags: "clipboard,url" };
  if (/^(import |const |let |var |function |class |def |from )/m.test(text)) return { type: "code", tags: "clipboard,code" };
  if (/\{[\s\S]*\}/.test(text) && text.includes(":")) return { type: "json", tags: "clipboard,json,data" };
  if (/^[A-Za-z0-9+/=]{20,}$/.test(text.replace(/\s/g, ""))) return { type: "encoded", tags: "clipboard,encoded" };
  if (/\.(js|ts|py|mjs|css|html|json|md)/.test(text)) return { type: "path", tags: "clipboard,path" };
  if (text.split("\n").length > 3) return { type: "multiline", tags: "clipboard,text,long" };
  return { type: "text", tags: "clipboard,text" };
}

function generateTitle(text, classification) {
  const prefix = {
    url: "🔗 URL",
    code: "💻 Code Snippet",
    json: "📋 JSON Data",
    encoded: "🔐 Encoded Data",
    path: "📁 File Path",
    multiline: "📝 Text Block",
    text: "📋 Clipboard",
  }[classification.type] || "📋 Clipboard";

  const preview = text.replace(/\n/g, " ").slice(0, 60);
  return `${prefix}: ${preview}${text.length > 60 ? "..." : ""}`;
}

async function postToVault(entry) {
  if (DRY_RUN) {
    console.log(`  [DRY] ${entry.title}`);
    return true;
  }
  try {
    const res = await fetch(`${API}/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    });
    return (await res.json()).ok;
  } catch { return false; }
}

// ─── Capture ────────────────────────────────────────────────────────────────

async function captureClipboard() {
  const text = getClipboard();

  // Skip empty, too short, or too long
  if (!text || text.length < MIN_LENGTH || text.length > MAX_LENGTH) return;

  // Skip duplicates
  const hash = hashContent(text);
  if (seenHashes.has(hash)) return;
  seenHashes.add(hash);

  // Keep set bounded (max 500 recent entries)
  if (seenHashes.size > 500) {
    const arr = [...seenHashes];
    for (let i = 0; i < 100; i++) seenHashes.delete(arr[i]);
  }

  const classification = classifyContent(text);
  const title = generateTitle(text, classification);

  const synced = await postToVault({
    type: "diary",
    source: "clipboard",
    title,
    content: text.slice(0, MAX_LENGTH),
    tags: classification.tags,
  });

  if (synced) {
    captureCount++;
    const time = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    console.log(`  ✅ [${time}] Captured: ${title.slice(0, 70)}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  Clipboard → MemVault Sync           ║");
  console.log(`║  Interval: ${String(INTERVAL_SEC).padEnd(3)}s | ${DRY_RUN ? "DRY RUN" : (ONCE ? "ONCE   " : "LIVE   ")}              ║`);
  console.log("╚══════════════════════════════════════╝\n");

  if (!DRY_RUN) {
    try {
      const h = await fetch(`${API}/health`);
      if (!h.ok) throw new Error();
      console.log("✅ Vault API reachable\n");
    } catch {
      console.error("❌ Vault API not reachable at", API);
      process.exit(1);
    }
  }

  if (ONCE) {
    await captureClipboard();
    console.log(`\nDone. Captured: ${captureCount} entries.`);
    return;
  }

  console.log(`📋 Monitoring clipboard every ${INTERVAL_SEC}s... (Ctrl+C to stop)\n`);

  // Initial capture
  await captureClipboard();

  // Poll
  setInterval(captureClipboard, INTERVAL_SEC * 1000);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log(`\n\n═══════════════════════════════════════`);
    console.log(`✅ Total captured: ${captureCount} entries`);
    console.log(`═══════════════════════════════════════\n`);
    process.exit(0);
  });
}

main().catch(console.error);

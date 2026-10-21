#!/usr/bin/env node
/**
 * device-sync.mjs — one memory on all your computers
 * ═══════════════════════════════════════════════════════════════════════════════
 * Each computer keeps its own vault, so everything still works offline. In a folder that you share between
 * your computers (Syncthing, iCloud Drive, Dropbox, OneDrive, Google Drive, or a folder on your own server),
 * each one writes ONE file of its own:  memvault-<device id>.mvsync
 *
 *   • The file is a full picture of that computer's memories, agents and deletions, encrypted with your
 *     sync passphrase (AES-256-GCM, scrypt), so whoever stores the folder sees only scrambled bytes.
 *   • Every computer reads the others' files and merges them into its own vault:
 *       the newest change to a memory wins, and a deletion wins over any older change.
 *   • A computer only ever writes its own file, so two of them never write the same file at once and the
 *     sharing tool has no conflicts to resolve.
 *   • What comes in is masked for secrets, written in one atomic step and recorded in the access log, like
 *     every other write. A merge that would delete many memories takes a local backup first.
 *
 * Not synced: the Secure Vault (each computer keeps its own, under its own master password), uploaded files,
 * the access log, and this computer's settings.
 *
 *   memvault devices                  what is set up, and the other computers seen
 *   memvault devices setup --folder <path> [--name "MacBook"]
 *   memvault devices passphrase       set the sync passphrase (the same on every computer)
 *   memvault devices sync             sync now
 *   memvault devices name "<name>"    rename this computer
 *   memvault devices off              stop syncing (your memories stay)
 *   memvault devices hub --address https://my-server.tailnet.ts.net
 *                                     let phones open this dashboard through a private address
 *   memvault devices pair [--name "iPhone"]   a one-time code to sign a phone or tablet in
 *   memvault devices keys | forget <id>       phones and tablets that can open this dashboard
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import crypto from "crypto";
import { VAULT_ROOT, TOKEN_FILE, SECURITY_CONFIG, loadUserConfig, saveUserConfig } from "./config.mjs";
import { resolveUserPath, expandHome } from "./paths.mjs";
import { encryptBuffer, decryptBuffer, isEncryptedBackup, MIN_PASSPHRASE_LENGTH } from "./crypto-vault.mjs";
import { redactItem } from "./redact.mjs";
import { normalizeProfile } from "./agents.mjs";
import { removeMirrors, updateMirror } from "./mirror.mjs";
import { audit } from "./audit.mjs";
import { isMain } from "./is-main.mjs";
import { retryBusy } from "./retry.mjs";

const FORMAT = "memvault-devices";
const FORMAT_VERSION = 1;
export const FILE_RE = /^memvault-([a-z0-9]{16})\.mvsync$/; // conflict copies ("… 2.mvsync", "….sync-conflict-….mvsync") never match
export const MAX_FILE_BYTES = 256 * 1024 * 1024; // a computer's whole vault, compressed: far below this
const RETRY_FAILED_MS = 30 * 60_000;     // a file that could not be read is tried again after this, or when it changes
const KEEP_TOMBSTONES_DAYS = 180;         // a computer away for longer may bring back notes deleted before that
const ITEM_COLS = ["id", "type", "source", "title", "content", "file_path", "tags", "created_at", "updated_at", "agent_id", "scope"];
const PKG_VERSION = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

/** Where this computer keeps what belongs to it, not to the vault: its id, its name, what it last read. */
const homeDir = () => path.dirname(TOKEN_FILE);
const now = () => new Date().toISOString();

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* not POSIX */ }
  fs.renameSync(tmp, file);
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };

// ─── this computer ──────────────────────────────────────────────────────────

const PLATFORM = { darwin: "Mac", win32: "Windows PC", linux: "Linux computer" };

/**
 * This computer's id and name. Kept outside the vault folder on purpose: a backup restored on a new
 * computer must not make it pretend to be the old one (both would then write the same file).
 */
export function deviceIdentity({ dir = homeDir() } = {}) {
  const file = path.join(dir, "device.json");
  const known = readJson(file, null);
  if (known && /^[a-z0-9]{16}$/.test(known.id || "")) return known;
  const host = String(os.hostname() || "").replace(/\.(local|lan|home)$/i, "").slice(0, 40);
  const identity = {
    id: crypto.randomBytes(8).toString("hex"),
    name: host ? `${host} (${PLATFORM[process.platform] || process.platform})` : PLATFORM[process.platform] || "This computer",
    platform: process.platform,
    created_at: now(),
  };
  writePrivate(file, JSON.stringify(identity, null, 2));
  return identity;
}

/** A new id for this computer, keeping its name. */
export function newDeviceId({ dir = homeDir() } = {}) {
  const identity = { ...deviceIdentity({ dir }), id: crypto.randomBytes(8).toString("hex") };
  writePrivate(path.join(dir, "device.json"), JSON.stringify(identity, null, 2));
  return identity;
}

/** Forget what was read from the other computers, so the next sync reads all their files again (after a restore). */
export function forgetSyncState({ dir = homeDir() } = {}) {
  try { fs.rmSync(stateFile(dir), { force: true }); } catch { /* nothing to forget */ }
}

export function renameDevice(name, { dir = homeDir() } = {}) {
  const clean = String(name || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 60);
  if (!clean) throw new Error("Give this computer a name, for example: memvault devices name \"MacBook\"");
  const identity = { ...deviceIdentity({ dir }), name: clean };
  writePrivate(path.join(dir, "device.json"), JSON.stringify(identity, null, 2));
  return identity;
}

// ─── settings ───────────────────────────────────────────────────────────────

/** The "devices" block of ~/.memvaultrc.json, with defaults, plus where the passphrase comes from. */
export function deviceSettings(cfg = loadUserConfig(), { dir = homeDir() } = {}) {
  const d = cfg.devices || {};
  const passphraseFile = d.passphraseFile ? expandHome(d.passphraseFile) : path.join(dir, "sync-passphrase");
  // The main machine (main-machine.mjs): "this" keeps the folder every other machine syncs through; a linked
  // machine's id means this one syncs through that machine, via a private copy of its folder.
  const main = typeof d.main === "string" ? d.main : "";
  let folder = d.folder ? expandHome(String(d.folder)) : "";
  if (main === "this" && !folder) folder = path.join(dir, "main-folder");
  if (main && main !== "this") folder = path.join(dir, "main-cache");
  if (main) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  return {
    enabled: d.enabled === true,
    main,
    folder,
    intervalMinutes: Math.min(Math.max(Number(d.intervalMinutes) || 5, 1), 24 * 60),
    passphraseFile,
  };
}

/** The sync passphrase: MEMVAULT_SYNC_PASSPHRASE, or the first line of the private passphrase file. */
export function syncPassphrase(settings = deviceSettings()) {
  if (process.env.MEMVAULT_SYNC_PASSPHRASE) return process.env.MEMVAULT_SYNC_PASSPHRASE;
  try { return fs.readFileSync(settings.passphraseFile, "utf8").split(/\r?\n/)[0].trim() || null; } catch { return null; }
}

export function saveSyncPassphrase(passphrase, settings = deviceSettings()) {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Use at least ${MIN_PASSPHRASE_LENGTH} characters for the sync passphrase.`);
  }
  writePrivate(settings.passphraseFile, passphrase + "\n");
}

/** Change the "devices" block (and only it), refusing a settings file with a mistake in it. */
export function updateDeviceSettings(change, { load = () => loadUserConfig({ forUpdate: true }), save = saveUserConfig } = {}) {
  const cfg = load();
  cfg.devices = { ...(cfg.devices || {}), ...change };
  save(cfg);
  return cfg.devices;
}

// ─── what this computer has ─────────────────────────────────────────────────

// When a memory last changed. A note dated in the future (an imported chat from a computer with a wrong clock)
// must not make every later change to it look older, so the later of the two times counts.
const stampOf = (row) => { const a = row.updated_at || "", b = row.created_at || ""; return a > b ? a : b; };

/** Everything this computer shares with the others. Uploaded files stay where they are. */
export function snapshot(vdb, identity) {
  return {
    format: FORMAT,
    v: FORMAT_VERSION,
    app: PKG_VERSION,
    device: { id: identity.id, name: identity.name, platform: identity.platform || process.platform },
    exported_at: now(),
    items: vdb.query(`SELECT ${ITEM_COLS.join(",")} FROM items WHERE type != 'file'`),
    agents: vdb.query("SELECT id, name, role, profile, created_at, updated_at FROM agents"),
    tombstones: vdb.query("SELECT kind, id, deleted_at FROM tombstones"),
  };
}

/** A short fingerprint of the vault: when it changes, this computer's file is written again. */
export function fingerprint(vdb) {
  const q = (sql) => Object.values(vdb.query(sql)[0] || {}).join("/");
  return [
    q("SELECT COUNT(*), MAX(COALESCE(updated_at, created_at)) FROM items WHERE type != 'file'"),
    q("SELECT COUNT(*), MAX(updated_at) FROM agents"),
    q("SELECT COUNT(*), MAX(deleted_at) FROM tombstones"),
  ].join("|");
}

export function encodeSnapshot(snap, passphrase) {
  return encryptBuffer(zlib.gzipSync(Buffer.from(JSON.stringify(snap), "utf8")), passphrase, { kind: FORMAT, v: FORMAT_VERSION });
}

export function decodeSnapshot(blob, passphrase) {
  if (!isEncryptedBackup(blob)) throw new Error("not a MemVault sync file");
  let plain;
  try { plain = decryptBuffer(blob, passphrase); } catch { throw new Error("cannot be opened: a different sync passphrase, or the file is still being copied"); }
  const snap = JSON.parse(zlib.gunzipSync(plain).toString("utf8"));
  if (snap.format !== FORMAT) throw new Error("not a MemVault sync file");
  if (snap.v > FORMAT_VERSION) throw new Error(`made by a newer MemVault (${snap.app}); update this computer`);
  if (!snap.device || typeof snap.device.name !== "string") throw new Error("damaged");
  for (const k of ["items", "agents", "tombstones"]) if (!Array.isArray(snap[k])) throw new Error("damaged");
  return snap;
}

// ─── merging ────────────────────────────────────────────────────────────────

/**
 * Pick the state every computer will agree on: the newest change wins, a deletion wins over a change made
 * at the same moment, and ties between two versions are broken by their content, the same way everywhere.
 */
function newer(a, b) {
  if (!b) return a;
  if (!a) return b;
  if (a.stamp !== b.stamp) return a.stamp > b.stamp ? a : b;
  if (a.gone !== b.gone) return a.gone ? a : b;
  return (a.key || "") >= (b.key || "") ? a : b;
}

// What another computer sends is checked before it can be offered: the same shapes the dashboard accepts.
const TYPES = new Set(["diary", "conversation", "worklog"]);
const SCOPE_RE = /^(?:shared|agent:[a-z][a-z0-9-]{1,39}|project:[a-z0-9][a-z0-9._-]{0,59})$/;
const isDate = (v) => v === null || v === undefined || (typeof v === "string" && Number.isFinite(Date.parse(v)));
const isText = (v, max) => v === null || v === undefined || (typeof v === "string" && v.length <= max);
function validItem(r) {
  return !!r && typeof r.id === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(r.id) && TYPES.has(r.type)
    && typeof r.created_at === "string" && isDate(r.created_at) && isDate(r.updated_at)
    && SCOPE_RE.test(r.scope ?? "shared") && (r.agent_id == null || /^[a-z][a-z0-9-]{1,39}$/.test(r.agent_id))
    && isText(r.title, 2000) && isText(r.source, 500) && isText(r.tags, 5000) && isText(r.file_path, 2000) && isText(r.content, 20 * 1024 * 1024);
}
/** Exactly the columns we store, with the defaults the vault would give them. */
const cleanItem = (r) => ({
  id: r.id, type: r.type, source: r.source ?? null, title: r.title ?? null, content: r.content ?? null,
  file_path: r.file_path ?? null, tags: r.tags ?? null, created_at: r.created_at, updated_at: r.updated_at ?? null,
  agent_id: r.agent_id ?? null, scope: r.scope ?? "shared",
});

const itemKey = (r) => JSON.stringify(ITEM_COLS.filter((c) => c !== "updated_at").map((c) => r[c] ?? null));
const agentKey = (r) => JSON.stringify([r.name, r.role, r.profile]);

/** Work out what to change locally. Pure: reads the vault, writes nothing. */
export function planMerge(vdb, snapshots) {
  const localItems = new Map(vdb.query(`SELECT ${ITEM_COLS.join(",")} FROM items WHERE type != 'file'`).map((r) => [r.id, r]));
  const localAgents = new Map(vdb.query("SELECT id, name, role, profile, created_at, updated_at FROM agents").map((r) => [r.id, r]));
  const localGone = new Map(vdb.query("SELECT kind, id, deleted_at FROM tombstones").map((t) => [`${t.kind}:${t.id}`, t.deleted_at]));
  const fileIds = new Set(vdb.query("SELECT id FROM items WHERE type = 'file'").map((r) => r.id));

  const best = new Map(); // "item:<id>" | "agent:<id>"  →  { stamp, gone, key, row }
  const offer = (k, cand) => best.set(k, newer(best.get(k), cand));
  for (const [id, r] of localItems) offer(`item:${id}`, { stamp: stampOf(r), gone: false, key: itemKey(r), row: r, local: true });
  for (const [id, r] of localAgents) offer(`agent:${id}`, { stamp: stampOf(r), gone: false, key: agentKey(r), row: r, local: true });
  for (const [k, at] of localGone) offer(k, { stamp: at, gone: true, local: true });

  for (const snap of snapshots) {
    for (const r of snap.items) {
      if (!validItem(r) || fileIds.has(r.id)) continue;
      const row = cleanItem(r);
      offer(`item:${r.id}`, { stamp: stampOf(row), gone: false, key: itemKey(row), row });
    }
    for (const r of snap.agents) {
      if (typeof r?.id !== "string" || !/^[a-z][a-z0-9-]{1,39}$/.test(r.id) || typeof r.profile !== "string" || !isDate(r.updated_at)) continue;
      offer(`agent:${r.id}`, { stamp: stampOf(r), gone: false, key: agentKey(r), row: r });
    }
    for (const t of snap.tombstones) {
      if (!["item", "agent"].includes(t?.kind) || typeof t.id !== "string" || t.id.length > 120 || typeof t.deleted_at !== "string" || !isDate(t.deleted_at)) continue;
      offer(`${t.kind}:${t.id}`, { stamp: String(t.deleted_at), gone: true });
    }
  }

  const plan = { addItems: [], changeItems: [], deleteItems: [], addAgents: [], changeAgents: [], deleteAgents: [], tombstones: [] };
  for (const [k, win] of best) {
    if (win.local) continue; // this computer already has the winning state
    const [kind, id] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    const here = kind === "item" ? localItems.get(id) : localAgents.get(id);
    if (win.gone) {
      if (here) (kind === "item" ? plan.deleteItems : plan.deleteAgents).push({ ...here, deleted_at: win.stamp });
      else plan.tombstones.push({ kind, id, deleted_at: win.stamp }); // keep passing the deletion on
    } else if (!here) {
      (kind === "item" ? plan.addItems : plan.addAgents).push(win.row);
    } else if ((kind === "item" ? itemKey(here) : agentKey(here)) !== win.key) {
      // Same content with only a different time (the same starter agents installed on two computers) is no change.
      (kind === "item" ? plan.changeItems : plan.changeAgents).push(win.row);
    }
  }
  return plan;
}

const planSize = (p) => Object.values(p).reduce((n, list) => n + list.length, 0);

const manyDeletions = (plan, total) => plan.deleteItems.length > 20 && plan.deleteItems.length > total * 0.1;

/**
 * Merge other computers' snapshots in ONE atomic write: what to change is worked out again inside the write
 * lock, from the freshest copy, so a change made a moment ago on this computer is never overwritten by an
 * older one. What comes in is masked like every other write, then one access-log record is kept.
 */
export function applyMerge(vdb, snapshots, { security = SECURITY_CONFIG, root = vdb.root || VAULT_ROOT, from = [], backup } = {}) {
  if (vdb.scoped) throw new Error("Device sync needs owner access to the vault.");
  const mask = (r) => (security.redact === false ? r : redactItem(r, { disable: security.redactDisable }).item);

  // Many deletions at once ("delete everything" on another computer, or a mistake) are not undoable by sync.
  const total = () => Number(vdb.query("SELECT COUNT(*) AS n FROM items")[0]?.n || 0);
  let backupName = null;
  const preview = planMerge(vdb, snapshots);
  if (manyDeletions(preview, total()) && backup) {
    const b = backup();
    if (!b?.ok) throw new Error(`Nothing was changed: ${preview.deleteItems.length} memories would be deleted, and the backup taken first failed (${b?.error || "unknown error"}).`);
    backupName = path.basename(b.location);
  }

  let plan, items, agents;
  const vals = (r) => ITEM_COLS.map((c) => r[c] ?? null);
  vdb.transaction((tx) => {
    plan = planMerge({ query: tx.query }, snapshots);
    if (!backupName && manyDeletions(plan, Number(tx.query("SELECT COUNT(*) AS n FROM items")[0]?.n || 0)) && backup) {
      throw new Error("Many memories would be deleted; sync again so a backup is taken first.");
    }
    items = { add: plan.addItems.map(mask), change: plan.changeItems.map(mask) };
    agents = [...plan.addAgents, ...plan.changeAgents].flatMap((r) => {
      try {
        const profile = normalizeProfile({ ...JSON.parse(r.profile), id: r.id }); // a damaged or odd profile is skipped, never half-applied
        return [{ ...r, name: profile.name, role: profile.role, profile: JSON.stringify(profile) }];
      } catch { return []; }
    });
    for (const r of items.add) {
      tx.run(`INSERT OR REPLACE INTO items (${ITEM_COLS.join(",")}) VALUES (${ITEM_COLS.map(() => "?").join(",")})`, vals(r));
      tx.run("UPDATE items SET updated_at = ? WHERE id = ?", [r.updated_at ?? null, r.id]); // the insert trigger stamped "now"
      tx.run("INSERT OR IGNORE INTO synced_in (id) VALUES (?)", [r.id]);
    }
    for (const r of items.change) {
      tx.run(`UPDATE items SET ${ITEM_COLS.slice(1).map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...vals(r).slice(1), r.id]);
      tx.run("UPDATE items SET updated_at = ? WHERE id = ?", [r.updated_at ?? null, r.id]); // the change trigger stamped "now"; keep the original time
    }
    for (const r of plan.deleteItems) tx.run("DELETE FROM items WHERE id = ?", [r.id]);
    for (const r of agents) {
      tx.run("INSERT OR REPLACE INTO agents (id, name, role, profile, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        [r.id, r.name, r.role ?? "", r.profile, r.created_at || r.updated_at || now(), r.updated_at || r.created_at || now()]);
    }
    for (const r of plan.deleteAgents) tx.run("DELETE FROM agents WHERE id = ?", [r.id]);
    // The delete triggers stamped "now": keep the time the deletion really happened, so every computer agrees.
    for (const t of [
      ...plan.deleteItems.map((r) => ({ kind: "item", id: r.id, deleted_at: r.deleted_at })),
      ...plan.deleteAgents.map((r) => ({ kind: "agent", id: r.id, deleted_at: r.deleted_at })),
      ...plan.tombstones,
    ]) tx.run("INSERT OR REPLACE INTO tombstones (kind, id, deleted_at) VALUES (?,?,?)", [t.kind, t.id, t.deleted_at]);
  });

  // The readable Markdown copies on this computer follow: deleted notes lose theirs, changed ones are rewritten.
  if (plan.deleteItems.length) removeMirrors(root, plan.deleteItems);
  for (const r of items.change) updateMirror(root, r);

  const report = {
    added: items.add.length, changed: items.change.length, deleted: plan.deleteItems.length,
    agents: agents.length + plan.deleteAgents.length, backup: backupName,
  };
  report.size = planSize(plan);
  if (security.audit !== false && report.size) audit({ actor: "device-sync", action: "device-sync", detail: { from, ...report, size: undefined } }, root);
  return report;
}

// ─── the folder ─────────────────────────────────────────────────────────────

export const ownFile = (folder, identity) => path.join(folder, `memvault-${identity.id}.mvsync`);

/**
 * Write this computer's file in one step: a half-copied file is never left under the real name. The temporary
 * name is random and created only if nothing is there yet ("wx"), so a link planted in the shared folder can
 * never make us write into another file; the rename replaces a link at the real name rather than following it.
 */
export function writeOwnFile(folder, identity, blob) {
  fs.mkdirSync(folder, { recursive: true });
  const target = ownFile(folder, identity);
  const tmp = path.join(folder, `.memvault-${identity.id}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, blob, { mode: 0o600, flag: "wx" });
    retryBusy(() => fs.renameSync(tmp, target)); // a sync app may hold the old file for a moment
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* already renamed */ }
  }
  return target;
}

/** A peer's file, read only if it is a plain file of a sane size (not a link to a device, not huge). */
function readPeerFile(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new Error("not a plain file, so it was not read");
  if (st.size > MAX_FILE_BYTES) throw new Error("too large to be a MemVault sync file, so it was not read");
  return fs.readFileSync(file);
}

/** The other computers' files, as { deviceId, file, sig }. */
export function peerFiles(folder, identity) {
  let names = [];
  try { names = fs.readdirSync(folder); } catch { return []; }
  return names.flatMap((n) => {
    const m = FILE_RE.exec(n);
    if (!m || m[1] === identity.id) return [];
    const file = path.join(folder, n);
    try { const s = fs.lstatSync(file); return [{ deviceId: m[1], file, sig: `${s.size}:${s.mtimeMs}` }]; } catch { return []; }
  });
}

// ─── one run ────────────────────────────────────────────────────────────────

const stateFile = (dir) => path.join(dir, "device-sync-state.json");

/** Only one sync at a time on this computer (the dashboard and each AI app may all try). */
function runLock(dir) {
  const file = path.join(dir, "device-sync.lock");
  const token = crypto.randomBytes(8).toString("hex");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { flag: "wx", mode: 0o600 });
      // Only our own lock is removed: if another process took over a lock it thought was left behind, it stays.
      return () => { try { if (readJson(file, {}).token === token) fs.rmSync(file, { force: true }); } catch { /* ignore */ } };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const held = readJson(file, {});
      let alive = false;
      try { process.kill(held.pid, 0); alive = true; } catch (k) { alive = k.code === "EPERM"; }
      if (alive && Date.now() - (held.at || 0) < 10 * 60_000) return null;
      fs.rmSync(file, { force: true }); // left by a sync that crashed
    }
  }
  return null;
}

/**
 * Sync once: read the other computers' changed files, merge them, then write this computer's file if its
 * vault changed. Never throws for a problem with one file; the report says what happened.
 */
export function syncDevices({
  vdb, settings = deviceSettings(), passphrase = syncPassphrase(settings), dir = homeDir(),
  identity = deviceIdentity({ dir }), security = SECURITY_CONFIG, backup, force = false,
} = {}) {
  const report = { at: now(), ok: false, device: identity, added: 0, changed: 0, deleted: 0, agents: 0, peers: [], problems: [], wrote: false };
  const vaultId = vdb.query("SELECT value FROM meta WHERE key = 'vault_id'")[0]?.value || "vault";
  let state, mine;
  const loadState = () => { state = readJson(stateFile(dir), {}); mine = state[vaultId] || (state[vaultId] = { peers: {} }); };
  loadState();
  // Every attempt is recorded, a failed one too, so a background sync waits its interval before trying again.
  const finish = () => {
    report.ok = report.problems.length === 0;
    for (const [id, peer] of Object.entries(mine.peers)) report.peers.push({ id, ...peer });
    mine.last = { at: report.at, ok: report.ok, added: report.added, changed: report.changed, deleted: report.deleted, problems: report.problems };
    try { writePrivate(stateFile(dir), JSON.stringify(state, null, 2)); } catch { /* reported by the next run */ }
    return report;
  };
  if (!settings.folder) { report.problems.push("No shared folder is set. Run: memvault devices setup --folder <path>"); return finish(); }
  if (!passphrase) { report.problems.push("No sync passphrase is set. Run: memvault devices passphrase"); return finish(); }
  if (!fs.existsSync(settings.folder)) { report.problems.push(`The shared folder ${settings.folder} does not exist (is the drive or sync app running?).`); return finish(); }

  const release = runLock(dir);
  if (!release) { report.problems.push("Another sync is running on this computer; try again in a minute."); return report; }
  try {
    loadState(); // again, now that no other sync can write it: one may have finished a moment ago
    // Two computers with the same id (a copied ~/.memvault) would write the same file and never see each other.
    // If our file holds something we did not write, this computer takes a new id.
    const own = ownFile(settings.folder, identity);
    if (mine.ownHash && fs.existsSync(own)) {
      let hash = null;
      try { hash = crypto.createHash("sha256").update(readPeerFile(own)).digest("hex"); } catch { /* unreadable: rewritten below */ }
      if (hash && hash !== mine.ownHash) {
        identity = newDeviceId({ dir });
        report.device = identity;
        report.problems.push("Another computer was using this computer's id (its settings were probably copied). This computer now has a new id; sync again.");
        delete mine.ownHash;
        return finish();
      }
    }

    const fresh = [];
    for (const p of peerFiles(settings.folder, identity)) {
      const known = mine.peers[p.deviceId] || {};
      if (!force && known.sig === p.sig && !known.error) continue; // read and merged already
      if (!force && known.sig === p.sig && known.error && Date.now() - Date.parse(known.failed_at || 0) < RETRY_FAILED_MS) {
        report.problems.push(`${known.name || p.deviceId}: ${known.error}`);
        continue; // the same file failed a moment ago: wait before trying it again
      }
      try {
        const snap = decodeSnapshot(readPeerFile(p.file), passphrase);
        fresh.push({ p, snap });
      } catch (e) {
        mine.peers[p.deviceId] = { ...known, sig: p.sig, error: e.message, failed_at: now() };
        report.problems.push(`${known.name || p.deviceId}: ${e.message}`);
      }
    }

    let changedHere = false;
    if (fresh.length) {
      const applied = applyMerge(vdb, fresh.map((f) => f.snap), { security, from: fresh.map((f) => f.snap.device.name), backup });
      Object.assign(report, { added: applied.added, changed: applied.changed, deleted: applied.deleted, agents: applied.agents, backup: applied.backup });
      changedHere = applied.size > 0;
      for (const { p, snap } of fresh) {
        mine.peers[p.deviceId] = {
          name: snap.device.name, platform: snap.device.platform, app: snap.app, exported_at: snap.exported_at,
          items: snap.items.length, sig: p.sig, merged_at: report.at, error: null,
        };
      }
    }

    // Deletion records are kept for half a year; a computer away for longer may bring back notes deleted before.
    const cutoff = new Date(Date.now() - KEEP_TOMBSTONES_DAYS * 86400000).toISOString();
    if (Number(vdb.query("SELECT COUNT(*) AS n FROM tombstones WHERE deleted_at < ?", [cutoff])[0]?.n || 0)) {
      vdb.run("DELETE FROM tombstones WHERE deleted_at < ?", [cutoff]);
    }

    // Merged-in changes are written out too (an edit that reached us must reach the computers that only see us).
    const fp = fingerprint(vdb);
    if (force || changedHere || fp !== mine.fingerprint || !fs.existsSync(own)) {
      const blob = encodeSnapshot(snapshot(vdb, identity), passphrase);
      writeOwnFile(settings.folder, identity, blob);
      mine.fingerprint = fp;
      mine.ownHash = crypto.createHash("sha256").update(blob).digest("hex");
      report.wrote = true;
    }
    return finish();
  } catch (e) {
    report.problems.push(e.message);
    return finish();
  } finally {
    release();
  }
}

/** What the dashboard and `memvault devices` show. Reads only. */
export function deviceStatus({ vdb, settings = deviceSettings(), dir = homeDir() } = {}) {
  const identity = deviceIdentity({ dir });
  const state = readJson(stateFile(dir), {});
  const vaultId = vdb?.query("SELECT value FROM meta WHERE key = 'vault_id'")[0]?.value;
  const mine = (vaultId && state[vaultId]) || { peers: {} };
  const seen = settings.folder ? new Set(peerFiles(settings.folder, identity).map((p) => p.deviceId)) : new Set();
  return {
    device: { id: identity.id, name: identity.name, platform: identity.platform },
    enabled: settings.enabled,
    folder: settings.folder,
    folderExists: !!settings.folder && fs.existsSync(settings.folder),
    passphraseSet: !!syncPassphrase(settings),
    intervalMinutes: settings.intervalMinutes,
    last: mine.last || null,
    peers: Object.entries(mine.peers).map(([id, p]) => ({ id, ...p, inFolder: seen.has(id) })),
  };
}

/** Is a scheduled sync due? Several processes may ask; the run lock makes sure only one runs. */
export function syncDue(settings = deviceSettings(), { dir = homeDir() } = {}) {
  if (!settings.enabled) return false;
  const state = readJson(stateFile(dir), {});
  const last = Math.max(0, ...Object.values(state).map((v) => Date.parse(v?.last?.at || 0) || 0));
  return Date.now() - last >= settings.intervalMinutes * 60_000 - 5_000;
}

// ─── command line ───────────────────────────────────────────────────────────

function printStatus(s) {
  console.log(`This computer:  ${s.device.name}   (id ${s.device.id})`);
  console.log(`Syncing:        ${s.enabled ? `on, every ${s.intervalMinutes} min` : "off"}`);
  console.log(`Shared folder:  ${s.folder || "not set"}${s.folder && !s.folderExists ? "   ⚠️  not found" : ""}`);
  console.log(`Passphrase:     ${s.passphraseSet ? "set" : "not set"}`);
  if (s.last) console.log(`Last sync:      ${s.last.at.replace("T", " ").slice(0, 16)}  ${s.last.ok ? "✅" : "⚠️"}  +${s.last.added} added, ${s.last.changed} changed, ${s.last.deleted} deleted`);
  if (s.last?.problems?.length) for (const p of s.last.problems) console.log(`                ⚠️  ${p}`);
  console.log(s.peers.length ? "\nOther computers:" : "\nNo other computers seen yet.");
  for (const p of s.peers) {
    console.log(`  • ${(p.name || p.id).padEnd(32)} ${p.error ? `⚠️  ${p.error}` : `${p.items ?? "?"} ${p.items === 1 ? "memory" : "memories"}, saved ${String(p.exported_at || "").replace("T", " ").slice(0, 16)}`}${p.inFolder ? "" : "   (file no longer in the folder)"}`);
  }
}

async function askHidden(question) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0];
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch) => {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); process.stdout.write("\n"); resolve(value);
      } else if (ch === "\u0003") { process.stdout.write("\n"); process.exit(130); }
      else if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
      else value += ch;
    };
    stdin.on("data", onData);
  });
}

async function main(argv) {
  const [cmd = "status", ...rest] = argv;
  const flag = (name) => { const i = rest.indexOf(`--${name}`); return i === -1 ? undefined : rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : true; };
  const { openVaultDb } = await import("./db.mjs");
  const fail = (msg) => { console.error(`❌ ${msg}`); process.exit(1); };

  switch (cmd) {
    case "status": case "list": {
      return printStatus(deviceStatus({ vdb: openVaultDb() }));
    }
    case "setup": {
      const folder = flag("folder");
      if (typeof folder !== "string") fail('Say which shared folder to use: memvault devices setup --folder "~/Sync/MemVault"');
      const resolved = resolveUserPath(folder);
      fs.mkdirSync(resolved, { recursive: true });
      if (typeof flag("name") === "string") renameDevice(flag("name"));
      try { updateDeviceSettings({ enabled: true, folder: resolved }); } catch (e) { fail(e.message); }
      const settings = deviceSettings();
      console.log(`✅ This computer (${deviceIdentity().name}) will sync through ${resolved}`);
      if (!syncPassphrase(settings)) {
        console.log("\nNext: set the sync passphrase. Use the SAME one on every computer, and keep it somewhere safe:");
        console.log("  memvault devices passphrase");
      } else {
        const r = syncDevices({ vdb: openVaultDb(), settings, backup: (await import("./storage.mjs")).backupLocal });
        console.log(r.ok ? "✅ First sync done." : `⚠️  ${r.problems.join("\n   ")}`);
      }
      console.log("\nThen do the same on your other computers, with the same shared folder and passphrase.");
      return;
    }
    case "passphrase": {
      const settings = deviceSettings();
      const p1 = process.env.MEMVAULT_SYNC_PASSPHRASE || await askHidden(`Sync passphrase (at least ${MIN_PASSPHRASE_LENGTH} characters, the same on every computer): `);
      if (process.stdin.isTTY && !process.env.MEMVAULT_SYNC_PASSPHRASE) {
        const p2 = await askHidden("Type it again: ");
        if (p1 !== p2) fail("The two passphrases are not the same. Nothing was saved.");
      }
      try { saveSyncPassphrase(p1, settings); } catch (e) { fail(e.message); }
      console.log(`✅ Saved in ${settings.passphraseFile} (private to your account). There is no way to recover it: write it down.`);
      return;
    }
    case "sync": {
      const settings = deviceSettings();
      if (!settings.folder) fail("Syncing is not set up yet. Run: memvault devices setup --folder <path>");
      if (rest.includes("--if-due") && !syncDue(settings)) return;
      const { runDeviceSync } = await import("./main-machine.mjs");
      const r = await runDeviceSync({ vdb: openVaultDb(), settings, force: rest.includes("--full"), backup: (await import("./storage.mjs")).backupLocal });
      if (rest.includes("--quiet")) { process.exitCode = r.ok ? 0 : 1; return; }
      console.log(`${r.ok ? "✅" : "⚠️ "} Sync: +${r.added} added, ${r.changed} changed, ${r.deleted} deleted${r.agents ? `, ${r.agents} ${r.agents === 1 ? "agent" : "agents"} updated` : ""}${r.wrote ? "; this computer's file updated" : ""}.`);
      if (r.backup) console.log(`   A backup was taken first: ${r.backup}`);
      for (const p of r.problems) console.log(`   ⚠️  ${p}`);
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    case "name": case "rename": {
      const name = rest.filter((a) => !a.startsWith("--")).join(" ");
      try { console.log(`✅ This computer is now called "${renameDevice(name).name}". The others see the new name after the next sync.`); } catch (e) { fail(e.message); }
      return;
    }
    case "off": {
      try { updateDeviceSettings({ enabled: false }); } catch (e) { fail(e.message); }
      console.log("✅ Syncing is off on this computer. Your memories stay here; its file in the shared folder stays until you delete it.");
      return;
    }
    case "hub": {
      const address = flag("address");
      if (typeof address !== "string") fail("Give the private address phones will use, for example: memvault devices hub --address https://my-server.tail1234.ts.net");
      const { addHubAddress } = await import("./device-keys.mjs");
      try { const r = addHubAddress(address); console.log(`✅ The dashboard now also answers at ${r.origin}. Restart \`memvault serve\` for it to take effect.\n   Keep that address private (Tailscale or another private network): never put the dashboard on the open internet.`); }
      catch (e) { fail(e.message); }
      return;
    }
    case "pair": {
      const { createPairingCode } = await import("./device-keys.mjs");
      const name = typeof flag("name") === "string" ? flag("name") : "Phone";
      const { code, expiresAt } = createPairingCode({ name });
      console.log(`On the phone or tablet, open the dashboard address and choose "Use a pairing code". Enter:\n\n      ${code}\n`);
      console.log(`It works once, for "${name}", until ${new Date(expiresAt).toLocaleTimeString()}. Remove a phone later with: memvault devices keys`);
      return;
    }
    case "keys": {
      const { listDeviceKeys } = await import("./device-keys.mjs");
      const keys = listDeviceKeys();
      if (!keys.length) return console.log("No phones or tablets are signed in. Add one with: memvault devices pair --name \"iPhone\"");
      for (const k of keys) console.log(`${k.id}  ${k.name.padEnd(24)} added ${k.created_at.slice(0, 10)}   last used ${k.last_used_at ? k.last_used_at.replace("T", " ").slice(0, 16) : "never"}`);
      console.log("\nSign one out with: memvault devices forget <id>");
      return;
    }
    case "forget": {
      const { forgetDeviceKey } = await import("./device-keys.mjs");
      if (!rest[0]) fail("Say which one: memvault devices forget <id>   (see memvault devices keys)");
      if (!forgetDeviceKey(rest[0])) fail(`No phone or tablet with id "${rest[0]}". See: memvault devices keys`);
      console.log("✅ Signed out. That phone or tablet can no longer open the dashboard.");
      return;
    }
    default:
      fail(`Unknown: memvault devices ${cmd}. Use: status | setup | passphrase | sync | name | off | hub | pair | keys | forget`);
  }
}

if (isMain(import.meta.url)) main(process.argv.slice(2)).catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });

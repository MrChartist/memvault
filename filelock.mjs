/**
 * filelock.mjs — tiny cross-process advisory lock (no dependencies)
 * Used by the database layer and the audit log so several AI clients can write
 * to one vault safely. Synchronous on purpose: callers hold it for milliseconds.
 *
 * A lock that its owner never releases (a crash) is removed once the owner is gone or the file is old.
 * That same rule could also fire for an owner that is merely paused for a long time (a laptop asleep
 * in the middle of a save), so each lock carries a private token and its owner can ask holds(): "is the
 * lock still mine?". The database layer checks that just before it publishes a file.
 */

import fs from "fs";
import crypto from "crypto";

// Test hooks only; the defaults are what ships.
const LOCK_STALE_MS = Number(process.env.MEMVAULT_LOCK_STALE_MS) || 15_000;
const LOCK_TIMEOUT_MS = Number(process.env.MEMVAULT_LOCK_TIMEOUT_MS) || Math.max(30_000, LOCK_STALE_MS * 2); // must outlast the stale limit, or a waiter gives up before it may take over

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists, but not ours
  }
}

export class FileLock {
  constructor(file) {
    this.file = file;
    this.depth = 0;
    this.token = null;
  }

  acquire() {
    if (this.depth > 0) { this.depth++; return; }
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const token = crypto.randomBytes(8).toString("hex");
        const fd = fs.openSync(this.file, "wx", 0o600);
        fs.writeSync(fd, `${process.pid}:${Date.now()}:${token}`);
        fs.closeSync(fd);
        this.token = token;
        this.depth = 1;
        return;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        this.#breakIfStale();
        if (Date.now() > deadline) {
          throw new Error(`MemVault: timed out waiting for the database lock (${this.file}).`);
        }
        sleepSync(4 + Math.floor(Math.random() * 16));
      }
    }
  }

  /** Is the lock file still the one this object created? False if it was taken over. */
  holds() {
    if (!this.token) return false;
    try {
      return fs.readFileSync(this.file, "utf8").split(":")[2] === this.token;
    } catch {
      return false;
    }
  }

  /**
   * Remove the lock only if its owner is provably gone. A freshly created lock
   * file is briefly EMPTY (created, PID not yet written) — that must never be
   * mistaken for a stale lock, so age comes from the file's mtime and an
   * unparseable body is treated as "being created".
   */
  #breakIfStale() {
    try {
      const before = fs.statSync(this.file);
      const body = fs.readFileSync(this.file, "utf8");
      const pid = Number(body.split(":")[0]);
      const ownerGone = Number.isInteger(pid) && pid > 0 && !pidAlive(pid);
      const tooOld = Date.now() - before.mtimeMs > LOCK_STALE_MS;
      if (!ownerGone && !tooOld) return;
      // Re-check identity right before unlinking so we never delete a lock that
      // another process re-created in the meantime.
      const now = fs.statSync(this.file);
      if (now.ino === before.ino && now.mtimeMs === before.mtimeMs) fs.unlinkSync(this.file);
    } catch { /* lock vanished or unreadable — the retry loop handles it */ }
  }

  release() {
    if (this.depth === 0) return;
    if (--this.depth === 0) {
      // Only remove the file if it is still ours: after a takeover it belongs to someone else.
      if (this.holds()) { try { fs.unlinkSync(this.file); } catch { /* ignore */ } }
      this.token = null;
    }
  }
}

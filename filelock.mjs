/**
 * filelock.mjs — tiny cross-process advisory lock (no dependencies)
 * Used by the database layer and the audit log so several AI clients can write
 * to one vault safely. Synchronous on purpose: callers hold it for milliseconds.
 */

import fs from "fs";

const LOCK_STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 10_000;

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
  }

  acquire() {
    if (this.depth > 0) { this.depth++; return; }
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(this.file, "wx", 0o600);
        fs.writeSync(fd, `${process.pid}:${Date.now()}`);
        fs.closeSync(fd);
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
      try { fs.unlinkSync(this.file); } catch { /* ignore */ }
    }
  }
}


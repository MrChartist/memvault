/**
 * retry.mjs — try a file operation again when the file is only briefly in use.
 * On Windows an antivirus scanner, the search indexer or a cloud-sync client can hold a file open for a
 * moment, and renaming or deleting it then fails with EBUSY, EPERM or EACCES even though a second try a
 * few milliseconds later works. Any other error is raised at once.
 */
const BUSY = new Set(["EBUSY", "EPERM", "EACCES"]);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function retryBusy(fn, { tries = 10, delayMs = 25 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (!BUSY.has(e?.code) || attempt >= tries) throw e;
      sleepSync(delayMs * attempt);
    }
  }
}

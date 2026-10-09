/**
 * git-log.mjs — read recent commits from one repository.
 * No shell is involved and fields are separated by control characters that cannot appear in a commit
 * message, so quotes, backslashes, new lines and non-Latin text all survive.
 */
import { execFileSync } from "child_process";

const FIELD = "\x1f";
const RECORD = "\x1e";

/** @returns {Array<{hash,short,author,email,date,subject,body}>} newest first; [] if not a repository */
export function readCommits(repoPath, days = 14) {
  try {
    const out = execFileSync(
      "git",
      ["log", `--since=${Number(days) || 14} days ago`, "--no-merges", `--format=%H${FIELD}%h${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%s${FIELD}%b${RECORD}`],
      { cwd: repoPath, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
    );
    return out
      .split(RECORD)
      .map((r) => r.replace(/^\n+/, ""))
      .filter((r) => r.trim())
      .map((r) => {
        const [hash, short, author, email, date, subject, body = ""] = r.split(FIELD);
        return { hash, short, author, email, date, subject, body: body.trim() };
      });
  } catch {
    return [];
  }
}

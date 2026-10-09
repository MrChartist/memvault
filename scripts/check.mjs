#!/usr/bin/env node
/**
 * scripts/check.mjs — pre-publish sanity checks (no dependencies).
 *   1. every .mjs file parses
 *   2. package.json, server.json and the lockfile agree on name + version
 *   3. no personal paths / credentials slipped into shipped files
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const problems = [];

// 1. syntax
const sources = [
  ...fs.readdirSync(root).filter((f) => f.endsWith(".mjs")),
  ...fs.readdirSync(path.join(root, "scripts")).filter((f) => f.endsWith(".mjs")).map((f) => `scripts/${f}`),
];
for (const f of sources) {
  try {
    execFileSync(process.execPath, ["--check", path.join(root, f)], { stdio: "pipe" });
  } catch (e) {
    problems.push(`syntax error in ${f}: ${String(e.stderr).split("\n")[0]}`);
  }
}

// 2. versions
const pkg = JSON.parse(read("package.json"));
const server = JSON.parse(read("server.json"));
const lock = JSON.parse(read("package-lock.json"));
if (server.version !== pkg.version) problems.push(`server.json version ${server.version} != package.json ${pkg.version}`);
if (server.packages?.[0]?.version !== pkg.version) problems.push(`server.json packages[0].version != package.json ${pkg.version}`);
if (server.packages?.[0]?.identifier !== pkg.name) problems.push(`server.json package identifier != ${pkg.name}`);
if (server.name !== pkg.mcpName) problems.push(`server.json name ${server.name} != package.json mcpName ${pkg.mcpName}`);
if (lock.version !== pkg.version) problems.push(`package-lock.json version ${lock.version} != package.json ${pkg.version}`);
const versionHeading = new RegExp(`^##\\s*\\[?${pkg.version.replace(/\./g, "\\.")}\\]?`, "m");
if (!versionHeading.test(read("CHANGELOG.md"))) problems.push(`CHANGELOG.md has no entry for ${pkg.version}`);

// 3. leftovers
const SHIPPED = [...sources.filter((f) => !f.startsWith("scripts/")), "README.md", "public/index.html", ...fs.readdirSync(path.join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];
const FORBIDDEN = [
  [/\/mnt\/d\/AG|D:\\+AG\b|Mam Valut/i, "personal path"],
  [/\/mnt\/c\/Users\/rohit/i, "personal Windows path"],
  [/\bvault2026\b/, "test password"],
  [/npx\s+(-y\s+)?memvault\b/, "unscoped `npx memvault` (a different npm package!) — use @mrchartist/memvault"],
];
for (const f of SHIPPED) {
  const text = read(f);
  for (const [re, what] of FORBIDDEN) if (re.test(text)) problems.push(`${what} found in ${f}`);
}

if (problems.length) {
  console.error("❌ check failed:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`✅ check passed (${sources.length} files parse, v${pkg.version} consistent)`);

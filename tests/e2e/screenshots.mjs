/**
 * Takes the screenshots used by the README (docs/images) and the product page (site/assets/img),
 * from a throwaway vault filled with friendly example notes. Run it after changing the dashboard:
 *
 *   npm run screenshots
 *
 * Needs a Chromium-based browser, like the browser tests: set CHROME_PATH, or run
 *   npx playwright-core install chromium
 * Nothing on your own vault is read or changed.
 */
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { fileURLToPath, pathToFileURL } from "url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(here, "..", "..");
const DOCS = path.join(ROOT_DIR, "docs", "images");
const SITE = path.join(ROOT_DIR, "site", "assets", "img");

// ── a throwaway vault with example notes (neutral, no personal data) ──
const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memvault-shots-"));
process.env.VAULT_ROOT = vaultRoot;
process.env.MEMVAULT_TOKEN_FILE = path.join(vaultRoot, "token");
const load = (f) => import(pathToFileURL(path.join(ROOT_DIR, f)).href);
const { openVaultDb } = await load("db.mjs");
const { installStarterPack } = await load("agents.mjs");
const { ingest } = await load("ingest.mjs");
const { audit } = await load("audit.mjs");
const { createApp } = await load("server.mjs");
const vdb = openVaultDb({ root: vaultRoot });
installStarterPack(vdb, { pack: "general" });
const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
ingest([
  { type: "conversation", source: "chatgpt", title: "Ideas for the October school holidays", content: "A short list of day trips: the science museum, a picnic by the lake, and the old fort. Keep travel under two hours.", tags: "conversation,import", created_at: ago(76) },
  { type: "worklog", source: "cursor", title: "Fixed the date bug in the invoice script", content: "Dates were read as month/day. Now they follow the system locale, with a test.", tags: "worklog,coding", agent_id: "coder", created_at: ago(52) },
  { type: "diary", source: "ai-memory", title: "[Memory:decision] Garden Shed: the base will be 2.4 m by 1.8 m", content: "Decided with the planner. Order the timber after the base is level.", tags: "memory,memory:decision,project:garden-shed", agent_id: "planner", created_at: ago(30) },
  { type: "diary", source: "ai-memory", title: "[Memory:preference] Learner likes a worked example before practice", content: "Show one worked example, then let the learner try two on their own.", tags: "memory,memory:preference", agent_id: "study-buddy", scope: "agent:study-buddy", created_at: ago(28) },
  { type: "conversation", source: "agent-handoff", title: "Handoff writer → planner: plan the launch week", content: "The newsletter draft is ready. Please turn the launch into small daily steps for next week.", tags: "handoff,from:writer,to:planner", agent_id: "writer", created_at: ago(20) },
  { type: "diary", source: "manual", title: "आज की योजना", content: "सुबह टहलना, फिर पढ़ाई, शाम को परिवार के साथ समय बिताना।", tags: "diary,manual", created_at: ago(6) },
  { type: "diary", source: "manual", title: "Note · weekly plan", content: "Finish the garden shed timber list, book the dentist, and call mum on Sunday.", tags: "diary,manual", created_at: ago(3) },
  { type: "diary", source: "ai-memory", title: "[Memory:preference] Answers should be short", content: "Prefers short answers with one example. Explain any technical word the first time it is used.", tags: "memory,memory:preference", agent_id: "assistant", created_at: ago(1) },
], { vdb, actor: "screenshots", root: vaultRoot });
for (const [actor, tool] of [["assistant", "vault_remember"], ["writer", "agent_handoff"], ["planner", "agent_inbox"], ["coder", "vault_search"], ["study-buddy", "agent_activate"]]) {
  audit({ actor, action: "tool", detail: { tool, args: ["query"] } }, vaultRoot);
}

// Two other computers share a folder with this one, and a phone is signed in, so "Your devices" shows a real picture.
const { renameDevice, syncDevices, saveSyncPassphrase, deviceSettings } = await load("device-sync.mjs");
const { createPairingCode, redeemPairingCode } = await load("device-keys.mjs");
const sharedDir = path.join(vaultRoot, "Shared folder");
fs.mkdirSync(sharedDir);
const SYNC_PASS = "example sync passphrase";
const syncAs = (vdb, home, name) => syncDevices({
  vdb, dir: home, identity: renameDevice(name, { dir: home }), passphrase: SYNC_PASS,
  settings: { enabled: true, folder: sharedDir, intervalMinutes: 5, passphraseFile: path.join(home, "sync-passphrase") },
  security: { redact: true, audit: true },
});
for (const [name, note] of [["MacBook", "Book the train for the conference"], ["Linux VPS", "Back up the photos folder every Sunday"]]) {
  const home = path.join(vaultRoot, "other computers", name);
  const pdb = openVaultDb({ root: path.join(home, "vault") });
  installStarterPack(pdb, { pack: "general" });
  pdb.addItems([{ type: "diary", source: "manual", title: note, content: `Written on the ${name}.`, created_at: ago(30 + note.length) }]);
  syncAs(pdb, home, name);
  pdb.close();
}

const token = "shots-" + Math.random().toString(16).slice(2);
const port = await new Promise((res) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const cfgFile = path.join(vaultRoot, "rc.json");
fs.writeFileSync(cfgFile, JSON.stringify({ devices: { enabled: true, folder: sharedDir } }));
saveSyncPassphrase(SYNC_PASS, deviceSettings(JSON.parse(fs.readFileSync(cfgFile, "utf8")), { dir: vaultRoot }));
syncAs(vdb, vaultRoot, "Windows PC");
redeemPairingCode(createPairingCode({ name: "iPhone" }).code, { name: "iPhone" });
const config = { load: () => JSON.parse(fs.readFileSync(cfgFile, "utf8")), save: (c) => fs.writeFileSync(cfgFile, JSON.stringify(c)), passphraseFile: path.join(vaultRoot, "outside", "backup-passphrase") };
const server = await new Promise((res) => { const s = createApp({ vdb, token, port, root: vaultRoot, config }).listen(port, "127.0.0.1", () => res(s)); });
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--no-sandbox"] });
const written = [];
const SITE_SHOTS = new Set(["dashboard.png", "dashboard-dark.png", "agents.png", "agents-dark.png"]); // what site/index.html shows
const save = async (page, name) => {
  const file = path.join(DOCS, name);
  await page.screenshot({ path: file });
  if (SITE_SHOTS.has(name)) fs.copyFileSync(file, path.join(SITE, name));
  written.push(name);
};

async function open({ theme = "light", width = 1180, height = 900, view = "memory" } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1.5, colorScheme: theme });
  await ctx.addInitScript((t) => { try { localStorage.setItem("memvault-guide", "hidden"); localStorage.setItem("memvault-theme", t); } catch {} }, theme);
  const page = await ctx.newPage();
  await page.goto(`${base}/#token=${token}`);
  await page.waitForSelector(".entry");
  if (view !== "memory") {
    await page.click(`[data-action="view"][data-view="${view}"]`);
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(300);
  return { ctx, page };
}

for (const [name, opts] of [
  ["dashboard.png", { theme: "light" }],
  ["dashboard-dark.png", { theme: "dark" }],
  ["agents.png", { theme: "light", height: 860, view: "agents" }],
  ["agents-dark.png", { theme: "dark", height: 860, view: "agents" }],
  ["security.png", { theme: "light", height: 1080, view: "security" }],
  ["settings.png", { theme: "light", height: 1000, view: "settings" }],
  ["phone.png", { theme: "light", width: 390, height: 800 }],
]) {
  const { ctx, page } = await open(opts);
  await save(page, name);
  await ctx.close();
}

// Just the "Your devices" card, for the README.
{
  const { ctx, page } = await open({ theme: "light", height: 1200, view: "settings" });
  await page.waitForFunction(() => /Other computers/.test(document.querySelector("#devices-info")?.innerText || ""));
  const card = page.locator(".card", { has: page.locator("#s-devices") });
  await card.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    document.querySelector(".top")?.classList.add("unstick"); // the sticky header would cover the card
    document.querySelector("#dv-folder").value = "C:\\Users\\you\\Sync\\MemVault Sync"; // this run's temporary folder means nothing to a reader
  });
  await card.screenshot({ path: path.join(DOCS, "devices.png") });
  written.push("devices.png");
  await ctx.close();
}

// The share-preview card (1200 × 630) for the product page: official logo, the promise, a real screenshot.
{
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const fileUrl = (p) => pathToFileURL(p).href;
  const card = path.join(vaultRoot, "og.html");
  fs.writeFileSync(card, `<!doctype html><html><head><style>
    @font-face { font-family: "PJS"; font-weight: 400 800; src: url("${fileUrl(path.join(ROOT_DIR, "public/brand/fonts/PlusJakartaSans-latin.woff2"))}") format("woff2"); }
    @font-face { font-family: "Inter"; font-weight: 400 700; src: url("${fileUrl(path.join(ROOT_DIR, "public/brand/fonts/Inter-latin.woff2"))}") format("woff2"); }
    body { margin: 0; width: 1200px; height: 630px; background: hsl(72 20% 95.1%); color: hsl(336.7 41% 8.6%); font-family: Inter, sans-serif; overflow: hidden; position: relative; }
    .l { position: absolute; left: 72px; top: 72px; width: 560px; }
    .logo { height: 40px; }
    h1 { font: 800 64px/1.04 PJS, sans-serif; letter-spacing: -0.035em; margin: 48px 0 0; }
    h1 em { font-style: normal; color: hsl(17.9 85.5% 38%); }
    p { font-size: 25px; line-height: 1.45; color: hsl(337 12% 30%); margin: 26px 0 0; }
    .tag { position: absolute; left: 72px; bottom: 64px; font: 700 18px/1 PJS, sans-serif; letter-spacing: .06em; text-transform: uppercase; color: hsl(17.9 85.5% 38%); }
    .shot { position: absolute; left: 690px; top: 92px; width: 640px; border-radius: 18px; box-shadow: 0 30px 70px hsl(336.7 41% 8.6% / .18); border: 8px solid #fff; }
  </style></head><body>
    <div class="l"><img class="logo" src="${fileUrl(path.join(ROOT_DIR, "public/brand/logo-horizontal-black.svg"))}" alt="">
    <h1>MemVault: one memory for <em>every AI</em></h1>
    <p>Private, on your own computer. Shared by Claude, Cursor, VS Code and other AI apps.</p></div>
    <div class="tag">Free · Open source · No tracking</div>
    <img class="shot" src="${fileUrl(path.join(DOCS, "dashboard.png"))}" alt="">
  </body></html>`);
  await page.goto(fileUrl(card), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(SITE, "og.png") });
  written.push("og.png (site only)");
  await ctx.close();
}

await browser.close();
server.close();
vdb.close?.();
fs.rmSync(vaultRoot, { recursive: true, force: true });
console.log(`Saved ${written.length} screenshots: ${written.join(", ")}`);

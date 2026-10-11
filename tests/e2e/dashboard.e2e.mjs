/**
 * Dashboard end-to-end tests: security, accessibility, languages, and phone/dark/high-contrast layouts.
 *
 *   npm run test:e2e
 *
 * Needs a Chromium-based browser. Set CHROME_PATH to its executable, or install one with
 *   npx playwright-core install chromium
 * Set E2E_SHOTS=/some/folder to also save screenshots. Not part of `npm test` (it needs a browser).
 *
 * What it proves in a real browser: hostile text written by an agent cannot run script; the page makes no
 * requests to other sites and breaks no Content-Security-Policy rule; every screen passes an automated
 * WCAG 2.1 AA audit (axe-core) in light, dark and phone layouts; text size, keyboard use, right-to-left
 * text, forced-colours mode, and the first-run guide all work.
 */
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(here, "..", "..");
const require = createRequire(import.meta.url);
const axeSrc = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

// ── a throwaway vault with generic data, several languages, and hostile entries ──
const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memvault-e2e-"));
process.env.VAULT_ROOT = vaultRoot;
process.env.MEMVAULT_TOKEN_FILE = path.join(vaultRoot, "token");
const load = (f) => import(pathToFileURL(path.join(ROOT_DIR, f)).href);
const { openVaultDb } = await load("db.mjs");
const { installStarterPack } = await load("agents.mjs");
const { ingest } = await load("ingest.mjs");
const { audit } = await load("audit.mjs");
const { createApp } = await load("server.mjs");
const vdb = openVaultDb({ root: vaultRoot });
installStarterPack(vdb, { pack: "all" });
const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
ingest([
  { type: "diary", source: "manual", title: "Diary · weekly plan", content: "Review the notes on Sunday and keep them short.", tags: "diary,manual", created_at: day(0) },
  { type: "worklog", source: "claude", title: "[Memory:decision] Describe gaps in candles", content: "Applies to every research post.", tags: "memory,memory:decision,trading", agent_id: "market-analyst", created_at: day(1) },
  { type: "conversation", source: "agent-handoff", title: "Handoff market-analyst → telegram-editor: post", content: "Format the draft. Keep every level exactly as written.", tags: "handoff,from:market-analyst,to:telegram-editor", agent_id: "market-analyst", created_at: day(1) },
  { type: "diary", source: "ai-memory", title: "Private style note", content: "Prefers short paragraphs.", tags: "memory,memory:preference", agent_id: "telegram-editor", scope: "agent:telegram-editor", created_at: day(3) },
  { type: "diary", source: "clipboard", title: "Clipboard: deployment notes", content: "Set DB_PASSWORD=correcthorsebattery and token ghp_abcdefghijklmnopqrstuvwxyz0123456789 in CI", tags: "clipboard,text", created_at: day(4) },
  { type: "diary", source: "manual", title: "ملاحظات اليوم: خطة الأسبوع", content: "أريد أن أراجع الدروس وأن أكتب مقالاً قصيراً هذا الأسبوع.", tags: "diary", created_at: day(0) },
  { type: "diary", source: "manual", title: "आज की योजना", content: "सुबह टहलना, फिर पढ़ाई, शाम को परिवार के साथ समय बिताना।", tags: "diary", created_at: day(0) },
  { type: "diary", source: "manual", title: "今週の目標", content: "毎日少しずつ日本語を勉強する。", tags: "diary", created_at: day(0) },
  // hostile entries: what a poisoned agent or imported chat could write
  { type: "diary", source: "<img src=x onerror=\"window.__pwned=1;document.title='PWNED'\">", title: "<script>window.__pwned=1</script>Hostile title", content: "<img src=x onerror=\"window.__pwned=1\"> and <svg onload=\"window.__pwned=1\">", tags: "<b>x</b>", created_at: day(5) },
  { type: "worklog", source: "\"><svg onload=window.__pwned=1>", title: "Attribute-breaking source", content: "plain", tags: "x", created_at: day(6) },
], { vdb, actor: "e2e", root: vaultRoot });
for (const [actor, tool] of [["market-analyst", "vault_search"], ["telegram-editor", "agent_activate"], ["coder", "vault_add"]]) audit({ actor, action: "tool", detail: { tool, args: ["query"] } }, vaultRoot);

const token = "e2e-token-" + Math.random().toString(16).slice(2);
const port = await new Promise((res) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const cfgFile = path.join(vaultRoot, "rc.json");
fs.writeFileSync(cfgFile, "{}");
const config = { load: () => JSON.parse(fs.readFileSync(cfgFile, "utf8")), save: (c) => fs.writeFileSync(cfgFile, JSON.stringify(c)), passphraseFile: path.join(vaultRoot, "outside", "backup-passphrase") };
const server = await new Promise((res) => { const s = createApp({ vdb, token, port, root: vaultRoot, config }).listen(port, "127.0.0.1", () => res(s)); });
const base = `http://127.0.0.1:${port}`;

const out = process.env.E2E_SHOTS;
if (out) fs.mkdirSync(out, { recursive: true });
const shot = async (page, name, opts = {}) => { if (out) await page.screenshot({ path: path.join(out, name), ...opts }); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--no-sandbox"] });

const results = []; const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };

async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 }, colorScheme: "light", ...opts });
  const page = await ctx.newPage();
  const bad = { external: [], csp: [], errors: [] };
  page.asked = []; // every confirm() the page shows; the test accepts it so the flow continues
  page.on("dialog", (d) => { page.asked.push(d.message()); d.accept(); });
  page.on("request", (r) => { const u = new URL(r.url()); if (u.protocol.startsWith("http") && !["127.0.0.1", "localhost"].includes(u.hostname)) bad.external.push(r.url()); });
  page.on("console", (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) bad.csp.push(t); if (m.type() === "error" && !/favicon|Failed to load resource/.test(t)) bad.errors.push(t); });
  page.on("pageerror", (e) => bad.errors.push(String(e)));
  return { ctx, page, bad };
}
async function axe(page, label) {
  await page.evaluate(axeSrc);
  const r = await page.evaluate(() => axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"], resultTypes: ["violations"] }));
  const v = r.violations.filter((x) => x.impact !== "minor");
  check(`axe WCAG 2.1 AA — ${label}`, v.length === 0, v.map((x) => `${x.id}(${x.nodes.length}): ${x.nodes[0]?.html?.slice(0, 90)}`).join(" | "));
  return v;
}

// ═════ A. first visit: guide, connect dialog, text size ═════
const A = await open();
let p = A.page;
await p.goto(`${base}/#token=${token}`);
await p.waitForSelector(".entry");
check("token removed from address bar", !p.url().includes("token"));
check("first-run guide is shown to a new visitor", await p.locator("#guide").isVisible());
check("page language is English (the words on the page are English)", (await p.getAttribute("html", "lang")) === "en");
await shot(p, 'memory-light.png');
await axe(p, "Memory (light, with guide)");

const fs0 = await p.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
await p.click('[data-action="text-larger"]'); await p.click('[data-action="text-larger"]');
const fs2 = await p.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
check("text size control enlarges everything (rem-based)", fs2 > fs0 * 1.2, `${fs0}px → ${fs2}px`);
const h = await p.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".entry h3")).fontSize));
check("entry text grew with it", h > 17, `${h}px`);
await shot(p, 'memory-large-text.png');
await p.reload(); await p.waitForSelector(".entry");
check("text size is remembered", (await p.getAttribute("html", "data-text")) === "l");
await p.click('[data-action="text-smaller"]'); await p.click('[data-action="text-smaller"]');

await p.click('[data-action="connect-apps"]');
await p.waitForSelector("#dlg-apps[open]");
check("connect dialog shows the exact config with real paths", /mcp-server\.mjs/.test(await p.locator("#apps-body").innerText()));
const appsText = await p.locator("#apps-body").innerText();
check("connect dialog says when to paste all of the block and when only the memvault part (the block already holds \"mcpServers\")",
  appsText.includes("If the file is empty, paste all of this. If it already has “mcpServers”, copy only the “memvault” part into it.") && !/inside "mcpServers"/.test(appsText) && /"mcpServers"/.test(appsText), appsText.slice(0, 200).replace(/\s+/g, " "));
await p.click('[data-app="claude-code"]');
const claudeCmd = await p.locator("#apps-body .code").first().innerText();
check("Claude Code gets a ready-to-run command (options first, then --transport, then the name: --env must not touch the name)", /^claude mcp add (--env \S+ )*--transport stdio memvault -- /.test(claudeCmd), claudeCmd.slice(0, 120));
await axe(p, "Connect dialog");
await p.keyboard.press("Escape");
check("Escape closes the dialog", !(await p.locator("#dlg-apps").getAttribute("open")));
await p.click('[data-action="dismiss-guide"]');
await p.reload(); await p.waitForSelector(".entry");
check("dismissing the guide is remembered", !(await p.locator("#guide").isVisible()));
await p.click('[data-action="help"]');
check("the ? button brings the guide back", await p.locator("#guide").isVisible());

// ═════ B. security regression (XSS, masking, scoping) ═════
await p.waitForTimeout(300);
check("hostile entries did NOT execute script", !(await p.evaluate(() => window.__pwned === 1 || document.title === "PWNED")));
check("hostile markup rendered as text", (await p.evaluate(() => document.querySelectorAll("#entries img, #entries svg, #entries script, #entries b").length)) === 0);
const body = await p.locator("#entries").innerText();
check("secrets in old clipboard entry show masked, in plain words", /\[hidden password or key\]/.test(body) && /\[hidden access key\]/.test(body) && !/REDACTED/.test(body) && !body.includes("correcthorsebattery") && !body.includes("ghp_abcdefghij"));
const byAgent = await p.locator("#entries .badge.by-agent").allInnerTexts();
const sources = await p.locator("#entries .entry-head > span:not(.badge)").allInnerTexts();
check("memory cards use plain words for sources and agent names", byAgent.includes("Market Analyst") && !byAgent.some((t) => /^[a-z]+(-[a-z]+)+$/.test(t)) && sources.includes("You") && sources.includes("Copied text") && sources.includes("Saved by an AI") && !sources.some((t) => /^(manual|ai-memory|clipboard)$/.test(t)), `${byAgent.join(",")} / ${sources.join(",")}`);
await p.selectOption("#viewas", "market-analyst"); await p.waitForTimeout(300);
check("'see what this agent can see' hides another agent's private note", !(await p.locator("#entries").innerText()).includes("Private style note"));
await p.selectOption("#viewas", ""); await p.waitForTimeout(200);

// ═════ C. languages and direction ═════
const dirs = await p.evaluate(() => [...document.querySelectorAll("#entries h3")].map((h) => ({ t: h.textContent, d: getComputedStyle(h).direction })));
const ar = dirs.find((x) => /ملاحظات/.test(x.t));
check("Arabic entry renders right-to-left (dir=auto)", ar?.d === "rtl", JSON.stringify(ar));
check("English entry stays left-to-right", dirs.find((x) => /Note|weekly/i.test(x.t))?.d === "ltr");
check("Hindi and Japanese text are present, not mangled", /आज की योजना/.test(body) && /今週の目標/.test(body));
await shot(p, 'memory-languages.png', { fullPage: true });

// ═════ D. agents: packs + plain-language form ═════
await p.click('[data-view="agents"]'); await p.waitForSelector("article.agent");
check("10 agents (7 general + 3 markets) are listed", (await p.locator("article.agent").count()) === 10, `${await p.locator("article.agent").count()}`);
check("starter-set chooser lists General first, then Markets", (await p.locator("#pack-select option").allInnerTexts()).join("|").startsWith("General helpers|Markets"));
check("brand casing preserved on the markets agent", /@MrChartist/.test(await p.locator("article.agent").allInnerTexts().then((a) => a.join(" "))));
await axe(p, "Agents (light)");
await shot(p, 'agents-light.png');

await p.click('[data-action="new-agent"]');
await p.fill("#agent-name", "Options Desk");
await p.fill("#agent-prompt", "You are an options educator for retail traders. Use simple, formal English. Never recommend a trade. Always state assumptions.");
await p.click('[data-action="draft"]');
await p.waitForSelector("#f-role");
check("draft fills the plain-language form", /options educator/i.test(await p.inputValue("#f-role")) && /Never recommend a trade/.test(await p.inputValue("#f-never")) && /Always state assumptions/.test(await p.inputValue("#f-always")));
await p.fill("#f-always", "Always state assumptions\nExplain every term in one sentence");
await axe(p, "Agent form dialog");
await shot(p, 'agent-form-light.png');
await p.click('[data-action="save-agent"]'); await p.waitForTimeout(600);
check("agent saved from the form (no JSON needed)", (await p.locator("article.agent").count()) === 11);
// editing keeps hidden fields: brand of a markets agent must survive a form edit
await p.click('[data-action="edit-agent"][data-id="market-analyst"]'); await p.waitForSelector("#f-role");
check("editing an existing agent locks its short id", await p.evaluate(() => document.querySelector("#f-id").readOnly));
await p.fill("#f-tone", "direct, practical, accurate, calm");
await p.click('[data-action="save-agent"]'); await p.waitForTimeout(500);
const kept = await (await fetch(`${base}/agents/market-analyst`, { headers: { authorization: `Bearer ${token}` } })).json();
check("form edit changed the tone but kept brand and rules it does not show", /calm/.test(kept.agent.voice.tone) && kept.agent.brand.handle === "@MrChartist" && kept.agent.rules.never.length === 3 && kept.agent.outputStyle.length >= 2);
// a new agent must not silently overwrite an existing one
await p.click('[data-action="new-agent"]'); await p.fill("#agent-name", "Coder"); await p.fill("#agent-prompt", "You are a different coder. Never break things.");
await p.click('[data-action="draft"]'); await p.waitForSelector("#f-role");
await p.click('[data-action="save-agent"]'); await p.waitForSelector("#agent-error:not([hidden])");
check("a new agent cannot silently replace an existing one with the same id", /already exists/.test(await p.locator("#agent-error").innerText()));
await p.click('#agent-edit-step [data-action="close-dialog"]');
// invalid values are explained
await p.click('[data-action="edit-agent"][data-id="assistant"]'); await p.waitForSelector("#f-role");
await p.click("#agent-more summary"); await p.fill("#f-read", "everything");
await p.click('[data-action="save-agent"]'); await p.waitForSelector("#agent-error:not([hidden])");
check("an invalid value gets a readable message", /readScopes/.test(await p.locator("#agent-error").innerText()));
await p.click('#agent-edit-step [data-action="close-dialog"]');

// ═════ E. vault + security ═════
await p.click('[data-view="vault"]');
await axe(p, "Secure Vault (locked)");
await p.fill("#master-pw", "short"); await p.click("#unlock-form button");
await p.waitForSelector("#pw-error:not([hidden])");
check("short master password refused with a clear reason", /at least 10/.test(await p.locator("#pw-error").innerText()));
check("first time: the vault asks for the password twice", await p.locator("#master-pw2").isVisible());
await p.fill("#master-pw", "correct horse battery"); await p.fill("#master-pw2", "something different 1"); await p.click("#unlock-form button");
await p.waitForFunction(() => /not the same/.test(document.querySelector("#pw-error")?.textContent || ""));
check("mismatched passwords are explained", true);
await p.fill("#master-pw2", "correct horse battery"); await p.click("#unlock-form button");
await p.waitForSelector("#unlocked:not([hidden])");
await p.click('[data-action="add-secret"]'); await p.selectOption("#s-category", "password"); await p.fill("#s-label", "<b>Email</b> password"); await p.fill("#sf-username", "me@example.com");
await p.click('#secret-form button[type="submit"]'); await p.waitForSelector(".secret");
check("secret name shown as text, not markup", (await p.locator(".secret b").first().innerText()) === "<b>Email</b> password");
await axe(p, "Secure Vault (unlocked)");
await p.click('[data-view="security"]'); await p.waitForSelector(".check-row"); await p.waitForTimeout(500);
check("security page reports loopback, masking and an intact log", /only listens on this computer \(127\.0\.0\.1\)/.test(await p.locator("#posture").innerText()) && /masking is ON/.test(await p.locator("#posture").innerText()) && (await p.locator("#chain-pill").getAttribute("class")).includes("good"));
const posture = await p.locator("#posture").innerText();
check("check rows are plain sentences (no \"(s)\" plurals, no backticks)", !/\(s\)|`/.test(posture) && /Node\.js \S+ \(supported\)/.test(posture), posture.match(/.*(\(s\)|`).*/)?.[0] || "");
const auditWho = await p.locator("#audit tbody td:nth-child(2)").allInnerTexts();
const auditText = await p.locator("#audit").innerText();
check("the activity list says who in plain words (You, agent names) and shows no raw key=value text", auditWho.length > 0 && auditWho.includes("You") && !auditWho.some((w) => /^(api|owner)$/.test(w)) && !/\b\w+=\S/.test(auditText), auditWho.slice(0, 6).join(","));
check("backups lead with the time, the file name comes second", await p.evaluate(() => { const r = document.querySelector("#backups .check-row div"); return !r || (r.querySelector("b") && r.firstElementChild.tagName === "B" && /\.sqlite|\.db|backup/i.test(r.querySelector(".backup-name")?.textContent || "")); }));
check("security page says plainly what leaves the computer", /sent to the company behind that AI/.test(await p.locator("#view-security").innerText()));
await axe(p, "Security (light)");
await shot(p, 'security-light.png', { fullPage: true });

// ═════ G. one memory at a time, undo, choosing several ═════
await p.click('[data-view="memory"]'); await p.waitForSelector("article.entry");
const card = (txt) => p.locator("article.entry", { hasText: txt });
await p.fill("#diary-input", "Maya's exam is on 12 June, study with pictures");
await p.click("#save-btn");
await card("Maya's exam").first().waitFor();
check("a saved note appears at once, with Pin, Edit and Delete buttons", (await card("Maya's exam").locator("[data-action]").count()) >= 4);
check("each action says which memory it is for (screen readers and voice control)", /Delete: Note/.test(await card("Maya's exam").locator('[data-action="delete-item"]').getAttribute("aria-label")));
check("the list is not a live region (it was re-announced on every search)", !(await p.locator("#entries").getAttribute("aria-live")));
check("a short status line says how many are shown", /memories shown|memory shown/.test(await p.locator("#results-status").innerText()));

await card("Maya's exam").locator(".linklike").click();
await p.waitForSelector("#dlg-memory[open]");
check("opening a memory shows its full text", /study with pictures/.test(await p.locator("#mem-full").innerText()));
await axe(p, "Memory window (read)");
check("in the memory window, Close is a plain button and Delete sits apart at the far start", await p.evaluate(() => {
  const del = document.querySelector('#mem-view-step [data-action="mem-delete"]').getBoundingClientRect();
  const close = document.querySelector('#mem-view-step [data-action="close-dialog"]');
  const others = [...document.querySelectorAll('#mem-view-step .dlg-actions .btn:not([data-action="mem-delete"])')].map((b) => b.getBoundingClientRect().left);
  return !close.classList.contains("primary") && others.every((x) => x > del.right + 8);
}));
await shot(p, "after-memory-open.png");
await p.click('[data-action="mem-pin"]'); await p.waitForFunction(() => document.querySelector("#mem-pin")?.textContent === "Unpin");
const toastTop = await p.evaluate(() => { const t = document.querySelector("#toast"); return t.matches(":popover-open") && getComputedStyle(t).opacity === "1" && document.querySelector("#dlg-memory").open; });
check("messages show ABOVE an open window (they used to hide behind it)", toastTop);
const [dl] = await Promise.all([p.waitForEvent("download"), p.click('[data-action="mem-download"]')]);
check("a single memory can be downloaded", /^memvault-.*\.json$/.test(dl.suggestedFilename()));
await p.click('[data-action="mem-edit"]'); await p.waitForSelector("#mem-edit-step:not([hidden])");
await p.fill("#m-content", "Maya's exam is on 14 June. API_KEY=abcd1234efgh5678");
await axe(p, "Memory window (edit)");
await shot(p, "after-memory-edit.png");
const askedBefore = p.asked.length;
await p.click('#mem-edit-step [data-action="close-dialog"]');
check("closing an edit with typing in it asks first", p.asked.length === askedBefore + 1 && /without saving/.test(p.asked.at(-1)));
await p.waitForSelector("#dlg-memory:not([open])", { state: "attached" });
await card("Maya's exam").locator('[data-action="edit-item"]').click();
await p.waitForFunction(() => document.querySelector("#dlg-memory").open && document.querySelector("#m-content").value.includes("study with pictures"));
check("the edit box hides the labels MemVault adds itself (pinned, diary, manual)", !/pinned|diary|manual/.test(await p.inputValue("#m-tags")), await p.inputValue("#m-tags"));
await p.fill("#m-content", "Maya's exam is on 14 June. API_KEY=abcd1234efgh5678");
await p.click('[data-action="mem-save"]'); await p.waitForSelector("#dlg-memory:not([open])", { state: "attached" });
check("saving an edit hides secrets and says so in plain words", /hid 1 password or key/.test(await p.locator("#toast").innerText()));
const saved = await (await fetch(`${base}/search?q=14%20June`, { headers: { authorization: `Bearer ${token}` } })).json();
check("the stored text is the edited, masked text", saved.results.length === 1 && !JSON.stringify(saved).includes("abcd1234efgh5678") && /14 June/.test(saved.results[0].snippet));
check("saving an edit keeps the hidden labels and the pin", ["diary", "manual", "pinned"].every((t) => saved.results[0].tags.split(",").includes(t)), saved.results[0].tags);
await p.waitForFunction(() => document.querySelector("article.entry")?.classList.contains("is-pinned"));
check("a pinned memory moves to the top and says 'Pinned' in words", /Pinned/.test(await p.locator("article.entry.is-pinned").first().innerText()));

await card("14 June").locator('[data-action="delete-item"]').click();
await p.waitForSelector("#undo:not([hidden])");
await card("14 June").first().waitFor({ state: "detached" });
check("deleting offers Undo and removes the card", (await card("14 June").count()) === 0 && /Deleted/.test(await p.locator("#undo-text").innerText()));
await shot(p, "after-undo-bar.png");
await p.click('#undo [data-action="undo"]');
await card("14 June").first().waitFor();
check("Undo puts the memory back", (await card("14 June").count()) === 1);
check("it is still pinned after Undo", await card("14 June").first().evaluate((e) => e.classList.contains("is-pinned")));

await p.click("#select-toggle");
await p.waitForSelector("#selbar:not([hidden])");
await p.locator('.entry input[data-action="pick"]').nth(1).check();
await p.locator('.entry input[data-action="pick"]').nth(2).check();
check("choosing several shows a live count", (await p.locator("#sel-count").innerText()) === "2 selected");
await axe(p, "Memory (choosing several)");
await shot(p, "after-select.png");
await p.click("#delete-selected"); await p.waitForSelector("#dlg-bulk[open]");
check("bulk delete cannot be done by accident (button waits for the typed words)", await p.locator("#bulk-go").isDisabled());
check("the words to type are shown as they must be typed, not run together in capitals", (await p.locator("#bulk-label code").innerText()) === "DELETE 2" && (await p.locator("#bulk-label").evaluate((e) => getComputedStyle(e).textTransform)) === "none");
await p.fill("#bulk-confirm", "DELETE 1");
check("the wrong number does not unlock it", await p.locator("#bulk-go").isDisabled());
await axe(p, "Delete several (confirm)");
await shot(p, "after-bulk-confirm.png");
await p.fill("#bulk-confirm", "DELETE 2");
await p.click("#bulk-go"); await p.waitForSelector("#undo:not([hidden])");
check("bulk delete reports how many and offers Undo", /Deleted 2/.test(await p.locator("#undo-text").innerText()));
await p.click('#undo [data-action="undo"]'); await p.waitForTimeout(500);

await p.fill("#search-input", "zzqqnothingmatches"); await p.click('#search-form button[type="submit"]'); await p.waitForTimeout(400);
check("a search that finds nothing says so, in plain words", /Nothing found for/.test(await p.locator("#entries").innerText()) && /Try fewer or different words/.test(await p.locator("#entries").innerText()));
await p.click('[data-action="clear-search"]'); await p.waitForTimeout(300);
await p.fill("#search-input", "Maya"); await p.click('#search-form button[type="submit"]'); await p.waitForTimeout(400);
check("searching reports how many were found", /shown/.test(await p.locator("#results-status").innerText()));
await p.click('[data-action="clear-search"]'); await p.waitForTimeout(300);

// ═════ H. Settings ═════
await p.click('[data-view="settings"]'); await p.waitForSelector("#capture-list .switch");
check("switching screens moves focus to the new heading", await p.evaluate(() => document.activeElement?.id === "h-settings"));
check("text size choices go from small to big: Normal, Large, Larger, Largest", (await p.locator('input[name="textsize"]').evaluateAll((l) => l.map((r) => `${r.value}:${r.parentElement.textContent.trim()}`))).join("|") === "0:Normal|1:Large|2:Larger|3:Largest");
check("every kind of automatic saving starts switched off", (await p.locator('[data-capture]:checked').count()) === 0);
await axe(p, "Settings (light)");
await shot(p, "after-settings-light.png", { fullPage: true });
await p.locator('[data-capture="git"]').check();
await p.waitForFunction(() => /On/.test(document.querySelector('[data-capture="git"]')?.closest(".switch")?.innerText || ""));
check("a switch is saved straight away", JSON.parse(fs.readFileSync(cfgFile, "utf8")).sync?.gitEnabled === true);
await p.locator('[data-capture="git"]').uncheck();
await p.waitForFunction(() => /Off/.test(document.querySelector('[data-capture="git"]')?.closest(".switch")?.innerText || ""));
check("and can be switched off again", JSON.parse(fs.readFileSync(cfgFile, "utf8")).sync?.gitEnabled === false);
await p.fill("#pj-name", "Garden Shed"); await p.fill("#pj-words", "shed, garden build"); await p.click('#project-form button[type="submit"]');
await p.waitForSelector("#project-list li");
check("a project can be added without editing a file", JSON.parse(fs.readFileSync(cfgFile, "utf8")).projects?.[0]?.name === "Garden Shed");
await p.click('[data-action="remove-project"]'); await p.waitForFunction(() => !document.querySelector("#project-list li"));
check("and removed", (JSON.parse(fs.readFileSync(cfgFile, "utf8")).projects || []).length === 0);
await p.fill("#bp-1", "short"); await p.fill("#bp-2", "short"); await p.click('#pass-form button[type="submit"]');
check("a short backup passphrase is refused with the reason", /at least 10/.test(await p.locator("#bp-error").innerText()));
await p.fill("#bp-1", "a long enough phrase"); await p.fill("#bp-2", "a different phrase!"); await p.click('#pass-form button[type="submit"]');
check("a mismatched passphrase is refused with the reason", /not the same/.test(await p.locator("#bp-error").innerText()));
await p.fill("#bp-2", "a long enough phrase"); await p.click('#pass-form button[type="submit"]');
await p.waitForFunction(() => /Backups locked with a passphrase: Yes/.test(document.querySelector("#backup-info")?.innerText || ""));
check("a good passphrase is saved and the page says so", fs.existsSync(path.join(vaultRoot, "outside", "backup-passphrase")) && !(await p.content()).includes("a long enough phrase"));
const [ex] = await Promise.all([p.waitForEvent("download"), p.click('[data-action="export-all"]')]);
const exported = JSON.parse(fs.readFileSync(await ex.path(), "utf8"));
check("'Download everything' gives all notes in one file", /^memvault-export-/.test(ex.suggestedFilename()) && exported.items.length > 5);
await p.click('[data-action="wipe-all"]'); await p.waitForSelector("#dlg-wipe[open]");
check("'Delete everything' waits for the typed words", await p.locator("#wipe-go").isDisabled());
await axe(p, "Delete everything (confirm)");
await p.fill("#wipe-confirm", "DELETE ALL"); check("and unlocks only when they match", await p.locator("#wipe-go").isEnabled());
await p.keyboard.press("Escape");
await p.click('[data-view="settings"]');
check("the trash list shows recently deleted memories with a way back", (await p.locator("#trash-list").innerText()).length > 0);

// ═════ I. Secure Vault: lock, reveal, auto-hide ═════
await p.click('[data-view="vault"]');
await p.waitForSelector("#unlocked:not([hidden]), #lock:not([hidden])");
if (await p.locator("#lock").isVisible()) { await p.fill("#master-pw", "correct horse battery"); await p.click("#unlock-form button"); await p.waitForSelector("#unlocked:not([hidden])"); }
check("a secret's Delete is its own real button (not inside another button)", (await p.locator(".secret-row > button").count()) >= 2 && (await p.locator("button button").count()) === 0);
await p.click(".secret"); await p.waitForSelector("#dlg-reveal[open]");
check("secret values are hidden until 'Show' is pressed", /^•+$/.test((await p.locator(".reveal .v").first().innerText()).trim()));
await p.click('[data-action="show-value"]');
check("'Show' reveals the value and the button becomes 'Hide'", /me@example\.com/.test(await p.locator(".reveal .v").first().innerText()) && (await p.locator('[data-action="show-value"]').innerText()) === "Hide");
await axe(p, "Secret revealed");
await p.keyboard.press("Escape");
await p.click('[data-action="lock"]');
await p.waitForFunction(() => document.activeElement?.id === "master-pw", null, { timeout: 3000 }).catch(() => {});
check("locking returns focus to the password box", await p.evaluate(() => document.activeElement?.id === "master-pw"));
check("no third-party requests", A.bad.external.length === 0, A.bad.external.join(","));
check("no CSP violations", A.bad.csp.length === 0, A.bad.csp.join("|"));
check("no JavaScript errors", A.bad.errors.length === 0, A.bad.errors.join("|"));

// ═════ F. dark, phone, forced colours, keyboard ═════
const D = await open({ colorScheme: "dark" });
await D.page.goto(`${base}/#token=${token}`); await D.page.waitForSelector(".entry"); await D.page.waitForTimeout(300);
await axe(D.page, "Memory (dark)");
await shot(D.page, 'memory-dark.png');
await D.page.click('[data-view="agents"]'); await D.page.waitForSelector("article.agent");
await axe(D.page, "Agents (dark)");
await shot(D.page, 'agents-dark.png');
await D.page.click('[data-view="security"]'); await D.page.waitForSelector(".check-row"); await D.page.waitForTimeout(400);
await axe(D.page, "Security (dark)");

const M = await open({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, hasTouch: true });
await M.page.goto(`${base}/#token=${token}`); await M.page.waitForSelector(".entry"); await M.page.waitForTimeout(300);
check("no sideways scrolling on a phone", !(await M.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)));
const small = await M.page.evaluate(() => [...document.querySelectorAll("button, a:not(p a), input, select, textarea, summary")].filter((e) => e.offsetParent !== null).map((e) => { const r = e.getBoundingClientRect(); return { t: (e.textContent || e.id || e.className).trim().slice(0, 24), h: Math.round(r.height), w: Math.round(r.width) }; }).filter((x) => x.h < 44 || x.w < 44));
check("every button and field is at least 44px tall on a phone", small.length === 0, JSON.stringify(small.slice(0, 5)));
const headH = await M.page.evaluate(() => document.querySelector(".top").getBoundingClientRect().height);
check("the phone header is short (one row of buttons, one row of tabs)", headH < 140, `${Math.round(headH)}px`);
check("the tabs stay on one row that scrolls sideways on a phone", await M.page.evaluate(() => { const t = [...document.querySelectorAll(".tab")].map((b) => Math.round(b.getBoundingClientRect().top)); return new Set(t).size === 1; }));
await M.page.evaluate(() => { document.querySelector(".tabs").scrollLeft = 0; document.querySelector('.tab[data-view="settings"]').click(); }); await M.page.waitForTimeout(300);
check("the chosen tab is scrolled fully into sight", await M.page.evaluate(() => { const r = document.querySelector(".tab.is-active").getBoundingClientRect(); return r.left >= 0 && r.right <= document.documentElement.clientWidth; }));
await M.page.click('.tab[data-view="memory"]'); await M.page.waitForSelector("article.entry");
await M.page.click("#select-toggle"); await M.page.waitForSelector("#selbar:not([hidden])");
await M.page.evaluate(() => window.scrollTo(0, 1400)); await M.page.waitForTimeout(300);
const bar = await M.page.evaluate(() => { const s = document.querySelector("#selbar").getBoundingClientRect(); const t = document.querySelector(".top").getBoundingClientRect(); return { top: s.top, bottom: s.bottom, head: t.bottom, vh: innerHeight, y: scrollY }; });
check("on a phone the select bar stays in sight below the header when scrolled", bar.y > 600 && bar.top >= bar.head - 1 && bar.bottom <= bar.vh, JSON.stringify(bar));
await M.page.evaluate(() => window.scrollTo(0, 0)); await M.page.click("#select-toggle");
await shot(M.page, 'memory-mobile.png');
await axe(M.page, "Memory (phone)");

await M.page.click('[data-view="settings"]'); await M.page.waitForSelector("#capture-list .switch"); await M.page.waitForTimeout(300);
check("Settings has no sideways scrolling on a phone", !(await M.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)));
await shot(M.page, "after-settings-mobile.png", { fullPage: true });
await axe(M.page, "Settings (phone)");
await D.page.click('[data-view="settings"]'); await D.page.waitForSelector("#capture-list .switch"); await D.page.waitForTimeout(300);
await shot(D.page, "after-settings-dark.png", { fullPage: true });
await axe(D.page, "Settings (dark)");
await D.page.click('[data-view="memory"]'); await D.page.waitForSelector("article.entry");
await D.page.click("#select-toggle"); await D.page.waitForSelector("#selbar:not([hidden])");
await shot(D.page, "after-select-dark.png");
await axe(D.page, "Memory choosing several (dark)");

const X = await open({ viewport: { width: 390, height: 844 }, hasTouch: true });
await X.ctx.addInitScript(() => { try { localStorage.setItem("memvault-text", "3"); } catch { /* storage blocked */ } });
await X.page.goto(`${base}/#token=${token}`); await X.page.waitForSelector(".entry"); await X.page.waitForTimeout(300);
const wide = [];
for (const v of ["memory", "agents", "vault", "security", "settings"]) {
  await X.page.click(`.tab[data-view="${v}"]`); await X.page.waitForTimeout(700);
  const r = await X.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  if (r.sw > r.cw) wide.push(`${v}: ${r.sw}>${r.cw}`);
}
check("no sideways scrolling on any screen at 390px with the largest text", wide.length === 0, wide.join(", "));
check("largest text really is on in that check", (await X.page.getAttribute("html", "data-text")) === "xl");

const F = await open({ forcedColors: "active" });
await F.page.goto(`${base}/#token=${token}`); await F.page.waitForSelector(".entry");
await shot(F.page, 'memory-forced-colors.png');
check("forced-colours (Windows High Contrast) mode renders without errors", F.bad.errors.length === 0);

const K = await open();
await K.page.goto(`${base}/#token=${token}`); await K.page.waitForSelector(".entry");
await K.page.keyboard.press("Tab");
check("first Tab stop is the 'Skip to content' link", (await K.page.evaluate(() => document.activeElement.className)) === "skip");
let reached = false;
for (let i = 0; i < 25 && !reached; i++) { await K.page.keyboard.press("Tab"); reached = await K.page.evaluate(() => document.activeElement?.id === "diary-input"); }
check("keyboard users can reach the note box in a few key presses", reached);
await K.page.keyboard.type("Typed with the keyboard only");
await K.page.keyboard.press("Control+Enter");
await K.page.waitForSelector("#toast.show");
check("Ctrl+Enter saves a note", /saved/i.test(await K.page.locator("#toast").innerText()));
const focusVisible = await K.page.evaluate(() => { const b = document.querySelector(".tab"); b.focus({ focusVisible: true }); const s = getComputedStyle(b); return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2; });
check("focus is clearly visible", focusVisible);

const N = await open();
await N.page.goto(base); await N.page.waitForSelector("#dlg-connect[open]");
check("without an access key it asks to connect and shows no data", (await N.page.locator(".entry").count()) === 0);
await axe(N.page, "Connect dialog (no key)");
await N.page.fill("#token-input", "not-the-key"); await N.page.click('#connect-form button[type="submit"]');
await N.page.waitForSelector("#token-error:not([hidden])");
check("a wrong dashboard key is explained, and the window stays open", /did not work/.test(await N.page.locator("#token-error").innerText()) && await N.page.locator("#dlg-connect").evaluate((d) => d.open));
await N.page.keyboard.press("Escape");
check("Escape cannot dismiss it while there is no working key", await N.page.locator("#dlg-connect").evaluate((d) => d.open));
await N.page.fill("#token-input", token); await N.page.click('#connect-form button[type="submit"]');
await N.page.waitForSelector("article.entry");
check("the right key opens the dashboard", (await N.page.locator("#dlg-connect[open]").count()) === 0);

// ═════ J. a new, empty vault: one clear next step ═════
const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memvault-e2e-empty-"));
const evdb = openVaultDb({ root: emptyRoot });
const ecfg = path.join(emptyRoot, "rc.json"); fs.writeFileSync(ecfg, "{}");
const eport = await new Promise((res) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const q = s.address().port; s.close(() => res(q)); }); });
const eserver = await new Promise((res) => { const s = createApp({ vdb: evdb, token, port: eport, root: emptyRoot, config: { load: () => JSON.parse(fs.readFileSync(ecfg, "utf8")), save: (c) => fs.writeFileSync(ecfg, JSON.stringify(c)), passphraseFile: path.join(emptyRoot, "outside", "pp") } }).listen(eport, "127.0.0.1", () => res(s)); });
const E = await open();
await E.page.goto(`http://127.0.0.1:${eport}/#token=${token}`); await E.page.waitForSelector("#empty-state:not([hidden])");
const shown = async (sel) => E.page.locator(sel).first().isVisible();
check("an empty vault shows one friendly next step", /Your memory is empty/.test(await E.page.locator("#empty-state").innerText()) && (await E.page.locator("#empty-state [data-action=\"connect-apps\"]").count()) === 1 && await shown("#diary-input"));
check("an empty vault hides the zero tiles, filters, search and select controls", !(await shown("#stats")) && !(await shown(".toolbar")) && !(await shown("#search-form")) && !(await shown("#select-toggle")) && (await E.page.locator("#entries .empty").count()) === 0);
await axe(E.page, "Memory (empty vault)");
await shot(E.page, "memory-empty.png", { fullPage: true });
await E.page.click('.tab[data-view="agents"]'); await E.page.waitForSelector("#agents .empty");
check("with no agents, the message spans the whole grid", await E.page.evaluate(() => { const g = document.querySelector("#agents").getBoundingClientRect(); const e = document.querySelector("#agents > .empty").getBoundingClientRect(); return Math.abs(g.width - e.width) < 2; }));
await E.page.click('.tab[data-view="memory"]'); await E.page.waitForSelector("#diary-input");
await E.page.fill("#diary-input", "My first note"); await E.page.click("#save-btn");
await E.page.waitForSelector("article.entry");
check("after the first note, the tiles, search and list come back", await shown("#stats") && await shown("#search-form") && !(await shown("#empty-state")));
check("the empty vault made no third-party requests and had no errors", E.bad.external.length === 0 && E.bad.errors.length === 0 && E.bad.csp.length === 0, [...E.bad.external, ...E.bad.errors, ...E.bad.csp].join("|"));
eserver.close();
fs.rmSync(emptyRoot, { recursive: true, force: true });

// ═════ K. your devices: the settings card, and a phone signing in with a one-time code ═════
const DV = await open();
const kp = DV.page;
await kp.goto(`${base}/#token=${token}`); await kp.waitForSelector("article.entry");
await kp.click('.tab[data-view="settings"]'); await kp.waitForSelector("#devices-info p");
check("Settings shows 'Your devices', off until it is switched on", /Syncing is off/.test(await kp.locator("#devices-info").innerText()) && !(await kp.locator("#dv-on").isChecked()));
await kp.click('[data-action="pair-phone"]'); await kp.waitForSelector("#pair-code:not([hidden]) .big");
const pairCode = (await kp.locator("#pair-code .big").innerText()).trim();
check("'Add a phone or tablet' shows a one-time code", /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pairCode), pairCode);
await axe(kp, "Settings with a pairing code");
await kp.locator("#s-devices").scrollIntoViewIfNeeded(); await shot(kp, "settings-devices.png");
const PH = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await PH.page.goto(`${base}/`); await PH.page.waitForSelector("#dlg-connect[open]");
await axe(PH.page, "Connect window on a phone (pairing code)");
await shot(PH.page, "phone-pairing.png", { fullPage: true });
await PH.page.fill("#pair-input", pairCode.toLowerCase()); await PH.page.fill("#pair-name", "Test phone");
await PH.page.click('#pair-form button[type="submit"]');
await PH.page.waitForSelector("article.entry");
check("a phone signs in with the code and sees the memories", (await PH.page.locator("#dlg-connect[open]").count()) === 0);
await PH.page.reload(); await PH.page.waitForSelector("article.entry");
check("and stays signed in after a reload, with a key of its own", (await PH.page.locator("#dlg-connect[open]").count()) === 0 && await PH.page.evaluate(() => (localStorage.getItem("memvault-device-key") || "").startsWith("mvd_")));
check("the same code does not work twice", (await (await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pairCode }) })).status) === 401);
await PH.page.click('.tab[data-view="settings"]'); await PH.page.waitForSelector("#devices-info p");
const onPhone = async (sel) => PH.page.locator(sel).first().isVisible();
check("on the phone, Settings hides what only a computer may change", await onPhone("#dv-phone-note") && await onPhone('[data-action="devices-sync"]')
  && !(await onPhone("#pair-phone-row")) && !(await onPhone("#dv-pass-form")) && !(await onPhone("#pass-form"))
  && (await PH.page.locator('#phones-list [data-action="forget-phone"]').count()) === 0 && await PH.page.locator("#dv-folder").isDisabled());
await axe(PH.page, "Settings on a phone");
await PH.page.click('.tab[data-view="memory"]');
await kp.click('.tab[data-view="memory"]'); await kp.click('.tab[data-view="settings"]');
await kp.waitForFunction(() => /Test phone/.test(document.querySelector("#phones-list")?.innerText || ""));
check("the phone is listed under 'Phones and tablets' with a way to sign it out", (await kp.locator('#phones-list [data-action="forget-phone"]').count()) === 1);
await kp.click('#phones-list [data-action="forget-phone"]'); // the confirm() is accepted by the test
await kp.waitForFunction(() => !document.querySelector('#phones-list [data-action="forget-phone"]'));
await PH.page.reload(); await PH.page.waitForSelector("#dlg-connect[open]");
check("once signed out, the phone is asked to connect again", (await PH.page.locator("#dlg-connect[open]").count()) === 1);
check("devices and pairing made no third-party requests and had no errors", [DV, PH].every((x) => x.bad.external.length === 0 && x.bad.errors.length === 0 && x.bad.csp.length === 0), [...DV.bad.errors, ...PH.bad.errors, ...DV.bad.csp, ...PH.bad.csp].join("|"));
await PH.ctx.close(); await DV.ctx.close();

const { makeOpenPage } = await load("cli-tools.mjs");
const O = await open();
await O.page.goto(pathToFileURL(makeOpenPage({ url: `${base}/#token=${token}`, dir: path.join(vaultRoot, "opendir") })).href);
await O.page.waitForSelector("article.entry");
check("the page `memvault open` uses signs in and removes the key from the address", O.page.url().startsWith(base) && !O.page.url().includes("token"), O.page.url());

await browser.close();
server.close();
fs.rmSync(vaultRoot, { recursive: true, force: true });
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
/**
 * MemVault MCP Server
 * ═══════════════════════════════════════════════════════════════════════════════
 * Model Context Protocol server that exposes your personal knowledge vault
 * to ALL AI tools — Claude, Cursor, VS Code Copilot, Antigravity, etc.
 *
 * Transport: stdio (local process — no network exposure)
 *
 * Tools:     24 (search, add, context, digests, git/files/system data, secrets list,
 *            AI-powered search & insights, backup, MCP bridges)
 * Resources: recent entries by type, vault stats
 * Prompts:   user_context, project_summary, daily_brief
 *
 * The server talks to the SQLite vault directly (see db.mjs); it does NOT need the
 * web server to be running.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  autoTag, rankByRelevance, extractKeywords,
  detectProject, generateDigest, deduplicateEntries, filterUnseen,
} from "./context-engine.mjs";
import { VAULT_ROOT, ensureVaultDir } from "./config.mjs";
import { DB_PATH, ITEM_TYPES, addItems, searchItems, queryAll, getStats } from "./db.mjs";
import { SENTINEL_ID } from "./secrets.mjs";
import { isoDate, dayRange, likeEscape, getVersion } from "./util.mjs";

ensureVaultDir();

const server = new McpServer({
  name: "memvault",
  version: getVersion(),
  description: "MemVault — Your personal knowledge vault. Search diary entries, worklogs, AI conversations, and encrypted secrets. Everything you know, searchable in milliseconds.",
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const text = (t) => ({ content: [{ type: "text", text: t }] });
const shortDate = (iso, opts = { day: "numeric", month: "short", year: "numeric" }, fallback = "unknown") =>
  iso ? new Date(iso).toLocaleDateString("en-IN", opts) : fallback;
const limitSchema = (max, dflt) =>
  z.number().int().min(1).max(max).optional().describe(`Maximum results to return (default: ${dflt})`);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** Entries whose `source` is exactly `source`, optionally narrowed by title/tags. */
function bySource(source, { match, limit, snippet }) {
  const params = [source];
  let extra = "";
  if (match) {
    const like = `%${likeEscape(match)}%`;
    extra = " AND (title LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')";
    params.push(like, like);
  }
  return queryAll(
    `SELECT title, substr(content, 1, ${snippet}) AS snippet, tags, created_at
     FROM items WHERE source = ?${extra}
     ORDER BY created_at DESC LIMIT ${limit}`,
    params
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  CORE TOOLS
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  "vault_search",
  "Search across all vault entries (diary, conversations, worklogs) by keyword or phrase. Returns matching entries with snippets. Use this when the user asks about past work, projects, decisions, or any historical information.",
  {
    query: z.string().min(1).describe("Search query — keywords, phrases, project names, or topics"),
    type: z.enum(ITEM_TYPES).optional().describe("Filter by entry type: diary, conversation, worklog, or file. Omit to search all types."),
    limit: limitSchema(50, 20),
  },
  async ({ query, type, limit }) => {
    const rows = searchItems({ terms: [query], type, limit: limit || 20, snippet: 500 });
    if (rows.length === 0) return text(`No results found for "${query}".`);

    const formatted = rows.map((r, i) =>
      `### ${i + 1}. [${r.type.toUpperCase()}] ${r.title || "Untitled"}\n📅 ${shortDate(r.created_at)} | 🏷️ ${r.tags || "none"}\n\n${r.snippet || "(no content)"}`
    ).join("\n\n---\n\n");
    return text(`## 🔍 Search Results for "${query}" (${rows.length} found)\n\n${formatted}`);
  }
);

server.tool(
  "vault_add",
  "Add a new entry to the knowledge vault. Use this to save diary entries, work logs, conversation summaries, or any knowledge the user wants to preserve. AI assistants should use this to auto-log significant work sessions.",
  {
    type: z.enum(["diary", "conversation", "worklog"]).describe("Entry type: diary (personal notes), conversation (AI chat logs), worklog (dev sessions, decisions)"),
    title: z.string().min(1).max(1000).describe("Title of the entry"),
    content: z.string().describe("Full content of the entry"),
    source: z.string().max(200).optional().describe("Source: manual, claude, cursor, copilot, etc."),
    tags: z.string().max(2000).optional().describe("Comma-separated tags for categorization"),
  },
  async ({ type, title, content, source, tags }) => {
    const { ids } = addItems([{ type, source: source || "mcp", title, content, tags }]);
    const id = ids[0];

    // Also write a flat markdown copy (human-readable backup next to the database)
    const day = isoDate();
    const folder = type === "diary" ? "entries" : type === "conversation" ? "conversations" : "worklogs";
    const dir = path.join(VAULT_ROOT, folder, day.slice(0, 4), day.slice(5, 7));
    fs.mkdirSync(dir, { recursive: true });
    const slug = title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "entry";
    const backupFile = path.join(dir, `${day}_${slug}_${id.slice(-6)}.md`);
    fs.writeFileSync(
      backupFile,
      `# ${title}\n\n${content}\n\n---\nSource: ${source || "mcp"}\nTags: ${tags || ""}\nCreated: ${new Date().toISOString()}\n`
    );

    return text(`✅ Entry saved to vault!\n\n- **ID**: ${id}\n- **Type**: ${type}\n- **Title**: ${title}\n- **Tags**: ${tags || "none"}\n- **Backed up to**: ${backupFile}`);
  }
);

server.tool(
  "vault_list",
  "List recent entries from the vault. Use this to browse what's been stored recently — diary entries, conversations, or worklogs. Good for getting an overview of recent activity.",
  {
    type: z.enum(ITEM_TYPES).optional().describe("Filter by type: diary, conversation, worklog, or file. Omit for all types."),
    limit: limitSchema(50, 15),
  },
  async ({ type, limit }) => {
    const rows = searchItems({ terms: [], type, limit: limit || 15, snippet: 300 });
    if (rows.length === 0) return text(`No entries found${type ? ` for type "${type}"` : ""}.`);

    const formatted = rows.map((r, i) =>
      `${i + 1}. **[${r.type.toUpperCase()}]** ${r.title || "Untitled"} — _${shortDate(r.created_at, undefined, "?")}_ ${r.tags ? `(${r.tags})` : ""}`
    ).join("\n");
    return text(`## 📋 Recent Entries${type ? ` (${type})` : ""}\n\n${formatted}\n\n_Total: ${rows.length} entries shown_`);
  }
);

server.tool(
  "vault_get_context",
  "Get relevant vault entries for a specific topic or task. Call this when starting a conversation or answering a complex question, to understand what the user has done before on this topic. (For better ranking prefer vault_smart_context.)",
  {
    topic: z.string().min(1).describe("Topic, project name, or description of what context is needed"),
    limit: limitSchema(20, 10),
  },
  async ({ topic, limit }) => {
    const rows = searchItems({ terms: extractKeywords(topic), orderBy: "matches", limit: limit || 10, snippet: 600 });
    if (rows.length === 0) {
      return text(`No prior context found for topic: "${topic}". This appears to be a new topic for this user.`);
    }

    const formatted = rows.map((r, i) =>
      `### ${i + 1}. ${r.title || "Untitled"} (${r.type})\n📅 ${shortDate(r.created_at, undefined, "?")} | Source: ${r.source || "unknown"}\n\n${r.snippet}`
    ).join("\n\n---\n\n");
    return text(`## 🧠 Context for "${topic}"\n\n_Found ${rows.length} relevant entries from the user's vault:_\n\n${formatted}\n\n---\n_Use this context to provide informed, personalized responses that build on the user's existing work._`);
  }
);

server.tool(
  "vault_stats",
  "Get vault statistics — entry counts by type, total entries, date range, and last activity. Use this to quickly understand the size and health of the user's knowledge vault.",
  {},
  async () => {
    const s = getStats();
    const breakdown = s.byType.map((r) => `- **${r.type}**: ${r.count} entries`).join("\n");
    return text(`## 📊 Vault Statistics\n\n- **Total entries**: ${s.total}\n- **Encrypted secrets**: ${s.secrets}\n\n### Breakdown by Type\n${breakdown || "- (empty vault)"}\n\n### Activity Range\n- **First entry**: ${s.first || "N/A"}\n- **Last entry**: ${s.last || "N/A"}\n- **Vault path**: ${VAULT_ROOT}`);
  }
);

server.tool(
  "vault_secret_list",
  "List all stored secret labels and categories (API keys, passwords, user IDs, etc.). Returns ONLY labels — never returns actual secret values. Use this when the user asks what credentials they have stored.",
  {},
  async () => {
    const rows = queryAll(
      "SELECT id, category, label, created_at FROM secrets WHERE id != ? ORDER BY category, label",
      [SENTINEL_ID]
    );
    if (rows.length === 0) return text("No secrets stored in the vault yet.");

    const grouped = {};
    for (const r of rows) (grouped[r.category] ||= []).push(r);
    const emojis = { apikey: "🔑", password: "🔐", userid: "👤", payment: "💳", phone: "📱", custom: "📦" };

    const formatted = Object.entries(grouped).map(([cat, secrets]) => {
      const items = secrets.map((s) => `  - ${s.label} _(added ${new Date(s.created_at).toLocaleDateString("en-IN")})_`).join("\n");
      return `### ${emojis[cat] || "📦"} ${cat.toUpperCase()}\n${items}`;
    }).join("\n\n");
    return text(`## 🔐 Stored Secrets (${rows.length} total)\n\n${formatted}\n\n_⚠️ Only labels shown. Values are AES-256-GCM encrypted and can only be decrypted with the master password in the MemVault web UI._`);
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  DATA CAPTURE TOOLS — Git commits, files, system, projects
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  "vault_git_log",
  "Get recent Git commits stored in the vault. Shows commit history across all tracked repositories. Use this when the user asks about recent code changes, what they committed, or project development history.",
  {
    repo: z.string().optional().describe("Filter by repository name. Leave empty for all repos."),
    limit: limitSchema(50, 20),
  },
  async ({ repo, limit }) => {
    const rows = bySource("git", { match: repo, limit: limit || 20, snippet: 500 });
    if (rows.length === 0) {
      return text(`No Git commits found${repo ? ` for repo "${repo}"` : ""}. Run \`npx @mrchartist/memvault sync\` to capture commits.`);
    }
    const formatted = rows.map((r, i) =>
      `${i + 1}. **${r.title}** — _${shortDate(r.created_at, { day: "numeric", month: "short" }, "?")}_`
    ).join("\n");
    return text(`## 📦 Git Commits${repo ? ` (${repo})` : ""}\n\n${formatted}`);
  }
);

server.tool(
  "vault_recent_files",
  "Get recently modified files across the user's projects. Shows what files were edited recently. Use this to understand current work patterns.",
  { project: z.string().optional().describe("Filter by project name. Leave empty for all.") },
  async ({ project }) => {
    const rows = bySource("filesystem", { match: project, limit: 10, snippet: 800 });
    if (rows.length === 0) return text("No file activity found. Run `npx @mrchartist/memvault sync` to capture.");
    return text(`## 📄 Recent File Activity\n\n${rows.map((r) => `### ${r.title}\n${r.snippet}`).join("\n\n---\n\n")}`);
  }
);

server.tool(
  "vault_system_info",
  "Get the user's system information — OS, hardware, dev tools, running processes. Use this to understand the user's working environment when answering system-specific questions.",
  {},
  async () => {
    const rows = bySource("system", { limit: 5, snippet: 800 });
    if (rows.length === 0) return text("No system info available. Run `npx @mrchartist/memvault sync` to capture.");
    return text(`## 💻 System Info\n\n${rows.map((r) => `### ${r.title}\n${r.snippet}`).join("\n\n")}`);
  }
);

server.tool(
  "vault_projects",
  "List the user's active development projects (from VS Code). Shows project names, paths, and recent activity. Use this to understand what projects the user is working on.",
  {},
  async () => {
    const rows = bySource("vscode", { limit: 5, snippet: 1000 });
    if (rows.length === 0) return text("No VS Code data available. Run `npx @mrchartist/memvault sync` to capture.");
    return text(`## 🗂️ Projects & Tools\n\n${rows.map((r) => `### ${r.title}\n${r.snippet}`).join("\n\n")}`);
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  SMART CONTEXT ENGINE
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  "vault_smart_context",
  "Get the most relevant vault entries for a topic, ranked by a relevance algorithm that considers keyword match strength, recency, and entry type. Automatically deduplicates and can filter entries already seen this session. THIS IS THE BEST TOOL for getting context — use it instead of vault_search when you need quality over quantity.",
  {
    topic: z.string().min(1).describe("Topic, question, or task description to find context for"),
    limit: limitSchema(30, 10),
    freshOnly: z.boolean().optional().describe("If true, only return entries not yet seen this session"),
  },
  async ({ topic, limit, freshOnly }) => {
    const maxResults = limit || 10;
    // Fetch more than needed so we can rank and deduplicate
    let rows = searchItems({ terms: extractKeywords(topic), orderBy: "matches", limit: maxResults * 3, snippet: 600 });
    if (rows.length === 0) return text(`No context found for: "${topic}". This appears to be a new topic.`);

    rows = rankByRelevance(rows, topic);
    rows = deduplicateEntries(rows, 0.55);
    rows = freshOnly ? filterUnseen(rows, maxResults) : rows.slice(0, maxResults);

    const project = detectProject(topic);
    const projectNote = project ? `\n\n> 🎯 Detected project: **${project.name}**` : "";

    const formatted = rows.map((r, i) => {
      const score = r._relevance ? ` (relevance: ${r._relevance})` : "";
      const detectedTags = autoTag(`${r.title} ${r.snippet}`);
      const tagBadges = detectedTags.length > 0 ? ` 🏷️ ${detectedTags.map((t) => `\`${t}\``).join(" ")}` : "";
      return `### ${i + 1}. ${r.title || "Untitled"} [${r.type}]\n📅 ${shortDate(r.created_at, { day: "numeric", month: "short" }, "?")}${score}${tagBadges}\n\n${r.snippet}`;
    }).join("\n\n---\n\n");

    return text(`## 🧠 Smart Context for "${topic}" (${rows.length} results)${projectNote}\n\n${formatted}\n\n---\n_Results ranked by relevance. Use this to provide context-aware, personalized responses._`);
  }
);

server.tool(
  "vault_project_context",
  "Get comprehensive context for a specific project — all related entries, detected tech stack, recent activity, and auto-tagged topics. Use this when the user is working on a known project and you need full background.",
  { project: z.string().min(1).describe("Project name (e.g. 'my-app', 'website redesign')") },
  async ({ project }) => {
    let rows = searchItems({ terms: [project], limit: 40, snippet: 500 });
    if (rows.length === 0) return text(`No entries found for project "${project}".`);

    rows = deduplicateEntries(rows, 0.5);

    const byType = {};
    for (const r of rows) (byType[r.type] ||= []).push(r);

    const techTags = autoTag(rows.map((r) => `${r.title} ${r.snippet} ${r.tags}`).join(" "));

    let output = `## 📁 Project: ${project}\n\n`;
    output += `**Total entries**: ${rows.length} | **Sources**: ${[...new Set(rows.map((r) => r.source))].filter(Boolean).join(", ")}\n`;
    if (techTags.length > 0) output += `**Tech stack**: ${techTags.map((t) => `\`${t}\``).join(" ")}\n`;

    const dates = rows.map((r) => r.created_at).filter(Boolean).sort();
    if (dates.length > 0) {
      output += `**Active**: ${new Date(dates[0]).toLocaleDateString("en-IN")} → ${new Date(dates[dates.length - 1]).toLocaleDateString("en-IN")}\n`;
    }
    output += "\n";

    const typeEmojis = { worklog: "🛠️", conversation: "💬", diary: "📔", file: "📎" };
    for (const [type, items] of Object.entries(byType)) {
      output += `### ${typeEmojis[type] || "📦"} ${type} (${items.length})\n\n`;
      for (const item of items.slice(0, 5)) {
        output += `- **${item.title}** (${shortDate(item.created_at, { day: "numeric", month: "short" }, "?")})\n`;
      }
      if (items.length > 5) output += `- _...and ${items.length - 5} more_\n`;
      output += "\n";
    }
    return text(output);
  }
);

server.tool(
  "vault_daily_digest",
  "Generate an auto-summary of a day's activity from the vault — diary entries, worklogs, conversations, projects touched, and tech stack used. Perfect for daily standup context or catching up on your day.",
  { date: dateSchema.optional().describe("Date in YYYY-MM-DD format (default: today)") },
  async ({ date }) => {
    const { start, end, date: day } = dayRange(date || isoDate());
    const rows = searchItems({ terms: [], since: start, until: end, limit: 500, snippet: 400 }).reverse();
    return text(generateDigest(rows, day));
  }
);

server.tool(
  "vault_remember",
  "Save an important piece of information to the vault for future reference. Use this when the user says 'remember this', when you discover something important during a conversation, or when you want to preserve context for future sessions. The AI proactively calls this to build persistent memory.",
  {
    what: z.string().min(1).describe("What to remember — a fact, decision, preference, or insight"),
    category: z.enum(["preference", "decision", "fact", "insight", "todo", "note"]).optional().describe("Category of the memory"),
    project: z.string().optional().describe("Related project name, if any"),
  },
  async ({ what, category, project }) => {
    const cat = category || "note";
    const now = new Date().toISOString();
    const detectedTags = autoTag(what);
    const detectedProject = project || detectProject(what)?.name;
    const tags = [
      "memory", `memory:${cat}`,
      ...(detectedProject ? [`project:${detectedProject.toLowerCase().replace(/\s+/g, "-")}`] : []),
      ...detectedTags,
    ].join(",");

    const title = `[Memory:${cat}] ${what.slice(0, 80)}${what.length > 80 ? "..." : ""}`;
    const content = [
      `## 💾 AI Memory: ${cat.toUpperCase()}`,
      "",
      what,
      "",
      "---",
      detectedProject ? `**Project**: ${detectedProject}` : "",
      `**Category**: ${cat}`,
      `**Auto-tags**: ${detectedTags.join(", ") || "none"}`,
      `**Saved**: ${now}`,
    ].filter(Boolean).join("\n");

    addItems([{ type: "diary", source: "ai-memory", title, content, tags }]);

    return text(`💾 **Remembered!**\n\n- **What**: ${what.slice(0, 100)}${what.length > 100 ? "..." : ""}\n- **Category**: ${cat}${detectedProject ? `\n- **Project**: ${detectedProject}` : ""}\n- **Tags**: \`${tags}\``);
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  RESOURCES — Read-only data the AI can access
// ═══════════════════════════════════════════════════════════════════════════

function registerResource(uri, name, description, type) {
  server.resource(name, uri, { description, mimeType: "text/plain" }, async () => {
    const rows = searchItems({ terms: [], type: type || undefined, limit: 20, snippet: 400 });
    const body = rows.length === 0
      ? `No ${type || ""} entries found.`
      : rows.map((r) => `[${r.type}] ${r.title || "Untitled"} (${shortDate(r.created_at, { day: "numeric", month: "numeric", year: "numeric" }, "?")})\n${r.snippet || ""}`).join("\n---\n");
    return { contents: [{ uri, text: body, mimeType: "text/plain" }] };
  });
}

registerResource("memvault://entries/recent", "recent-entries", "Last 20 entries across all types", null);
registerResource("memvault://entries/diary", "diary-entries", "Recent diary entries", "diary");
registerResource("memvault://entries/worklogs", "worklog-entries", "Recent work logs", "worklog");
registerResource("memvault://entries/conversations", "conversation-entries", "Recent conversations", "conversation");

server.resource(
  "vault-stats",
  "memvault://stats",
  { description: "Vault health and statistics", mimeType: "text/plain" },
  async () => {
    const s = getStats();
    const breakdown = s.byType.map((r) => `${r.type}: ${r.count}`).join(", ");
    const body = `MemVault Stats | Total: ${s.total} | ${breakdown} | Secrets: ${s.secrets} | Path: ${VAULT_ROOT}`;
    return { contents: [{ uri: "memvault://stats", text: body, mimeType: "text/plain" }] };
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  PROMPTS — Context injection templates
// ═══════════════════════════════════════════════════════════════════════════

server.prompt(
  "user_context",
  "Inject relevant vault history into the AI's context. Use this at the start of a conversation to give the AI knowledge about the user's past work, preferences, and decisions.",
  { topic: z.string().optional().describe("Optional topic to focus context on") },
  async ({ topic }) => {
    const rows = searchItems({ terms: topic ? [topic] : [], limit: 15, snippet: 300 });
    const history = rows.map((r) =>
      `- [${r.type}] ${r.title} (${shortDate(r.created_at, { day: "numeric", month: "numeric", year: "numeric" }, "?")}): ${r.snippet?.slice(0, 150) || ""}`
    ).join("\n");

    return {
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Here is relevant context from my personal knowledge vault (MemVault):\n\n${history || "No entries found."}\n\nPlease use this context to provide more informed, personalized responses that build on my existing work and knowledge. Do not repeat information I already know.`,
        },
      }],
    };
  }
);

server.prompt(
  "project_summary",
  "Generate a summary prompt for a specific project based on vault history.",
  { project: z.string().describe("Project name to summarize") },
  async ({ project }) => {
    const rows = searchItems({ terms: [project], limit: 20, snippet: 400 });
    const entries = rows.map((r) =>
      `[${shortDate(r.created_at, { day: "numeric", month: "numeric", year: "numeric" }, "?")}] [${r.type}] ${r.title}: ${r.snippet?.slice(0, 200) || ""}`
    ).join("\n");

    return {
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Summarize my work on the "${project}" project based on these vault entries:\n\n${entries || "No entries found for this project."}\n\nProvide a concise summary of: what the project is, what's been done, recent changes, and any outstanding issues.`,
        },
      }],
    };
  }
);

server.prompt(
  "daily_brief",
  "Today's diary entries and worklogs as context. Use this to catch up on what happened today.",
  {},
  async () => {
    const today = isoDate();
    const { start, end } = dayRange(today);
    const rows = searchItems({ terms: [], since: start, until: end, limit: 100, snippet: 500 });
    const entries = rows.map((r) => {
      const time = r.created_at ? new Date(r.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "?";
      return `[${time}] [${r.type}] ${r.title}: ${r.snippet?.slice(0, 200) || ""}`;
    }).join("\n");

    return {
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Here's my activity today (${today}):\n\n${entries || "No entries logged today yet."}\n\nUse this context to understand what I've been working on today.`,
        },
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  AI-POWERED TOOLS (optional — need a Gemini API key)
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  "vault_capture_prompt",
  "Automatically capture and store the user's prompt/request in the vault. AI clients can call this at the START of a conversation to build a searchable prompt history across all AI tools.",
  {
    prompt: z.string().min(1).describe("The user's original prompt or request text"),
    aiTool: z.string().max(100).optional().describe("Which AI tool captured this (e.g. 'claude', 'cursor', 'antigravity')"),
    project: z.string().max(200).optional().describe("Related project context, if known"),
  },
  async ({ prompt: userPrompt, aiTool, project }) => {
    const now = new Date().toISOString();
    const source = aiTool || "unknown-ai";
    const tags = ["prompt-log", `ai:${source}`, ...(project ? [`project:${project}`] : [])].join(",");
    const title = `[Prompt:${source}] ${userPrompt.slice(0, 80)}${userPrompt.length > 80 ? "..." : ""}`;
    const content = [
      `## 📝 Prompt Captured from ${source}`,
      "",
      userPrompt,
      "",
      "---",
      `**AI Tool**: ${source}`,
      project ? `**Project**: ${project}` : "",
      `**Captured**: ${now}`,
    ].filter(Boolean).join("\n");

    addItems([{ type: "conversation", source: `prompt-${source}`, title, content, tags }]);
    return text(`📝 Prompt logged from ${source}`);
  }
);

server.tool(
  "vault_log_conversation",
  "Save a summary of the current AI conversation to the vault. Call this when the user says 'save this conversation' or at the end of an important session. Builds persistent memory across AI tools.",
  {
    summary: z.string().min(1).describe("A concise summary of the conversation"),
    keyPoints: z.string().optional().describe("Key decisions, insights, or outcomes from the conversation"),
    aiTool: z.string().max(100).optional().describe("Which AI tool this conversation was with"),
    project: z.string().max(200).optional().describe("Related project name"),
  },
  async ({ summary, keyPoints, aiTool, project }) => {
    const now = new Date().toISOString();
    const source = aiTool || "ai-conversation";
    const tags = ["conversation-log", `ai:${source}`, ...(project ? [`project:${project}`] : [])].join(",");
    const title = `[Conv:${source}] ${summary.slice(0, 80)}`;
    const content = [
      `## 💬 Conversation Log — ${source}`,
      "",
      `**Summary**: ${summary}`,
      "",
      keyPoints ? `### Key Points\n${keyPoints}` : "",
      "",
      "---",
      project ? `**Project**: ${project}` : "",
      `**Logged**: ${now}`,
    ].filter(Boolean).join("\n");

    addItems([{ type: "conversation", source, title, content, tags }]);
    return text("💬 Conversation saved to vault!");
  }
);

const AI_OFF = "⚠️ AI features are not configured. Add your Gemini API key under \"ai\" in ~/.memvaultrc.json (or set GEMINI_API_KEY).";

server.tool(
  "vault_ai_summarize",
  "Use AI (Gemini) to generate a smart summary of vault entries matching a query. Highlights key points, decisions, and action items. Sends the matching entries to the Gemini API.",
  {
    query: z.string().min(1).describe("Search query to find entries to summarize"),
    limit: z.number().int().min(1).max(20).optional().describe("Max entries to include (default: 5)"),
  },
  async ({ query, limit }) => {
    try {
      const { isAIEnabled, summarize } = await import("./ai-engine.mjs");
      if (!isAIEnabled()) return text(AI_OFF);

      const rows = searchItems({ terms: [query], limit: limit || 5, snippet: 1500 });
      if (rows.length === 0) return text(`No entries found for "${query}"`);

      const combined = rows.map((r) => `## ${r.title}\n${r.snippet}`).join("\n\n---\n\n");
      return text(`🧠 **AI Summary for "${query}"**\n\n${await summarize(combined, { context: `Search: ${query}` })}`);
    } catch (e) {
      return text(`⚠️ AI error: ${e.message}`);
    }
  }
);

server.tool(
  "vault_ai_insights",
  "Use AI to analyze your vault data and discover patterns, productivity insights, and focus areas. Great for weekly reviews. Sends recent entry titles/snippets to the Gemini API.",
  {
    timeframe: z.enum(["today", "this week", "this month"]).optional().describe("Time period to analyze (default: this week)"),
    topic: z.string().optional().describe("Optional topic to focus insights on"),
  },
  async ({ timeframe, topic }) => {
    try {
      const { isAIEnabled, generateInsights } = await import("./ai-engine.mjs");
      if (!isAIEnabled()) return text(AI_OFF);

      const tf = timeframe || "this week";
      const range = dayRange(isoDate());
      const since = tf === "today" ? range.start : new Date(Date.now() - (tf === "this week" ? 7 : 30) * 86400000).toISOString();

      const rows = searchItems({ terms: topic ? [topic] : [], since, limit: 50, snippet: 200 });
      if (rows.length === 0) return text(`No entries found for ${tf}`);

      return text(await generateInsights(rows, { timeframe: tf }));
    } catch (e) {
      return text(`⚠️ AI error: ${e.message}`);
    }
  }
);

server.tool(
  "vault_smart_search",
  "Semantic search that understands the INTENT of your query, not just keywords. Candidates are ranked locally by relevance; if a Gemini key is configured they are re-ranked by AI (which sends candidate titles/snippets to Gemini).",
  {
    query: z.string().min(1).describe("Natural language search query"),
    limit: limitSchema(50, 10),
  },
  async ({ query, limit }) => {
    try {
      const maxResults = limit || 10;
      let rows = searchItems({ terms: extractKeywords(query), orderBy: "matches", limit: maxResults * 3, snippet: 300 });
      if (rows.length === 0) return text(`No results for "${query}"`);

      rows = rankByRelevance(rows, query);

      let aiRanked = false;
      const { isAIEnabled, semanticRerank } = await import("./ai-engine.mjs");
      if (isAIEnabled()) {
        try {
          rows = await semanticRerank(query, rows);
          aiRanked = true;
        } catch { /* fall back to local ranking */ }
      }

      const output = rows.slice(0, maxResults).map((r, i) =>
        `${i + 1}. **${r.title}** [${r.type}] — ${r.created_at?.split("T")[0] || "?"}\n   ${(r.snippet || "").slice(0, 150)}...`
      ).join("\n\n");
      return text(`🔍 **Smart Search${aiRanked ? " (AI-ranked)" : ""}**: "${query}"\n\n${output}`);
    } catch (e) {
      return text(`⚠️ Search error: ${e.message}`);
    }
  }
);

server.tool(
  "vault_weekly_digest",
  "Generate an AI-powered weekly digest of all your vault activity — projects, conversations, insights, and recommended actions. Sends recent entry titles/snippets to the Gemini API.",
  {},
  async () => {
    try {
      const { isAIEnabled, weeklyDigest } = await import("./ai-engine.mjs");
      if (!isAIEnabled()) return text(AI_OFF);

      const since = new Date(Date.now() - 7 * 86400000).toISOString();
      const rows = searchItems({ terms: [], since, limit: 50, snippet: 200 }).map((r) => ({ ...r, content: r.snippet }));
      if (rows.length === 0) return text("No activity found this week!");

      return text(await weeklyDigest(rows));
    } catch (e) {
      return text(`⚠️ AI error: ${e.message}`);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  STORAGE & BACKUP — local + Google Drive
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  "vault_backup",
  "Back up the entire vault (database + entries) to all enabled storage backends — a local timestamped copy plus Google Drive (folder mirror and/or Drive API). Use when the user asks to back up, save, or sync their data to Google Drive.",
  {},
  async () => {
    try {
      const { backupVault, enabledBackends } = await import("./storage.mjs");
      const results = await backupVault();
      const lines = results.map((r) => (r.ok ? `- ✅ **${r.backend}** → ${r.location}` : `- ❌ **${r.backend}** — ${r.error}`));
      return text(`## 💾 Backup complete\n\nBackends: ${enabledBackends().join(", ")}\n\n${lines.join("\n")}`);
    } catch (e) {
      return text(`⚠️ Backup error: ${e.message}`);
    }
  }
);

server.tool(
  "vault_backups",
  "List local timestamped vault backups that are available to restore.",
  {},
  async () => {
    const { listLocalBackups } = await import("./storage.mjs");
    const backups = listLocalBackups();
    if (backups.length === 0) return text("No local backups yet. Run vault_backup to create one.");
    const lines = backups.map((b) => `- \`${b.name}\` — ${(b.size / 1024).toFixed(1)} KB, ${b.modified}`);
    return text(`## 📜 Local backups (${backups.length})\n\n${lines.join("\n")}`);
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  MCP BRIDGES — connect to OTHER AI tools' MCP servers
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  "vault_bridge_list",
  "List the other AI MCP servers MemVault is bridged to (configured under mcpBridges) and the tools/resources each one exposes. Use to see which external AI memories/tools are connected.",
  {},
  async () => {
    try {
      const { enabledBridges, inspectBridge, PRESET_BRIDGES } = await import("./mcp-bridge.mjs");
      const bridges = enabledBridges();
      if (bridges.length === 0) {
        const presetList = PRESET_BRIDGES.map((p) => `- \`${p.name}\` — ${p.description}`).join("\n");
        return text(`No MCP bridges enabled yet.\n\n**Available presets** (enable with \`npx @mrchartist/memvault bridge add <name>\`):\n${presetList}`);
      }
      const blocks = [];
      for (const b of bridges) {
        try {
          const info = await inspectBridge(b);
          blocks.push(`### 🔌 ${info.name}\n- Tools: ${info.tools.map((t) => t.name).join(", ") || "(none)"}\n- Resources: ${info.resources.map((r) => r.name || r.uri).join(", ") || "(none)"}`);
        } catch (e) {
          blocks.push(`### 🔌 ${b.name}\n- ❌ ${e.message}`);
        }
      }
      return text(`## Connected MCP Bridges\n\n${blocks.join("\n\n")}`);
    } catch (e) {
      return text(`⚠️ Bridge error: ${e.message}`);
    }
  }
);

server.tool(
  "vault_bridge_sync",
  "Pull data from connected AI MCP servers into the vault so all your AI tools share one memory. Optionally target a single bridge by name; otherwise syncs all enabled bridges.",
  { name: z.string().optional().describe("Name of a specific bridge to sync. Omit to sync all enabled bridges.") },
  async ({ name }) => {
    try {
      const { enabledBridges, syncBridge } = await import("./mcp-bridge.mjs");
      const targets = name ? enabledBridges().filter((b) => b.name === name) : enabledBridges();
      if (targets.length === 0) return text(name ? `No enabled bridge named "${name}".` : "No MCP bridges configured.");

      const lines = [];
      for (const b of targets) {
        try {
          const r = await syncBridge(b);
          lines.push(`- ✅ **${b.name}** — ingested ${r.ingested} item(s)${r.errors.length ? `, ${r.errors.length} error(s)` : ""}`);
        } catch (e) {
          lines.push(`- ❌ **${b.name}** — ${e.message}`);
        }
      }
      return text(`## 🔄 Bridge sync\n\n${lines.join("\n")}`);
    } catch (e) {
      return text(`⚠️ Bridge error: ${e.message}`);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════════════════════════════════════

await server.connect(new StdioServerTransport());

// Log to stderr (stdout is reserved for the MCP protocol)
process.stderr.write(`[MemVault MCP] v${getVersion()} started — stdio transport\n`);
process.stderr.write(`[MemVault MCP] VAULT_ROOT=${VAULT_ROOT}\n`);
process.stderr.write(`[MemVault MCP] DB_PATH=${DB_PATH}\n`);

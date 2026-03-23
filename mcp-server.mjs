#!/usr/bin/env node
/**
 * MemVault MCP Server
 * ═══════════════════════════════════════════════════════════════════════════════
 * Model Context Protocol server that exposes your personal knowledge vault
 * to ALL AI tools — Antigravity, Claude, VS Code Copilot, Cursor, etc.
 *
 * Transport: stdio (local process, maximum security — no network exposure)
 *
 * Tools:     vault_search, vault_add, vault_list, vault_get_context,
 *            vault_stats, vault_secret_list,
 *            vault_git_log, vault_recent_files, vault_system_info, vault_projects
 * Resources: recent entries by type, vault stats
 * Prompts:   user_context, project_summary, daily_brief
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import initSqlJs from "sql.js";
import {
  autoTag, mergeAutoTags, scoreRelevance, rankByRelevance,
  detectProject, generateDigest, deduplicateEntries,
  filterUnseen, resetSession, getSessionStats,
} from "./context-engine.mjs";

import { VAULT_ROOT, ensureVaultDir } from "./config.mjs";

// ─── Configuration ──────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
ensureVaultDir();
const DB_PATH = path.join(VAULT_ROOT, "db", "index.sqlite");

// ─── Database Setup ─────────────────────────────────────────────────────────

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
ensureDir(path.join(VAULT_ROOT, "db"));

const Sql = await initSqlJs();
let db;

function loadDb() {
  if (fs.existsSync(DB_PATH)) {
    const filebuf = fs.readFileSync(DB_PATH);
    db = new Sql.Database(filebuf);
  } else {
    db = new Sql.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT,
      title TEXT,
      content TEXT,
      file_path TEXT,
      tags TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
    CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS secrets (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      encrypted TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_secrets_category ON secrets(category);
  `);

  persistDb();
}

function persistDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

loadDb();

// ─── Database Helpers ───────────────────────────────────────────────────────

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function runSql(sql, params = []) {
  db.run(sql, params);
  persistDb();
}

function isoDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ─── Create MCP Server ─────────────────────────────────────────────────────

const server = new McpServer({
  name: "memvault",
  version: "2.0.0",
  description: "MemVault — Your personal knowledge vault. Search diary entries, worklogs, AI conversations, and encrypted secrets. Everything you know, searchable in milliseconds.",
});

// ═══════════════════════════════════════════════════════════════════════════
//  TOOLS — AI calls these to interact with your vault
// ═══════════════════════════════════════════════════════════════════════════

// 🔍 vault_search — Full-text search across all entries
server.tool(
  "vault_search",
  "Search across all vault entries (diary, conversations, worklogs) using full-text search. Returns matching entries with snippets. Use this when the user asks about past work, projects, decisions, or any historical information.",
  {
    query: z.string().describe("Search query — keywords, phrases, project names, or topics"),
    type: z.enum(["diary", "conversation", "worklog", "file", ""]).optional().describe("Filter by entry type: diary, conversation, worklog, file. Leave empty for all."),
    limit: z.number().min(1).max(50).optional().describe("Maximum results to return (default: 20)"),
  },
  async ({ query, type, limit }) => {
    const maxResults = limit || 20;
    const like = `%${query}%`;
    const where = type ? `AND type = ?` : "";
    const params = type ? [like, like, like, type] : [like, like, like];

    const rows = queryAll(
      `SELECT id, type, source, title, substr(content, 1, 500) as snippet, tags, created_at
       FROM items
       WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?)
       ${where}
       ORDER BY created_at DESC
       LIMIT ${maxResults};`,
      params
    );

    if (rows.length === 0) {
      return { content: [{ type: "text", text: `No results found for "${query}".` }] };
    }

    const formatted = rows.map((r, i) => {
      const date = r.created_at ? new Date(r.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "unknown";
      return `### ${i + 1}. [${r.type.toUpperCase()}] ${r.title || "Untitled"}\n📅 ${date} | 🏷️ ${r.tags || "none"}\n\n${r.snippet || "(no content)"}`;
    }).join("\n\n---\n\n");

    return {
      content: [{
        type: "text",
        text: `## 🔍 Search Results for "${query}" (${rows.length} found)\n\n${formatted}`,
      }],
    };
  }
);

// ➕ vault_add — Add a new entry to the vault
server.tool(
  "vault_add",
  "Add a new entry to the knowledge vault. Use this to save diary entries, work logs, conversation summaries, or any knowledge the user wants to preserve. AI assistants should use this to auto-log significant work sessions.",
  {
    type: z.enum(["diary", "conversation", "worklog"]).describe("Entry type: diary (personal notes), conversation (AI chat logs), worklog (dev sessions, decisions)"),
    title: z.string().describe("Title of the entry"),
    content: z.string().describe("Full content of the entry"),
    source: z.string().optional().describe("Source: manual, antigravity, chatgpt, claude, copilot, etc."),
    tags: z.string().optional().describe("Comma-separated tags for categorization"),
  },
  async ({ type, title, content, source, tags }) => {
    const id = `${type}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const created_at = new Date().toISOString();

    runSql(
      `INSERT INTO items (id, type, source, title, content, file_path, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, type, source || "mcp", title, content, null, tags || null, created_at]
    );

    // Also write to flat file backup
    const day = isoDate();
    const backupDir = path.join(VAULT_ROOT, type === "diary" ? "entries" : type === "conversation" ? "conversations" : "worklogs", day.slice(0, 4), day.slice(5, 7));
    ensureDir(backupDir);

    const safeTitle = title.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
    const backupFile = path.join(backupDir, `${day}_${safeTitle}.md`);
    fs.writeFileSync(backupFile, `# ${title}\n\n${content}\n\n---\nSource: ${source || "mcp"}\nTags: ${tags || ""}\nCreated: ${created_at}\n`);

    return {
      content: [{
        type: "text",
        text: `✅ Entry saved to vault!\n\n- **ID**: ${id}\n- **Type**: ${type}\n- **Title**: ${title}\n- **Tags**: ${tags || "none"}\n- **Backed up to**: ${backupFile}`,
      }],
    };
  }
);

// 📋 vault_list — List recent entries
server.tool(
  "vault_list",
  "List recent entries from the vault. Use this to browse what's been stored recently — diary entries, conversations, or worklogs. Good for getting an overview of recent activity.",
  {
    type: z.enum(["diary", "conversation", "worklog", "file", ""]).optional().describe("Filter by type. Leave empty for all types."),
    limit: z.number().min(1).max(50).optional().describe("Maximum entries to return (default: 15)"),
  },
  async ({ type, limit }) => {
    const maxResults = limit || 15;
    const where = type ? `WHERE type = ?` : "";
    const params = type ? [type] : [];

    const rows = queryAll(
      `SELECT id, type, source, title, substr(content, 1, 300) as snippet, tags, created_at
       FROM items ${where}
       ORDER BY created_at DESC
       LIMIT ${maxResults};`,
      params
    );

    if (rows.length === 0) {
      return { content: [{ type: "text", text: `No entries found${type ? ` for type "${type}"` : ""}.` }] };
    }

    const formatted = rows.map((r, i) => {
      const date = r.created_at ? new Date(r.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "?";
      return `${i + 1}. **[${r.type.toUpperCase()}]** ${r.title || "Untitled"} — _${date}_ ${r.tags ? `(${r.tags})` : ""}`;
    }).join("\n");

    return {
      content: [{
        type: "text",
        text: `## 📋 Recent Entries${type ? ` (${type})` : ""}\n\n${formatted}\n\n_Total: ${rows.length} entries shown_`,
      }],
    };
  }
);

// 🧠 vault_get_context — Smart context for current task
server.tool(
  "vault_get_context",
  "Get relevant vault entries for a specific topic or task. This is the PRIMARY tool for making AI responses context-aware. When starting a conversation or answering a complex question, call this first to understand what the user has done before on this topic.",
  {
    topic: z.string().describe("Topic, project name, or description of what context is needed"),
    limit: z.number().min(1).max(20).optional().describe("Maximum context entries (default: 10)"),
  },
  async ({ topic, limit }) => {
    const maxResults = limit || 10;
    const keywords = topic.split(/\s+/).filter(w => w.length > 2);
    const conditions = keywords.map(() => "(title LIKE ? OR content LIKE ? OR tags LIKE ?)").join(" OR ");
    const params = keywords.flatMap(k => {
      const like = `%${k}%`;
      return [like, like, like];
    });

    const rows = queryAll(
      `SELECT id, type, source, title, substr(content, 1, 600) as snippet, tags, created_at
       FROM items
       WHERE ${conditions || "1=1"}
       ORDER BY created_at DESC
       LIMIT ${maxResults};`,
      params
    );

    if (rows.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No prior context found for topic: "${topic}". This appears to be a new topic for this user.`,
        }],
      };
    }

    const formatted = rows.map((r, i) => {
      const date = r.created_at ? new Date(r.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "?";
      return `### ${i + 1}. ${r.title || "Untitled"} (${r.type})\n📅 ${date} | Source: ${r.source || "unknown"}\n\n${r.snippet}`;
    }).join("\n\n---\n\n");

    return {
      content: [{
        type: "text",
        text: `## 🧠 Context for "${topic}"\n\n_Found ${rows.length} relevant entries from the user's vault:_\n\n${formatted}\n\n---\n_Use this context to provide informed, personalized responses that build on the user's existing work._`,
      }],
    };
  }
);

// 📊 vault_stats — Vault statistics
server.tool(
  "vault_stats",
  "Get vault statistics — entry counts by type, total entries, date range, and last activity. Use this to quickly understand the size and health of the user's knowledge vault.",
  {},
  async () => {
    const total = queryAll("SELECT COUNT(*) as count FROM items")[0]?.count || 0;
    const byType = queryAll("SELECT type, COUNT(*) as count FROM items GROUP BY type ORDER BY count DESC");
    const lastEntry = queryAll("SELECT created_at FROM items ORDER BY created_at DESC LIMIT 1")[0];
    const firstEntry = queryAll("SELECT created_at FROM items ORDER BY created_at ASC LIMIT 1")[0];
    const secretCount = queryAll("SELECT COUNT(*) as count FROM secrets WHERE id != '__sentinel__'")[0]?.count || 0;

    const typeBreakdown = byType.map(r => `- **${r.type}**: ${r.count} entries`).join("\n");

    return {
      content: [{
        type: "text",
        text: `## 📊 Vault Statistics\n\n- **Total entries**: ${total}\n- **Encrypted secrets**: ${secretCount}\n\n### Breakdown by Type\n${typeBreakdown || "- (empty vault)"}\n\n### Activity Range\n- **First entry**: ${firstEntry?.created_at || "N/A"}\n- **Last entry**: ${lastEntry?.created_at || "N/A"}\n- **Vault path**: ${VAULT_ROOT}`,
      }],
    };
  }
);

// 🔐 vault_secret_list — List secret labels (no decryption)
server.tool(
  "vault_secret_list",
  "List all stored secret labels and categories (API keys, passwords, user IDs, etc.). Returns ONLY labels — never returns actual secret values. Use this when the user asks what credentials they have stored.",
  {},
  async () => {
    const rows = queryAll(
      "SELECT id, category, label, created_at FROM secrets WHERE id != '__sentinel__' ORDER BY category, label"
    );

    if (rows.length === 0) {
      return { content: [{ type: "text", text: "No secrets stored in the vault yet." }] };
    }

    const grouped = {};
    for (const r of rows) {
      if (!grouped[r.category]) grouped[r.category] = [];
      grouped[r.category].push(r);
    }

    const categoryEmojis = {
      apikey: "🔑", password: "🔐", userid: "👤",
      payment: "💳", phone: "📱", custom: "📦"
    };

    const formatted = Object.entries(grouped).map(([cat, secrets]) => {
      const emoji = categoryEmojis[cat] || "📦";
      const items = secrets.map(s => `  - ${s.label} _(added ${new Date(s.created_at).toLocaleDateString("en-IN")})_`).join("\n");
      return `### ${emoji} ${cat.toUpperCase()}\n${items}`;
    }).join("\n\n");

    return {
      content: [{
        type: "text",
        text: `## 🔐 Stored Secrets (${rows.length} total)\n\n${formatted}\n\n_⚠️ Only labels shown. Values are AES-256-GCM encrypted and require the master password to decrypt via the web UI._`,
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 2 TOOLS — Data capture: Git commits, files, system, projects
// ═══════════════════════════════════════════════════════════════════════════

// 📦 vault_git_log — Recent Git commits from vault
server.tool(
  "vault_git_log",
  "Get recent Git commits stored in the vault. Shows commit history across all tracked repositories. Use this when the user asks about recent code changes, what they committed, or project development history.",
  {
    repo: z.string().optional().describe("Filter by repository name. Leave empty for all repos."),
    limit: z.number().min(1).max(50).optional().describe("Maximum commits to return (default: 20)"),
  },
  async ({ repo, limit }) => {
    const maxResults = limit || 20;
    const where = repo
      ? `WHERE source = 'git' AND (tags LIKE ? OR title LIKE ?)`
      : `WHERE source = 'git'`;
    const params = repo ? [`%${repo}%`, `%${repo}%`] : [];

    const rows = queryAll(
      `SELECT title, substr(content, 1, 500) as snippet, tags, created_at
       FROM items ${where}
       ORDER BY created_at DESC LIMIT ${maxResults};`,
      params
    );

    if (rows.length === 0) {
      return { content: [{ type: "text", text: `No Git commits found${repo ? ` for repo "${repo}"` : ""}. Run \`node sync-git.mjs\` to sync commits.` }] };
    }

    const formatted = rows.map((r, i) => {
      const date = r.created_at ? new Date(r.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "?";
      return `${i + 1}. **${r.title}** — _${date}_`;
    }).join("\n");

    return {
      content: [{ type: "text", text: `## 📦 Git Commits${repo ? ` (${repo})` : ""}\n\n${formatted}` }],
    };
  }
);

// 📄 vault_recent_files — Recently modified files
server.tool(
  "vault_recent_files",
  "Get recently modified files across the user's projects. Shows what files were edited recently. Use this to understand current work patterns.",
  {
    project: z.string().optional().describe("Filter by project name. Leave empty for all."),
  },
  async ({ project }) => {
    const where = project
      ? `WHERE source = 'filesystem' AND (title LIKE ? OR tags LIKE ?)`
      : `WHERE source = 'filesystem'`;
    const params = project ? [`%${project}%`, `%${project}%`] : [];

    const rows = queryAll(
      `SELECT title, substr(content, 1, 800) as snippet, created_at
       FROM items ${where}
       ORDER BY created_at DESC LIMIT 10;`,
      params
    );

    if (rows.length === 0) {
      return { content: [{ type: "text", text: `No file activity found. Run \`node sync-files.mjs\` to capture.` }] };
    }

    const formatted = rows.map(r => `### ${r.title}\n${r.snippet}`).join("\n\n---\n\n");
    return {
      content: [{ type: "text", text: `## 📄 Recent File Activity\n\n${formatted}` }],
    };
  }
);

// 💻 vault_system_info — System environment info
server.tool(
  "vault_system_info",
  "Get the user's system information — OS, hardware, dev tools, running processes. Use this to understand the user's working environment when answering system-specific questions.",
  {},
  async () => {
    const rows = queryAll(
      `SELECT title, substr(content, 1, 800) as snippet, created_at
       FROM items WHERE source = 'system'
       ORDER BY created_at DESC LIMIT 5;`
    );

    if (rows.length === 0) {
      return { content: [{ type: "text", text: `No system info available. Run \`node sync-system.mjs\` to capture.` }] };
    }

    const formatted = rows.map(r => `### ${r.title}\n${r.snippet}`).join("\n\n");
    return {
      content: [{ type: "text", text: `## 💻 System Info\n\n${formatted}` }],
    };
  }
);

// 🗂️ vault_projects — Active VS Code projects
server.tool(
  "vault_projects",
  "List the user's active development projects (from VS Code). Shows project names, paths, and recent activity. Use this to understand what projects the user is working on.",
  {},
  async () => {
    const rows = queryAll(
      `SELECT title, substr(content, 1, 1000) as snippet, created_at
       FROM items WHERE source = 'vscode'
       ORDER BY created_at DESC LIMIT 5;`
    );

    if (rows.length === 0) {
      return { content: [{ type: "text", text: `No VS Code data available. Run \`node sync-vscode.mjs\` to capture.` }] };
    }

    const formatted = rows.map(r => `### ${r.title}\n${r.snippet}`).join("\n\n");
    return {
      content: [{ type: "text", text: `## 🗂️ Projects & Tools\n\n${formatted}` }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 3 TOOLS — Smart Context Engine
// ═══════════════════════════════════════════════════════════════════════════

// 🧠 vault_smart_context — Relevance-ranked context
server.tool(
  "vault_smart_context",
  "Get the most relevant vault entries for a topic, ranked by a smart relevance algorithm that considers keyword match strength, recency, and entry type. Automatically deduplicates and filters previously seen entries. THIS IS THE BEST TOOL for getting context — use it instead of vault_search when you need quality over quantity.",
  {
    topic: z.string().describe("Topic, question, or task description to find context for"),
    limit: z.number().min(1).max(30).optional().describe("Max results (default: 10)"),
    freshOnly: z.boolean().optional().describe("If true, only return entries not yet seen this session"),
  },
  async ({ topic, limit, freshOnly }) => {
    const maxResults = limit || 10;
    const keywords = topic.split(/\s+/).filter(w => w.length > 2);
    const conditions = keywords.map(() => "(title LIKE ? OR content LIKE ? OR tags LIKE ?)").join(" OR ");
    const params = keywords.flatMap(k => { const l = `%${k}%`; return [l, l, l]; });

    // Fetch more than needed so we can rank and deduplicate
    let rows = queryAll(
      `SELECT id, type, source, title, substr(content, 1, 600) as snippet, tags, created_at
       FROM items
       WHERE ${conditions || "1=1"}
       ORDER BY created_at DESC
       LIMIT ${maxResults * 3};`,
      params
    );

    if (rows.length === 0) {
      return { content: [{ type: "text", text: `No context found for: "${topic}". This appears to be a new topic.` }] };
    }

    // Smart pipeline: rank → deduplicate → filter seen → limit
    rows = rankByRelevance(rows, topic);
    rows = deduplicateEntries(rows, 0.55);
    if (freshOnly) rows = filterUnseen(rows);
    rows = rows.slice(0, maxResults);

    // Auto-detect project
    const project = detectProject(topic);
    const projectNote = project ? `\n\n> 🎯 Detected project: **${project.name}**` : "";

    const formatted = rows.map((r, i) => {
      const date = r.created_at ? new Date(r.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "?";
      const score = r._relevance ? ` (relevance: ${r._relevance})` : "";
      const detectedTags = autoTag(`${r.title} ${r.snippet}`);
      const tagBadges = detectedTags.length > 0 ? ` 🏷️ ${detectedTags.map(t => `\`${t}\``).join(" ")}` : "";
      return `### ${i + 1}. ${r.title || "Untitled"} [${r.type}]\n📅 ${date}${score}${tagBadges}\n\n${r.snippet}`;
    }).join("\n\n---\n\n");

    return {
      content: [{
        type: "text",
        text: `## 🧠 Smart Context for "${topic}" (${rows.length} results)${projectNote}\n\n${formatted}\n\n---\n_Results ranked by relevance. Use this to provide context-aware, personalized responses._`,
      }],
    };
  }
);

// 📁 vault_project_context — Full project context
server.tool(
  "vault_project_context",
  "Get comprehensive context for a specific project — all related entries, detected tech stack, recent activity, and auto-tagged topics. Use this when the user is working on a known project and you need full background.",
  {
    project: z.string().describe("Project name (e.g., 'Investology', 'MemVault', 'TradeBook')"),
  },
  async ({ project }) => {
    const like = `%${project}%`;

    let rows = queryAll(
      `SELECT id, type, source, title, substr(content, 1, 500) as snippet, tags, created_at
       FROM items
       WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?)
       ORDER BY created_at DESC
       LIMIT 40;`,
      [like, like, like]
    );

    if (rows.length === 0) {
      return { content: [{ type: "text", text: `No entries found for project "${project}".` }] };
    }

    rows = deduplicateEntries(rows, 0.5);

    // Group by type
    const byType = {};
    for (const r of rows) {
      if (!byType[r.type]) byType[r.type] = [];
      byType[r.type].push(r);
    }

    // Detect tech stack
    const allText = rows.map(r => `${r.title} ${r.snippet} ${r.tags}`).join(" ");
    const techTags = autoTag(allText);

    // Build summary
    let output = `## 📁 Project: ${project}\n\n`;
    output += `**Total entries**: ${rows.length} | **Sources**: ${[...new Set(rows.map(r => r.source))].filter(Boolean).join(", ")}\n`;

    if (techTags.length > 0) {
      output += `**Tech stack**: ${techTags.map(t => `\`${t}\``).join(" ")}\n`;
    }

    // Activity timeline
    const dates = rows.map(r => r.created_at).filter(Boolean).sort();
    if (dates.length > 0) {
      output += `**Active**: ${new Date(dates[0]).toLocaleDateString("en-IN")} → ${new Date(dates[dates.length - 1]).toLocaleDateString("en-IN")}\n`;
    }

    output += "\n";

    // Recent entries by type
    const typeEmojis = { worklog: "🛠️", conversation: "💬", diary: "📔", file: "📎" };
    for (const [type, items] of Object.entries(byType)) {
      const emoji = typeEmojis[type] || "📦";
      output += `### ${emoji} ${type} (${items.length})\n\n`;
      for (const item of items.slice(0, 5)) {
        const date = item.created_at ? new Date(item.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "?";
        output += `- **${item.title}** (${date})\n`;
      }
      if (items.length > 5) output += `- _...and ${items.length - 5} more_\n`;
      output += "\n";
    }

    return {
      content: [{ type: "text", text: output }],
    };
  }
);

// 📋 vault_daily_digest — Auto-generated day summary
server.tool(
  "vault_daily_digest",
  "Generate an auto-summary of today's activity from the vault — diary entries, worklogs, conversations, projects touched, and tech stack used. Perfect for daily standup context or catching up on your day.",
  {
    date: z.string().optional().describe("Date in YYYY-MM-DD format (default: today)"),
  },
  async ({ date }) => {
    const targetDate = date || isoDate();

    const rows = queryAll(
      `SELECT id, type, source, title, substr(content, 1, 400) as snippet, tags, created_at
       FROM items
       WHERE created_at LIKE '${targetDate}%'
       ORDER BY created_at ASC;`
    );

    const digest = generateDigest(rows);

    return {
      content: [{ type: "text", text: digest }],
    };
  }
);

// 💾 vault_remember — AI tells vault "remember this"
server.tool(
  "vault_remember",
  "Save an important piece of information to the vault for future reference. Use this when the user says 'remember this', when you discover something important during a conversation, or when you want to preserve context for future sessions. The AI proactively calls this to build persistent memory.",
  {
    what: z.string().describe("What to remember — a fact, decision, preference, or insight"),
    category: z.enum(["preference", "decision", "fact", "insight", "todo", "note"]).optional().describe("Category of the memory"),
    project: z.string().optional().describe("Related project name, if any"),
  },
  async ({ what, category, project }) => {
    const cat = category || "note";
    const now = new Date().toISOString();

    // Auto-detect tags
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

    // Write via HTTP API (avoids FTS5 trigger incompatibility in sql.js WASM)
    const { API_URL } = await import("./config.mjs");
    let saved = false;
    try {
      const res = await fetch(`${API_URL}/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "diary", source: "ai-memory", title, content, tags }),
      });
      saved = (await res.json()).ok === true;
    } catch (e) {
      // API not running — skip, note the error
    }

    if (!saved) {
      return {
        content: [{
          type: "text",
          text: `⚠️ Could not save memory — MemVault API is not running at ${API_URL}. Start it with \`npm run start\` then try again.\n\n**What you asked to remember:**\n${what}`,
        }],
      };
    }

    return {
      content: [{
        type: "text",
        text: `💾 **Remembered!**\n\n- **What**: ${what.slice(0, 100)}${what.length > 100 ? "..." : ""}\n- **Category**: ${cat}${detectedProject ? `\n- **Project**: ${detectedProject}` : ""}\n- **Tags**: \`${tags}\``,
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════
//  RESOURCES — Read-only data the AI can access
// ═══════════════════════════════════════════════════════════════════════════

function registerResource(uri, name, description, type) {
  server.resource(
    name,
    uri,
    { description, mimeType: "text/plain" },
    async () => {
      const where = type ? `WHERE type = '${type}'` : "";
      const rows = queryAll(
        `SELECT type, title, substr(content, 1, 400) as snippet, tags, created_at
         FROM items ${where}
         ORDER BY created_at DESC LIMIT 20;`
      );

      const text = rows.length === 0
        ? `No ${type || ""} entries found.`
        : rows.map((r, i) => {
            const date = r.created_at ? new Date(r.created_at).toLocaleDateString("en-IN") : "?";
            return `[${r.type}] ${r.title || "Untitled"} (${date})\n${r.snippet || ""}`;
          }).join("\n---\n");

      return { contents: [{ uri, text, mimeType: "text/plain" }] };
    }
  );
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
    const total = queryAll("SELECT COUNT(*) as count FROM items")[0]?.count || 0;
    const byType = queryAll("SELECT type, COUNT(*) as count FROM items GROUP BY type");
    const secretCount = queryAll("SELECT COUNT(*) as count FROM secrets WHERE id != '__sentinel__'")[0]?.count || 0;

    const breakdown = byType.map(r => `${r.type}: ${r.count}`).join(", ");
    const text = `MemVault Stats | Total: ${total} | ${breakdown} | Secrets: ${secretCount} | Path: ${VAULT_ROOT}`;

    return { contents: [{ uri: "memvault://stats", text, mimeType: "text/plain" }] };
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
    const where = topic
      ? `WHERE (title LIKE '%${topic}%' OR content LIKE '%${topic}%' OR tags LIKE '%${topic}%')`
      : "";

    const rows = queryAll(
      `SELECT type, title, substr(content, 1, 300) as snippet, created_at
       FROM items ${where}
       ORDER BY created_at DESC LIMIT 15;`
    );

    const history = rows.map(r => {
      const date = r.created_at ? new Date(r.created_at).toLocaleDateString("en-IN") : "?";
      return `- [${r.type}] ${r.title} (${date}): ${r.snippet?.slice(0, 150) || ""}`;
    }).join("\n");

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
    const like = `%${project}%`;
    const rows = queryAll(
      `SELECT type, title, substr(content, 1, 400) as snippet, created_at
       FROM items
       WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?)
       ORDER BY created_at DESC LIMIT 20;`,
      [like, like, like]
    );

    const entries = rows.map(r => {
      const date = r.created_at ? new Date(r.created_at).toLocaleDateString("en-IN") : "?";
      return `[${date}] [${r.type}] ${r.title}: ${r.snippet?.slice(0, 200) || ""}`;
    }).join("\n");

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
    const rows = queryAll(
      `SELECT type, title, substr(content, 1, 500) as snippet, created_at
       FROM items
       WHERE created_at LIKE '${today}%'
       ORDER BY created_at DESC;`
    );

    const entries = rows.map(r => {
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
//  START SERVER
// ═══════════════════════════════════════════════════════════════════════════

const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr (stdout is reserved for MCP protocol)
process.stderr.write(`[MemVault MCP] Server started — stdio transport\n`);
process.stderr.write(`[MemVault MCP] VAULT_ROOT=${VAULT_ROOT}\n`);
process.stderr.write(`[MemVault MCP] DB_PATH=${DB_PATH}\n`);

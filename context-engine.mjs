/**
 * context-engine.mjs — MemVault Smart Context Engine
 * ═══════════════════════════════════════════════════════════════════════════════
 * The intelligence layer that makes AI responses context-aware. Handles:
 *
 *  1. Auto-tagging — detect project names, tech stacks, topics
 *  2. Relevance scoring — rank entries by recency + keyword match strength
 *  3. Project detection — identify active project from CWD / Git / title
 *  4. Daily digest — auto-summarize today's activity
 *  5. Deduplication — merge similar entries across sources
 *  6. Session memory — track what AI has already seen
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ─── Auto-Tagging ───────────────────────────────────────────────────────────

const TECH_PATTERNS = [
  // Frontend
  { pattern: /\b(react|jsx|tsx|next\.?js|nextjs)\b/i, tag: "react" },
  { pattern: /\b(vue|nuxt|vuex)\b/i, tag: "vue" },
  { pattern: /\b(angular|ng-|rxjs)\b/i, tag: "angular" },
  { pattern: /\b(svelte|sveltekit)\b/i, tag: "svelte" },
  { pattern: /\b(tailwind|css|scss|styled-components)\b/i, tag: "css" },
  { pattern: /\b(html5?|dom|web\s?component)\b/i, tag: "html" },
  // Backend
  { pattern: /\b(node\.?js|express|fastify|koa)\b/i, tag: "nodejs" },
  { pattern: /\b(python|django|flask|fastapi)\b/i, tag: "python" },
  { pattern: /\b(java|spring|maven|gradle)\b/i, tag: "java" },
  { pattern: /\b(rust|cargo|tokio)\b/i, tag: "rust" },
  { pattern: /\b(go|golang|gin|fiber)\b/i, tag: "golang" },
  // Database
  { pattern: /\b(sql|sqlite|postgres|mysql|supabase)\b/i, tag: "database" },
  { pattern: /\b(mongodb|mongoose|redis)\b/i, tag: "nosql" },
  // DevOps
  { pattern: /\b(docker|kubernetes|k8s|helm)\b/i, tag: "devops" },
  { pattern: /\b(aws|azure|gcp|cloud)\b/i, tag: "cloud" },
  { pattern: /\b(ci\/cd|github\s?actions|jenkins)\b/i, tag: "cicd" },
  // AI/ML
  { pattern: /\b(ai|ml|llm|gpt|claude|gemini|openai|anthropic)\b/i, tag: "ai" },
  { pattern: /\b(mcp|model\s?context\s?protocol)\b/i, tag: "mcp" },
  // Tools
  { pattern: /\b(git|github|gitlab)\b/i, tag: "git" },
  { pattern: /\b(vscode|vs\s?code|cursor|copilot)\b/i, tag: "ide" },
  { pattern: /\b(npm|yarn|pnpm|bun)\b/i, tag: "packagemgr" },
  // Trading/Finance (for this user's domain)
  { pattern: /\b(trading|candlestick|nifty|sensex|nse|bse)\b/i, tag: "trading" },
  { pattern: /\b(fii|dii|sebi|portfolio)\b/i, tag: "finance" },
  { pattern: /\b(investology|mrchartist|chartist)\b/i, tag: "investology" },
];

const TOPIC_PATTERNS = [
  { pattern: /\b(bug|fix|error|crash|debug|issue)\b/i, tag: "bugfix" },
  { pattern: /\b(deploy|hosting|hostinger|vercel|netlify)\b/i, tag: "deployment" },
  { pattern: /\b(design|ui|ux|layout|responsive)\b/i, tag: "design" },
  { pattern: /\b(auth|login|signup|password|session)\b/i, tag: "auth" },
  { pattern: /\b(api|endpoint|rest|graphql)\b/i, tag: "api" },
  { pattern: /\b(test|jest|mocha|cypress|playwright)\b/i, tag: "testing" },
  { pattern: /\b(refactor|cleanup|optimize|performance)\b/i, tag: "refactor" },
  { pattern: /\b(security|encrypt|ssl|cors|xss)\b/i, tag: "security" },
  { pattern: /\b(docs|documentation|readme|guide)\b/i, tag: "docs" },
];

/**
 * Auto-detect tags from content text
 * @param {string} text - Title + content to analyze
 * @returns {string[]} Array of detected tags
 */
export function autoTag(text) {
  if (!text) return [];
  const tags = new Set();

  for (const { pattern, tag } of [...TECH_PATTERNS, ...TOPIC_PATTERNS]) {
    if (pattern.test(text)) tags.add(tag);
  }

  return [...tags];
}

/**
 * Merge existing tags with auto-detected ones
 * @param {string} existingTags - Comma-separated existing tags
 * @param {string} text - Text to auto-tag from
 * @returns {string} Merged comma-separated tags
 */
export function mergeAutoTags(existingTags, text) {
  const existing = (existingTags || "").split(",").map(t => t.trim()).filter(Boolean);
  const detected = autoTag(text);
  const merged = [...new Set([...existing, ...detected])];
  return merged.join(",");
}

// ─── Relevance Scoring ──────────────────────────────────────────────────────

/**
 * Score an entry's relevance to a query
 * Higher = more relevant
 * @param {Object} entry - {title, content, tags, created_at, source}
 * @param {string} query - Search query
 * @returns {number} Relevance score (0-100)
 */
export function scoreRelevance(entry, query) {
  let score = 0;
  const queryLower = query.toLowerCase();
  const keywords = queryLower.split(/\s+/).filter(w => w.length > 2);

  const title = (entry.title || "").toLowerCase();
  const content = (entry.content || entry.snippet || "").toLowerCase();
  const tags = (entry.tags || "").toLowerCase();

  // Title match (highest weight)
  for (const kw of keywords) {
    if (title.includes(kw)) score += 25;
  }

  // Exact title match
  if (title.includes(queryLower)) score += 30;

  // Tag match
  for (const kw of keywords) {
    if (tags.includes(kw)) score += 15;
  }

  // Content match
  for (const kw of keywords) {
    if (content.includes(kw)) score += 10;
    // Count occurrences (capped at 5)
    const count = Math.min((content.match(new RegExp(kw, "gi")) || []).length, 5);
    score += count * 2;
  }

  // Recency bonus (entries from today get +20, yesterday +15, this week +10, this month +5)
  if (entry.created_at) {
    const ageMs = Date.now() - new Date(entry.created_at).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays < 1) score += 20;
    else if (ageDays < 2) score += 15;
    else if (ageDays < 7) score += 10;
    else if (ageDays < 30) score += 5;
  }

  // Source bonus (worklogs and conversations are more useful than raw data)
  if (entry.type === "worklog") score += 5;
  if (entry.type === "conversation") score += 3;

  return Math.min(score, 100);
}

/**
 * Sort entries by relevance to a query
 * @param {Object[]} entries - Array of vault entries
 * @param {string} query - Search query
 * @returns {Object[]} Entries sorted by relevance (highest first) with scores
 */
export function rankByRelevance(entries, query) {
  return entries
    .map(entry => ({ ...entry, _relevance: scoreRelevance(entry, query) }))
    .sort((a, b) => b._relevance - a._relevance);
}

// ─── Project Detection ──────────────────────────────────────────────────────

const KNOWN_PROJECTS = [
  { patterns: [/investology/i, /mrchartist/i, /sebi/i], name: "Investology", tags: "investology,trading" },
  { patterns: [/memvault/i, /vault/i, /mcp.*server/i], name: "MemVault", tags: "memvault,mcp" },
  { patterns: [/tradebook/i, /trade.*book/i, /journal.*trade/i], name: "TradeBook", tags: "tradebook,trading" },
  { patterns: [/fii.*dii/i, /dii.*fii/i, /flows.*dashboard/i], name: "FII-DII Dashboard", tags: "fii-dii,finance" },
  { patterns: [/twitter.*bot/i, /tweet/i, /promotion.*plan/i], name: "Twitter Bot", tags: "twitter,marketing" },
  { patterns: [/ollama/i, /local.*llm/i], name: "Ollama MCP", tags: "ollama,ai,mcp" },
];

/**
 * Detect project from text content
 * @param {string} text - Text to analyze
 * @returns {{name: string, tags: string} | null}
 */
export function detectProject(text) {
  if (!text) return null;
  for (const project of KNOWN_PROJECTS) {
    for (const pattern of project.patterns) {
      if (pattern.test(text)) return { name: project.name, tags: project.tags };
    }
  }
  return null;
}

// ─── Daily Digest Generator ─────────────────────────────────────────────────

/**
 * Generate a daily digest summary from entries
 * @param {Object[]} entries - Today's vault entries
 * @returns {string} Formatted digest markdown
 */
export function generateDigest(entries) {
  if (!entries || entries.length === 0) {
    return "No activity recorded today yet.";
  }

  // Group by type
  const grouped = {};
  for (const e of entries) {
    const type = e.type || "other";
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(e);
  }

  const typeEmoji = {
    diary: "📔", conversation: "💬", worklog: "🛠️", file: "📎",
  };

  let digest = `## 📋 Daily Digest — ${new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}\n\n`;
  digest += `**Total activity**: ${entries.length} entries\n\n`;

  for (const [type, items] of Object.entries(grouped)) {
    const emoji = typeEmoji[type] || "📦";
    digest += `### ${emoji} ${type.charAt(0).toUpperCase() + type.slice(1)} (${items.length})\n\n`;

    for (const item of items.slice(0, 8)) {
      const time = item.created_at
        ? new Date(item.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
        : "?";
      const title = item.title || "Untitled";
      const snippet = (item.content || item.snippet || "").slice(0, 100).replace(/\n/g, " ");
      digest += `- **[${time}]** ${title}${snippet ? ` — _${snippet}_` : ""}\n`;
    }

    if (items.length > 8) {
      digest += `- _...and ${items.length - 8} more_\n`;
    }
    digest += "\n";
  }

  // Detect projects worked on
  const projectsWorked = new Set();
  for (const e of entries) {
    const text = `${e.title || ""} ${e.content || e.snippet || ""} ${e.tags || ""}`;
    const project = detectProject(text);
    if (project) projectsWorked.add(project.name);
  }

  if (projectsWorked.size > 0) {
    digest += `### 📁 Projects Touched\n${[...projectsWorked].map(p => `- ${p}`).join("\n")}\n\n`;
  }

  // Auto-detected tech stack
  const allText = entries.map(e => `${e.title || ""} ${e.content || ""} ${e.tags || ""}`).join(" ");
  const techTags = autoTag(allText);
  if (techTags.length > 0) {
    digest += `### 🏷️ Tech Stack Today\n${techTags.map(t => `\`${t}\``).join(", ")}\n`;
  }

  return digest;
}

// ─── Deduplication ──────────────────────────────────────────────────────────

/**
 * Simple similarity check between two strings
 * Uses Jaccard similarity on word sets
 */
function jaccardSimilarity(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Remove duplicate entries from an array (above threshold similarity)
 * @param {Object[]} entries - Array of entries
 * @param {number} threshold - Similarity threshold (0-1), default 0.6
 * @returns {Object[]} Deduplicated entries
 */
export function deduplicateEntries(entries, threshold = 0.6) {
  const unique = [];

  for (const entry of entries) {
    const entryText = `${entry.title || ""} ${entry.content || entry.snippet || ""}`;
    let isDupe = false;

    for (const existing of unique) {
      const existingText = `${existing.title || ""} ${existing.content || existing.snippet || ""}`;
      if (jaccardSimilarity(entryText, existingText) > threshold) {
        isDupe = true;
        break;
      }
    }

    if (!isDupe) unique.push(entry);
  }

  return unique;
}

// ─── Session Memory ─────────────────────────────────────────────────────────

/** In-memory set of entry IDs the AI has already seen this session */
const seenEntryIds = new Set();

/**
 * Mark entries as seen and filter out already-seen ones
 * @param {Object[]} entries - Array with `id` field
 * @returns {Object[]} Only entries not yet seen this session
 */
export function filterUnseen(entries) {
  const unseen = entries.filter(e => !seenEntryIds.has(e.id));
  for (const e of unseen) seenEntryIds.add(e.id);
  return unseen;
}

/** Reset session memory (e.g., on new conversation) */
export function resetSession() {
  seenEntryIds.clear();
}

/** Get session stats */
export function getSessionStats() {
  return { seen: seenEntryIds.size };
}

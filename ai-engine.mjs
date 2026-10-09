#!/usr/bin/env node
/**
 * ai-engine.mjs — MemVault AI Intelligence Layer
 * ═══════════════════════════════════════════════════════════════════
 * Uses Gemini API to add AI-powered features to MemVault:
 *  - Smart summarization of vault entries
 *  - Pattern & insight discovery
 *  - Semantic search re-ranking
 *  - Weekly digest generation
 *
 * Privacy: Uses YOUR API key. No data leaves your machine except
 * to your own Gemini API calls. Fully optional.
 * ═══════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import path from "path";
import os from "os";

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG_FILE = path.join(os.homedir(), ".memvaultrc.json");

function getAIConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      return config.ai || {};
    }
  } catch { /* ignore */ }
  return {};
}

function getApiKey() {
  return process.env.GEMINI_API_KEY
    || process.env.GOOGLE_AI_API_KEY
    || getAIConfig().apiKey
    || null;
}

function getModel() {
  return getAIConfig().model || "gemini-2.0-flash";
}

function isAIEnabled() {
  const config = getAIConfig();
  return config.enabled !== false && getApiKey() !== null;
}

// ─── Gemini API Caller ─────────────────────────────────────────────────────

async function callGemini(prompt, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("No Gemini API key configured. Add it to ~/.memvaultrc.json under ai.apiKey or set GEMINI_API_KEY env var.");
  }

  const model = options.model || getModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{
      parts: [{ text: prompt }],
    }],
    generationConfig: {
      temperature: options.temperature || 0.7,
      maxOutputTokens: options.maxTokens || 2048,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${err}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty response from Gemini API");

  return text;
}

// ─── AI Features ────────────────────────────────────────────────────────────

/**
 * Summarize vault entries or text
 */
export async function summarize(text, options = {}) {
  const context = options.context || "";
  const prompt = `You are a personal knowledge assistant. Summarize the following entry concisely, highlighting key decisions, insights, and action items.

${context ? `Context: ${context}\n\n` : ""}Entry:
${text.slice(0, 4000)}

Provide a clear, structured summary in markdown format with:
- **Key Points** (2-3 bullet points)
- **Decisions Made** (if any)
- **Action Items** (if any)
- **Tags** (suggest 3-5 relevant tags)`;

  return callGemini(prompt, { temperature: 0.3 });
}

/**
 * Generate insights from vault data
 */
export async function generateInsights(entries, options = {}) {
  const timeframe = options.timeframe || "this week";

  const entrySummaries = entries.slice(0, 30).map((e, i) =>
    `${i + 1}. [${e.type}] "${e.title}" (${e.created_at?.split("T")[0] || "unknown"}) — ${(e.content || e.snippet || "").slice(0, 150)}...`
  ).join("\n");

  const prompt = `You are analyzing a user's personal knowledge vault to find patterns and insights from ${timeframe}.

Here are their recent entries:
${entrySummaries}

Provide insights in this format:
## 📊 Activity Insights for ${timeframe}

### 🎯 Focus Areas
- What topics/projects dominated their time

### ⏰ Productivity Patterns
- When they were most active
- How many different projects they touched

### 💡 Interesting Observations
- Patterns, recurring themes, or notable shifts

### 📋 Recommended Actions
- What they should prioritize based on the data

Keep it concise and actionable. Use emoji for readability.`;

  return callGemini(prompt, { temperature: 0.5 });
}

/**
 * Semantic search re-ranking
 */
export async function semanticRerank(query, results, options = {}) {
  if (results.length === 0) return results;

  const resultsList = results.slice(0, 15).map((r, i) =>
    `${i + 1}. [${r.type}] "${r.title}" — ${(r.content || r.snippet || "").slice(0, 200)}...`
  ).join("\n");

  const prompt = `Given this search query: "${query}"

And these search results:
${resultsList}

Rank these results by relevance to the query. Return ONLY a comma-separated list of the result numbers in order from most relevant to least relevant.
Example: 3,1,7,2,5

Return ONLY the numbers, nothing else.`;

  try {
    const ranking = await callGemini(prompt, { temperature: 0.1, maxTokens: 100 });
    const indices = ranking.trim().split(",").map(n => parseInt(n.trim()) - 1).filter(n => !isNaN(n) && n >= 0 && n < results.length);

    // Reorder results
    const reranked = [];
    const seen = new Set();
    for (const idx of indices) {
      if (!seen.has(idx)) {
        reranked.push(results[idx]);
        seen.add(idx);
      }
    }
    // Add any missed results at the end
    for (let i = 0; i < results.length; i++) {
      if (!seen.has(i)) reranked.push(results[i]);
    }
    return reranked;
  } catch {
    return results; // Fallback to original order
  }
}

/**
 * Generate a weekly digest
 */
export async function weeklyDigest(entries, options = {}) {
  const entrySummaries = entries.slice(0, 50).map((e) =>
    `- [${e.type}] "${e.title}" (${e.created_at?.split("T")[0] || "?"}) ${(e.content || "").slice(0, 100)}...`
  ).join("\n");

  const prompt = `Create a weekly digest from this user's personal vault entries. Write it like a personal newsletter to the user.

Entries from this week:
${entrySummaries}

Format the digest as:
## 📰 Your Weekly MemVault Digest

### 🏆 Highlights
- Top 3 most impactful things that happened

### 📁 Projects Touched
- List each project and what was done

### 📊 By the Numbers
- Total entries, conversations, worklogs etc.

### 🔮 Looking Ahead
- Suggested focus areas for next week

Keep it concise, friendly, and motivating.`;

  return callGemini(prompt, { temperature: 0.6 });
}

/**
 * Auto-categorize and tag an entry
 */
export async function autoCategorizeTags(text, existingTags = []) {
  const prompt = `Analyze this text and suggest relevant tags/categories for it.

Text:
${text.slice(0, 2000)}

Existing tags: ${existingTags.join(", ") || "none"}

Return ONLY a comma-separated list of 3-7 relevant tags. Use lowercase, hyphens for multi-word tags. No hashtags, no explanations.
Example: web-development, react, bug-fix, frontend, css`;

  try {
    const result = await callGemini(prompt, { temperature: 0.2, maxTokens: 100 });
    return result.trim().split(",").map(t => t.trim()).filter(Boolean);
  } catch {
    return existingTags;
  }
}

// ─── Status Check ───────────────────────────────────────────────────────────

export function getAIStatus() {
  const enabled = isAIEnabled();
  const hasKey = getApiKey() !== null;
  const model = getModel();

  return {
    enabled,
    hasApiKey: hasKey,
    model,
    provider: "gemini",
    configPath: CONFIG_FILE,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

export {
  callGemini,
  isAIEnabled,
  getApiKey,
  getModel,
};

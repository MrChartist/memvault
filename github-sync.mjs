import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration (Should come from .env in production)
const CONFIG = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",
    GITHUB_USERNAME: process.env.GITHUB_USERNAME || "",
    API_ENDPOINT: "http://127.0.0.1:7800/add",
    REPOS: [], // If empty, fetch all recent repos
    DAYS: 1 // Sync commits from last 1 day
};

async function syncGithub() {
    if (!CONFIG.GITHUB_TOKEN) {
        console.warn("⚠️ GITHUB_TOKEN not set. Skipping GitHub sync.");
        return;
    }

    console.log(`🚀 Starting GitHub Sync for ${CONFIG.GITHUB_USERNAME || "active user"}...`);

    const since = new Date();
    since.setDate(since.getDate() - CONFIG.DAYS);
    const sinceISO = since.toISOString();

    try {
        // 1. Fetch Repositories
        const reposRes = await fetch(`https://api.github.com/user/repos?sort=updated&per_page=100`, {
            headers: {
                Authorization: `token ${CONFIG.GITHUB_TOKEN}`,
                Accept: "application/vnd.github.v3+json",
            }
        });

        if (!reposRes.ok) throw new Error(`GitHub API Error: ${reposRes.status} ${await reposRes.text()}`);
        const repos = await reposRes.json();

        let totalCommits = 0;

        for (const repo of repos) {
            // 2. Fetch Commits for each repo since yesterday
            const commitsRes = await fetch(`https://api.github.com/repos/${repo.full_name}/commits?since=${sinceISO}&author=${CONFIG.GITHUB_USERNAME}`, {
                headers: {
                    Authorization: `token ${CONFIG.GITHUB_TOKEN}`,
                    Accept: "application/vnd.github.v3+json",
                }
            });

            if (!commitsRes.ok) continue;
            const commits = await commitsRes.json();

            if (!Array.isArray(commits)) continue;

            for (const commit of commits) {
                // Map repo name to project (Strip dashes and capitalize or use as is)
                const projectName = repo.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

                const payload = {
                    type: "worklog",
                    source: "github",
                    project: projectName,
                    title: `Commit: ${commit.commit.message.split('\n')[0]}`,
                    content: `${commit.commit.message}\n\nSHA: ${commit.sha}\nURL: ${commit.html_url}`,
                    tags: `github,commit,${repo.name}`,
                    created_at: commit.commit.author.date
                };

                // Post to Vault
                const regRes = await fetch(CONFIG.API_ENDPOINT, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });

                if (regRes.ok) totalCommits++;
            }
        }

        console.log(`✅ GitHub Sync Complete. Imported ${totalCommits} new commits.`);
    } catch (err) {
        console.error("❌ GitHub Sync Failed:", err.message);
    }
}

syncGithub();

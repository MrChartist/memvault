import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const CONFIG = {
    API_ENDPOINT: "http://127.0.0.1:7800/add",
    DOCS_DIR: path.join(__dirname, "docs")
};

async function syncDocs() {
    console.log(`🚀 Starting Docs Sync from ${CONFIG.DOCS_DIR}...`);

    if (!fs.existsSync(CONFIG.DOCS_DIR)) {
        console.warn(`⚠️ Docs directory not found at ${CONFIG.DOCS_DIR}. Creating it...`);
        fs.mkdirSync(CONFIG.DOCS_DIR, { recursive: true });
        return;
    }

    const files = fs.readdirSync(CONFIG.DOCS_DIR).filter(f => f.endsWith('.md'));

    let totalDocs = 0;

    for (const file of files) {
        const filePath = path.join(CONFIG.DOCS_DIR, file);
        const content = fs.readFileSync(filePath, 'utf-8');

        // Use filename as title, strip extension and replace dashes
        const titleName = file.replace('.md', '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

        const payload = {
            type: "file",
            source: "doc",
            title: `Documentation: ${titleName}`,
            content: content,
            file_path: filePath,
            tags: "documentation,markdown"
        };

        try {
            const regRes = await fetch(CONFIG.API_ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (regRes.ok) {
                totalDocs++;
                console.log(`✅ Synced: ${titleName}`);
            } else {
                console.error(`❌ Failed to sync ${titleName}: ${regRes.statusText}`);
            }
        } catch (err) {
            console.error(`❌ Connection error syncing ${titleName}:`, err.message);
        }
    }

    console.log(`🎉 Docs Sync Complete. Imported ${totalDocs} documents to MemVault.`);
}

syncDocs();

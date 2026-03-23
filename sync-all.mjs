import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log("🔄 Running all sync engines sequentially...\n");

const engines = [
  "sync-git.mjs",
  "sync-vscode.mjs",
  "sync-system.mjs",
  "sync-files.mjs"
];

async function runEngine(script) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [path.join(__dirname, script)], { stdio: "inherit" });
    cp.on("exit", resolve);
  });
}

async function main() {
  for (const engine of engines) {
    console.log(`\n▶️ Starting ${engine}...`);
    await runEngine(engine);
  }
  console.log(`\n✅ All sync engines complete!`);
}

main().catch(console.error);

// Child process used by db.test.js: an independent "AI client" writing to the shared vault.
import { openVaultDb } from "../../db.mjs";
const [root, tag, n] = process.argv.slice(2);
const v = openVaultDb({ root });
for (let i = 0; i < Number(n); i++) {
  v.addItem({ type: "diary", title: `${tag}-${i}`, source: tag });
  await new Promise((r) => setTimeout(r, Math.random() * 4));
}

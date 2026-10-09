// Child process used by audit.test.js
import { audit } from "../../audit.mjs";
const [root, tag, n] = process.argv.slice(2);
for (let i = 0; i < Number(n); i++) {
  audit({ actor: tag, action: "tool", detail: { i } }, root);
  await new Promise((r) => setTimeout(r, Math.random() * 3));
}

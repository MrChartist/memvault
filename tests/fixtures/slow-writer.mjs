// A writer that holds the database lock for a long time (like a laptop going to sleep mid-write).
import { openVaultDb } from "../../db.mjs";
const [root, tag, holdMs] = process.argv.slice(2);
const v = openVaultDb({ root });
let first = true;
v.transaction((tx) => {
  if (first) { const until = Date.now() + Number(holdMs); while (Date.now() < until) { /* busy */ } first = false; }
  tx.run("INSERT INTO items (id,type,title,created_at,scope) VALUES (?,?,?,?,?)", [`diary_${tag}`, "diary", tag, new Date().toISOString(), "shared"]);
});
console.log("done");

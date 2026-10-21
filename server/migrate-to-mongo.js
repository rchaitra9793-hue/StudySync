/* =========================================
   Copy your local data (data/db.json) into MongoDB

   Run once, from the server folder, after putting MONGODB_URI in server/.env:
     node migrate-to-mongo.js

   Accounts that already exist in MongoDB (same email) are skipped,
   so running it twice is safe.
   ========================================= */

const path = require("path");

try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch (e) { /* no .env file */ }

const { createStore, createFileStore } = require("./store");

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set. Add it to server/.env first.");
    process.exit(1);
  }

  const file = process.env.DATA_FILE || path.join(__dirname, "data", "db.json");
  const local = createFileStore(file);
  const mongo = createStore(); // MongoDB, because MONGODB_URI is set
  await mongo.init();

  // List the accounts in the local file
  const db = JSON.parse(require("fs").readFileSync(file, "utf8"));
  const users = Array.isArray(db.users) ? db.users : [];

  let copied = 0, skipped = 0;
  for (const user of users) {
    if (await mongo.getUserByEmail(user.email)) {
      console.log(`Skipped (already in MongoDB): ${user.email}`);
      skipped++;
      continue;
    }
    await mongo.addUser(user);
    await mongo.saveData(user.id, await local.getData(user.id));
    console.log(`Copied: ${user.email}`);
    copied++;
  }

  console.log(`\nDone. ${copied} account(s) copied, ${skipped} skipped.`);
  console.log("Students will need to log in again on the new site.");
  process.exit(0);
}

main().catch(err => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});

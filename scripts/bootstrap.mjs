#!/usr/bin/env node
/**
 * Create the first owner account (and their personal mailbox).
 *
 *   npm run bootstrap:local  -- --email you@example.com --name "Your Name"
 *   npm run bootstrap:remote -- --email you@example.com --name "Your Name"
 *
 * You'll be prompted for a password. Pass --no-mailbox to skip creating a mailbox.
 */
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = args.includes("--remote") ? "--remote" : "--local";
const email = (flag("email") ?? "").trim().toLowerCase();
const name = (flag("name") ?? "").trim();
const withMailbox = !args.includes("--no-mailbox");

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Usage: npm run bootstrap:local -- --email you@example.com --name \"Your Name\"");
  process.exit(1);
}

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => rl.output.write(s.includes(question) ? s : "");
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

const password = process.env.BOOTSTRAP_PASSWORD ?? (await ask("Password (10+ chars, mixed): ", true));
const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
if (password.length < 10 || classes < 3) {
  console.error("Password must be 10+ characters and use at least three of: lowercase, uppercase, numbers, symbols.");
  process.exit(1);
}

// Must match worker/lib/password.ts
const salt = randomBytes(16);
const hash = pbkdf2Sync(password.normalize("NFKC"), salt, 100_000, 32, "sha256");
const passwordHash = `pbkdf2$100000$${salt.toString("base64")}$${hash.toString("base64")}`;

const id = () => randomBytes(16).toString("base64url");
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const now = new Date().toISOString();
const userId = id();
const mailboxId = id();

const sql = [
  `INSERT INTO users (id, email, name, password_hash, role, status, avatar_color, created_at, updated_at)
   VALUES (${q(userId)}, ${q(email)}, ${q(name)}, ${q(passwordHash)}, 'owner', 'active', '#6366f1', ${q(now)}, ${q(now)})
   ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, role = 'owner', status = 'active', updated_at = excluded.updated_at;`,
];
if (withMailbox) {
  sql.push(
    `INSERT OR IGNORE INTO mailboxes (id, address, name, display_name, type, color, created_at, updated_at)
     VALUES (${q(mailboxId)}, ${q(email)}, ${q(name)}, ${q(name)}, 'personal', '#6366f1', ${q(now)}, ${q(now)});`,
    `INSERT OR IGNORE INTO mailbox_members (mailbox_id, user_id, role, created_at)
     SELECT m.id, u.id, 'owner', ${q(now)} FROM mailboxes m, users u WHERE m.address = ${q(email)} AND u.email = ${q(email)};`,
  );
}

try {
  execFileSync("npx", ["wrangler", "d1", "execute", "MAIL_DB", target, "--command", sql.join("\n")], { stdio: "inherit" });
  console.log(`\n✓ Owner ${email} is ready${withMailbox ? ` with mailbox ${email}` : ""}. Sign in at your app URL.`);
} catch {
  console.error("\nFailed. Did you run the migrations first? (npm run db:migrate:local / db:migrate:remote)");
  process.exit(1);
}

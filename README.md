<p align="center">
  <img src=".github/readme.png" alt="Acme Mail — mail.example.com" width="100%" />
</p>

<h1 align="center">InboxOS</h1>

<p align="center">
  <strong>The team email client for <a href="https://example.com">Acme</a>.</strong><br />
  Shared inboxes, a fast compose window and delivery tracking. White-labeled and hosted on Cloudflare.
</p>

<p align="center">
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1%20%2B%20R2-F38020?logo=cloudflare&logoColor=white" />
  <img alt="Resend" src="https://img.shields.io/badge/Email-Resend-000000" />
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-Proprietary%20%C2%B7%20Lazy%20Marketing-4f46e5" />
</p>

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Quick start (local)](#quick-start-local)
- [Deploy to production](#deploy-to-production)
- [Connect Resend](#connect-resend)
- [Google sign-in (optional)](#google-sign-in-optional)
- [White-labeling](#white-labeling)
- [Upgrading your Resend plan](#upgrading-your-resend-plan)
- [Project structure](#project-structure)
- [Scripts](#scripts)
- [Security](#security)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Troubleshooting](#troubleshooting)
- [License & credits](#license--credits)

## Features

**Inboxes**
- Personal and shared mailboxes (like `hello@` and `support@`), each with owner, can-send and read-only access
- Give anyone access to any other inbox. Switch between mailboxes in one click, or read them all together in **All inboxes**
- Aliases (extra addresses that deliver into a mailbox) and an optional catch-all
- Conversation threading, labels, stars, archive, spam and trash (emptied automatically after a set number of days)
- Gmail-style search: `from:` `to:` `subject:` `has:attachment` `is:unread` `in:sent` `label:` `before:` `after:`

**Compose**
- Rich-text editor, recipient autocomplete, Cc/Bcc, drag-and-drop attachments and pasted inline images
- Autosaved drafts, **undo send**, **scheduled send**, templates, and personal or per-mailbox signatures
- Priority flags, read receipts, and a "did you forget the attachment?" check
- Replies and forwards keep the original email's formatting

**Email viewer**
- Emails are shown in a locked-down frame, so nothing inside them can run
- Remote images (often used for tracking) stay blocked until you click **Show images**
- Attachment previews, full headers, `.eml` download and print
- Delivery timeline on sent mail: sent → delivered, bounced, spam complaint, opens and clicks

**Administration**
- Invite users, set roles, disable accounts, reset passwords or two-factor, and sign users out everywhere
- Roles: **Owner** (everything), **Admin** (manage users, mailboxes and settings), **Manager** (view-only admin console: overview, all traffic, users, mailboxes and logs), **Member** (their mailboxes)
- Manage each person's mailbox access from **Admin → Users** (or choose it while inviting them)
- Two-factor authentication (authenticator app plus recovery codes), with an optional org-wide requirement
- Google sign-in, which can be limited to your Workspace domains
- **All traffic**: every email sent or received across the domain in one searchable view, including mail for addresses that have no mailbox. Stray mail can be delivered to a mailbox, and its address can be routed there automatically from then on. Every message an admin opens is recorded in the audit log.
- Delivery log and audit log, both searchable and exportable to CSV
- Dashboard with quota meters, a 14-day activity chart and connection status
- A built-in **Setup guide** in the admin console

## How it works

```
Browser (React app)  ──►  Cloudflare Worker (Hono API)  ──►  D1 (database)  ·  R2 (email bodies & attachments)
                                     │   ▲
                         send via API │   │ webhooks: email.received, delivered, bounced, opened…
                                     ▼   │
                                    Resend
```

- **Sending:** the Worker calls the Resend API. Scheduled messages go out from a cron job that runs every minute.
- **Receiving:** Resend sends a webhook when mail arrives. The Worker then fetches the full message and its attachments and files it into the right mailbox.
- **Statuses:** delivery events arrive by webhook and update each message's timeline. Every webhook's signature is checked, and duplicates are ignored.

## Quick start (local)

Requirements: Node 20+ and a free Cloudflare account (only needed for deploying).

```bash
cd mail.example.com
npm install
cp .dev.vars.example .dev.vars          # fill in values (Resend keys are optional locally)
npm run db:migrate:local
npm run bootstrap:local -- --email you@example.com --name "Your Name"
npm run dev
```

Open http://localhost:5173 and sign in with the account you just created.

> Without `RESEND_API_KEY` you can use the whole interface, but sending will show a clear "not configured" error.

## Deploy to production

```bash
# 1. Create the database and storage bucket
npx wrangler d1 create MAIL_DB                 # copy the database_id into wrangler.jsonc
npx wrangler r2 bucket create inboxos-files

# 2. Apply the schema
npm run db:migrate:remote

# 3. Add secrets (you'll be prompted for each value)
npx wrangler secret put SESSION_SECRET         # any long random string
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_WEBHOOK_SECRET

# 4. Deploy (applies any pending database migrations first), then create the first owner
npm run deploy
npm run bootstrap:remote -- --email you@example.com --name "Your Name"
```

Then point `mail.example.com` at the Worker: Cloudflare dashboard → **Workers → inboxos → Settings → Domains & Routes**. Make sure `APP_URL` in `wrangler.jsonc` matches this address.

## Connect Resend

1. **Domains:** add `example.com`, create the DKIM/SPF records it shows you, and wait for **Verified**.
2. **Receiving:** turn on receiving for the domain and add the MX record Resend gives you.
   > ⚠️ If the domain already receives mail somewhere else (for example Google Workspace), changing its MX record moves **all** of that mail. Use a subdomain such as `mail.example.com` for receiving instead.
3. **API key:** create a **Full access** key. It needs to read received mail, not just send.
4. **Webhook:** add `https://mail.example.com/webhooks/resend`, subscribe to **all `email.*` events**, and save the signing secret (`whsec_…`) as `RESEND_WEBHOOK_SECRET`.
5. In the app, open **Admin → Mailboxes** and create your addresses, then invite your team from **Admin → Users**.

## Google sign-in (optional)

1. Google Cloud Console → **APIs & Services → Credentials** → **OAuth client ID** (Web application).
2. Authorized redirect URI: `https://mail.example.com/api/auth/google/callback`
3. `npx wrangler secret put GOOGLE_CLIENT_ID` and `npx wrangler secret put GOOGLE_CLIENT_SECRET`
4. In **Admin → Settings & policy**, set the allowed domains and choose whether accounts are created automatically.

## White-labeling

Everything customers see comes from one brand configuration:

| Where | What |
|---|---|
| **Admin → Branding** (no code) | Company and product name, logo, monogram, accent color, corner style, font, sign-in headline and tagline, support email, footer, default sender name. Includes a live preview, plus previews of every system email. |
| `worker/lib/email-templates.ts` | Wording of system emails: invitations, welcome, password reset, and security alerts (password changed, two-factor on/off). Layout lives in `email-layout.ts`. |
| `shared/brand.ts` | The default brand for a fresh install. Edit it to ship a different default. |
| `src/index.css` | Design tokens (neutrals, light/dark surfaces). Everything else derives from the accent color. |

To rebrand for another company, update **Admin → Branding** and the domain settings. No code changes are needed.

## Upgrading your Resend plan

The free plan allows **100 emails/day** and **3,000/month**, and the app enforces those limits so you never hit provider errors. After upgrading, raise the limits in **Admin → Settings & policy**. That's all it takes.

All provider code lives in `worker/lib/resend.ts`, so switching to a different email provider only touches that one file.

## Project structure

```
mail.example.com/
├── shared/            # Types + white-label defaults shared by API and UI
├── worker/            # Cloudflare Worker (API, webhooks, cron)
│   ├── lib/           # auth, sessions, 2FA, Resend client, sending, inbound, search
│   └── routes/        # REST endpoints (auth, mail, compose, admin…)
├── src/               # React app
│   ├── components/    # UI kit, compose window, mail viewer, layout
│   └── pages/         # Mail, Settings, Admin, Auth
├── migrations/        # D1 schema
├── scripts/           # bootstrap (create first owner)
├── tests/             # unit tests (Vitest)
└── wrangler.jsonc     # Cloudflare config
```

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Runs the app and API locally with hot reload |
| `npm run build` | Production build |
| `npm run deploy` | Build and deploy to Cloudflare |
| `npm run typecheck` | Checks TypeScript for both the app and the Worker |
| `npm test` | Unit tests |
| `npm run db:migrate:local` / `:remote` | Applies database migrations |
| `npm run bootstrap:local` / `:remote` | Creates or resets the first owner account |

## Security

- Passwords are hashed with PBKDF2-SHA256. Accounts lock after repeated failed sign-ins, and auth endpoints are rate-limited.
- Sessions use HttpOnly, SameSite cookies stored as hashes. Requests from other websites are blocked (CSRF protection).
- Two-factor authentication via authenticator app (TOTP), with single-use recovery codes.
- Incoming email is cleaned up before display and shown in a frame where nothing can run, backed by a strict Content Security Policy.
- Every webhook's signature and timestamp are checked, so forged or replayed requests are rejected.
- Admins can't read other people's mailboxes without adding themselves, which is recorded in the audit log.

## Keyboard shortcuts

`c` compose · `/` search · `j`/`k` next/previous · `e` archive · `#` delete · `!` spam · `s` star · `r` reply · `a` reply all · `f` forward · `g i` go to Inbox · `⌘/Ctrl+Enter` send · `?` show all shortcuts

## Troubleshooting

| Symptom | Fix |
|---|---|
| "RESEND_API_KEY is not configured" | Add the secret: `npx wrangler secret put RESEND_API_KEY` |
| Incoming mail never shows up | Check the MX record, the webhook URL, and `RESEND_WEBHOOK_SECRET`. Then check **Admin → All traffic → Unrouted**: mail for addresses with no mailbox or alias waits there. |
| "Daily sending limit reached" | You hit the limit set in Settings & policy. Raise it after upgrading Resend. |
| Google sign-in button missing | Set both Google secrets and enable Google sign-in in Settings & policy. |
| Locked out | Rerun `npm run bootstrap:remote` with your email to reset your password and owner role. |

## License & credits

**InboxOS is a product of [Acme](https://example.com).**
Designed and built by **Dylan Lambertson ([@DylanLambertson](https://github.com/DylanLambertson))**.

Proprietary. Acme holds all rights to use, modify, rebrand, sell and distribute it. See [LICENSE](./LICENSE). Open-source dependencies remain under their own licenses.

<p align="center"><sub>© 2026 Acme · Built by DylanLambertson</sub></p>

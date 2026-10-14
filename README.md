<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/brand/inboxos-wordmark.png" />
    <img src=".github/logo-light.png" alt="InboxOS" width="420" />
  </picture>
</h1>

<p align="center">
  <strong>Self-hosted email for your team, on your own domain.</strong><br />
  Personal and shared inboxes, a guided setup, a real admin console and a theme you control.<br />
  Runs on Cloudflare Workers, D1 and R2, and sends and receives through Resend.
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-6210f8" /></a>
  <a href="./CHANGELOG.md"><img alt="Version 1.0.0" src="https://img.shields.io/badge/version-1.0.0-6210f8" /></a>
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1%20%2B%20R2-F38020?logo=cloudflare&logoColor=white" />
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" />
  <a href="./CONTRIBUTING.md"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-6210f8" /></a>
</p>

<p align="center">
  <a href="#deploy-to-cloudflare"><strong>Deploy</strong></a> ·
  <a href="#run-it-locally"><strong>Run locally</strong></a> ·
  <a href="#faq"><strong>FAQ</strong></a> ·
  <a href="https://github.com/DylanLambertson/InboxOS/issues/new/choose"><strong>Report a bug</strong></a> ·
  <a href="#contact"><strong>Contact</strong></a>
</p>

<p align="center">
  <img src=".github/screenshots/inbox-light.png" alt="The InboxOS inbox" width="100%" />
</p>

---

## What is InboxOS?

InboxOS is a complete email system for a team that you deploy to your own Cloudflare account. Everyone gets a real
address on your domain, shared addresses like `support@` and `hello@` can be read and answered together, and an
admin console covers the rest: people, mailboxes, domains, security, compliance and health.

There are no servers to look after. The whole product is one Cloudflare Worker with a D1 database and an R2 bucket,
and [Resend](https://resend.com) handles delivery in both directions. A fresh deploy opens a setup wizard that takes
you from an empty URL to working mail in your browser: your owner account, your brand, your provider key, DNS
records checked live, mailboxes, invitations and a real send-and-receive test.

| | |
|---|---|
| **For** | Small companies, agencies, support teams, startups, families and regulated teams that want their own mail platform |
| **Runs on** | Cloudflare Workers, D1 (SQLite) and R2, with a per-minute cron trigger |
| **Mail provider** | Resend for sending, receiving and delivery events |
| **Built with** | TypeScript, Hono, React 19, React Router, TanStack Query, Tailwind CSS 4, Tiptap, Vite, Vitest |
| **License** | [GNU AGPL v3.0](./LICENSE), copyright © 2026 Dylan Lambertson |
| **Status** | 1.0.0, released October 13, 2026 ([changelog](./CHANGELOG.md)) |

## Contents

- [Why InboxOS](#why-inboxos)
- [The story](#the-story)
- [Features](#features)
- [Screenshots](#screenshots)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Deploy to Cloudflare](#deploy-to-cloudflare)
- [Run it locally](#run-it-locally)
- [The setup wizard](#the-setup-wizard)
- [Use cases](#use-cases)
- [Make it yours](#make-it-yours)
- [Email providers](#email-providers)
- [Webhooks](#webhooks)
- [API and MCP](#api-and-mcp)
- [Configuration reference](#configuration-reference)
- [Running it in production](#running-it-in-production)
- [Security](#security)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)
- [Development](#development)
- [Roadmap](#roadmap)
- [FAQ](#faq)
- [Contact](#contact)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## Why InboxOS

- **You own it.** Your mail, your database and your domain. One Worker on your Cloudflare account, no per-seat pricing and no one else's terms on your inbox.
- **Set up in the browser.** Deploy, open the URL, and the setup wizard walks you through everything else, including DNS, with live checks at every step.
- **Fits what you use it for.** Pick a use case (team, agency, support desk, personal and family, startup, regulated) and InboxOS sets a matching look and switches on the features that fit. Change anything later.
- **An admin console you'll actually open.** Health checks with one-click fixes, a dashboard, bulk actions, CSV import and export, and a ⌘K palette that gets you anywhere.
- **Serious where it counts.** Passkeys, enforced two-factor, SCIM provisioning, retention, legal hold, eDiscovery, DLP and a full audit log come built in, not as an upsell.

## The story

I started InboxOS in August 2026 to run email for a small agency team. We needed a handful of personal inboxes,
a few shared addresses across more than one domain, and a way for several people to work the same inbox without
stepping on each other. The options were per-seat suites built for much bigger companies, or self-hosted mail
servers that need constant care. I wanted something in between: a modern mail client and admin console that runs on
infrastructure I don't have to babysit.

The first version took about three weeks of evenings and weekends: a Cloudflare Worker for the API, D1 for data, R2
for message bodies and attachments, Resend for delivery, and a React app on top. It went into daily use at the end
of August, and each week of real use added the next piece: an API and an MCP server, multi-domain mailboxes, an
installable phone app with push notifications, mail rules, a security center, shared-inbox assignments, SCIM,
compliance tools and passkeys.

By the end of September it was clear the app was useful well beyond one team, but a new person would have needed my
help to get it running. So I spent the two weeks before the release turning it into a product: a first-run setup
wizard, use-case presets, a theme studio, a health center, signed webhooks and an admin console built for hundreds of
people. InboxOS 1.0 was released as free software under the AGPL on October 13, 2026.

| When | Milestone |
|---|---|
| Aug 8, 2026 | First commit: Worker and React scaffold, white-label brand config, D1 schema |
| Aug 9 – 18 | Sessions, sign-in with 2FA and Google, sending and receiving through Resend, mail API, app shell, message list and reading pane |
| Aug 24 – 30 | Compose, sign-in page, settings, admin console, first tests. In daily use from here |
| Sep 3 – 7 | All inboxes view, unrouted-mail safety net, all-traffic view, system email redesign, read-only Manager role, REST API and MCP server, multi-domain mailboxes |
| Sep 8 – 20 | Act-as keys, vacation replies, blocked senders, snooze, installable phone app, unread digests, push notifications |
| Sep 21 – 29 | Mail rules, security center, shared-inbox collaboration, SCIM, retention and legal hold, signatures and DLP, passkeys |
| Sep 30 – Oct 5 | Theme tokens and use-case presets, health center, command palette, feature switches, profiles and team directory, theme studio, domain automation |
| Oct 8 – 12 | First-run setup wizard, signed outbound webhooks, server-side search, bulk actions, CSV import and export, rebuilt admin tables |
| Oct 13, 2026 | The InboxOS brand, documentation and the 1.0.0 public release |

## Features

**Mail**
- Personal and shared mailboxes (`hello@`, `support@`) with owner, can-send and read-only access, plus an **All inboxes** view
- Several domains at once: every mailbox gets its address on each domain, and compose lets you pick which one to send from
- Aliases and an optional catch-all; mail for unknown addresses is kept, never lost
- Conversations, labels, stars, archive, spam, trash, snooze, and Gmail-style search (`from:` `to:` `subject:` `has:attachment` `is:unread` `before:` `after:` …)
- Rich-text compose with autosaved drafts, undo send, scheduled send, templates, signatures and attachment reminders
- Delivery timeline on sent mail: delivered, bounced, complained, opened, clicked
- Mail rules (filter, label, move, mark, star) with dry-run previews, vacation replies and blocked senders
- Installable on phones and desktops, with push notifications and optional unread digests to a personal address
- Unsubscribe links, a do-not-email list and a branded unsubscribe page for outreach

**Working together**
- Assign conversations, set them open, pending or closed, leave internal notes and @mention teammates
- Collision warnings when two people reply to the same conversation
- A team directory with profile photos, titles, departments, pronouns and local time

**Admin console**
- **Dashboard** with sent, received and bounce trends, quota meters and a setup checklist
- **Health center**: provider key, webhook, DNS, cron, quotas, bounce rates, 2FA coverage, storage and more, each with a fix
- **Users and mailboxes** with server-side search, filters, sorting, bulk actions and CSV import and export
- **Domains** with live DNS checks (SPF, DKIM, MX, DMARC) and copy-ready records
- **All traffic**: every email across your domains in one view, including unrouted mail
- **Security center**: sessions, sign-in history, new-device alerts, IP allowlist, required 2FA, passkeys, Google sign-in and SCIM provisioning (Okta, Entra ID)
- **Compliance**: retention policies, legal holds and eDiscovery exports
- **Signatures and DLP**: company signatures, legal disclaimers and outbound data-loss rules
- **Roles**: owner, admin, member and a read-only manager who can see the console but change nothing
- Delivery and audit logs, both searchable and exportable
- **⌘K / Ctrl+K command palette** for pages, actions, people and mailboxes

**For developers**
- REST API with scoped keys, an MCP server, and signed outbound webhooks with retries
- Every feature can be switched off per workspace; switched-off features are hidden in the app and refused by the API

## Screenshots

| | |
|---|---|
| ![Setup wizard](.github/screenshots/setup.png) | ![Admin dashboard](.github/screenshots/dashboard.png) |
| **Setup wizard**: from a fresh deploy to working mail | **Dashboard**: activity, quotas and setup progress |
| ![Health center](.github/screenshots/health.png) | ![Appearance](.github/screenshots/appearance.png) |
| **Health center**: every problem with a fix | **Appearance**: presets, palettes and live previews |
| ![Inbox in dark mode](.github/screenshots/inbox-dark.png) | ![Webhooks](.github/screenshots/webhooks.png) |
| **Dark mode**, from the same theme tokens | **Webhooks**: signed, retried and logged |
| ![Sign-in page](.github/screenshots/signin.png) | |
| **Sign-in**, with your name, logo and colors | |

## How it works

```
Browser (React app)  ──►  Cloudflare Worker (Hono API)  ──►  D1 (database)  ·  R2 (bodies, attachments, photos)
                                    │   ▲
                       send via API │   │ webhooks: email.received, delivered, bounced, opened…
                                    ▼   │
                                  Resend
```

- **Sending** goes through the Resend API. Every send path (the app, scheduled mail, the API and MCP) passes through one function that applies quotas, suppressions, signatures, disclaimers and DLP rules.
- **Receiving**: Resend calls a webhook when mail arrives. The Worker verifies the signature, fetches the message, runs mail rules and files it into the right mailbox, then sends push notifications, auto-replies and outbound webhooks.
- **Statuses** arrive by webhook and update each message's timeline. Every webhook is signature-checked and de-duplicated.
- **The cron trigger** runs every minute: scheduled sends, snoozed mail, digests, webhook retries, retention and daily cleanup.

| Where | What lives there |
|---|---|
| **D1** | People, sessions, mailboxes, message metadata and full-text search index, labels, rules, settings, audit and delivery logs, encrypted provider credentials |
| **R2** | Message bodies, attachments, inline images, profile photos, logos and eDiscovery exports |
| **Worker secrets** | `SESSION_SECRET` (signing and encryption), plus any optional secrets you choose to set |

## Requirements

- A **Cloudflare account**. The free plan is enough for a small team; the Workers Paid plan raises CPU and request limits as you grow.
- A **domain** whose DNS you can edit (it doesn't have to be on Cloudflare).
- A **Resend account**. The free plan sends 100 emails a day and 3,000 a month.
- **Node.js 20 or newer** and npm, to build and deploy.

## Deploy to Cloudflare

```bash
git clone https://github.com/DylanLambertson/InboxOS.git
cd InboxOS
npm install

# 1. Create the database and the storage bucket
npx wrangler d1 create inboxos                 # copy the database_id into wrangler.jsonc
npx wrangler r2 bucket create inboxos-files

# 2. One required secret: a long random string. Keep a copy; the setup wizard asks for it once.
openssl rand -base64 48 | tee /dev/tty | npx wrangler secret put SESSION_SECRET

# 3. Set APP_URL in wrangler.jsonc to the address you'll use, then deploy
npm run deploy
```

`npm run deploy` builds the app, applies any pending database migrations and deploys the Worker. Open your Worker's URL
and the setup wizard takes it from there.

**Your own hostname.** To serve the app on, say, `mail.example.com`, uncomment `routes` in `wrangler.jsonc`, or add it in
the Cloudflare dashboard under **Workers → inboxos → Settings → Domains & Routes**. Keep `APP_URL` in step with it. Add a
route per hostname if you use several mail domains.

**A separate setup key.** If you'd rather not type `SESSION_SECRET` into the wizard, set `SETUP_TOKEN` with
`npx wrangler secret put SETUP_TOKEN` and the wizard asks for that instead.

**Google sign-in (optional).** Create an OAuth client in Google Cloud with the redirect URI
`<APP_URL>/api/auth/google/callback`, then set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as secrets.

**Push notifications (optional).** Generate a VAPID key and store it as a secret:

```bash
node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']).then(k=>crypto.subtle.exportKey('jwk',k.privateKey)).then(j=>console.log(JSON.stringify(j)))" \
  | npx wrangler secret put VAPID_PRIVATE_JWK
```

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars      # set SESSION_SECRET to any long string
npm run db:migrate:local
npm run dev
```

Open http://localhost:5173. You'll land in the setup wizard; the setup key is the `SESSION_SECRET` (or `SETUP_TOKEN`)
from `.dev.vars`. Without a Resend key you can use the whole interface; sending shows a clear "not connected" message.
Local data lives in `.wrangler/` and can be wiped by deleting that folder.

## The setup wizard

The first visit to a fresh install opens `/setup`. Every step can be skipped and finished later from **Admin → Setup**,
and progress is saved on the server, so you can stop and come back from another device.

1. **Your account**: create the owner. A setup key proves you're the person who deployed the app, so nobody can claim a fresh URL before you.
2. **Use case**: pick what you'll use it for. This sets a starting theme and feature set.
3. **Brand**: company and app name, logo and accent color, with a live preview.
4. **Email provider**: paste a Resend API key. It's checked live and stored encrypted.
5. **Domains**: add your domains. InboxOS creates them in Resend, shows the DNS records to add (with tips for Cloudflare, Namecheap, GoDaddy, Route 53 and others, plus a zone file), checks them live, and warns if the domain already receives mail elsewhere.
6. **Receiving**: registers the inbound webhook for you and stores its signing secret.
7. **Mailboxes**: your own inbox plus suggested shared ones for your use case.
8. **Team**: invite people by pasting addresses.
9. **Test**: send a real email out, and a loopback test that waits for it to come back in.

## Use cases

The use case you pick sets a starting look and a set of features. It's a starting point, not a lock: every feature can
be switched on or off later in **Admin → Features**, and the look can be changed in **Admin → Appearance**.

| Use case | Built for |
|---|---|
| **Team** | Personal and shared inboxes for a small company |
| **Agency** | Client work across several domains, with outreach built in |
| **Support desk** | Shared inboxes first: assign, note and answer together |
| **Personal & family** | Your own domain, a few addresses, nothing to manage |
| **Startup** | Founders' mail, investor updates and early customer support |
| **Regulated / enterprise** | Everything on: retention, legal hold, DLP, SCIM and required 2FA |

## Make it yours

Everything people see comes from settings, not code. A fresh install wears the InboxOS logo and purple accent; rename
the app in the setup wizard and the logo steps aside for your initials until you upload your own.

| Where | What |
|---|---|
| **Admin → Branding** | Company and app name, logo, monogram, sign-in headline, support email, footer, default sender name, previews of every system email |
| **Admin → Appearance** | Use-case presets, accent, corner radius, density, fonts, text size, default color mode, and full light and dark palettes with contrast warnings. Bright accents stay readable: links and highlights automatically use a deeper shade on light backgrounds. Import and export themes as JSON. |
| **Admin → Features** | Turn features on or off for the whole workspace. Off means hidden in the UI and refused by the API; nothing is deleted. |
| **Settings → Profile** | Each person's photo, title, pronouns, time zone, color mode and density |

Themes are plain JSON (see `shared/theme.ts`), so you can keep them in version control or share them:

```json
{ "accent": "#0f766e", "radius": "lg", "density": "comfortable", "fontFamily": "\"Inter\", system-ui, sans-serif",
  "googleFont": "Inter", "fontScale": 1, "defaultMode": "system", "light": {}, "dark": { "bg": "#0b0f0e" } }
```

Installed app icons, the favicon, system emails and the sign-in page all follow the brand, so a renamed install
shows no trace of InboxOS to the people using it.

## Email providers

InboxOS uses [Resend](https://resend.com) for sending and receiving. The app enforces whatever daily and monthly limits
you set in **Admin → Policies**, so you never hit provider errors; raise them after upgrading your Resend plan.

All provider code lives behind a small interface (`worker/lib/resend.ts` for the API, `worker/lib/provider-config.ts`
for credentials). Adding another provider, such as Postmark, Amazon SES or Mailgun, means implementing sending,
inbound parsing and delivery events in one adapter. Pluggable providers are on the [roadmap](#roadmap), and
contributions are welcome.

## Webhooks

**Admin → Webhooks** sends signed HTTP notifications to your own services when things happen.

| Group | Events |
|---|---|
| Mail | `message.received`, `message.sent` |
| Delivery | `message.delivered`, `message.bounced`, `message.complained`, `message.opened`, `message.clicked` |
| People | `user.created`, `user.disabled`, `user.deleted` |
| Mailboxes | `mailbox.created`, `mailbox.deleted` |

Requests follow the [Standard Webhooks](https://www.standardwebhooks.com) spec: each carries `webhook-id`,
`webhook-timestamp` and `webhook-signature` headers, and the signature is `v1,` followed by a base64 HMAC-SHA256 of
`<id>.<timestamp>.<body>`, keyed with your `whsec_…` secret. Any Standard Webhooks library can verify them, or do it by hand:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(secret, headers, body) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signed = `${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`;
  const expected = Buffer.from(createHmac("sha256", key).update(signed).digest("base64"));
  return headers["webhook-signature"].split(" ").some((sig) => {
    const given = Buffer.from(sig.replace(/^v1,/, ""));
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

Failed deliveries are retried with exponential backoff for about a day, and an endpoint that keeps failing is switched
off automatically and flagged in the health center. Every attempt is logged and can be redelivered from the admin page,
which also shows verification samples for Node and Python.

## API and MCP

Create keys in **Admin → API & MCP**. Keys are scoped (`send`, `contacts`, `read`), can be limited to specific
mailboxes, and changes made with a key are recorded in the audit log.

**REST** at `https://<your-app>/api/v1`, with `Authorization: Bearer <key>`:

| Method | Path | Does |
|---|---|---|
| `POST` | `/send` | Send an email, with attachments, scheduling and replies |
| `GET` | `/status` | Remaining sending quota |
| `GET` | `/mailboxes` | Mailboxes the key can use |
| `GET` `POST` | `/contacts` | Search and save contacts |
| `GET` `DELETE` | `/contacts/:email` | Read or delete one contact |
| `GET` | `/messages` | List messages |
| `GET` | `/messages/:id` | One message in full |
| `GET` | `/messages/:id/thread` | A whole conversation |
| `POST` | `/messages/actions` | Mark read or unread, star, archive, trash or restore |
| `GET` | `/attachments/:id` | Download an attachment |

Keys flagged **Act as a user** may send `X-Act-As: <email>` to narrow a request to that person's mailboxes, for
integrations that work on behalf of your team.

**MCP**: point any [Model Context Protocol](https://modelcontextprotocol.io) client at `https://<your-app>/mcp` with the
same bearer key (or `https://<your-app>/mcp/<key>` for clients that can't send headers). Tools cover sending and drafts
(`send_email`, `create_draft`), reading and triage (`list_messages`, `get_thread`, `triage_messages`), contacts
(`search_contacts`, `get_contact`, `save_contacts`, `delete_contact`, `mark_do_not_email`) and status (`get_status`,
`list_mailboxes`).

## Configuration reference

| Name | Kind | Required | What it does |
|---|---|---|---|
| `APP_URL` | var | yes | Public URL of the app, used for links, OAuth and webhooks |
| `SESSION_SECRET` | secret | yes | Signs links and encrypts stored credentials. Also the default setup key. |
| `SETUP_TOKEN` | secret | no | A separate setup key for creating the first owner |
| `RESEND_API_KEY` | secret | no | Overrides the key entered in the setup wizard |
| `RESEND_WEBHOOK_SECRET` | secret | no | Overrides the signing secret captured by the setup wizard |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | secret | no | Enables Google sign-in (redirect URI: `<APP_URL>/api/auth/google/callback`) |
| `VAPID_PRIVATE_JWK` | secret | no | Enables push notifications |

Everything else (branding, theme, features, policies, domains, retention, security rules) is set in the app and stored in D1.

## Running it in production

**Updating.** Pull the latest release and deploy again. Migrations are applied automatically before the new Worker goes live.

```bash
git pull
npm install
npm run deploy
```

**Backups.** Export the database whenever you like, and copy the R2 bucket with any S3-compatible tool (R2 speaks the S3 API).

```bash
npx wrangler d1 export inboxos --remote --output inboxos-backup.sql
```

D1 also keeps its own point-in-time history (Time Travel), so you can restore the database to an earlier moment
with `npx wrangler d1 time-travel restore`.

**Monitoring.** **Admin → Health** checks the provider, webhooks, DNS, cron, quotas, bounce rates, storage and security
settings, and the dashboard shows trends. For live logs, run `npx wrangler tail`.

**Keep `SESSION_SECRET` safe.** It encrypts the provider credentials and webhook secrets stored in the database.
If you change it, re-enter the Resend key in **Admin → Setup** and rotate your webhook secrets.

**Recovery.** If you're ever locked out, `npm run bootstrap:remote -- --email you@example.com` resets that person's
password and owner role.

## Security

- Passwords hashed with PBKDF2-SHA256, account lockout and rate-limited sign-in; passkeys and TOTP two-factor with recovery codes
- HttpOnly, SameSite session cookies stored as hashes; cross-site requests are refused
- Provider credentials and webhook secrets are encrypted at rest (AES-GCM, key derived from `SESSION_SECRET`)
- Incoming mail is sanitized and shown in a sandboxed frame with remote images blocked until you allow them, under a strict Content Security Policy
- Every inbound webhook's signature and timestamp are checked; replays are rejected
- Outbound webhooks only go to public HTTPS addresses, never to private networks
- Admins can't read other people's mailboxes without adding themselves, and that's recorded in the audit log

Found a vulnerability? Please don't open a public issue. See [SECURITY.md](./SECURITY.md) for how to report it privately.

## Keyboard shortcuts

`⌘/Ctrl+K` go to anything · `c` compose · `/` search · `j`/`k` next/previous · `e` archive · `#` delete · `!` spam ·
`b` snooze · `s` star · `r` reply · `a` reply all · `f` forward · `g i` inbox · `⌘/Ctrl+Enter` send · `?` all shortcuts

## Troubleshooting

Start with **Admin → Health**: it checks most of what can go wrong and links to the fix.

| Symptom | Fix |
|---|---|
| "No email provider API key" | Finish the **Email provider** step in Admin → Setup, or set `RESEND_API_KEY` |
| Incoming mail never shows up | Check the MX record in Admin → Domains and the webhook in Admin → Setup. Mail for addresses without a mailbox waits in **Admin → All traffic → Unrouted**. |
| A domain stays "pending" | DNS can take a while to spread. Use **Re-check** in Admin → Domains; the per-record status shows which record is still missing. |
| "Scheduled jobs haven't run" | Cron triggers only run on deployed Workers; check `triggers` in `wrangler.jsonc` |
| "Daily sending limit reached" | Raise the limits in Admin → Policies after upgrading your Resend plan |
| Push notifications never arrive | Set `VAPID_PRIVATE_JWK`. On iPhone and iPad, add the app to the home screen first (iOS 16.4 or newer). |
| Lost the setup key | Set a new one: `npx wrangler secret put SETUP_TOKEN` |
| Locked out | `npm run bootstrap:remote -- --email you@example.com` resets your password and owner role |
| The page looks out of date after an update | The installed app caches its shell; reload once, or accept the "new version ready" prompt |

## Project structure

```
InboxOS/
├── shared/          # Types and pure logic used by both the Worker and the app (theme, workspace, setup, CSV…)
├── worker/          # Cloudflare Worker: Hono API, inbound webhooks, cron
│   ├── lib/         # auth, sessions, 2FA, passkeys, Resend, sending, inbound, DNS, webhooks, health…
│   └── routes/      # REST endpoints
├── src/             # React app
│   ├── components/  # UI kit, compose, mail viewer, layout, command palette, setup pieces
│   └── pages/       # Mail, Setup, Settings, Admin, People, Auth
├── migrations/      # D1 schema, applied in order
├── public/          # Static assets: brand, icons, service worker
├── scripts/         # bootstrap.mjs: recover access if you're locked out
├── tests/           # Unit and integration tests (Vitest)
└── wrangler.jsonc   # Cloudflare config
```

| Command | Does |
|---|---|
| `npm run dev` | App and API locally with hot reload |
| `npm run build` | Production build |
| `npm run deploy` | Build, apply database migrations and deploy |
| `npm run typecheck` | TypeScript checks for the app and the Worker |
| `npm test` | Unit and integration tests |
| `npm run db:migrate:local` / `:remote` | Apply database migrations |
| `npm run bootstrap:local` / `:remote` | Reset an owner's password and role (recovery) |

## Development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Before opening a pull request, make sure everything passes:

```bash
npm run typecheck && npm test && npm run build
```

A few conventions keep the codebase easy to work in:

- **Shared first.** Logic that both the Worker and the app need lives in `shared/` as plain, tested functions.
- **Validate at the edge.** Every request body is parsed with zod before it reaches business logic.
- **Small files.** Split a file before it passes about 500 lines.
- **Schema changes are migrations.** Add a new numbered file in `migrations/`; never edit one that has shipped.
- **Every feature can be switched off.** New features get a switch in `shared/workspace.ts` and a server-side guard.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide.

## Roadmap

These are the things I plan to work on next. If one matters to you, say so in an issue; that's how I decide what comes first.

- Pluggable email providers (Postmark, Amazon SES, Mailgun)
- IMAP import for moving existing mailboxes in
- Calendar invites: show and answer `.ics` invitations in the reader
- Saved searches and smart folders
- Translations
- A one-click deploy button

## FAQ

<details>
<summary><strong>Is InboxOS free?</strong></summary>

Yes. InboxOS is free software under the AGPL-3.0. You pay only for what you use on Cloudflare and Resend, and both
have free plans that cover a small team.
</details>

<details>
<summary><strong>Is this a mail server?</strong></summary>

No, and that's on purpose. InboxOS doesn't run SMTP or IMAP itself. Resend handles delivery in both directions, and
InboxOS is the mail client, storage, team tooling and admin console on top. That means no IP reputation to build,
no spam filter to tune and no server to patch.
</details>

<details>
<summary><strong>Can I use Outlook, Apple Mail or Thunderbird with it?</strong></summary>

Not today. There's no IMAP or SMTP access; people use the InboxOS web app, which installs like a native app on
phones and computers and supports push notifications. Other services can use the REST API or MCP.
</details>

<details>
<summary><strong>Can I move my existing mail in?</strong></summary>

Not yet. IMAP import is on the roadmap. Until then, InboxOS works well alongside your old provider while you switch
over: point the MX records at Resend when you're ready to receive in InboxOS.
</details>

<details>
<summary><strong>Do I need my domain on Cloudflare?</strong></summary>

No. Your DNS can be anywhere. The setup wizard shows the exact records to add and includes tips for Cloudflare,
Namecheap, GoDaddy, Route 53 and others, plus a zone file you can import.
</details>

<details>
<summary><strong>How many people can it handle?</strong></summary>

The admin console is built for hundreds of people and mailboxes, with server-side search, paging, bulk actions and
CSV import. The practical limits are your Resend sending plan and your Cloudflare plan's D1 and CPU limits.
</details>

<details>
<summary><strong>Can I host several domains or brands?</strong></summary>

Several domains, yes: every mailbox gets an address on each domain, and people choose which one to send from. One
install has one brand; run another install for a completely separate brand.
</details>

<details>
<summary><strong>Can I remove the InboxOS name and logo?</strong></summary>

Yes. Rename the app and upload your own logo in the setup wizard or in **Admin → Branding**, and every screen, email
and app icon follows. The AGPL still applies to the code itself; see [License](#license).
</details>

<details>
<summary><strong>Who can read my mail?</strong></summary>

Only the people with access to a mailbox. Messages are stored in your own Cloudflare account. Admins can't open other
people's mailboxes without adding themselves, and that action is written to the audit log. Owners can run eDiscovery
searches when legal hold or compliance requires it, and those are audited too.
</details>

<details>
<summary><strong>What does the AGPL mean for my company?</strong></summary>

Using InboxOS inside your company, including modifying it for your own use, places no obligations on you beyond
keeping the license notices. If you modify InboxOS and offer it to people outside your organization over a network,
you must make your modified source available to them under the same license. If you're unsure how that applies to
you, [get in touch](#contact).
</details>

<details>
<summary><strong>Can I use it for cold outreach?</strong></summary>

The Agency preset includes outreach tools: unsubscribe links, a do-not-email list and suppression of bounced and
complaining addresses. You're responsible for following the anti-spam laws that apply to you (CAN-SPAM, GDPR, CASL)
and Resend's acceptable use policy.
</details>

<details>
<summary><strong>How do I get help?</strong></summary>

Check [Troubleshooting](#troubleshooting) and **Admin → Health** first. If you're still stuck, open an
[issue](https://github.com/DylanLambertson/InboxOS/issues/new/choose) with what you tried and what you saw.
</details>

## Contact

InboxOS is created and maintained by **Dylan Lambertson**.

| | |
|---|---|
| **Bugs and feature requests** | [GitHub Issues](https://github.com/DylanLambertson/InboxOS/issues/new/choose) |
| **Security reports** | Privately, as described in [SECURITY.md](./SECURITY.md) |
| **Licensing, partnerships and everything else** | [me@dylanlambertson.dev](mailto:me@dylanlambertson.dev) |
| **Website** | [dylanlambertson.dev](https://dylanlambertson.dev) |
| **GitHub** | [@DylanLambertson](https://github.com/DylanLambertson) |

## License

Copyright © 2026 Dylan Lambertson.

InboxOS is free software: you can redistribute it and/or modify it under the terms of the
[GNU Affero General Public License v3.0](./LICENSE) as published by the Free Software Foundation. It is distributed
in the hope that it will be useful, but **without any warranty**; without even the implied warranty of
merchantability or fitness for a particular purpose.

In plain terms: you can use, study, modify and self-host InboxOS freely. If you run a modified version as a service
for others, you must offer them your changes under the same license.

The InboxOS name and logo belong to Dylan Lambertson and are not covered by the AGPL. You're welcome to use them to
refer to the project, but a fork or hosted service that is not the original should use its own name and logo. See
[NOTICE](./NOTICE) for details. Third-party dependencies remain under their own licenses.

## Acknowledgements

InboxOS stands on excellent open-source work, including [Hono](https://hono.dev), [React](https://react.dev),
[React Router](https://reactrouter.com), [TanStack Query](https://tanstack.com/query), [Tiptap](https://tiptap.dev),
[Tailwind CSS](https://tailwindcss.com), [Lucide](https://lucide.dev), [Zod](https://zod.dev),
[DOMPurify](https://github.com/cure53/DOMPurify), [SimpleWebAuthn](https://simplewebauthn.dev),
[Sonner](https://sonner.emilkowal.ski), [Vite](https://vite.dev) and [Vitest](https://vitest.dev), and on the
platforms of [Cloudflare](https://workers.cloudflare.com) and [Resend](https://resend.com).

<p align="center">
  <sub>Built by <a href="https://github.com/DylanLambertson">Dylan Lambertson</a> · © 2026 · <a href="./LICENSE">AGPL-3.0</a></sub>
</p>

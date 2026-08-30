# InboxOS

Self-hosted team email on Cloudflare Workers, D1 and R2, with Resend for sending and receiving.

> Work in progress. Expect rough edges and breaking changes.

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run bootstrap:local -- --email you@example.com --name "Your Name"
npm run dev
```

Open http://localhost:5173 and sign in.

## Deploy

```bash
npx wrangler d1 create inboxos        # put the database_id in wrangler.jsonc
npx wrangler r2 bucket create inboxos-files
npx wrangler secret put SESSION_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_WEBHOOK_SECRET
npm run deploy
```

## License

AGPL-3.0. Copyright (c) 2026 Dylan Lambertson.

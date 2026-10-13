# Contributing to InboxOS

Thanks for taking the time to help. Bug reports, fixes, documentation and new features are all welcome. This guide
explains how to get set up and what makes a pull request easy to accept.

## Before you start

- **Bugs**: search the [issues](https://github.com/DylanLambertson/InboxOS/issues) first, then open one with the bug
  report form. Steps to reproduce and what **Admin → Health** says help most.
- **Features**: open an issue to talk it through before writing a lot of code, so we can agree on the approach and you
  don't spend time on something that doesn't fit.
- **Security problems**: don't open an issue. Follow [SECURITY.md](./SECURITY.md).

## Getting set up

You need Node.js 20 or newer.

```bash
git clone https://github.com/DylanLambertson/InboxOS.git
cd InboxOS
npm install
cp .dev.vars.example .dev.vars      # set SESSION_SECRET to any long string
npm run db:migrate:local
npm run dev
```

Open http://localhost:5173 and finish the setup wizard with the `SESSION_SECRET` from `.dev.vars` as the setup key.
You don't need a Resend account to work on most of the app.

## Making a change

1. Fork the repository and create a branch from `main` (`fix/unread-count`, `feat/imap-import`).
2. Make your change, with tests for any new logic.
3. Run the full check:

   ```bash
   npm run typecheck && npm test && npm run build
   ```

4. Open a pull request and fill in the template. Screenshots or a short recording help a lot for UI changes.

## Guidelines

**Code**
- TypeScript everywhere, strict mode, no `any` without a good reason.
- Logic used by both the Worker and the app belongs in `shared/` as plain functions with tests.
- Validate every request body with zod at the route boundary.
- Keep files focused; split one before it passes about 500 lines.
- Match the style of the code around you. Comments explain why, not what.

**Database**
- Schema changes are new numbered files in `migrations/`. Never edit a migration that has shipped.
- Prefer adding columns over rebuilding tables, and make migrations safe to run on a live install.

**Features**
- New user-facing features get a switch in `shared/workspace.ts`, a server-side guard (`requireFeature`) and a
  hidden state in the UI when switched off.
- Anything visible to people comes from brand and theme settings, never hard-coded names or colors.
- UI must work on phones, with the keyboard, and in light and dark mode.

**Security**
- Never log message contents, secrets or tokens.
- Check access on the server for every request; the UI hiding something is not a permission check.

## Commit messages

The history uses [Conventional Commits](https://www.conventionalcommits.org):

```
feat(admin): bulk actions for mailboxes
fix(compose): keep the selected sending domain on reply
docs: explain webhook retries
```

Use the imperative mood, keep the subject under about 72 characters, and explain the why in the body when it isn't
obvious.

## Licensing of contributions

InboxOS is licensed under the [GNU AGPL v3.0](./LICENSE). By submitting a contribution, you agree that it is your own
work (or you have the right to submit it) and that it is licensed under the same terms as the project.

## Code of conduct

Everyone taking part is expected to follow the [code of conduct](./CODE_OF_CONDUCT.md).

Questions about contributing? Open an issue or write to [me@dylanlambertson.dev](mailto:me@dylanlambertson.dev).

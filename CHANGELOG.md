# Changelog

All notable changes to InboxOS are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-13

The first public release.

### Mail
- Personal and shared mailboxes with owner, can-send and read-only access, and an All inboxes view
- Multiple mail domains, with a send-domain switch in compose
- Aliases, an optional catch-all and a safety net that keeps mail for unknown addresses
- Conversations, labels, stars, archive, spam, trash, snooze and Gmail-style search
- Rich-text compose with autosaved drafts, undo send, scheduled send, templates and signatures
- Delivery timeline for sent mail
- Mail rules with dry-run previews, vacation replies and blocked senders
- Installable app for phones and desktops, push notifications and unread digests
- Unsubscribe links, a do-not-email list and a branded unsubscribe page

### Working together
- Conversation assignment, statuses, internal notes, @mentions and reply-collision warnings
- Team directory with profile photos and profile details

### Setup and appearance
- First-run setup wizard: owner account, use case, brand, Resend key, domains with live DNS checks, receiving, mailboxes, invitations and send and receive tests
- Six use-case presets that set a starting look and feature set
- Theme studio with presets, palettes, fonts, density, contrast checks and JSON import and export
- Per-workspace feature switches, enforced on the server
- InboxOS logo, app icons and purple default theme, with a readable accent shade for text on any background

### Administration
- Dashboard, health center and ⌘K command palette
- Users and mailboxes with server-side search, filters, bulk actions and CSV import and export
- Domains page with live DNS status
- All-traffic view, delivery and audit logs
- Security center with sessions, sign-in history, new-device alerts and an IP allowlist
- Passkeys, TOTP two-factor, Google sign-in and SCIM 2.0 provisioning
- Retention policies, legal hold and eDiscovery exports
- Company signatures, disclaimers and outbound data-loss prevention
- Read-only Manager role

### Developers
- REST API with scoped keys and act-as keys
- MCP server
- Signed outbound webhooks (Standard Webhooks) with retries, a delivery log and redelivery

[1.0.0]: https://github.com/DylanLambertson/InboxOS/releases/tag/v1.0.0

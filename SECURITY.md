# Security policy

InboxOS holds people's email, so security reports get priority over everything else.

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | Yes |
| Earlier development builds | No |

Security fixes are released as patch versions. Updating is `git pull && npm install && npm run deploy`.

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request for a security problem.**

Report it privately, in either of these ways:

1. **GitHub**: open the repository's **Security** tab and choose **Report a vulnerability**.
2. **Email**: write to [me@dylanlambertson.dev](mailto:me@dylanlambertson.dev) with "InboxOS security" in the subject.

Please include:

- what the problem is and what an attacker could do with it
- steps to reproduce, or a proof of concept
- the version or commit you tested, and any configuration it depends on
- how you'd like to be credited, if at all

## What to expect

- An acknowledgement within **3 business days**
- An initial assessment and severity within **7 days**
- A fix or a mitigation plan within **30 days** for confirmed issues, sooner for critical ones
- Credit in the release notes and the security advisory, unless you'd rather stay anonymous

I'll keep you updated along the way and agree a disclosure date with you. Please give a fix a reasonable chance to ship
before talking about the issue publicly.

## Scope

In scope: the code in this repository, including the Worker, the web app, the MCP server, webhooks and the setup wizard.

Out of scope:

- vulnerabilities in Cloudflare, Resend or other third-party services (report those to the vendor)
- installs that were modified, or misconfigured against the documentation
- missing best-practice headers or settings without a demonstrated impact
- denial of service by sheer request volume, and social engineering

## Safe harbor

Research done in good faith under this policy is welcome. Test only against installs you own or have permission to
test, don't access or change other people's data beyond what's needed to show the issue, and don't degrade the service
for others. I won't pursue or support legal action against anyone who follows these rules.

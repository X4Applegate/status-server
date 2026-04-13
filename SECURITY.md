# Security Policy

## Supported Versions

Only the latest release on the `main` branch receives security fixes.
Older versions are not backported.

| Version | Supported |
|---|---|
| Latest (`main`) | ✅ Yes |
| Older releases | ❌ No — please upgrade |

---

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**
Public disclosure before a fix is available puts everyone running this
software at risk.

Instead, report privately by emailing:

**richard@x4-applegate.com**

Include as much of the following as you can:

- A description of the vulnerability and its potential impact
- The affected version(s) or commit(s)
- Steps to reproduce or a proof-of-concept (even a partial one helps)
- Any suggested fix or mitigation, if you have one

Your report will be acknowledged within **48 hours**. If you don't hear
back, follow up — emails sometimes land in spam.

---

## Disclosure Process

1. **Report received** — acknowledged within 48 hours.
2. **Triage** — severity assessed, reproduction attempted.
3. **Fix developed** — a patch is written and tested.
4. **Release** — a new version is published with the fix.
5. **Credit** — reporters are credited in the release notes and
   CHANGELOG unless they prefer to remain anonymous.

For critical vulnerabilities (remote code execution, auth bypass,
data exposure) the goal is a fix within **7 days** of confirmation.
For lower severity issues the timeline is best-effort.

---

## Scope

This policy covers the **Applegate Monitor** application code in this
repository. It does not cover:

- Your own deployment configuration (docker-compose secrets, firewall rules)
- Third-party dependencies — report those to the upstream maintainer,
  though a heads-up here is always appreciated
- The live demo at [uptime.richardapplegate.io](https://uptime.richardapplegate.io)
  — that's a personal instance, not a managed service

---

## Known Security Measures

For transparency, here is a summary of the security controls currently
built into the application:

- **Authentication** — bcrypt password hashing (cost factor 10), session-based auth
- **Session security** — server-side sessions stored in MariaDB, `httpOnly` + `sameSite=lax` cookies, auto-`Secure` flag on HTTPS
- **Rate limiting** — login, setup, and password-change endpoints are rate-limited per IP
- **Security headers** — HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy via helmet
- **Input validation** — parameterized queries throughout (no raw SQL concatenation)
- **Role-based access** — admin and viewer roles with per-group scoping; viewers cannot see other tenants' data
- **Audit log** — all significant user actions (logins, CRUD, password changes) are logged with timestamp and IP
- **Dependency scanning** — `npm audit` runs in CI on every push; Dependabot files weekly update PRs
- **Least privilege** — Docker container runs as the non-root `node` user

---

## Acknowledgements

Security reporters who have responsibly disclosed issues:

*None yet — be the first.*

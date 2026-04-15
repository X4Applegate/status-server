# Contributing to Status Server

Thank you for your interest in contributing! Whether you're reporting a bug, suggesting a feature, or submitting a pull request — all contributions are welcome and appreciated.

Please take a moment to read through these guidelines before getting started.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Development Setup](#development-setup)
- [Coding Standards](#coding-standards)
- [Commit Messages](#commit-messages)
- [Contact](#contact)

---

## Code of Conduct

This project is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it. Please report unacceptable behavior to [richard@x4-applegate.com](mailto:richard@x4-applegate.com).

---

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/your-username/status-server.git
   cd status-server
   ```
3. **Create a branch** for your change:
   ```bash
   git checkout -b feature/your-feature-name
   ```
4. Make your changes, then **commit** and **push**
5. Open a **Pull Request** against the `main` branch

---

## Reporting Bugs

Before opening an issue, please search existing issues to avoid duplicates.

When filing a bug report, include:

- A clear and descriptive title
- Steps to reproduce the issue
- Expected behavior vs. actual behavior
- Screenshots or logs if applicable
- Your environment (OS, Node.js version, Docker version)

> **Security vulnerabilities** should be reported privately to [richard@x4-applegate.com](mailto:richard@x4-applegate.com) — please do **not** open a public issue.

---

## Suggesting Features

Feature requests are welcome! When opening a feature request, please include:

- A clear description of the problem you're trying to solve
- Your proposed solution or idea
- Any alternatives you've considered

---

## Submitting a Pull Request

To keep things smooth, please follow these steps:

1. Ensure your branch is up to date with `main` before submitting
2. Keep pull requests focused — one feature or fix per PR
3. Write a clear PR description explaining **what** changed and **why**
4. Test your changes locally using Docker Compose before submitting
5. Be responsive to review feedback

PRs that break existing functionality or introduce major changes without prior discussion may be closed.

---

## Development Setup

### Requirements

- [Docker](https://www.docker.com/) and Docker Compose
- Node.js 18+ (for local development without Docker)
- A MariaDB / MySQL database

### Running locally with Docker

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env with your database credentials and settings

# Start all services
docker compose up -d --build

# View logs
docker compose logs -f
```

### Running the backend directly

```bash
cd backend
npm install
node server.js
```

---

## Coding Standards

- **JavaScript** — plain ES2020+, no TypeScript required
- **Formatting** — 2-space indentation, single quotes preferred
- **Templates** — EJS for server-rendered views
- **CSS** — vanilla CSS, no frameworks
- Keep changes minimal and scoped — avoid refactoring unrelated code in the same PR
- Add comments for anything non-obvious

---

## Commit Messages

Please write clear, concise commit messages:

```
Short summary (50 chars or less)

Optional body explaining the why, not the what.
Wrap lines at 72 characters.
```

**Good examples:**
- `Add Square account group permissions`
- `Fix server card name truncation on small screens`
- `Update debounce logic for Square POS alerts`

**Avoid:**
- `fix stuff`
- `WIP`
- `asdfgh`

---

## Contact

Have a question that doesn't fit an issue? Reach out directly:

**Richard Applegate** — [richard@x4-applegate.com](mailto:richard@x4-applegate.com)

---

Thank you for helping make Status Server better!

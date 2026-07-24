# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report privately via
GitHub's [Report a vulnerability](https://github.com/sanguneo/test-osterone/security/advisories/new)
(Security → Advisories), or contact the maintainer directly.

Include what you found, how to reproduce it, and the impact. We'll acknowledge and work a fix before any public disclosure.

## What this project does with secrets

test-osterone is a local tool, and it is designed to keep credentials **out of the repository and out of version control**:

- **Model tokens** (ChatGPT/Codex OAuth, API keys) are read at runtime from your local `~/.codex` session or entered in the Studio UI and held **in memory** — never written into the repo.
- **Studio project & run state** (accounts, sheets, traces) lives under `~/.test-osterone/` in your home directory, not in the repo.
- The repo's fixtures use only **synthetic placeholders** (e.g. `admin` / `secret` for the bundled demo app). Never commit real credentials, tokens, or client URLs.

If you're contributing, see the "Never commit secrets" invariant in [CONTRIBUTING.md](CONTRIBUTING.md).

## Scope

Web/browser test automation run locally. The Studio server binds to `localhost` and is intended for local, single-user use — do not expose it to an untrusted network.

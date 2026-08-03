# Contributing to test-osterone

[English](CONTRIBUTING.md) · [한국어](CONTRIBUTING.ko.md)

Thanks for helping out. This project has one sacred rule that shapes everything else:

> **false-pass = 0.** A silently-wrong `pass` is the worst possible outcome. The AI *writes* tests; a deterministic engine *judges* them. Never weaken the verdict to make something green.

Read [`README.md`](README.md) for the architecture and the trust model before you start.

## Prerequisites

- **[Bun](https://bun.com) ≥ 1.3** — tests, CLI, lint, build.
- **[Node](https://nodejs.org) ≥ 22.7** — the browser/Studio path (`--experimental-transform-types`). Playwright's browser launch currently hangs under Bun on Windows, so the engine runs the browser under Node.
- **git**.

## Setup

```bash
bun install        # installs deps + Playwright Chromium (postinstall)
bun run setup      # if Chromium didn't install above, run it explicitly
```

## Run it

```bash
bun run studio     # the app — builds the UI and serves http://localhost:8686
bun run demo       # or watch the pipeline run against a bundled fixture (no extra setup)
```

## Before you open a PR — run the gates

CI runs exactly these; run them locally first so the loop is fast:

```bash
bun run typecheck        # tsc --noEmit (engine)
bun run studio:webcheck  # tsc for the web app
bun run lint             # biome check
bun run fmt              # biome format --write (fix style before committing)
bun test                 # 298/298 must stay green
bun run studio:build     # only if you touched src/app/studio/web
```

## Measuring against human verdicts

`bun test` proves the engine is deterministic; it cannot tell you whether the engine agrees with a
person about a real app. If you touch anything that can change a verdict, score a labelled sheet:

```bash
bun run studio                                          # in one terminal
bun run measure -- <projectId> <sheetId> [labelColumn]   # in another; default column: 검증 결과
```

It runs the sheet live and compares each verdict to the QA verdict already recorded in the sheet,
then **exits non-zero if any case a human filed as a defect came back green**. `held` is not a miss —
declining to judge is the engine working. Watch `false-pass` first, `false-fail` second.

**Read the scorecard in this order:** `false-pass` / `false-fail` first — those are the hard numbers.
Then `agree` and the `held` total. The per-reason breakdown moves ±1–3 between runs and is the last
thing to draw a conclusion from.

Verdicts are reproducible: the same sheet run twice returns the same verdict for every case, because
vision answers are remembered and an absence is confirmed on a settled screen. What is still not
reproducible is *which* heal fired — an action can time out on one run and not the next, which is app
and network timing rather than anything the engine decides. So a single case moving is worth a second
run before it is called a regression; a moved invariant never is.

## Non-negotiable invariants

1. **Determinism of the verdict.** Assertions are authored once and cached by `(caseId + ruleId + ruleVersion + caseHash)`; re-runs only *evaluate* the cache. No LLM at judge time. If a selector self-heals, the run may **not** auto-pass — it goes to `needs_review`. Don't touch `assertionCacheKey` / `baselineKey` formats without understanding the false-pass consequences.
2. **Unit tests are deterministic and browserless.** They run against `FakePage` — no real Chromium. Keep it that way so `bun test` stays fast and CI needs no browser. Live-browser behavior is covered by fixtures/smoke, not the unit suite.
3. **Never commit secrets or real app data.** Model tokens live in `~/.codex`; Studio project/run state lives in `~/.test-osterone/` — both outside the repo. Don't paste real credentials, tokens, or client URLs into code, tests, or fixtures (use neutral placeholders like `acme` / `admin`/`secret`).

## Style & tests

- **Biome** formats and lints (tabs, TypeScript strict). Run `bun run fmt` before committing.
- Add or extend tests for any behavior change. Test **observable behavior** (verdicts, edge values, error paths) — not implementation details or tautologies.
- Prefer editing existing files and following existing patterns over introducing parallel conventions.

## Commits & PRs

- Keep PRs focused; one concern per PR.
- Clear messages (`type: summary` — e.g. `fix:`, `feat:`, `docs:`, `test:`, `chore:`).
- Fill in the PR template and make sure **CI is green**.

## Project layout

See the [project layout in the README](README.md#project-layout). In short: `src/intake` (spreadsheet) · `src/interpret` (rule/assertions/triage/author/recon) · `src/execute` (page/browser/runner) · `src/judge` (baseline) · `src/app/studio` (browser UI) · `test/`.

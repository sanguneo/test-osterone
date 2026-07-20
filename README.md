<div align="center">

<img src="assets/logo.png" width="168" alt="test-osterone logo" />

# test-osterone

**AI writes the tests. A deterministic engine delivers the verdict.**

Spreadsheet-authored test cases → an AI agent reads them, writes the assertions, and self-heals selectors → a deterministic engine judges pass/fail the same way every run.

[English](README.md) · [한국어](README.ko.md)

![stack](https://img.shields.io/badge/stack-Node%2FTS-3178c6)
![runtime](https://img.shields.io/badge/runtime-Bun%20%E2%89%A51.3-black)
![browser](https://img.shields.io/badge/engine-Playwright-2ead33)
![tests](https://img.shields.io/badge/tests-56%2F56-9ccc00)
![false--pass](https://img.shields.io/badge/false--pass-0-critical)

</div>

---

## Why

Test automation stalls on two costs: **authoring** (writing cases + selectors) and **maintenance** (selectors rot). test-osterone hands both to an AI agent so a non-developer can drive regression testing from a spreadsheet — while keeping the one thing that must never be a guess: **the verdict**.

The name is a pun on *testosterone* (`test` + `osterone`). The persona — **"테토"** — is decisive: it would rather flag a case for review than emit a silently-wrong pass. **false-pass = 0** is the first-class goal.

## The core split — an agent that *writes*, an engine that *judges*

| Layer | Owner | Human in the loop |
|---|---|---|
| Authoring | AI establishes the sheet-reading rule, turns cases into assertions, triages automatability, self-heals selectors | Approve the rule / first baseline **once** (optional) |
| Execution & verdict | Deterministic engine — identical conclusion every run | **None — fully automatic** |
| Exceptions | Only low-confidence cases become `needs_review` | Review the ambiguous few **once**, then automated |

> We deliberately do **not** blur this into "an agent that also judges." Determinism of the verdict is what makes the product trustworthy enough to gate a deploy.

### How determinism is guaranteed

- Assertions are authored **once and cached** by `(caseId + ruleId + ruleVersion + caseHash)`. Re-runs only *evaluate* the cache, so the conclusion is identical. Change the rule or the case and the key changes → re-authoring (cache invalidation).
- **Self-heal gate:** if a selector self-heals, the run may **not** auto-pass → `needs_review`.
- **Baseline:** visual / ambiguous cases are diffed against a human-approved golden baseline with dynamic-region masking. Unapproved or drifted → `needs_review`.
- **Principle:** *rather than emit a false pass, route to needs_review.*

## Pipeline

```
Spreadsheet (XLSX / Google Sheet)
  → normalize · dedupe (deterministic content-hash)
  → establish rule (AI, conversational · versioned · persisted · reusable)
  → triage (automatable vs needs-human)
  → interpret (rule + case → deterministic assertions, cached)
  → execute (headless browser, retries, self-heal gate)
  → judge (deterministic assertion eval + baseline diff + needs_review)
  → evidence (screenshots / DOM + SQLite)
  → web dashboard (history · verdicts · evidence · needs_review queue)
```

## Success gates (hard)

| Metric | Bar | Meaning |
|---|---|---|
| Verdict determinism | **100%** (same case, K=5 runs, exact match) | Reproducible enough to gate a deploy |
| False-pass | **0** (benchmark hard gate) | A silently-wrong pass is the worst outcome — blocked first |
| Selection accuracy | **≥ 90%** (initial bar, tuned on measurement) | Automatability triage agrees with human labels |

## Quickstart

```bash
bun install            # installs Playwright Chromium via postinstall
bun run setup          # or install the headless browser explicitly
bun test               # 56/56

test-osterone --help
test-osterone setup
```

> Requires **Bun ≥ 1.3**. `rule`, `run`, `benchmark`, and `dashboard` commands land in later phases; the CLI today exposes `setup`, `--version`, `--help`.

## Try it — live demo

No project to test yet? A bundled fixture app lets you watch the full pipeline run against a **real headless Chromium** browser:

```bash
bun install        # one-time (installs Chromium via postinstall)
bun run demo
```

It ingests `src/testing/sample-cases.csv`, authors deterministic assertions, and runs four cases against a local login app:

```
case                                      verdict        conf  assert  heal
Valid login shows welcome                 pass           1.00  2/2     -
Invalid login shows error                 pass           1.00  2/2     -
Wrong password must not pass as welcome   fail           1.00  0/2     -
Missing button triggers self-heal gate    needs_review   0.50  1/1     click
verdicts    : {"pass":2,"fail":1,"needs_review":1}
determinism : 4/4 identical on rerun OK
false-pass  : 0 OK
```

The third case *expects* a welcome but supplies a wrong password — the engine returns `fail`, never a false pass. The fourth clicks a missing selector — the self-heal gate caps it at `needs_review`. Rerun and every verdict is byte-identical.

Point it at your own site — write your own cases file and pass a base URL:

```bash
bun run run:live -- --url https://your.app --cases ./my-cases.csv
```

> Requires **Node ≥ 22.7**. The demo executes the browser under Node (`node --experimental-transform-types`) because Playwright's browser launch currently hangs under Bun on Windows; the CLI and the deterministic engine run on Bun.

## Studio — no-terminal browser UI (for non-developers)

A point-and-click front door. Start it once; after that everything happens in the browser:

```bash
bun run studio     # then open http://localhost:8686
```

- Click **"샘플로 실행" (Run sample)** to run the bundled cases with zero input.
- Or pick **구글 시트로 실행 (Run from Google Sheet)**: paste a Sheet shared "anyone with the link (Viewer)" plus the target site URL, then **실행 (Run)**.

The deterministic engine runs each case against real headless Chromium and renders verdict badges, per-assertion detail, self-heal events, and the needs_review queue — no CSV escaping, no terminal after launch.

**Model connection (optional).** Click **Codex 로그인** to reuse a local Codex/ChatGPT login (OAuth proxy — token and model are read from `~/.codex`), or paste an access token / API key. Once connected, **AI 규칙 다듬기** refines the interpretation rule in natural language (e.g. "recognize 누르기 as a click"). It is **conversational** — each turn builds on the last (e.g. "undo that") — and after every turn the UI shows an **intent diff** and flags **ambiguous or empty intents**, so the rule converges to an optimal, interpretable form. Changes bump the rule version and apply to later runs; **초기화** resets the conversation.

## Architecture

- **Runtime:** single Node/TS stack (Playwright), shipped as a **single binary** via Bun.
- **Runner contract (seam):** `runScenario(scenario, rule, target) → StructuredResult`. This contract is the node boundary.
- **Node / host:** the same artifact runs **standalone (parent)** or as a **host-driven worker (child)** over HTTP/JSON; the host aggregates results. **Headless by default.**
- **StructuredResult:** `{ verdict ∈ {pass, fail, needs_review, error}, confidence, assertions[], evidenceRefs[], healEvents[], ruleVersion, scenarioHash, executionId, env, … }`.

## Scope

- **In (v1):** core pipeline · XLSX/XLS input · Google Sheet ingest · evidence + web dashboard · orchestration (node/host) · OAuth-proxy auth · JUnit report output.
- **Out (non-goals):** LLM per-run judgment (non-deterministic) · headed browser on every node · terminal-first TUI / runtime ideology · **API testing** (out of scope now; the same engine can extend to it later). Web/browser testing only.

## Model auth

Two interchangeable clients behind one interface:
1. **API key.**
2. **OAuth proxy** — reuse a ChatGPT/Codex login token against the Responses backend.

## Status

**Built & verified (static, deterministic — 56/56 automated tests):** ingest → normalize → dedupe → rule (CLI) → triage → interpret → assertion cache → execute → judge → baseline → evidence → runner contract · benchmark hard gate · web dashboard · orchestration (node/host) · auth (API key + OAuth proxy) + JUnit.

**Pending environment-dependent integration (implemented, not yet live-verified):** live benchmark against real Chromium + docker fixtures / real OAuth-token ChatGPT calls — contracts and implementations are complete; only a smoke pass in a browser/docker/token environment remains.

## Project layout

```
src/
  intake/       spreadsheet ingest + schema
  interpret/    rule · assertions · triage
  execute/      page · headless browser · runner
  judge/        golden baseline
  evidence/     sqlite execution store
  orchestrate/  host + worker (node/host protocol)
  model/        model client + OAuth proxy
  report/       dashboard · JUnit · benchmark
  testing/      fixture app + fixture model
  app/studio/   browser UI (Studio)
  cli.ts · index.ts
test/           unit + smoke suites (56/56)
examples/demo/  CLI live-run example
```

Prior Python (`webtest-agent`) and Bun (`webtest-agent-ts`) implementations are preserved under `archive/`; the fixture site + labeled cases are reused as a language-neutral benchmark asset.

---

<div align="center">
<sub>built with <b>GJC (Gajae Code)</b> autonomous coding agent.</sub>
</div>

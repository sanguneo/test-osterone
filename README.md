<div align="center">

<img src="assets/logo-forged.png" width="200" alt="test-osterone logo" />

# test-osterone

**AI writes the tests. A deterministic engine delivers the verdict.**

Spreadsheet-authored test cases → an AI agent reads them, writes the assertions, and self-heals selectors → a deterministic engine judges pass/fail the same way every run.

[English](README.md) · [한국어](README.ko.md)

![stack](https://img.shields.io/badge/stack-Node%2FTS-3178c6)
![runtime](https://img.shields.io/badge/runtime-Bun%20%E2%89%A51.3-black)
![browser](https://img.shields.io/badge/engine-Playwright-2ead33)
![tests](https://img.shields.io/badge/tests-124%2F124-9ccc00)
![false--pass](https://img.shields.io/badge/false--pass-0-critical)

</div>

---

## Why

Test automation stalls on two costs: **authoring** (writing the cases, and the *selectors* that point each test step at an on-screen element) and **maintenance** (those selectors rot — one small UI change and the test can no longer find the button it was clicking, so it breaks even though the feature still works). test-osterone hands both to an AI agent so a non-developer can drive regression testing from a spreadsheet — while keeping the one thing that must never be a guess: **the verdict**.

The name is a pun on *testosterone* (`test` + `osterone`). The persona — **"테토" (Teto)** — is decisive: it would rather flag a case for review than emit a silently-wrong pass. **false-pass = 0** is the first-class goal.

## The core split — an agent that *writes*, an engine that *judges*

| Layer | Owner | Human in the loop |
|---|---|---|
| Authoring | AI establishes the sheet-reading rule, turns cases into assertions (the concrete pass/fail checks), triages automatability, self-heals selectors | Approve the rule / first baseline **once** (optional) |
| Execution & verdict | Deterministic engine — identical conclusion every run | **None — fully automatic** |
| Exceptions | Only low-confidence cases become `needs_review` | Review the ambiguous few **once**, then automated |

> We deliberately do **not** blur this into "an agent that also judges." Determinism of the verdict is what makes the product trustworthy enough to gate a deploy.

### How determinism is guaranteed

- **Author once, cache forever.** Assertions are authored once and cached by `(caseId + ruleId + ruleVersion + caseHash)`. Re-runs only *evaluate* the cache, so the conclusion is identical. Change the rule or the case and the key changes → re-authoring (cache invalidation).
- **Self-heal gate.** If a selector self-heals, the run may **not** auto-pass → `needs_review`.
- **Baseline.** Visual / ambiguous cases are diffed against a human-approved golden baseline with dynamic-region masking. Unapproved or drifted → `needs_review`.
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
bun install            # one-time; installs Playwright Chromium via postinstall
bun run setup          # if Chromium didn't install above, run it explicitly

bun run studio         # ← the app: builds the UI and serves http://localhost:8686
bun run demo           # or watch the pipeline run against a bundled fixture (no extra setup)

bun test               # 124/124 (for contributors)
```

> Requires **Bun ≥ 1.3**. test-osterone is **Studio-first** — the day-to-day UI is the browser Studio (`bun run studio`); the CLI is a thin bootstrap that exposes `setup`, `--version`, and `--help`.

## Try it — live demo

No project to test yet? A bundled fixture app lets you watch the full pipeline run against a **real, headless** (no visible window — it runs in the background) Chromium browser:

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
bun run studio     # builds the React UI (Vite) then serves it — open http://localhost:8686
```

The deterministic engine runs each case against real headless Chromium and renders verdict badges, per-assertion detail, self-heal events, and the needs_review queue — no CSV escaping, no terminal after launch.

### Model connection (global, in the top bar)

A login-style control (● status + model name) opens a modal with three modes:

- **ChatGPT login** — native OpenAI **device-code** OAuth in the browser. **No `codex` CLI required**; a local `codex` session is auto-detected if present.
- **Paste a token** — plus an optional model override.
- **API Key / endpoint** — connect *any* OpenAI-compatible endpoint (Azure OpenAI, OpenRouter, Together, local vLLM/Ollama) via model + Base URL.

An optional **reasoning level** (minimal/low/medium/high/xhigh/max) applies to reasoning models. The model is only ever used at **author time**; it never judges.

### Navigation & layout

- **Top bar** — brand mark, product name, global model-connection status, and a **KO/EN language toggle**. Clicking the brand returns you to the Welcome screen.
- **Context strip** — a horizontal **Project | Sheet** strip to pick or switch the active project and sheet, with **inline add/edit/delete** for both (a project editor modal and a sheet editor modal — no separate "manage" screen).
- **View rail** — once a sheet is selected, a left vertical rail (a bottom dock on mobile) exposes the four sheet-scoped views — **Dashboard, Rules, Run & Results, Review** — each with its own title and `project · sheet` context line.
- **Explicit drill-down** — no project selected → a **Welcome** screen (with a forged-logo brand hero) to pick or create one. Project but no sheet → a **Project home** listing that project's sheets as a selectable grid (or an add-first-sheet prompt). Selecting a sheet opens its four views; deleting the active project returns you to Welcome.
- **Data model** — a **Project** holds one or more first-class **Test Sheets** (Google Sheet URL / pasted CSV / uploaded `.xlsx`) plus shared defaults (target URL, environment, **account pool**, reference repo, AI toggle). Each **Test Sheet** can **override** the target URL, environment, column mapping, and default account independently.
- **No cap on sheet count** — a search/filter appears once the list exceeds ~8 items, the active item auto-scrolls into view, the context strip goes responsive on narrow screens, and long names get tooltips.

### Working with sheets

- **Per-sheet runtime** — every sheet has its **own run history and review queue**, plus its **own interpretation rule, refine chat, and approved baselines** (the project keeps a **default rule** that new sheets clone, and a **legacy baseline fallback** for pre-upgrade approvals). The Dashboard shows the selected sheet's data plus a compact **project roll-up** (aggregate pass rate across sheets); the review nav badge counts the **selected sheet's** own queue (live during a run). Running a sheet ingests only that sheet, with per-sheet dedupe.
- **AI sheet interpretation** — adding a sheet runs a **3-step onboarding wizard**: pick the **source** (Google Sheet URL / CSV / `.xlsx`) → the model proposes an **interpretation** (column mapping `id/title/step/expected/priority/…` → your header names, plus a case preview) → a **conversational refine** step where you adjust it in natural language ("use 중분류 as the title, not 소분류"). The resulting rule is stored **per sheet** and applied at ingestion; you can keep refining it later from the Rules view.
- **One sheet per file · in-file categories** — importing an `.xlsx` maps to **one sheet per file** (its tabs merge, each tab name captured into a `분류` category column); a category column or a `[말머리]` title prefix groups cases into **categories**, surfaced as badges with per-category counts across preview, results, dashboard, and review.
- **Conversational rule refine** — once connected, **AI 규칙 다듬기** refines the selected sheet's rule in natural language (e.g. "recognize 누르기 as a click"). Each turn builds on the last (e.g. "undo that"), and after every turn the UI shows an **intent diff** and flags **ambiguous or empty intents**, so the rule converges to an optimal, interpretable form. Changes bump that sheet's rule version; **초기화** resets the conversation.

### Running

- **Run** — pick a project and sheet and hit **실행 (Run)** (**AI 스텝 해석** is on by default). Results **stream in per case** (NDJSON) — verdicts and a running pass/fail/needs_review tally appear live as each case finishes.
- **AI step interpretation** — with **AI 스텝 해석** on, the connected model turns free natural-language steps (no quotes, no DSL) into a deterministic plan (actions + assertions). The plan is **authored once and cached**, then replayed deterministically — identical `pass` / `fail` / `needs_review` semantics, false-pass still 0. The bundled sample ships a quote-free variant to demonstrate it. When **no model is connected** the run **soft-falls-back** to rule interpretation with a notice; a Codex/ChatGPT login is **auto-restored on server startup**.
- **Account pool + role routing** — a project holds an **account pool**; each sheet links a default account and each case routes by its `role` to the matching account (legacy username/password migrates to a single account).
- **Run modes** — run a single sheet or **all sheets at once** (`run-all`: per-sheet stream + aggregate verdicts), and toggle **headed** mode to watch a visible Chromium (slowMo).
- **Login precondition** — before a non-login sheet runs, the engine **auto-logs-in once** with the project account (it detects and fills the login form, polling until it clears) and shares the session across cases; cases in the **로그인** category skip this so they can drive their own login flow.
- **Run lifecycle** — a run lives **server-side**: refresh or reconnect and it keeps going (the run bench re-attaches and shows live progress), and a **중지 (Stop)** button cancels an in-flight run cleanly.

### Live recon & repo context (accuracy levers)

From the Rules view:

- **Analyze live app** (`reconApp`) — logs in with the sheet's account and scans the app's structure (nav, form fields, buttons, table headers) into a concise Korean domain brief → the sheet's **appContext**.
- **Analyze repo** (`repo-recon`) — resolves the project's reference repo (local path / cache / shallow clone, with optional token + re-clone) and, when the **CodeGraph** CLI is installed, **indexes the clone first** (init/clone or cache sync, never local), then scans it (AGENTS.md, README, routes, components) and folds the CodeGraph exploration into a code brief → the sheet's **codeContext**. CodeGraph is optional material — without it the plain scan still runs.

Both run at **author time**, are human-reviewed before saving, and are injected into plan authoring, so determinism is unaffected.

### Review queue

`needs_review` cases surface with their evidence — a **screenshot**, the page text, and a **plain-language reason** (why this one needs a human: self-heal, missing baseline, …). Approve the baseline — the approved **reference screen** for that case — once, and a matching re-run **passes** across every sheet that shares the same case content (a reconcile-on-read — a quick re-check when the queue is opened — clears a stale needs_review elsewhere without re-running); if the page drifts it is re-flagged. Evidence handling is robust: text assertions can match **leniently** (ignoring whitespace/punctuation) when the project opts in, failing text checks are **retried briefly** for async UIs, and when a check has no DOM match — or the expectation is purely **visual** (a color, an icon) — a **vision** pass judges the screenshot before holding it. This is the trust model's human-in-the-loop: a human approves the ambiguous few once, then it's automated — never a silent false pass.

For held cases the review also embeds a **Playwright trace** — the bundled trace viewer is served **same-origin** (dodging the public viewer's Private Network Access block), so you can scrub the run action-by-action inline, open it in a new tab, or download the `trace.zip`. Traces are captured per case and kept only for `needs_review`/`error` (a clean pass keeps nothing).

### Persistence

Project metadata lives in `~/.test-osterone/studio-projects.json`. Per-project runtime state lives in `~/.test-osterone/studio-state/<projectId>.json` as **per-sheet** rule, refine chat, plan cache, and approved baselines, plus a project **default rule** (cloned by new sheets) and a **legacy baseline fallback** for approvals made before the per-sheet upgrade — a `STATE_VERSION` v2→v3 migration lifts old project-level state into this shape **losslessly and idempotently** (running the migration twice changes nothing). **Sheet CSV content is offloaded to per-sheet files** (`sheet-data/<projectId>/<sheetId>.csv`) so neither file grows with sheet count — hence no cap. `baselineKey`/`assertionCacheKey` formats are unchanged, so false-pass=0 holds across all of this.

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

**Built & verified** (static, deterministic — 124/124 automated tests):

- **Core pipeline** — ingest → normalize → dedupe → rule → triage → interpret → assertion cache → execute → judge → baseline → evidence → runner contract, plus the benchmark hard gate.
- **Platform** — web dashboard · orchestration (node/host) · auth (API key + OAuth proxy + **native OpenAI device-code login**) · JUnit output.
- **Studio** — per-sheet first-class runtime · AI column mapping + conversational refine · AI step interpretation (author-once plan, soft-fallback to rules) · account pool + role routing + login precondition · multi-sheet run-all · headed runs · run lifecycle (survive refresh · reconnect · cancel) · XLSX one-sheet-per-file import + in-file categories + per-sheet TC auto-detect · KO/EN toggle + path-based routing · live recon → appContext · repo code-context → codeContext (CodeGraph optional) · popup/native-dialog auto-dismiss + interactive-first & whitespace-tolerant click · vision fallback + lenient match + async assertion retry · Codex auto-restore on startup · Playwright trace capture + self-hosted trace viewer.

**Pending environment-dependent integration** (implemented, not yet live-verified): live benchmark against real Chromium + docker fixtures, and real OAuth-token ChatGPT calls — contracts and implementations are complete; only a smoke pass in a browser/docker/token environment remains.

## Project layout

```
src/
  intake/       spreadsheet ingest + schema
  interpret/    rule · assertions · triage · author · recon · repo-recon
  execute/      page · headless browser · runner
  judge/        golden baseline
  evidence/     sqlite execution store
  orchestrate/  host + worker (node/host protocol)
  model/        model client + OAuth proxy
  report/       dashboard · JUnit · benchmark
  testing/      fixture app + fixture model
  app/studio/   browser UI (Studio)
  cli.ts · index.ts
test/           unit + smoke suites (124/124)
examples/demo/  CLI live-run example
```

Prior Python (`webtest-agent`) and Bun (`webtest-agent-ts`) implementations are preserved under `archive/`; the fixture site + labeled cases are reused as a language-neutral benchmark asset.

---

<div align="center">
<sub>built with <b>GJC (Gajae Code)</b> autonomous coding agent.</sub>
</div>

<div align="center">

<img src="assets/logo.png" width="168" alt="test-osterone 로고" />

# test-osterone

**테스트는 AI가 작성하고, 판정은 결정적 엔진이 내립니다.**

스프레드시트로 작성한 테스트 케이스를 AI 에이전트가 읽고 assertion을 써내며 셀렉터를 자가복구하고, 결정적 엔진이 매 실행 동일하게 pass/fail을 판정합니다.

[English](README.md) · [한국어](README.ko.md)

![stack](https://img.shields.io/badge/stack-Node%2FTS-3178c6)
![runtime](https://img.shields.io/badge/runtime-Bun%20%E2%89%A51.3-black)
![browser](https://img.shields.io/badge/engine-Playwright-2ead33)
![tests](https://img.shields.io/badge/tests-56%2F56-9ccc00)
![false--pass](https://img.shields.io/badge/false--pass-0-critical)

</div>

---

## 왜

테스트 자동화는 두 가지 비용에서 막힙니다. **작성**(케이스와 셀렉터를 쓰는 일)과 **유지보수**(셀렉터가 썩는 일)입니다. test-osterone은 이 둘을 AI 에이전트에 맡겨, 비개발자도 스프레드시트만으로 회귀 테스트를 돌릴 수 있게 합니다. 단, 절대 추측이어서는 안 되는 **판정**만큼은 결정적으로 지킵니다.

이름은 *testosterone*의 말장난입니다(`test` + `osterone`). 페르소나 **"테토"** 는 단호합니다. 조용히 틀린 pass를 내느니 케이스를 리뷰로 흘려보냅니다. **false-pass = 0** 이 최우선 목표입니다.

## 핵심 분리 — *작성하는* 에이전트, *판정하는* 엔진

| 층위 | 담당 | 사람 개입 |
|---|---|---|
| 작성 | AI가 시트 규칙 확립, 케이스→assertion 작성, 자동화 가능 여부 선별, 셀렉터 자가복구 | 규칙/첫 baseline **1회 승인**(선택) |
| 실행·판정 | 결정적 엔진 — 매 실행 동일한 결론 | **없음 — 완전 자동** |
| 예외 | 확신하지 못하는 케이스만 `needs_review` | 애매한 소수만 **한 번** 확인 후 자동화 |

> 전체를 "판정까지 하는 에이전트"로 뭉뚱그리지 않습니다. **판정의 결정성**이 배포 게이트로 쓸 만큼의 신뢰를 만들기 때문입니다.

### 결정성을 어떻게 보장하나요

- assertion은 `(caseId + ruleId + ruleVersion + caseHash)`로 **1회 작성한 뒤 캐시**합니다. 재실행은 캐시를 *평가만* 하므로 결론이 동일합니다. 규칙이나 케이스가 바뀌면 키가 바뀌어 재작성됩니다(캐시 무효화).
- **self-heal 게이트:** 셀렉터 자가복구가 일어나면 자동 통과를 금지하고 `needs_review`로 보냅니다.
- **baseline:** 시각·애매 케이스는 사람이 승인한 골든 baseline과 동적 영역을 마스킹하여 diff합니다. 미승인이거나 드리프트가 감지되면 `needs_review`로 보냅니다.
- **원칙:** *거짓 통과를 내느니 needs_review로 흘려보냅니다.*

## 파이프라인

```
스프레드시트 (XLSX / 구글시트)
  → 정규화 · 중복 제거 (결정적 content-hash)
  → 규칙 확립 (AI 대화형 · 버전 · 영속 · 재사용)
  → 선별 triage (자동화 가능 vs 사람 개입 필요)
  → 해석 (규칙 + 케이스 → 결정적 assertion, 캐시)
  → 실행 (헤드리스 브라우저, 재시도, self-heal 게이트)
  → 판정 (assertion 결정적 평가 + baseline diff + needs_review)
  → 증거 (스크린샷 / DOM + SQLite)
  → 웹 대시보드 (이력 · 판정 · 증거 · needs_review 큐)
```

## 성공 기준 (하드 게이트)

| 지표 | 기준 | 의미 |
|---|---|---|
| 판정 결정성 | **100%** (동일 케이스 K=5회 완전 일치) | 배포 게이트로 쓸 수 있는 재현성 전제 |
| 거짓 통과(false-pass) | **0** (벤치마크 하드 게이트) | 조용히 틀린 pass = 최악, 최우선 차단 |
| 선별 정확도 | **≥ 90%** (초기바, 실측 후 조정) | 자동화 대상 분류가 사람 라벨과 일치 |

## 빠른 시작

```bash
bun install            # postinstall이 Playwright Chromium 설치
bun run setup          # 또는 헤드리스 브라우저 명시 설치
bun test               # 56/56

test-osterone --help
test-osterone setup
```

> **Bun ≥ 1.3** 이 필요합니다. `rule`·`run`·`benchmark`·`dashboard` 명령은 이후 단계에서 추가됩니다. 현재 CLI는 `setup`·`--version`·`--help`를 제공합니다.

## 직접 돌려보기 — 라이브 데모

테스트할 프로젝트가 아직 없으신가요? 번들된 fixture 앱으로 전체 파이프라인이 **실제 헤드리스 Chromium**을 상대로 도는 모습을 바로 확인할 수 있습니다.

```bash
bun install        # 최초 1회 (postinstall이 Chromium 설치)
bun run demo
```

`examples/demo/cases.csv`를 읽어 결정적 assertion을 작성한 뒤, 로컬 로그인 앱을 상대로 네 개의 케이스를 실행합니다.

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

세 번째 케이스는 성공(Welcome)을 *기대*하지만 틀린 비밀번호를 넣습니다. 엔진은 거짓 통과 대신 `fail`을 냅니다. 네 번째는 없는 셀렉터를 클릭하는데, self-heal 게이트가 이를 `needs_review`로 묶습니다. 다시 돌려도 모든 판정이 완전히 동일합니다.

내 사이트로 바꾸려면 케이스 파일을 만들고 베이스 URL을 넘기시면 됩니다.

```bash
bun run run:live -- --url https://your.app --cases ./my-cases.csv
```

> **Node ≥ 22.7** 이 필요합니다. 데모는 브라우저를 Node(`node --experimental-transform-types`)로 실행합니다. Playwright의 브라우저 런치가 현재 Windows의 Bun에서 멈추기 때문이며, CLI와 결정적 엔진은 Bun 위에서 동작합니다.

## 아키텍처

- **런타임:** Node/TS 단일 스택(Playwright)이며, Bun으로 **단일 바이너리**로 배포합니다.
- **러너 계약(seam):** `runScenario(scenario, rule, target) → StructuredResult`. 이 계약이 노드 경계입니다.
- **노드/호스트:** 같은 아티팩트가 **독립 실행(부모)** 또는 **호스트 구동 워커(자식)**로 HTTP/JSON 위에서 동작하고, 호스트가 결과를 취합합니다. **헤드리스가 기본입니다.**
- **StructuredResult:** `{ verdict ∈ {pass, fail, needs_review, error}, confidence, assertions[], evidenceRefs[], healEvents[], ruleVersion, scenarioHash, executionId, env, … }`.

## 스코프

- **v1 포함:** 코어 파이프라인 · XLSX/XLS 입력 · 구글시트 연동 · 증거 + 웹 대시보드 · 오케스트레이션(노드/호스트) · OAuth 프록시 인증 · JUnit 출력.
- **비목표:** LLM 매 실행 판정(비결정성) · 모든 노드 헤디드 브라우저 · 터미널-우선 TUI / 런타임 이데올로기 · **API 테스트**(현재 비스코프이며, 향후 같은 엔진 위에서 확장 가능). 웹/브라우저 테스트 전용입니다.

## 모델 인증

하나의 인터페이스 뒤로 교체 가능한 두 가지 클라이언트를 제공합니다.
1. **API key.**
2. **OAuth 프록시** — ChatGPT/Codex 로그인 토큰을 Responses 백엔드에 재사용합니다.

## 현재 상태

**구축·검증 완료 (정적·결정적 — 자동화 테스트 56/56):** 입력 → 정규화 → 중복제거 → 규칙(CLI) → 선별 → 해석 → assertion 캐시 → 실행 → 판정 → baseline → 증거 → 러너 계약 · 벤치마크 하드 게이트 · 웹 대시보드 · 오케스트레이션(노드/호스트) · 인증(API key + OAuth 프록시) + JUnit.

**환경-의존 통합 대기 (구현 완료, 라이브 미검증):** 실제 Chromium + docker fixture 대상 라이브 벤치마크와 실 OAuth 토큰 ChatGPT 호출이 남아 있습니다. 계약과 구현체는 완성되었고, 브라우저·docker·토큰 환경에서 스모크만 남았습니다.

## 프로젝트 구조

```
src/        18개 모듈 (ingest, rule, triage, interpret, runner, baseline, evidence, dashboard, host/worker, auth …)
test/       유닛 + 스모크 스위트 (56/56)
artifacts/  단계별 빌드 리포트 (g001–g006)
```

기존 Python(`webtest-agent`)·Bun(`webtest-agent-ts`) 구현은 `archive/`에 보존합니다. fixture 사이트와 라벨 케이스는 언어중립 벤치마크 자산으로 재사용합니다.

---

<div align="center">
<sub>built with <b>GJC (Gajae Code)</b> 자율 코딩 에이전트</sub>
</div>

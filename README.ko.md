<div align="center">

<img src="assets/logo.png" width="168" alt="test-osterone 로고" />

# test-osterone

**테스트는 AI가 쓰고, 판정은 결정적 엔진이 내린다.**

스프레드시트로 쓴 테스트 케이스 → AI 에이전트가 읽고 assertion을 써내고 셀렉터를 자가복구 → 결정적 엔진이 매 실행 동일하게 pass/fail을 판정한다.

[English](README.md) · [한국어](README.ko.md)

![stack](https://img.shields.io/badge/stack-Node%2FTS-3178c6)
![runtime](https://img.shields.io/badge/runtime-Bun%20%E2%89%A51.3-black)
![browser](https://img.shields.io/badge/engine-Playwright-2ead33)
![tests](https://img.shields.io/badge/tests-56%2F56-9ccc00)
![false--pass](https://img.shields.io/badge/false--pass-0-critical)

</div>

---

## 왜

테스트 자동화는 두 가지 비용에서 막힌다. **작성**(케이스+셀렉터 쓰기)과 **유지보수**(셀렉터가 썩는다). test-osterone은 이 둘을 AI 에이전트에 맡겨 비개발자도 스프레드시트만으로 회귀 테스트를 돌리게 한다 — 단, 절대 추측이면 안 되는 **판정**만은 결정적으로 지킨다.

이름은 *testosterone*의 말장난(`test` + `osterone`)이다. 페르소나 **"테토"** 는 단호하다: 조용히 틀린 pass를 내느니 케이스를 리뷰로 흘린다. **false-pass = 0** 이 최우선 목표다.

## 핵심 분리 — *쓰는* 에이전트, *판정하는* 엔진

| 층위 | 담당 | 사람 개입 |
|---|---|---|
| 작성 | AI가 시트 규칙 확립, 케이스→assertion 작성, 자동화 가능 여부 선별, 셀렉터 자가복구 | 규칙/첫 baseline **1회 승인**(선택) |
| 실행·판정 | 결정적 엔진 — 매 실행 동일한 결론 | **없음 — 완전 자동** |
| 예외 | 확신 못 하는 케이스만 `needs_review` | 애매한 소수만 **한 번** 확인 → 이후 자동화 |

> 전체를 "판정까지 하는 에이전트"로 뭉뚱그리지 않는다. **판정의 결정성**이 배포 게이트로 쓸 만큼의 신뢰를 만든다.

### 결정성을 어떻게 보장하나

- assertion은 `(caseId + ruleId + ruleVersion + caseHash)`로 **1회 작성 후 캐시**한다. 재실행은 캐시를 *평가만* 하므로 결론이 동일하다. 규칙/케이스가 바뀌면 키가 바뀌어 재작성(캐시 무효화).
- **self-heal 게이트:** 셀렉터 자가복구가 일어나면 자동 통과 금지 → `needs_review`.
- **baseline:** 시각/애매 케이스는 사람이 승인한 골든 baseline과 동적 영역 마스킹 diff. 미승인·드리프트 시 → `needs_review`.
- **원칙:** *거짓 통과를 내느니 needs_review로 흘린다.*

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

> **Bun ≥ 1.3** 필요. `rule`·`run`·`benchmark`·`dashboard` 명령은 이후 단계에서 추가된다. 현재 CLI는 `setup`·`--version`·`--help`를 제공한다.

## 아키텍처

- **런타임:** Node/TS 단일 스택(Playwright), Bun으로 **단일 바이너리** 배포.
- **러너 계약(seam):** `runScenario(scenario, rule, target) → StructuredResult`. 이 계약이 노드 경계다.
- **노드/호스트:** 같은 아티팩트가 **독립 실행(부모)** 또는 **호스트 구동 워커(자식)**로 HTTP/JSON 동작. 호스트가 결과를 취합. **헤드리스 기본**.
- **StructuredResult:** `{ verdict ∈ {pass, fail, needs_review, error}, confidence, assertions[], evidenceRefs[], healEvents[], ruleVersion, scenarioHash, executionId, env, … }`.

## 스코프

- **v1 포함:** 코어 파이프라인 · XLSX/XLS 입력 · 구글시트 연동 · 증거 + 웹 대시보드 · 오케스트레이션(노드/호스트) · OAuth 프록시 인증 · JUnit 출력.
- **비목표:** LLM 매 실행 판정(비결정성) · 모든 노드 헤디드 브라우저 · 터미널-우선 TUI / 런타임 이데올로기 · **API 테스트**(현재 비스코프, 향후 같은 엔진 위 확장 가능). 웹/브라우저 테스트 전용.

## 모델 인증

하나의 인터페이스 뒤로 교체 가능한 두 클라이언트:
1. **API key.**
2. **OAuth 프록시** — ChatGPT/Codex 로그인 토큰을 Responses 백엔드에 재사용.

## 현재 상태

**구축·검증 완료 (정적·결정적 — 자동화 테스트 56/56):** 입력 → 정규화 → 중복제거 → 규칙(CLI) → 선별 → 해석 → assertion 캐시 → 실행 → 판정 → baseline → 증거 → 러너 계약 · 벤치마크 하드 게이트 · 웹 대시보드 · 오케스트레이션(노드/호스트) · 인증(API key + OAuth 프록시) + JUnit.

**환경-의존 통합 대기 (구현 완료, 라이브 미검증):** 실제 Chromium + docker fixture 대상 라이브 벤치마크 / 실 OAuth 토큰 ChatGPT 호출 — 계약·구현체는 완성, 브라우저·docker·토큰 환경에서 스모크만 남음.

## 프로젝트 구조

```
src/        18개 모듈 (ingest, rule, triage, interpret, runner, baseline, evidence, dashboard, host/worker, auth …)
test/       유닛 + 스모크 스위트 (56/56)
artifacts/  단계별 빌드 리포트 (g001–g006)
```

기존 Python(`webtest-agent`)·Bun(`webtest-agent-ts`) 구현은 `archive/`에 보존한다. fixture 사이트 + 라벨 케이스는 언어중립 벤치마크 자산으로 재사용한다.

---

<div align="center">
<sub><b>GJC (Gajae Code)</b> 자율 코딩 에이전트가 제작 · Anthropic Claude 기반.</sub>
</div>

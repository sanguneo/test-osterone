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

`src/testing/sample-cases.csv`를 읽어 결정적 assertion을 작성한 뒤, 로컬 로그인 앱을 상대로 네 개의 케이스를 실행합니다.

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

## Studio — 터미널 없는 브라우저 UI (비개발자용)

클릭만으로 쓰는 진입점입니다. 한 번만 켜두면 그다음은 전부 브라우저에서 이뤄집니다.

```bash
bun run studio     # 켠 뒤 http://localhost:8686 접속
```

모델 연결은 **전역**입니다(한 번 연결하면 앱 전체에 적용). 그 외 모든 것은 **프로젝트별로 격리**됩니다(프로젝트마다 규칙/매핑·대화·baseline·리뷰 큐가 독립). 사이드바: 전역 **모델 연결** + 현재 프로젝트 선택, 그 아래 프로젝트별 단계 **1 프로젝트 정보 → 2 규칙·해석 → 3 실행 & 결과 → 4 리뷰 큐**:

- **프로젝트** — 재사용 프로젝트를 저장합니다: **이름, 하나 이상의 TC 소스(구글 시트 URL / CSV 붙여넣기 / `.xlsx` 업로드 — 담을 시트 선택), 대상 사이트 URL, 환경, 테스트 계정(아이디/비밀번호), 참고 repo, 기본 AI 토글**. 여러 소스는 인제스트 후 **전체에 걸쳐 중복 제거**됩니다. `~/.test-osterone/studio-projects.json`에 영속되고, 계정·참고 repo는 AI 스텝 해석에 컨텍스트로 전달됩니다.
- **TC 읽기 & 중복 확인** — 프로젝트의 시트/CSV를 현재 열 매핑으로 인제스트해, 감지된 열·구조화된 케이스·**중복 제거된 케이스**를 실행 전에 보여줍니다.
- **실행** — 프로젝트를 고르고 필요하면 **AI 스텝 해석**을 켠 뒤 **실행**을 누릅니다. 결과는 **케이스 단위로 스트리밍**됩니다(NDJSON) — 전체가 끝날 때까지 기다리지 않고, 각 케이스가 끝나는 즉시 판정과 pass/fail/needs_review 집계가 실시간으로 갱신됩니다.

결정적 엔진이 각 케이스를 실제 헤드리스 Chromium으로 실행해 판정 배지·assertion 상세·self-heal 이벤트·needs_review 큐를 브라우저에 그려 줍니다. CSV 이스케이프도, 실행 후 터미널도 필요 없습니다.

**모델 연결(선택).** **Codex 로그인**을 누르면 로컬 Codex/ChatGPT 로그인을 그대로 재사용합니다(OAuth 프록시 — 토큰·모델을 `~/.codex`에서 읽음). 액세스 토큰이나 API 키를 직접 넣어도 됩니다. 연결하면 **AI 규칙 다듬기**로 해석 규칙을 자연어로 다듬습니다(예: "누르기도 click으로 인식해"). **대화식**이라 이전 턴을 이어받고("그건 되돌려") 매 턴마다 **intent diff**와 **모호·빈 intent 경고**를 보여줘, 규칙이 최적의·해석가능한 형태로 수렴합니다. 변경은 규칙 버전을 올려 이후 실행에 반영되며, **초기화**로 대화를 리셋합니다.

**AI 스텝 해석.** 실행 시 **AI 스텝 해석**을 켜면, 연결된 모델이 따옴표·DSL 없는 자유 자연어 스텝을 결정적 계획(actions + assertions)으로 바꿉니다. 계획은 **1회 작성 후 캐시**되고 엔진이 결정적으로 재생합니다 — `pass` / `fail` / `needs_review` 의미 동일, false-pass 0 유지. 번들 샘플에 따옴표 없는 변형이 포함되어 바로 확인할 수 있습니다.

**AI 시트 해석 (열 매핑).** 구글 시트 프로젝트에서는 AI 규칙 탭의 **시트 해석**이 시트 헤더 + 샘플 행을 모델에 보내 열 매핑(`id/title/step/expected/priority/…` → 실제 헤더명)을 제안하고 규칙에 반영합니다. 대화로 조정할 수 있습니다("소분류 말고 중분류를 제목으로"). 그리고 이 매핑은 **인제스트에 실제로 적용**되어, 대화로 정한 해석법이 시트 읽는 방식을 그대로 바꿉니다 — 한국어 QA 시트로 라이브 검증했습니다.

**리뷰 큐.** `needs_review` 케이스가 **스크린샷**·페이지 텍스트·사유(self-heal, baseline 미승인 등) 증거와 함께 뜹니다. baseline을 한 번 승인하면 매치되는 재실행은 **통과**하고, 페이지가 바뀌면 다시 표시됩니다. 신뢰 모델의 human-in-the-loop 그대로 — 애매한 소수만 한 번 승인하면 이후 자동이며, 조용한 거짓 통과는 없습니다.

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
src/
  intake/       스프레드시트 인제스트 + 스키마
  interpret/    규칙 · assertion · 선별(triage)
  execute/      페이지 · 헤드리스 브라우저 · 러너
  judge/        골든 baseline
  evidence/     sqlite 실행 저장소
  orchestrate/  호스트 + 워커 (노드/호스트 프로토콜)
  model/        모델 클라이언트 + OAuth 프록시
  report/       대시보드 · JUnit · 벤치마크
  testing/      fixture 앱 + fixture 모델
  app/studio/   브라우저 UI (Studio)
  cli.ts · index.ts
test/           유닛 + 스모크 스위트 (56/56)
examples/demo/  CLI 라이브 실행 예제
```

기존 Python(`webtest-agent`)·Bun(`webtest-agent-ts`) 구현은 `archive/`에 보존합니다. fixture 사이트와 라벨 케이스는 언어중립 벤치마크 자산으로 재사용합니다.

---

<div align="center">
<sub>built with <b>GJC (Gajae Code)</b> 자율 코딩 에이전트</sub>
</div>

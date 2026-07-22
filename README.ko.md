<div align="center">

<img src="assets/logo-forged.png" width="200" alt="test-osterone 로고" />

# test-osterone

**테스트는 AI가 작성하고, 판정은 결정적 엔진이 내립니다.**

스프레드시트로 작성한 테스트 케이스를 AI 에이전트가 읽고 assertion을 써내며 셀렉터를 자가복구하고, 결정적 엔진이 매 실행 동일하게 pass/fail을 판정합니다.

[English](README.md) · [한국어](README.ko.md)

![stack](https://img.shields.io/badge/stack-Node%2FTS-3178c6)
![runtime](https://img.shields.io/badge/runtime-Bun%20%E2%89%A51.3-black)
![browser](https://img.shields.io/badge/engine-Playwright-2ead33)
![tests](https://img.shields.io/badge/tests-114%2F114-9ccc00)
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
bun test               # 114/114

test-osterone --help
test-osterone setup
```

> **Bun ≥ 1.3** 이 필요합니다. test-osterone은 **Studio 우선** 도구입니다 — 일상 사용은 브라우저 Studio(`bun run studio`)에서 이뤄지고, CLI는 `setup`·`--version`·`--help`만 제공하는 얇은 부트스트랩입니다.

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
bun run studio     # React UI(Vite) 빌드 후 서빙 — 켠 뒤 http://localhost:8686 접속
```

모델 연결은 **전역**이며, **톱바**에 있습니다 — 로그인형 컨트롤(●상태+모델명)을 누르면 세 가지 모드의 모달이 열립니다: **ChatGPT 로그인**(브라우저에서 OpenAI **디바이스 코드** OAuth — **codex CLI 불필요**, 로컬 `codex` 세션이 있으면 자동 감지), **토큰 직접입력**(+모델 오버라이드), 또는 **API Key / 엔드포인트** — model + Base URL로 *임의의* OpenAI 호환 엔드포인트(Azure OpenAI, OpenRouter, Together, 로컬 vLLM/Ollama)에 연결합니다. 선택적으로 **추론 수준**(minimal/low/medium/high/xhigh/max)을 추론 모델에 적용할 수 있습니다. 모델은 항상 **작성 시점**에만 쓰이고 판정에는 절대 개입하지 않습니다.

톱바에는 브랜드 마크·제품명·전역 모델 연결 상태와 **KO/EN 언어 토글**이 표시되며, 브랜드를 누르면 환영 화면으로 돌아갑니다. 그 아래 가로형 **프로젝트 | 시트** 컨텍스트 스트립에서 활성 프로젝트와 시트를 고르거나 전환하며, 둘 다 **바로 추가/수정/삭제**를 지원합니다(프로젝트 편집기 모달과 시트 편집기 모달 — 별도 "관리" 화면 없음). 시트를 선택하면 콘텐츠 옆에 **좌측 세로 뷰 레일**(모바일에서는 하단 도크)이 네 가지 시트 범위 뷰 — **대시보드, 규칙, 실행 & 결과, 리뷰** — 를 노출하며, 각 뷰는 자체 제목과 `프로젝트 · 시트` 컨텍스트 줄을 가집니다. 내비게이션은 명시적인 드릴다운입니다: 프로젝트가 없으면 (좌측에 forged 로고 브랜드 히어로가 있는) **환영 화면**에서 프로젝트를 고르거나 새로 만들고, 프로젝트는 있지만 시트가 없으면 **프로젝트 홈**에서 해당 프로젝트의 시트를 선택 가능한 그리드로 보여줍니다(시트가 없으면 첫 시트 추가 CTA). 시트를 고르면 그 시트의 네 뷰가 열립니다. 활성 프로젝트를 삭제하면 환영 화면으로 돌아갑니다. **프로젝트**는 하나 이상의 1급 **테스트 시트**(구글 시트 URL / CSV 붙여넣기 / `.xlsx` 업로드)를 담고, 공유 기본값(대상 URL, 환경, 테스트 계정, 참고 repo, AI 토글)을 갖습니다. 각 **테스트 시트**는 대상 URL·환경·열 매핑을 독립적으로 **오버라이드**할 수 있습니다. **시트 개수 캡은 없습니다** — 시트 목록이 8개를 넘으면 검색/필터가 나타나고, 활성 항목은 자동으로 스크롤되어 보이며, 좁은 화면에서는 컨텍스트 스트립이 반응형으로 바뀌며, 긴 이름에는 툴팁이 붙습니다.

- **시트별 런타임** — 모든 시트는 **자신만의 실행 히스토리와 리뷰 대기**를 가지며, 이제 **자신만의 해석 규칙·다듬기 대화·승인된 기준 화면**도 갖습니다(프로젝트는 새 시트가 복제해 가는 **기본 규칙**과, 업그레이드 이전 승인을 위한 **레거시 기준 화면 폴백**을 유지합니다). 대시보드 뷰는 선택된 시트의 데이터와 함께 간결한 **프로젝트 롤업**(시트 전체 합격률 집계)을 보여주고, 리뷰 네비 배지는 프로젝트 단위 롤업을 보여줍니다. 시트를 실행하면 그 시트만 인제스트됩니다(시트별 dedupe).
- **AI 시트 해석 & 규칙 다듬기** — 시트를 추가하면 **3단계 온보딩 마법사**가 실행됩니다: **원본** 선택(구글 시트 URL / CSV / `.xlsx`) → 모델이 **해석 제안**(열 매핑 `id/title/step/expected/priority/…` → 실제 헤더명, 케이스 미리보기 포함)을 제시 → **대화형 다듬기** 단계에서 자연어로 조정합니다("소분류 말고 중분류를 제목으로"). 결과 규칙은 **시트별로** 저장되며(새 시트는 시작점으로 프로젝트의 기본 규칙을 복제), 해당 시트의 인제스트에 적용됩니다. 이후에도 해당 시트의 규칙 뷰에서 계속 다듬을 수 있습니다.
- **실행** — 프로젝트와 시트를 고르고 필요하면 **AI 스텝 해석**을 켠 뒤 **실행**을 누릅니다. 결과는 **케이스 단위로 스트리밍**됩니다(NDJSON) — 각 케이스가 끝나는 즉시 판정과 pass/fail/needs_review 집계가 실시간으로 갱신됩니다.
- **계정 풀 + 역할 라우팅** — 프로젝트가 **계정 풀**을 갖고, 각 시트는 기본 계정을 링크하며 각 케이스는 자신의 `role`로 맞는 계정에 라우팅됩니다(레거시 username/password는 단일 계정으로 마이그레이션).
- **실행 모드** — 단일 시트 또는 **전체 시트 일괄 실행**(`run-all`: 시트별 스트림 + 집계 판정), 그리고 **헤디드** 토글로 보이는 Chromium(slowMo)을 지켜볼 수 있습니다.

결정적 엔진이 각 케이스를 실제 헤드리스 Chromium으로 실행해 판정 배지·assertion 상세·self-heal 이벤트·needs_review 큐를 브라우저에 그려 줍니다. CSV 이스케이프도, 실행 후 터미널도 필요 없습니다.

**대화형 규칙 다듬기.** 연결 후, **AI 규칙 다듬기**로 **선택된 시트의** 해석 규칙을 자연어로 다듬습니다(예: "누르기도 click으로 인식해"). **대화식**이라 이전 턴을 이어받고("그건 되돌려") 매 턴마다 **intent diff**와 **모호·빈 intent 경고**를 보여줘, 규칙이 최적의·해석가능한 형태로 수렴합니다. 변경은 해당 시트의 규칙 버전을 올리며, **초기화**로 대화를 리셋합니다.

**AI 스텝 해석.** 실행 시 **AI 스텝 해석**을 켜면, 연결된 모델이 따옴표·DSL 없는 자유 자연어 스텝을 결정적 계획(actions + assertions)으로 바꿉니다. 계획은 **1회 작성 후 캐시**되고 엔진이 결정적으로 재생합니다 — `pass` / `fail` / `needs_review` 의미 동일, false-pass 0 유지. 번들 샘플에 따옴표 없는 변형이 포함되어 바로 확인할 수 있습니다.

**라이브 정찰 & 레포 맥락(정확도 레버).** 규칙 뷰에서 **라이브 앱 분석**(`reconApp`)은 시트 계정으로 로그인해 앱 구조(내비·폼 필드·버튼·표 헤더)를 스캔, 간결한 한국어 도메인 브리프로 축약해 시트의 **appContext**를 채웁니다. **레포 코드 분석**(`repo-recon`)은 프로젝트의 참고 repo를 확보(로컬 경로 / 캐시 / shallow clone, 선택적 토큰 + 재클론)해 스캔(AGENTS.md·README·라우트·컴포넌트)하고 — **CodeGraph** CLI가 설치돼 있으면 그 exploration도 함께 접어 넣어 — 코드 브리프로 축약해 시트의 **codeContext**를 채웁니다. 둘 다 **작성 시점**에 돌고, 저장 전 사람이 검토하며, 플랜 작성에 주입되므로 결정성에는 영향이 없습니다.

**리뷰 대기.** `needs_review` 케이스가 **스크린샷**·페이지 텍스트·사유(self-heal, 기준 화면 미승인 등) 증거와 함께 뜹니다. 기준 화면을 한 번 승인하면 매치되는 재실행은 같은 케이스 콘텐츠를 공유하는 **모든 시트에서** **통과**하고(reconcile-on-read가 재실행 없이 다른 시트의 stale 리뷰 대기 항목을 정리), 페이지가 바뀌면 다시 표시됩니다. 신뢰 모델의 human-in-the-loop 그대로 — 애매한 소수만 한 번 승인하면 이후 자동이며, 조용한 거짓 통과는 없습니다.

보류된 케이스에는 리뷰에 **Playwright 트레이스**도 임베드됩니다 — 번들 트레이스 뷰어를 **동일 오리진**으로 서빙(공개 뷰어의 Private Network Access 차단 회피)하므로, 실행을 행동 단위로 인라인 스크럽하거나 새 탭에서 열거나 `trace.zip`을 내려받을 수 있습니다. 트레이스는 케이스별로 캡처되며 `needs_review`/`error`에만 보존됩니다(깨끗한 pass는 보존 안 함).

**영속.** 프로젝트 메타데이터는 `~/.test-osterone/studio-projects.json`에 저장됩니다. 프로젝트별 런타임 상태는 이제 `~/.test-osterone/studio-state/<projectId>.json`에 **시트별** 규칙·다듬기 대화·플랜 캐시·승인된 기준 화면으로 저장되며, 여기에 프로젝트 **기본 규칙**과 (시트별 업그레이드 이전 승인을 위한) **레거시 기준 화면 폴백**이 더해집니다. `STATE_VERSION` v2→v3 마이그레이션이 기존 프로젝트 단위 상태를 이 구조로 **손실 없이, 멱등적으로** 끌어올립니다. **시트 CSV 본문은 시트별 파일로 오프로드**되어(`sheet-data/<projectId>/<sheetId>.csv`) 두 파일 모두 시트 개수와 무관하게 작게 유지됩니다 — 그래서 캡이 없습니다. `baselineKey`/`assertionCacheKey` 포맷은 그대로이므로 false-pass=0이 전 구간에서 유지됩니다.

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

**구축·검증 완료 (정적·결정적 — 자동화 테스트 114/114):** 입력 → 정규화 → 중복제거 → 규칙 → 선별 → 해석 → assertion 캐시 → 실행 → 판정 → baseline → 증거 → 러너 계약 · 벤치마크 하드 게이트 · 웹 대시보드 · 오케스트레이션(노드/호스트) · 인증(API key + OAuth 프록시 + **네이티브 OpenAI 디바이스코드 로그인**) + JUnit · **브라우저 Studio** — 시트 1급화 · AI 열매핑 + 대화형 다듬기 · AI 스텝 해석(플랜 author-once) · **계정 풀 + 역할 라우팅** · **다중 시트 run-all** · **헤디드 실행** · **XLSX 다중시트 임포트 + 시트별 TC 자동감지** · **KO/EN 토글 + 경로 기반 라우팅** · **라이브 정찰 → appContext** · **레포 코드 맥락 → codeContext (CodeGraph 옵션)** · **Playwright 트레이스 캡처 + 자체 호스팅 트레이스 뷰어**.

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
test/           유닛 + 스모크 스위트 (114/114)
examples/demo/  CLI 라이브 실행 예제
```

기존 Python(`webtest-agent`)·Bun(`webtest-agent-ts`) 구현은 `archive/`에 보존합니다. fixture 사이트와 라벨 케이스는 언어중립 벤치마크 자산으로 재사용합니다.

---

<div align="center">
<sub>built with <b>GJC (Gajae Code)</b> 자율 코딩 에이전트</sub>
</div>

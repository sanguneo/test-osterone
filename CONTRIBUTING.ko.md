# test-osterone 기여 가이드

[English](CONTRIBUTING.md) · [한국어](CONTRIBUTING.ko.md)

도와줘서 고맙습니다. 이 프로젝트엔 나머지 전부를 좌우하는 단 하나의 신성한 규칙이 있습니다:

> **false-pass = 0.** 조용히 틀린 `pass`가 최악의 결과입니다. AI는 테스트를 *작성*하고, 판정은 결정적 엔진이 *내립니다*. 초록으로 만들려고 판정을 절대 약화시키지 마세요.

시작 전에 아키텍처와 신뢰 모델은 [`README.ko.md`](README.ko.md)를 읽어 주세요.

## 사전 준비

- **[Bun](https://bun.com) ≥ 1.3** — 테스트·CLI·린트·빌드.
- **[Node](https://nodejs.org) ≥ 22.7** — 브라우저/Studio 경로(`--experimental-transform-types`). Windows의 Bun에서 Playwright 브라우저 런치가 멈추기 때문에 엔진은 브라우저를 Node로 실행합니다.
- **git**.

## 셋업

```bash
bun install        # 의존성 + Playwright Chromium 설치(postinstall)
bun run setup      # 위에서 Chromium이 설치 안 됐으면 명시 실행
```

## 실행

```bash
bun run studio     # 본체 — UI 빌드 후 http://localhost:8686 서빙
bun run demo       # 또는 번들 fixture로 파이프라인 실행 관찰(추가 설정 없이)
```

## PR 전에 — 게이트 실행

CI가 정확히 이것들을 돌립니다. 로컬에서 먼저 돌려 루프를 빠르게 하세요:

```bash
bun run typecheck        # tsc --noEmit (엔진)
bun run studio:webcheck  # 웹 앱 tsc
bun run lint             # biome check
bun run fmt              # biome format --write (커밋 전 스타일 정리)
bun test                 # 132/132 유지
bun run studio:build     # src/app/studio/web을 건드렸을 때만
```

## 타협 불가 불변식

1. **판정의 결정성.** assertion은 `(caseId + ruleId + ruleVersion + caseHash)`로 한 번 작성·캐시되고, 재실행은 캐시를 *평가만* 합니다. 판정 시점엔 LLM이 개입하지 않습니다. 셀렉터가 자가복구되면 자동 통과가 금지되고 `needs_review`로 갑니다. false-pass 결과를 이해하지 못한 채 `assertionCacheKey`·`baselineKey` 포맷을 건드리지 마세요.
2. **유닛 테스트는 결정적이고 브라우저가 없습니다.** `FakePage`로 돌아 실제 Chromium이 필요 없습니다 — `bun test`가 빠르고 CI에 브라우저가 필요 없도록 유지하세요. 실브라우저 동작은 fixture/스모크가 커버하지 유닛 스위트가 아닙니다.
3. **시크릿·실데이터를 절대 커밋하지 마세요.** 모델 토큰은 `~/.codex`, Studio 프로젝트/실행 상태는 `~/.test-osterone/` — 둘 다 리포 밖입니다. 실제 자격증명·토큰·클라이언트 URL을 코드·테스트·fixture에 넣지 마세요(중립 플레이스홀더 `acme`·`admin`/`secret` 사용).

## 스타일 & 테스트

- **Biome**가 포맷·린트합니다(탭, TypeScript strict). 커밋 전 `bun run fmt`.
- 동작 변경엔 테스트를 추가/확장하세요. 구현 세부나 자명한 것 말고 **관찰 가능한 동작**(판정·경계값·에러 경로)을 테스트하세요.
- 병렬 관습을 새로 만들기보다 기존 파일·패턴을 따르세요.

## 커밋 & PR

- PR은 한 가지 관심사만, 작게.
- 메시지는 명확하게(`type: 요약` — `fix:`·`feat:`·`docs:`·`test:`·`chore:`).
- PR 템플릿을 채우고 **CI가 초록인지** 확인하세요.

## 프로젝트 구조

[README의 프로젝트 구조](README.ko.md#프로젝트-구조)를 참고하세요. 요약: `src/intake`(스프레드시트) · `src/interpret`(규칙/assertion/선별/author/recon) · `src/execute`(페이지/브라우저/러너) · `src/judge`(baseline) · `src/app/studio`(브라우저 UI) · `test/`.

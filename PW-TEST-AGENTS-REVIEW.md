# pw-test-agents 검토 — 차용 후보 정리

> 목적: 동료의 `pw-test-agents` 프로젝트를 검토해 test-osterone으로 **가져올 만한 것**을 골라 기록.
> 출처: `C:/Users/USER/WebstormProjects/pw-test-agents` (Python + Playwright Agents + Gemini/OpenAI, POC).
> 작성: 2026-07-22. 이 문서는 의사결정 근거용 검토 노트다(제품 스펙 아님).

## 0. 한 줄 결론

**트레이스 뷰어(범용)**를 1순위로 가져오고, **동료의 xperp 화면지도를 appContext로 재활용(즉효)**을 병행한다. 프롬프트 외부화는 낮은 우선순위, 나머지는 doctrine으로만 흡수한다. 생성-실행 아키텍처는 가져오지 않는다.

## 1. 맥락 — 형제 프로젝트다

pw-test-agents는 **test-osterone과 같은 앱(dev-xpapproval.xperp.co.kr, test_member6/7)을 같은 신념으로** 공략한 병행 프로젝트다. 신념까지 수렴한다: 그들의 `검증할 수 없는 사실은 지어낸 사실과 구별되지 않는다` = 우리의 **false-pass=0**.

아키텍처만 다르고, 이 차이가 "무엇이 이식 가능한가"를 결정한다:

| | pw-test-agents | test-osterone |
|---|---|---|
| 실행 | `.spec.ts`를 **생성**해 `npx playwright test`로 구동 | 플랜을 author-once 캐시하고 `BrowserPage`로 **직접** 구동 |
| 판정 | `report.json` + 사람 PASS/FAIL | 결정적 엔진(캐시 assertion) + baseline 승인 |
| 스택 | Python 오케스트레이터, MCP, Gemini/OpenAI, ReAct 툴콜 | Bun/Node, single-shot completion |
| 트레이스 | `playwright.config`의 `trace:'on'` | (없음 — PNG 스냅샷만) |

## 2. 범용성 판정 (← "xperp에만 국한되나?"에 대한 답)

| 항목 | 범용? | 비고 |
|---|---|---|
| ① 트레이스 캡처 + 자체 호스팅 뷰어 | ✅ 범용 | 어떤 Playwright 대상에도 적용. 앱 무관. |
| ② 동료의 `specs/screens/*.md`를 appContext로 재활용 | ⚠️ **xperp 전용** | 지도 파일 자체가 xperp 결재화면. **단, "화면지도로 appContext 시드"라는 패턴은 범용.** |
| ③ 프롬프트 .md 외부화 | ✅ 범용 | 단 이득 낮음(§4). |
| ④ 검증가능-사실 doctrine / 플랜 린트 | ✅ 범용 | |
| ⑤ cost/pricing doctrine, verdict 분리 | ✅ 범용 | |

즉 **차용 대상의 실질은 전부 범용**이고, 앱에 묶이는 건 ②의 "특정 지도 파일"뿐이다.

---

## 3. Tier 1 — 지금 가져온다

### ① Playwright 트레이스 + 자체 호스팅 트레이스 뷰어 — ✅ 구현 완료 (범용, 최고 가치)

**그들의 트릭**: 공개 `trace.playwright.dev`는 localhost의 trace.zip을 fetch하다 **Private Network Access로 막힌다.** 해법 = playwright에 **번들된 정적 뷰어**(`node_modules/playwright-core/lib/vite/traceViewer`)를 자기 서버에서 **동일 오리진으로 서빙** → QA 페이지가 `iframe`으로 임베드. trace.zip은 액션별 DOM 스냅샷 + 네트워크 + 콘솔 + 타임라인 스크럽(죽은 시간 자동 스킵)이라, 현재의 PNG 1장보다 리뷰 증거로 압도적이다. "증거 없이 승인 없음" 원칙과 정확히 정렬.

**test-osterone 이식 레시피** (그들은 config 기반, 우린 프로그램 구동이라 **Playwright API로 잡아야 함**):

1. **캡처** — `src/execute/browser-page.ts`:
   - `BrowserPage.create`에서 `context = await browser.newContext(...)` 직후:
     `await context.tracing.start({ screenshots: true, snapshots: true, sources: true })`
   - `close()`에서 `await context.tracing.stop({ path: <traceZipPath> })` (닫기 전에 stop).
   - `BrowserPageOptions`에 `tracePath?`(run당 1개) 추가.
2. **케이스별 증거(2차)** — `BrowserPage`는 run당 1개(케이스 공유)라, 케이스별 zip이 필요하면 `src/execute/runner.ts` 액션 루프 앞뒤에서 `context.tracing.startChunk({title})` / `stopChunk({ path })`. **1차는 run당 1개로 단순하게, 이후 chunk로 승격.**
3. **보존 정책** — 트레이스는 용량이 있으니 **needs_review/fail 케이스만 보존**(pass는 삭제). 디스크 방어 + "증거는 리뷰 대상만"이라는 그들의 원칙과 동일.
4. **저장/모델** — zip 경로를 `store.ts`의 `ReviewItem`(+`CaseView` 필요시)에 `trace?: string`로 추가, `runBatch`가 채움. 저장 위치는 evidence 디렉터리(`~/.test-osterone/...`).
5. **서빙** — `src/app/studio/server.ts`:
   - `node_modules/playwright-core/lib/vite/traceViewer`를 `/trace-viewer`로 정적 서빙(존재할 때만; 이미 `web/dist` 정적 서빙 로직 있음).
   - trace.zip을 `/api/trace?...`(또는 `/artifacts/...`)로 서빙.
6. **UI** — `ReviewPanel.tsx`에서 `iframe src="/trace-viewer/index.html?trace=<zip url>"` 임베드 + "새 탭에서 크게" 링크 + zip 다운로드. 동일 오리진이라 PNA 문제 없음.

**주의**: 헤드리스에서도 스냅샷 트레이스는 정상 캡처됨. playwright ^1.61 의존이라 playwright-core 번들 뷰어 경로 존재(설치 후 실경로 1회 확인).

**추정**: 서버 서빙 + BrowserPage tracing + ReviewPanel iframe = 반나절~하루.
**✅ 구현 완료 (2026-07-22)** — 위 레시피대로 구현하되 두 지점 개선:
- **케이스별 chunk를 1차부터** 적용(`Page`에 옵셔널 `startTrace()/stopTrace(path?)` + `BrowserPage`가 `context.tracing.start` 후 케이스마다 `startChunk`/`stopChunk`, `runner`가 케이스 액션을 감쌈). "run당 1개" 단계를 건너뜀.
- **보존은 needs_review/error만**(fail은 리뷰큐 밖이라 트레이스도 버려 고아 방지). pass는 `stopTrace()`로 chunk 자체를 discard → 디스크 낭비 0.
- 파일: `page.ts`(옵셔널 트레이스 메서드), `browser-page.ts`(`trace` 옵션+chunk), `runner.ts`(`tracePath`+verdict별 보존), `store.ts`/web `types.ts`(`ReviewItem.trace`), `server.ts`(`/trace-viewer` 정적 서빙 + `/api/trace` zip 서빙 + `runBatch` 캡처), `ReviewPanel.tsx`(뷰어 iframe + 새탭/다운로드).
- 검증: 유닛(runner 트레이스 오케스트레이션 2 tests, 총 114 pass) + 스모크(fixture로 **실제 21KB 유효 trace.zip 캡처**, discard는 무파일) + 서빙(`/trace-viewer/index.html`·`sw.bundle.js` 200, `/api/trace` 404/400). 전 게이트 그린.

### ② 동료의 xperp 화면지도를 appContext/codeContext로 재활용 — 제로코드 즉효 (xperp 전용 · 범용화는 §6)

`pw-test-agents/specs/screens/*.md`(approval-inbox, approval-sign-detail, all-approval-documents, approval-document-create-register)는 **우리가 테스트하는 바로 그 xperp 결재화면의 기계검증된 지도**다 — 실제 로케이터, 정확한 인용 문자열(`검색 결과가 없습니다.`), 진입 헬퍼, "사실" 표. 코드 없이 dev-xpapproval 프로젝트의 **appContext(도메인)** + **codeContext(구조)**에 붙여넣으면 authorPlanAI 정확도가 즉시 오른다. 방금 붙인 recon/repo-analyze 결과를 이 지도로 **교차검증**하는 용도로도 이상적. (동료 동의 후.)

---

## 4. Tier 2 — 개념만 흡수 (코드 이식 X, 전부 범용)

- **프롬프트 .md 외부화**: 그들의 frontmatter `tools:` 스코핑은 **ReAct 툴콜 전용**이라 우리(single-shot)와 무관. 남는 건 "프롬프트를 편집가능한 파일로 뺀다"뿐인데, 우리 프롬프트는 작고 결정적 seam에 인라인이라 **파일 IO + 번들 경로 탐색 비용 대비 이득 낮음. QA가 프롬프트를 직접 튜닝할 계획이 아니면 보류.**
- **검증가능-사실 doctrine + 플랜 린트**: 지도의 모든 "사실"을 실행식으로 적고 매번 기계 판정 → 우리 **baseline**과 같은 사상. 차용은 코드가 아니라 원칙. 여력되면 `spec_lint`처럼 **플랜/assertion 린트**(nav·헤딩·정적 라벨 같은 boilerplate를 assert하면 false-pass 위험 경고)를 `ruleLint` 옆에 추가 검토.
- **cost/pricing doctrine**: "모르는 모델이면 $0가 아니라 '모른다'". 우린 유저 쿼터라 계측 우선순위는 낮지만 doctrine은 좋음.
- **verdict 분리**: 그들 `verdicts.json`(사람 판정) ↔ `summary.json`(실행결과) 분리로 재실행해도 판정 보존 → 우리가 baseline 승인과 run history를 분리한 것과 수렴. 확인 완료.

---

## 5. Tier 3 — 가져오지 않는다

- **generate-.spec-then-run 아키텍처 통째로**: 우리 programmatic 결정적 replay + author-once 캐시가 false-pass=0엔 더 깔끔. 갈아엎지 말 것.
- **ReAct 트리밍 / `record_observation`**: 그들의 긴 탐색 루프에서 "컨텍스트가 지워지니 즉시 기록"용. 우리 recon은 single-shot이라 불필요(그 원칙 — 인용 verbatim, 지어내지 말 것 — 은 이미 author 프롬프트에 반영).
- **RAG**: 그들도 "먼저 얹지 마라"라고 못박음. 이미 정렬.

---

## 6. T1② 재검토 — 범용화 가능 부분 (사용자 요청)

②의 표면(특정 xperp 지도 재활용)은 앱 전용이지만, 그 밑의 메커니즘은 전부 범용이며 우리가 이미 만든 **recon**과 자연스럽게 잇는다.

1. **구조화 화면지도 = appContext의 상위호환 (범용)**. 지금 appContext/codeContext는 freetext 한 덩어리. 그들의 지도는 화면을 키로 한 구조화 자산(로케이터·인용문자열·사실). 우리는 이미 `recon.extractStructure`가 페이지별 구조(url·nav·formFields·buttons·tableHeaders)를 뽑는데 `reduceRecon`이 freetext로 축약해 버린다. **개선: recon의 구조화 결과를 화면별로 영속(자체 screen-map 자산)** 하고 필요한 화면만 주입(그들 README의 "진입 경로 매칭" = 정규식, LLM 0원). 어떤 앱에도 적용.
2. **기계검증 = 드리프트 감지 (범용, LLM 0원)**. 그들 지도의 핵심은 "사실을 실행식으로 적고 매 실행 재검증(verify.spec)". 우리 대응물은 baseline(승인 스냅샷 재매칭)이지만 appContext 자체는 검증되지 않는다. **확장: recon이 뽑은 사실(로그인 버튼 라벨·라우트 존재·테이블 헤더)을 결정적으로 싸게 재검증**해 appContext가 낡았는지(앱 변경) 자동 감지 → 재-recon/재-analyze 유도. 우리 baseline·false-pass 사상과 동형.
3. **컨텍스트 import/export (범용, 저비용)**. "외부 지도를 appContext로 가져오기"의 일반형 = RulesPanel "파일/붙여넣기에서 컨텍스트 가져오기". 파일은 데이터일 뿐 기능은 앱 무관. xperp 지도는 이 파이프라인의 첫 입력일 뿐.
4. **verbatim 인용 원칙** — 이미 author 프롬프트에 반영(범용). recon 프롬프트에도 "관찰 안 된 문자열 지어내지 말 것"을 명시하면 강화됨.

**결론**: ②는 "xperp 지도 붙여넣기"라는 앱 전용 꿀팁을 넘어, **recon을 구조화·검증가능·재사용 자산으로 승격**하는 범용 로드맵으로 일반화된다. 1·2는 recon을 이미 만들어놨으니 자연스러운 후속.

---

## 7. 다음 액션

1. ✅ **[범용]** 트레이스 캡처+뷰어 (§3①) — **구현 완료**, 커밋 대기.
2. **[범용]** recon 구조화 영속 + 저비용 드리프트 재검증 (§6-1·2) — 후속 후보.
3. **[범용, 저비용]** 컨텍스트 import(§6-3) · 플랜/assertion boilerplate 린트(§4).
4. **[xperp]** 동료 화면지도 → dev-xpapproval appContext/codeContext 시드 (§3②) — 동료 동의 후, 제로코드.
/** Public surface (scaffold — grows per phase). */

export { VERSION } from "./cli.ts";
export { type ExecutionRow, SqliteEvidenceStore } from "./evidence/evidence.ts";
export { BrowserPage, type BrowserPageOptions } from "./execute/browser-page.ts";
export { type FakeAction, FakePage, type Page, type PageSnapshot } from "./execute/page.ts";
export {
	determinismView,
	type RunEnv,
	type RunOptions,
	runScenario,
	type StructuredResult,
	type Verdict,
} from "./execute/runner.ts";
export {
	csvToRawTable,
	type DedupeResult,
	dedupe,
	ingestCsv,
	ingestGoogleSheet,
	mapColumns,
	normalizeTable,
	parseCsv,
	toCsvExportUrl,
} from "./intake/ingest.ts";
export type { NormalizedTC, RawTable, TcField } from "./intake/schema.ts";
export {
	type Assertion,
	type AssertionCache,
	type AssertionResult,
	assertionCacheKey,
	dedupeAssertions,
	evaluateAssertion,
	MemoryAssertionCache,
} from "./interpret/assertion.ts";
export {
	type AuthoredPlan,
	type AuthoredPlanResult,
	authorPlanAI,
	getOrAuthorPlan,
	MemoryPlanCache,
	type PlanCache,
} from "./interpret/author.ts";
export {
	type AuthoredAssertions,
	authorAssertions,
	getOrAuthorAssertions,
	type PageAction,
	parseStep,
} from "./interpret/interpret.ts";
export {
	bumpRuleVersion,
	establishRuleFromHeaders,
	INTENT_KINDS,
	type IntentKind,
	type InterpretationRule,
	loadRule,
	parseRule,
	type RuleRefineResult,
	refineRule,
	ruleLint,
	saveRule,
	serializeRule,
} from "./interpret/rule.ts";
export { HUMAN_SIGNALS, type TriageDecision, triageAll, triageDeterministic } from "./interpret/triage.ts";
export {
	type Baseline,
	type BaselineGate,
	baselineKey,
	DEFAULT_MASKS,
	MemoryBaselineStore,
	maskDynamic,
} from "./judge/baseline.ts";
export {
	ApiKeyModelClient,
	type ApiKeyModelOptions,
	FakeModelClient,
	type ModelClient,
	type ModelMessage,
} from "./model/model-client.ts";
export {
	codexResponsesUrl,
	getCodexAccountId,
	OAuthProxyModelClient,
	type OAuthProxyOptions,
	parseResponsesSse,
} from "./model/oauth-proxy.ts";
export { type Aggregate, type Dispatch, httpDispatch, inProcessDispatch, runScenarios } from "./orchestrate/host.ts";
export { createWorkerHandler, executeJob, serveWorker, type WorkerJob } from "./orchestrate/worker.ts";
export {
	type BenchmarkOptions,
	type BenchmarkScore,
	type CaseResult,
	DEFAULT_GATE,
	evaluateGate,
	type GateResult,
	type GateThresholds,
	type LabeledCase,
	type LabelSet,
	runBenchmark,
} from "./report/benchmark.ts";
export { createDashboard, serveDashboard } from "./report/dashboard.ts";
export { toJUnitXml } from "./report/junit.ts";
export { fixtureReducer, makeFixturePage } from "./testing/fixture-model.ts";

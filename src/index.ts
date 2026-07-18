/** Public surface (scaffold — grows per phase). */

export {
	type Assertion,
	type AssertionCache,
	type AssertionResult,
	assertionCacheKey,
	dedupeAssertions,
	evaluateAssertion,
	MemoryAssertionCache,
} from "./assertion.ts";
export {
	type Baseline,
	type BaselineGate,
	baselineKey,
	DEFAULT_MASKS,
	MemoryBaselineStore,
	maskDynamic,
} from "./baseline.ts";
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
} from "./benchmark.ts";
export { BrowserPage, type BrowserPageOptions } from "./browser-page.ts";
export { VERSION } from "./cli.ts";
export { createDashboard, serveDashboard } from "./dashboard.ts";
export { type ExecutionRow, SqliteEvidenceStore } from "./evidence.ts";
export { fixtureReducer, makeFixturePage } from "./fixture-model.ts";
export { type Aggregate, type Dispatch, httpDispatch, inProcessDispatch, runScenarios } from "./host.ts";
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
} from "./ingest.ts";
export {
	type AuthoredAssertions,
	authorAssertions,
	getOrAuthorAssertions,
	type PageAction,
	parseStep,
} from "./interpret.ts";
export { toJUnitXml } from "./junit.ts";
export {
	ApiKeyModelClient,
	type ApiKeyModelOptions,
	FakeModelClient,
	type ModelClient,
	type ModelMessage,
} from "./model-client.ts";
export {
	codexResponsesUrl,
	getCodexAccountId,
	OAuthProxyModelClient,
	type OAuthProxyOptions,
	parseResponsesSse,
} from "./oauth-proxy.ts";
export { type FakeAction, FakePage, type Page, type PageSnapshot } from "./page.ts";
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
	saveRule,
	serializeRule,
} from "./rule.ts";
export {
	determinismView,
	type RunEnv,
	type RunOptions,
	runScenario,
	type StructuredResult,
	type Verdict,
} from "./runner.ts";
export type { NormalizedTC, RawTable, TcField } from "./schema.ts";
export { HUMAN_SIGNALS, type TriageDecision, triageAll, triageDeterministic } from "./triage.ts";
export { createWorkerHandler, executeJob, serveWorker, type WorkerJob } from "./worker.ts";

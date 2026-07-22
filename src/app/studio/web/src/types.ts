export type Verdict = "pass" | "fail" | "needs_review" | "error";

export interface TestSheet {
	id: string;
	name: string;
	kind: "sheet" | "csv";
	sheetUrl: string;
	csvText: string;
	baseUrl?: string;
	env?: string;
	mapping?: Record<string, string>;
	username?: string;
	password?: string;
	origin?: "sheet" | "csv" | "xlsx";
}

export interface Project {
	id: string;
	name: string;
	sheets: TestSheet[];
	baseUrl: string;
	env: string;
	username: string;
	password: string;
	referenceRepo: string;
	aiInterpret: boolean;
}

export interface AssertionView {
	detail: string;
	passed: boolean;
	kind?: string;
	value?: string;
}

export interface CaseView {
	caseId: string;
	title: string;
	verdict: Verdict;
	confidence: number;
	passed: number;
	total: number;
	heal: string[];
	assertions: AssertionView[];
}

export interface RunView {
	at: number;
	source: string;
	baseUrl: string;
	interpreter: "ai" | "rule";
	counts: Record<Verdict, number>;
	results: CaseView[];
	sheetId: string;
}

export interface ChatMsg {
	role: "user" | "assistant";
	content: string;
}

export interface AuthState {
	mode: string;
	accountId?: string;
	model: string;
	reasoning?: string;
	endpoint?: string;
}

export interface Status {
	connected: boolean;
	codexAvailable?: boolean;
	appContext?: string;
	auth: AuthState | null;
	projectId: string;
	ruleVersion: number;
	intents: Record<string, string[]>;
	mapping: Record<string, string>;
	warnings: string[];
	chat: ChatMsg[];
}

export interface RefineResult {
	message: string;
	changed: boolean;
	ruleVersion: number;
	intents: Record<string, string[]>;
	mapping: Record<string, string>;
	diff: Record<string, { added: string[]; removed: string[] }>;
	warnings: string[];
	chat: ChatMsg[];
}

export interface AnalyzeResult {
	headers: string[];
	mapping: Record<string, string>;
	ruleVersion: number;
	message: string;
	warnings: string[];
	chat: ChatMsg[];
}

export interface PreviewCase {
	caseId: string;
	title: string;
	steps: string[];
	expected: string;
	priority: string | null;
}

export interface PreviewResult {
	headers: string[];
	mapping: Record<string, string>;
	counts: { total: number; unique: number; duplicates: number };
	unique: PreviewCase[];
	duplicates: { title: string; duplicateOf: string }[];
}

export interface ReviewItem {
	caseId: string;
	title: string;
	verdict: Verdict;
	reason: string;
	url: string;
	text: string;
	screenshot?: string;
	ruleVersion: number;
	env: string;
	sheetId: string;
}

export interface XlsxSheet {
	name: string;
	csv: string;
	rows: number;
	isTc?: boolean;
}

export type RunEvent =
	| { type: "start"; total: number; baseUrl: string; interpreter: "ai" | "rule" }
	| { type: "case"; index: number; total: number; result: CaseView }
	| { type: "done"; view: RunView }
	| { type: "error"; error: string };

export type RunAllEvent =
	| { type: "all-start"; totalSheets: number; sheets: { sheetId: string; name: string }[] }
	| { type: "sheet-start"; sheetId: string; name: string; index: number; totalSheets: number }
	| { type: "start"; total: number; baseUrl: string; interpreter: "ai" | "rule"; sheetId: string }
	| { type: "case"; index: number; total: number; result: CaseView; sheetId: string }
	| { type: "sheet-done"; sheetId: string; view: RunView }
	| { type: "sheet-error"; sheetId: string; error: string }
	| { type: "all-done" }
	| { type: "error"; error: string };

/** A run request payload (project config + ephemeral toggles). */
export interface RunInput {
	sample?: boolean;
	sheets?: TestSheet[];
	sheetId?: string;
	baseUrl?: string;
	env?: string;
	username?: string;
	password?: string;
	referenceRepo?: string;
	aiInterpret?: boolean;
	projectId?: string;
	headed?: boolean;
}

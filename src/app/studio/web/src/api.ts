import type {
	ActiveRunView,
	AnalyzeResult,
	AppReconResult,
	PreviewResult,
	Project,
	RefineResult,
	RepoReconResult,
	ReviewItem,
	RunAllEvent,
	RunEvent,
	RunInput,
	RunView,
	Status,
	XlsxSheet,
} from "./types";

function post(body: unknown): RequestInit {
	return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * Turn a failed response into an error a person can act on.
 *
 * The server answers failures as `{ "error": "<한국어 문장>" }`, and that sentence is the whole point —
 * "이미 실행 중인 런이 있습니다. 먼저 중지하세요." tells the user what to do. Everything else here is a
 * fallback so the message is never empty: `statusText` is absent over HTTP/2, and an empty error banner
 * is indistinguishable from no error at all.
 */
export async function responseFailure(res: Response): Promise<Error> {
	const text = await res.text().catch(() => "");
	let message = "";
	try {
		const parsed = text ? (JSON.parse(text) as { error?: unknown }) : null;
		if (parsed && typeof parsed.error === "string") message = parsed.error;
	} catch {
		// Not JSON. The status line below is all we have.
	}
	return new Error(message || res.statusText || `HTTP ${res.status}`);
}

async function j<T>(url: string, opts?: RequestInit): Promise<T> {
	const r = await fetch(url, opts);
	if (!r.ok) throw await responseFailure(r);
	const text = await r.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		// A 2xx whose body will not parse used to become `null` cast to `T`, and the caller then failed
		// several frames away on a field of the thing it believed it had. Name it here instead.
		throw new Error(`${url}: response was not JSON (${r.status})`);
	}
}

const q = (pid: string) => `projectId=${encodeURIComponent(pid)}`;

export const api = {
	sheetContent: (projectId: string, sheetId: string) =>
		j<{ csvText: string }>(`/api/sheet/content?projectId=${encodeURIComponent(projectId)}&sheetId=${encodeURIComponent(sheetId)}`),
	status: (pid: string, sheetId?: string) => j<Status>(`/api/status?${q(pid)}${sheetId ? `&sheetId=${encodeURIComponent(sheetId)}` : ""}`),
	history: (pid: string, sheetId?: string) =>
		j<RunView[]>(`/api/history?${q(pid)}${sheetId ? `&sheetId=${encodeURIComponent(sheetId)}` : ""}`),
	activeRun: (pid: string) => j<ActiveRunView | null>(`/api/run/active?${q(pid)}`),
	cancelRun: (pid: string) => j<{ ok: boolean }>("/api/run/cancel", post({ projectId: pid })),
	connect: (body: { mode: string; token?: string; apiKey?: string; model?: string; baseUrl?: string; reasoning?: string; projectId: string }) =>
		j<Status>("/api/auth", post(body)),
	deviceStart: (body: { model?: string; reasoning?: string }) => j<{ userCode: string; url: string }>("/api/auth/device/start", post(body)),
	devicePoll: (body: { projectId: string }) => j<Status & { pending?: boolean }>("/api/auth/device/poll", post(body)),
	projects: () => j<Project[]>("/api/projects"),
	saveProject: (p: Partial<Project> & { projectId: string; sample?: boolean }) =>
		j<{ saved: Project; projects: Project[] }>("/api/projects", post(p)),
	deleteProject: (id: string) => j<{ projects: Project[] }>("/api/projects/delete", post({ id })),
	preview: (cfg: RunInput, signal?: AbortSignal) => j<PreviewResult>("/api/tc/preview", { ...post(cfg), signal }),
	refine: (instruction: string, projectId: string, sheetId?: string) => j<RefineResult>("/api/refine", post({ instruction, projectId, sheetId })),
	refineReset: (projectId: string, sheetId?: string) => j<Status>("/api/refine/reset", post({ projectId, sheetId })),
	clearSheet: (projectId: string, sheetId?: string) => j<{ cleared: boolean }>("/api/sheet/clear", post({ projectId, sheetId })),
	setRuleContext: (appContext: string, projectId: string, sheetId?: string) => j<Status>("/api/rule/context", post({ appContext, projectId, sheetId })),
	setRuleCodeContext: (codeContext: string, projectId: string, sheetId?: string) => j<Status>("/api/rule/context", post({ codeContext, projectId, sheetId })),
	analyze: (body: { sheetUrl?: string; csvText?: string; projectId: string; sheetId: string }) =>
		j<AnalyzeResult>("/api/sheet/analyze", post(body)),
	analyzeApp: (body: { projectId: string; sheetId: string; deep?: boolean; loginPath?: string; accountId?: string }) =>
		j<AppReconResult>("/api/app/analyze", post(body)),
	analyzeRepo: (body: { projectId: string; sheetId?: string; query?: string; token?: string; refresh?: boolean }) =>
		j<RepoReconResult>("/api/repo/analyze", post(body)),
	reviewQueue: (pid: string, sheetId?: string, all?: boolean) =>
		j<ReviewItem[]>(
			`/api/review/queue?${q(pid)}${sheetId ? `&sheetId=${encodeURIComponent(sheetId)}` : ""}${all ? "&all=1" : ""}`,
		),
	reviewApprove: (caseId: string, projectId: string, sheetId?: string) =>
		j<{ queue: ReviewItem[] }>("/api/review/approve", post({ caseId, projectId, sheetId })),
	reviewReject: (caseId: string, projectId: string, sheetId?: string) =>
		j<{ queue: ReviewItem[] }>("/api/review/reject", post({ caseId, projectId, sheetId })),
	// No `reviewApproveAll`: bulk-blessing golden baselines was measured turning six correctly-held
	// defects into permanent passes in one click. Approve per case, or mark it failed.
	xlsxConvert: (base64: string) => j<{ sheets: XlsxSheet[] }>("/api/xlsx/convert", post({ base64 })),

	/** Stream a run: emits start / case / done / error events as they arrive. */
	async runStream(cfg: RunInput, onEvent: (ev: RunEvent) => void, signal?: AbortSignal): Promise<void> {
		const res = await fetch("/api/run", { ...post(cfg), signal });
		// A refused run is an HTTP failure, not a stream. Read as one it parsed into an "event" with no
		// `type`, the panel's if/else chain dropped it, and the run ended with nothing on screen — the
		// server's own "이미 실행 중인 런이 있습니다. 먼저 중지하세요." never reached the person who needed it.
		if (!res.ok) throw await responseFailure(res);
		if (!res.body) throw new Error("no stream");
		const reader = res.body.getReader();
		const dec = new TextDecoder();
		let buf = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const ln of lines) {
				const s = ln.trim();
				if (s) onEvent(JSON.parse(s) as RunEvent);
			}
		}
	},

	/** Stream a per-sheet "run all sheets" batch: all-start / sheet-start / start / case / sheet-done / sheet-error / all-done / error. */
	async runAllStream(cfg: RunInput, onEvent: (ev: RunAllEvent) => void, signal?: AbortSignal): Promise<void> {
		const res = await fetch("/api/run/all", { ...post(cfg), signal });
		// Same as `runStream`: a 409 here is a refusal to start, not the first line of a stream.
		if (!res.ok) throw await responseFailure(res);
		if (!res.body) throw new Error("no stream");
		const reader = res.body.getReader();
		const dec = new TextDecoder();
		let buf = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const ln of lines) {
				const s = ln.trim();
				if (s) onEvent(JSON.parse(s) as RunAllEvent);
			}
		}
	},
};

import type {
	AnalyzeResult,
	PreviewResult,
	Project,
	RefineResult,
	ReviewItem,
	RunEvent,
	RunInput,
	Status,
	XlsxSheet,
} from "./types";

function post(body: unknown): RequestInit {
	return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function j<T>(url: string, opts?: RequestInit): Promise<T> {
	const r = await fetch(url, opts);
	const d = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
	if (!r.ok) throw new Error((d?.error as string) || r.statusText);
	return d as T;
}

const q = (pid: string) => `projectId=${encodeURIComponent(pid)}`;

export const api = {
	status: (pid: string) => j<Status>(`/api/status?${q(pid)}`),
	connect: (body: { mode: string; token?: string; apiKey?: string; model?: string; projectId: string }) =>
		j<Status>("/api/auth", post(body)),
	projects: () => j<Project[]>("/api/projects"),
	saveProject: (p: Partial<Project> & { projectId: string; sample?: boolean }) =>
		j<{ saved: Project; projects: Project[] }>("/api/projects", post(p)),
	deleteProject: (id: string) => j<{ projects: Project[] }>("/api/projects/delete", post({ id })),
	preview: (cfg: RunInput) => j<PreviewResult>("/api/tc/preview", post(cfg)),
	refine: (instruction: string, projectId: string) => j<RefineResult>("/api/refine", post({ instruction, projectId })),
	refineReset: (projectId: string) => j<Status>("/api/refine/reset", post({ projectId })),
	analyze: (body: { sheetUrl?: string; csvText?: string; projectId: string }) =>
		j<AnalyzeResult>("/api/sheet/analyze", post(body)),
	reviewQueue: (pid: string) => j<ReviewItem[]>(`/api/review/queue?${q(pid)}`),
	reviewApprove: (caseId: string, projectId: string) =>
		j<{ queue: ReviewItem[] }>("/api/review/approve", post({ caseId, projectId })),
	xlsxConvert: (base64: string) => j<{ sheets: XlsxSheet[] }>("/api/xlsx/convert", post({ base64 })),

	/** Stream a run: emits start / case / done / error events as they arrive. */
	async runStream(cfg: RunInput, onEvent: (ev: RunEvent) => void): Promise<void> {
		const res = await fetch("/api/run", post(cfg));
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
};

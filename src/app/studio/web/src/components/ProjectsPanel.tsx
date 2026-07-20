import { useState } from "react";
import { api } from "../api";
import type { PreviewResult, Project, TcSource, XlsxSheet } from "../types";

interface Editor {
	id: string;
	name: string;
	sources: TcSource[];
	baseUrl: string;
	env: string;
	username: string;
	password: string;
	referenceRepo: string;
	aiInterpret: boolean;
}
const blank = (): Editor => ({
	id: "",
	name: "",
	sources: [],
	baseUrl: "",
	env: "",
	username: "",
	password: "",
	referenceRepo: "",
	aiInterpret: false,
});

export function ProjectsPanel({
	projects,
	selId,
	setSelId,
	setProjects,
}: {
	projects: Project[];
	selId: string;
	setSelId: (id: string) => void;
	setProjects: (p: Project[]) => void;
}) {
	const [ed, setEd] = useState<Editor>(blank());
	const [addMode, setAddMode] = useState<"" | "sheet" | "csv">("");
	const [sheetUrl, setSheetUrl] = useState("");
	const [csvText, setCsvText] = useState("");
	const [xlsxSheets, setXlsxSheets] = useState<XlsxSheet[] | null>(null);
	const [xlsxName, setXlsxName] = useState("");
	const [pick, setPick] = useState<Record<number, boolean>>({});
	const [statusMsg, setStatusMsg] = useState("");
	const [preview, setPreview] = useState<PreviewResult | null>(null);

	function editProject(p: Project) {
		setEd({
			id: p.id,
			name: p.name,
			sources: p.sources.map((s) => ({ ...s })),
			baseUrl: p.baseUrl,
			env: p.env,
			username: p.username,
			password: p.password,
			referenceRepo: p.referenceRepo,
			aiInterpret: p.aiInterpret,
		});
		setPreview(null);
		setStatusMsg("");
		setAddMode("");
		setXlsxSheets(null);
	}
	function newProject() {
		setEd(blank());
		setPreview(null);
		setStatusMsg("");
		setAddMode("");
		setXlsxSheets(null);
	}

	function addSheet() {
		if (!sheetUrl.trim()) return;
		setEd((e) => ({ ...e, sources: [...e.sources, { kind: "sheet", label: "시트", sheetUrl: sheetUrl.trim(), csvText: "" }] }));
		setSheetUrl("");
		setAddMode("");
	}
	function addCsv() {
		if (!csvText.trim()) return;
		setEd((e) => ({ ...e, sources: [...e.sources, { kind: "csv", label: "붙여넣기", sheetUrl: "", csvText }] }));
		setCsvText("");
		setAddMode("");
	}
	function removeSource(i: number) {
		setEd((e) => ({ ...e, sources: e.sources.filter((_, k) => k !== i) }));
	}

	async function onXlsx(file: File) {
		setStatusMsg("XLSX 파싱 중…");
		try {
			const b64 = await new Promise<string>((res, rej) => {
				const r = new FileReader();
				r.onload = () => res(String(r.result).split(",")[1] ?? "");
				r.onerror = rej;
				r.readAsDataURL(file);
			});
			const { sheets } = await api.xlsxConvert(b64);
			setXlsxSheets(sheets);
			setXlsxName(file.name);
			setPick({});
			setStatusMsg("");
		} catch (e) {
			setStatusMsg((e as Error).message);
		}
	}
	function addPicked() {
		if (!xlsxSheets) return;
		const add: TcSource[] = xlsxSheets
			.filter((_, i) => pick[i])
			.map((s) => ({ kind: "csv", label: s.name, sheetUrl: "", csvText: s.csv }));
		setEd((e) => ({ ...e, sources: [...e.sources, ...add] }));
		setXlsxSheets(null);
	}

	function payload() {
		return {
			id: ed.id || undefined,
			projectId: ed.id || "sample",
			sample: false,
			name: ed.name.trim() || "Untitled",
			sources: ed.sources,
			baseUrl: ed.baseUrl.trim(),
			env: ed.env.trim(),
			username: ed.username.trim(),
			password: ed.password,
			referenceRepo: ed.referenceRepo.trim(),
			aiInterpret: ed.aiInterpret,
		};
	}
	async function save() {
		setStatusMsg("저장 중…");
		try {
			const { saved, projects: ps } = await api.saveProject(payload());
			setProjects(ps);
			setSelId(saved.id);
			editProject(saved);
			setStatusMsg("저장됨");
		} catch (e) {
			setStatusMsg((e as Error).message);
		}
	}
	async function del(id: string) {
		try {
			const { projects: ps } = await api.deleteProject(id);
			setProjects(ps);
			if (selId === id) setSelId("sample");
		} catch (e) {
			alert((e as Error).message);
		}
	}
	async function doPreview() {
		setStatusMsg("TC 읽는 중…");
		try {
			const d = await api.preview({ sample: false, sources: ed.sources, baseUrl: ed.baseUrl, projectId: ed.id || "sample" });
			setPreview(d);
			setStatusMsg("");
		} catch (e) {
			setPreview(null);
			setStatusMsg((e as Error).message);
		}
	}

	function srcSummary(s: TcSource) {
		return s.kind === "sheet"
			? `시트: ${s.sheetUrl.slice(0, 60)}`
			: `CSV[${s.label}] ${s.csvText.split("\n").filter((l) => l.trim()).length}행`;
	}

	return (
		<section>
			<h2 className="sec">프로젝트</h2>
			<div className="card">
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
					<b>저장된 프로젝트</b>
					<button className="run" style={{ marginTop: 0, padding: "8px 14px", fontSize: 13 }} type="button" onClick={newProject}>
						+ 새 프로젝트
					</button>
				</div>
				{projects.map((p) => (
					<div className="plist-item" key={p.id}>
						<div>
							<b>{p.name}</b>
							<div className="meta">
								{p.id === "sample" ? "샘플 (번들 데모)" : `${p.sources.length}개 소스 · ${p.baseUrl || "대상 미설정"}`}
								{p.aiInterpret ? " · AI 해석" : ""}
							</div>
						</div>
						<div>
							{p.id === "sample" ? (
								<span className="muted" style={{ fontSize: 12 }}>
									기본
								</span>
							) : (
								<>
									<button className="mini" type="button" onClick={() => editProject(p)}>
										편집
									</button>{" "}
									<button className="mini" type="button" onClick={() => del(p.id)}>
										삭제
									</button>
								</>
							)}
						</div>
					</div>
				))}
			</div>

			<div className="card">
				<b>{ed.id ? "프로젝트 편집" : "새 프로젝트"}</b>
				<label>이름</label>
				<input type="text" value={ed.name} onChange={(e) => setEd({ ...ed, name: e.target.value })} placeholder="예: 우리 서비스 회귀" />

				<label style={{ marginTop: 14 }}>
					TC 소스 <span className="muted">— 시트 / CSV / XLSX를 여러 개 추가</span>
				</label>
				<div className="detail" style={{ margin: "4px 0 8px" }}>
					{ed.sources.length === 0 ? (
						"아직 소스가 없습니다."
					) : (
						ed.sources.map((s, i) => (
							<div className="plist-item" style={{ padding: "6px 10px" }} key={i}>
								<span className="detail" style={{ margin: 0 }}>
									{srcSummary(s)}
								</span>
								<button className="mini" type="button" onClick={() => removeSource(i)}>
									제거
								</button>
							</div>
						))
					)}
				</div>
				<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
					<button className="mini" type="button" onClick={() => setAddMode(addMode === "sheet" ? "" : "sheet")}>
						+ 구글 시트
					</button>
					<button className="mini" type="button" onClick={() => setAddMode(addMode === "csv" ? "" : "csv")}>
						+ CSV 붙여넣기
					</button>
					<label className="mini" style={{ cursor: "pointer" }}>
						+ XLSX 파일
						<input
							type="file"
							accept=".xlsx,.xls"
							style={{ display: "none" }}
							onChange={(e) => {
								const f = e.target.files?.[0];
								if (f) onXlsx(f);
								e.target.value = "";
							}}
						/>
					</label>
				</div>
				{addMode === "sheet" && (
					<div style={{ marginTop: 8 }}>
						<input type="text" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
						<button className="mini" type="button" style={{ marginTop: 6 }} onClick={addSheet}>
							시트 추가
						</button>
					</div>
				)}
				{addMode === "csv" && (
					<div style={{ marginTop: 8 }}>
						<textarea rows={3} value={csvText} onChange={(e) => setCsvText(e.target.value)} placeholder="Test ID,Title,Steps,Expected&#10;…" />
						<button className="mini" type="button" style={{ marginTop: 6 }} onClick={addCsv}>
							CSV 추가
						</button>
					</div>
				)}
				{xlsxSheets && (
					<div style={{ marginTop: 8 }}>
						<div className="detail" style={{ marginBottom: 4 }}>
							{xlsxName} — 담을 시트 선택:
						</div>
						{xlsxSheets.map((s, i) => (
							<label key={s.name} style={{ display: "block", fontSize: 13 }}>
								<input type="checkbox" checked={!!pick[i]} onChange={(e) => setPick({ ...pick, [i]: e.target.checked })} /> {s.name} ({s.rows}행)
							</label>
						))}
						<button className="mini" type="button" style={{ marginTop: 6 }} onClick={addPicked}>
							선택 시트 추가
						</button>
					</div>
				)}

				<div className="row" style={{ marginTop: 8 }}>
					<div style={{ flex: "2 1 240px" }}>
						<label>테스트 대상 사이트 URL</label>
						<input type="text" value={ed.baseUrl} onChange={(e) => setEd({ ...ed, baseUrl: e.target.value })} placeholder="https://your.app" />
					</div>
					<div style={{ flex: "1 1 120px" }}>
						<label>환경</label>
						<input type="text" value={ed.env} onChange={(e) => setEd({ ...ed, env: e.target.value })} placeholder="staging" />
					</div>
				</div>
				<div className="row">
					<div style={{ flex: "1 1 160px" }}>
						<label>테스트 계정 (선택)</label>
						<input type="text" value={ed.username} onChange={(e) => setEd({ ...ed, username: e.target.value })} placeholder="아이디" />
					</div>
					<div style={{ flex: "1 1 160px" }}>
						<label>비밀번호 (선택)</label>
						<input type="text" value={ed.password} onChange={(e) => setEd({ ...ed, password: e.target.value })} placeholder="비밀번호" />
					</div>
				</div>
				<label>
					참고 프로젝트 repo (선택) <span className="muted">— AI가 앱 맥락 파악에 사용</span>
				</label>
				<input type="text" value={ed.referenceRepo} onChange={(e) => setEd({ ...ed, referenceRepo: e.target.value })} placeholder="https://github.com/org/app" />

				<label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, cursor: "pointer" }}>
					<input type="checkbox" checked={ed.aiInterpret} onChange={(e) => setEd({ ...ed, aiInterpret: e.target.checked })} />{" "}
					<span>기본으로 AI 스텝 해석 사용</span>
				</label>
				<div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
					<button className="run" style={{ marginTop: 0 }} type="button" onClick={save}>
						저장
					</button>
					<button className="mini" type="button" onClick={doPreview}>
						TC 읽기 & 중복 확인
					</button>
					<button className="mini" type="button" onClick={newProject}>
						새로 만들기
					</button>
					<span className="muted">{statusMsg}</span>
				</div>
				{preview && (
					<div style={{ marginTop: 14 }}>
						<div className="summary">
							<span className="chip">
								케이스 <b>{preview.counts.unique}</b>
							</span>
							<span className="chip" style={{ color: "var(--review)" }}>
								중복 <b>{preview.counts.duplicates}</b>
							</span>
						</div>
						<div className="detail" style={{ marginBottom: 8 }}>
							열 매핑:{" "}
							{Object.keys(preview.mapping).length
								? Object.entries(preview.mapping)
										.map(([k, v]) => `${k}→${v}`)
										.join("   ")
								: "(자동감지 실패 — 규칙·해석 탭에서 시트 해석)"}
						</div>
						<table>
							<thead>
								<tr>
									<th>제목</th>
									<th>스텝</th>
									<th>기대결과</th>
								</tr>
							</thead>
							<tbody>
								{preview.unique.slice(0, 30).map((c) => (
									<tr key={c.caseId}>
										<td>{c.title || c.caseId}</td>
										<td className="detail">{c.steps.join(" · ")}</td>
										<td className="detail">{c.expected}</td>
									</tr>
								))}
							</tbody>
						</table>
						{preview.duplicates.length > 0 && (
							<div className="detail" style={{ marginTop: 10, color: "var(--review)" }}>
								중복 제거: {preview.duplicates.map((x) => `${x.title} ↔ ${x.duplicateOf}`).join(", ")}
							</div>
						)}
					</div>
				)}
			</div>
		</section>
	);
}

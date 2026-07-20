import { useEffect, useState } from "react";
import { api } from "../api";
import type { PreviewResult, Project, TestSheet, XlsxSheet } from "../types";

interface Editor {
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
const blank = (): Editor => ({
	id: "",
	name: "",
	sheets: [],
	baseUrl: "",
	env: "",
	username: "",
	password: "",
	referenceRepo: "",
	aiInterpret: false,
});

export function ProjectsPanel({
	initialProject,
	onSaved,
	onClose,
}: {
	initialProject: Project | null;
	projects: Project[];
	onSaved: (savedId: string, projects: Project[]) => void;
	onClose: () => void;
}) {
	const [ed, setEd] = useState<Editor>(blank());
	const [addMode, setAddMode] = useState<"" | "sheet" | "csv">("");
	const [sheetUrl, setSheetUrl] = useState("");
	const [csvText, setCsvText] = useState("");
	const [xlsxSheets, setXlsxSheets] = useState<XlsxSheet[] | null>(null);
	const [xlsxName, setXlsxName] = useState("");
	const [pick, setPick] = useState<Record<number, boolean>>({});
	const [statusMsg, setStatusMsg] = useState("");
	const [statusErr, setStatusErr] = useState(false);
	const [preview, setPreview] = useState<PreviewResult | null>(null);
	const [dirty, setDirty] = useState(false);

	function note(msg: string, isErr = false) {
		setStatusMsg(msg);
		setStatusErr(isErr);
	}

	/** All form mutations go through here so unsaved changes are tracked. */
	function upd(patch: Partial<Editor>) {
		setEd((e) => ({ ...e, ...patch }));
		setDirty(true);
	}

	// Warn before the page unloads with unsaved edits.
	useEffect(() => {
		if (!dirty) return;
		const warn = (e: BeforeUnloadEvent) => {
			e.preventDefault();
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);

	// (Re)initialize the editor whenever the panel is opened for a different project.
	useEffect(() => {
		setDirty(false);
		setEd(
			initialProject
				? {
						id: initialProject.id,
						name: initialProject.name,
						sheets: initialProject.sheets.map((s) => ({ ...s })),
						baseUrl: initialProject.baseUrl,
						env: initialProject.env,
						username: initialProject.username,
						password: initialProject.password,
						referenceRepo: initialProject.referenceRepo,
						aiInterpret: initialProject.aiInterpret,
					}
				: blank(),
		);
		setPreview(null);
		setStatusMsg("");
		setAddMode("");
		setXlsxSheets(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [initialProject]);

	function addSheet() {
		if (!sheetUrl.trim()) return;
		setEd((e) => ({
			...e,
			sheets: [
				...e.sheets,
				{ id: `sh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, kind: "sheet", name: "시트", sheetUrl: sheetUrl.trim(), csvText: "" },
			],
		}));
		setDirty(true);
		setSheetUrl("");
		setAddMode("");
	}
	function addCsv() {
		if (!csvText.trim()) return;
		setEd((e) => ({
			...e,
			sheets: [
				...e.sheets,
				{ id: `sh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, kind: "csv", name: "붙여넣기", sheetUrl: "", csvText },
			],
		}));
		setDirty(true);
		setCsvText("");
		setAddMode("");
	}
	function removeSheet(i: number) {
		setEd((e) => ({ ...e, sheets: e.sheets.filter((_, k) => k !== i) }));
		setDirty(true);
	}

	async function onXlsx(file: File) {
		note("XLSX 파싱 중…");
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
			note("");
		} catch (e) {
			note(`XLSX 변환 실패: ${(e as Error).message} — 파일이 올바른 엑셀 형식인지 확인하세요.`, true);
		}
	}
	function addPicked() {
		if (!xlsxSheets) return;
		const add: TestSheet[] = xlsxSheets
			.filter((_, i) => pick[i])
			.map((s) => ({
				id: `sh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
				kind: "csv",
				name: s.name,
				sheetUrl: "",
				csvText: s.csv,
			}));
		setEd((e) => ({ ...e, sheets: [...e.sheets, ...add] }));
		setDirty(true);
		setXlsxSheets(null);
	}

	function payload() {
		return {
			id: ed.id || undefined,
			projectId: ed.id || "sample",
			sample: false,
			name: ed.name.trim() || "Untitled",
			sheets: ed.sheets,
			baseUrl: ed.baseUrl.trim(),
			env: ed.env.trim(),
			username: ed.username.trim(),
			password: ed.password,
			referenceRepo: ed.referenceRepo.trim(),
			aiInterpret: ed.aiInterpret,
		};
	}
	async function save() {
		note("저장 중…");
		try {
			const { saved, projects: ps } = await api.saveProject(payload());
			setDirty(false);
			note("저장됨");
			onSaved(saved.id, ps);
		} catch (e) {
			note(`저장 실패: ${(e as Error).message} — 다시 시도하세요.`, true);
		}
	}
	async function doPreview() {
		note("TC 읽는 중…");
		try {
			const d = await api.preview({ sample: false, sheets: ed.sheets, baseUrl: ed.baseUrl, projectId: ed.id || "sample" });
			setPreview(d);
			note("");
		} catch (e) {
			setPreview(null);
			note(`TC 읽기 실패: ${(e as Error).message} — 소스 URL과 형식을 확인하세요.`, true);
		}
	}

	function srcSummary(s: TestSheet) {
		return s.kind === "sheet"
			? `시트: ${s.sheetUrl.slice(0, 60)}`
			: s.csvText
				? `CSV[${s.name}] ${s.csvText.split("\n").filter((l) => l.trim()).length}행`
				: `CSV[${s.name}] (저장됨)`;
	}

	return (
		<section>
			<h2 className="sec">프로젝트</h2>
			<div className="card">
				<b>{ed.id ? "프로젝트 편집" : "새 프로젝트"}</b>
				<label>이름</label>
				<input type="text" value={ed.name} onChange={(e) => upd({ name: e.target.value })} placeholder="예: 우리 서비스 회귀" />

				<label style={{ marginTop: 14 }}>
					TC 소스 <span className="muted">— 시트 / CSV / XLSX를 여러 개 추가</span>
				</label>
				<div className="detail" style={{ margin: "4px 0 8px" }}>
					{ed.sheets.length === 0 ? (
						"아직 소스가 없습니다."
					) : (
						ed.sheets.map((s, i) => (
							<div className="plist-item" style={{ padding: "6px 10px" }} key={i}>
								<span className="detail" style={{ margin: 0 }}>
									{srcSummary(s)}
								</span>
								<button className="mini" type="button" onClick={() => removeSheet(i)}>
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
						<input type="text" value={ed.baseUrl} onChange={(e) => upd({ baseUrl: e.target.value })} placeholder="https://your.app" />
					</div>
					<div style={{ flex: "1 1 120px" }}>
						<label>환경</label>
						<input type="text" value={ed.env} onChange={(e) => upd({ env: e.target.value })} placeholder="staging" />
					</div>
				</div>
				<div className="row">
					<div style={{ flex: "1 1 160px" }}>
						<label>테스트 계정 (선택)</label>
						<input type="text" value={ed.username} onChange={(e) => upd({ username: e.target.value })} placeholder="아이디" />
					</div>
					<div style={{ flex: "1 1 160px" }}>
						<label>비밀번호 (선택)</label>
						<input type="password" value={ed.password} onChange={(e) => upd({ password: e.target.value })} placeholder="비밀번호" autoComplete="off" />
					</div>
				</div>
				<label>
					참고 프로젝트 repo (선택) <span className="muted">— AI가 앱 맥락 파악에 사용</span>
				</label>
				<input type="text" value={ed.referenceRepo} onChange={(e) => upd({ referenceRepo: e.target.value })} placeholder="https://github.com/org/app" />

				<label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, cursor: "pointer" }}>
					<input type="checkbox" checked={ed.aiInterpret} onChange={(e) => upd({ aiInterpret: e.target.checked })} />{" "}
					<span>기본으로 AI 스텝 해석 사용</span>
				</label>
				<div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
					<button className="run" style={{ marginTop: 0 }} type="button" onClick={save}>
						저장
					</button>
					<button className="mini" type="button" onClick={doPreview}>
						TC 읽기 & 중복 확인
					</button>
					<span className={statusErr ? "err" : "muted"} style={{ fontSize: 12.5 }}>
						{statusMsg}
					</span>
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
						<div className="tscroll">
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
						</div>
						{preview.unique.length > 30 && (
							<div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
								외 {preview.unique.length - 30}개 케이스는 표시를 생략했습니다.
							</div>
						)}
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

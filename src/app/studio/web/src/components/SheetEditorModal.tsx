import { useEffect, useState } from "react";
import { api } from "../api";
import type { TestSheet } from "../types";
import { ModalShell } from "./ModalShell";

export function SheetEditorModal({
	editSheet,
	projectId,
	onSave,
	onClose,
}: {
	editSheet: TestSheet | null;
	projectId: string;
	onSave: (sheet: TestSheet) => void;
	onClose: () => void;
}) {
	const [name, setName] = useState(editSheet?.name ?? "");
	const [kind, setKind] = useState<"sheet" | "csv">(editSheet?.kind ?? "sheet");
	const [sheetUrl, setSheetUrl] = useState(editSheet?.sheetUrl ?? "");
	const [csvText, setCsvText] = useState(editSheet?.csvText ?? "");
	const [baseUrl, setBaseUrl] = useState(editSheet?.baseUrl ?? "");
	const [env, setEnv] = useState(editSheet?.env ?? "");
	const [loadingCsv, setLoadingCsv] = useState(false);
	const [loadError, setLoadError] = useState("");

	// Existing csv sheets no longer carry csvText from the projects list (it now lives in a file); fetch on demand.
	useEffect(() => {
		if (editSheet && editSheet.kind === "csv" && !editSheet.csvText && projectId) {
			setLoadingCsv(true);
			setLoadError("");
			let live = true;
			api
				.sheetContent(projectId, editSheet.id)
				.then((r) => {
					if (live) setCsvText(r.csvText);
				})
				.catch((error) => {
					if (live) setLoadError(`CSV를 불러오지 못했습니다: ${(error as Error).message}`);
				})
				.finally(() => {
					if (live) setLoadingCsv(false);
				});
			return () => {
				live = false;
			};
		}
	}, [editSheet, projectId]);

	function save() {
		const sheet: TestSheet = editSheet
			? { ...editSheet, name: name.trim() || editSheet.name, sheetUrl, csvText, baseUrl: baseUrl || undefined, env: env || undefined }
			: {
					id: `sh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
					name: name.trim() || "시트",
					kind,
					sheetUrl,
					csvText,
					baseUrl: baseUrl || undefined,
					env: env || undefined,
				};
		onSave(sheet);
	}

	return (
		<ModalShell label="시트" onClose={onClose}>
				<h2 className="sec">{editSheet ? "시트 편집" : "새 시트"}</h2>
				<div className="card">
					<label htmlFor="sheet-name">이름</label>
					<input id="sheet-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 로그인 시나리오" />

					{!editSheet && (
						<>
							<span className="field-label" style={{ marginTop: 10 }}>소스</span>
							<div style={{ display: "flex", gap: 8 }}>
								<button className={`mini${kind === "sheet" ? " on" : ""}`} type="button" onClick={() => setKind("sheet")}>
									구글 시트
								</button>
								<button className={`mini${kind === "csv" ? " on" : ""}`} type="button" onClick={() => setKind("csv")}>
									CSV
								</button>
							</div>
						</>
					)}

					{(editSheet ? editSheet.kind : kind) === "sheet" ? (
						<>
							<label htmlFor="sheet-url" style={{ marginTop: 10 }}>구글 시트 URL</label>
							<input id="sheet-url" type="text" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
						</>
					) : (
						<>
							<label htmlFor="sheet-csv" style={{ marginTop: 10 }}>CSV</label>
							<textarea
								id="sheet-csv"
								rows={4}
								value={csvText}
								onChange={(e) => setCsvText(e.target.value)}
								placeholder={loadingCsv ? "불러오는 중…" : "Test ID,Title,Steps,Expected&#10;…"}
								disabled={loadingCsv || Boolean(loadError)}
							/>
							{loadError && <p className="err" role="alert">{loadError}</p>}
						</>
					)}

					<label htmlFor="sheet-base-url" style={{ marginTop: 10 }}>대상 URL 오버라이드 (선택)</label>
					<input id="sheet-base-url" type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your.app" />

					<label htmlFor="sheet-env" style={{ marginTop: 10 }}>환경 오버라이드 (선택)</label>
					<input id="sheet-env" type="text" value={env} onChange={(e) => setEnv(e.target.value)} placeholder="staging" />

					<div className="editor-actions" style={{ marginTop: 14 }}>
						<button className="run" style={{ marginTop: 0 }} type="button" disabled={loadingCsv || Boolean(loadError)} onClick={save}>
							저장
						</button>
						<button className="mini" type="button" onClick={onClose}>취소</button>
					</div>
				</div>
		</ModalShell>
	);
}

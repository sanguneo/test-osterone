import { useEffect, useState } from "react";
import { api } from "../api";
import type { TestSheet } from "../types";

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

	// Existing csv sheets no longer carry csvText from the projects list (it now lives in a file); fetch on demand.
	useEffect(() => {
		if (editSheet && editSheet.kind === "csv" && !editSheet.csvText && projectId) {
			setLoadingCsv(true);
			let live = true;
			api
				.sheetContent(projectId, editSheet.id)
				.then((r) => {
					if (live) setCsvText(r.csvText);
				})
				.catch(() => {})
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
		<div
			className="modal-overlay"
			role="dialog"
			aria-modal="true"
			aria-label="시트"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="modal">
				<button className="modal-close" type="button" aria-label="닫기" onClick={onClose}>
					✕
				</button>
				<h2 className="sec">{editSheet ? "시트 편집" : "새 시트"}</h2>
				<div className="card">
					<label>이름</label>
					<input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 로그인 시나리오" />

					{!editSheet && (
						<>
							<label style={{ marginTop: 10 }}>소스</label>
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
							<label style={{ marginTop: 10 }}>구글 시트 URL</label>
							<input type="text" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
						</>
					) : (
						<>
							<label style={{ marginTop: 10 }}>CSV</label>
							<textarea
								rows={4}
								value={csvText}
								onChange={(e) => setCsvText(e.target.value)}
								placeholder={loadingCsv ? "불러오는 중…" : "Test ID,Title,Steps,Expected&#10;…"}
								disabled={loadingCsv}
							/>
						</>
					)}

					<label style={{ marginTop: 10 }}>대상 URL 오버라이드 (선택)</label>
					<input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your.app" />

					<label style={{ marginTop: 10 }}>환경 오버라이드 (선택)</label>
					<input type="text" value={env} onChange={(e) => setEnv(e.target.value)} placeholder="staging" />

					<div style={{ marginTop: 14 }}>
						<button className="run" style={{ marginTop: 0 }} type="button" onClick={save}>
							저장
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

import type { TestSheet, XlsxSheet } from "../types";

export interface ProjectDraft {
	readonly id: string;
	readonly name: string;
	readonly sheets: TestSheet[];
	readonly baseUrl: string;
	readonly env: string;
	readonly username: string;
	readonly password: string;
	readonly referenceRepo: string;
	readonly aiInterpret: boolean;
}

interface SourceSectionProps {
	readonly addMode: "" | "sheet" | "csv";
	readonly csvText: string;
	readonly draft: ProjectDraft;
	readonly onAddCsv: () => void;
	readonly onAddMode: (mode: "" | "sheet" | "csv") => void;
	readonly onAddPicked: () => void;
	readonly onCsvText: (value: string) => void;
	readonly onFile: (file: File) => void;
	readonly onPick: (index: number, checked: boolean) => void;
	readonly onRemoveSheet: (index: number) => void;
	readonly onSheetUrl: (value: string) => void;
	readonly onAddSheet: () => void;
	readonly pick: Record<number, boolean>;
	readonly sheetUrl: string;
	readonly xlsxName: string;
	readonly xlsxSheets: XlsxSheet[] | null;
}

function sourceSummary(sheet: TestSheet): string {
	if (sheet.kind === "sheet") return `시트: ${sheet.sheetUrl.slice(0, 60)}`;
	if (sheet.csvText) return `CSV[${sheet.name}] ${sheet.csvText.split("\n").filter((line) => line.trim()).length}행`;
	return `CSV[${sheet.name}] (저장됨)`;
}

export function ProjectSourceSection(props: SourceSectionProps) {
	return (
		<>
			<span className="field-label source-label">테스트 원본 <span className="muted">— 시트 / CSV / XLSX를 여러 개 추가</span></span>
			<div className="detail source-list">
				{props.draft.sheets.length === 0 ? "아직 원본이 없습니다." : props.draft.sheets.map((sheet, index) => (
					<div className="plist-item compact-item" key={sheet.id}>
						<span className="detail">{sourceSummary(sheet)}</span>
						<button className="mini" type="button" onClick={() => props.onRemoveSheet(index)}>제거</button>
					</div>
				))}
			</div>
			<div className="source-actions">
				<button className="mini" type="button" onClick={() => props.onAddMode(props.addMode === "sheet" ? "" : "sheet")}>+ 구글 시트</button>
				<button className="mini" type="button" onClick={() => props.onAddMode(props.addMode === "csv" ? "" : "csv")}>+ CSV 붙여넣기</button>
				<label className="mini file-picker">+ XLSX 파일<input type="file" accept=".xlsx,.xls" onChange={(event) => { const file = event.target.files?.[0]; if (file) props.onFile(file); event.target.value = ""; }} /></label>
			</div>
			{props.addMode === "sheet" && <div className="inline-source"><input aria-label="구글 시트 URL" type="text" value={props.sheetUrl} onChange={(event) => props.onSheetUrl(event.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" /><button className="mini" type="button" onClick={props.onAddSheet}>시트 추가</button></div>}
			{props.addMode === "csv" && <div className="inline-source"><textarea aria-label="CSV 내용" rows={3} value={props.csvText} onChange={(event) => props.onCsvText(event.target.value)} placeholder="Test ID,Title,Steps,Expected&#10;…" /><button className="mini" type="button" onClick={props.onAddCsv}>CSV 추가</button></div>}
			{props.xlsxSheets && (
				<div className="xlsx-picker">
					<p className="detail">{props.xlsxName} — 담을 시트 선택:</p>
					{props.xlsxSheets.map((sheet, index) => <label key={sheet.name}><input type="checkbox" checked={Boolean(props.pick[index])} onChange={(event) => props.onPick(index, event.target.checked)} /> {sheet.name} ({sheet.rows}행)</label>)}
					<button className="mini" type="button" onClick={props.onAddPicked}>선택 시트 추가</button>
				</div>
			)}
		</>
	);
}

export function ProjectEnvironmentSection({ draft, onUpdate }: { readonly draft: ProjectDraft; readonly onUpdate: (patch: Partial<ProjectDraft>) => void }) {
	return (
		<>
			<div className="row field-row">
				<label htmlFor="project-base-url">테스트 대상 사이트 URL<input id="project-base-url" type="text" value={draft.baseUrl} onChange={(event) => onUpdate({ baseUrl: event.target.value })} placeholder="https://your.app" /></label>
				<label htmlFor="project-env">환경<input id="project-env" type="text" value={draft.env} onChange={(event) => onUpdate({ env: event.target.value })} placeholder="staging" /></label>
			</div>
			<div className="row">
				<label htmlFor="project-username">테스트 계정 (선택)<input id="project-username" type="text" value={draft.username} onChange={(event) => onUpdate({ username: event.target.value })} placeholder="아이디" /></label>
				<label htmlFor="project-password">비밀번호 (선택)<input id="project-password" type="password" value={draft.password} onChange={(event) => onUpdate({ password: event.target.value })} placeholder="비밀번호" autoComplete="off" /></label>
			</div>
			<label htmlFor="project-reference-repo">참고 프로젝트 repo (선택) <span className="muted">— AI가 앱 맥락 파악에 사용</span></label>
			<input id="project-reference-repo" type="text" value={draft.referenceRepo} onChange={(event) => onUpdate({ referenceRepo: event.target.value })} placeholder="https://github.com/org/app" />
			<label className="check-label"><input type="checkbox" checked={draft.aiInterpret} onChange={(event) => onUpdate({ aiInterpret: event.target.checked })} /><span>기본으로 AI 스텝 해석 사용</span></label>
		</>
	);
}

import type { TestSheet, XlsxSheet } from "../types";
import { useLang } from "../i18n";

const S = {
	ko: {
		sourceLabel: "테스트 원본",
		sourceLabelHint: "— 시트 / CSV / XLSX를 여러 개 추가",
		noSources: "아직 원본이 없습니다.",
		remove: "제거",
		addGoogleSheet: "+ 구글 시트",
		addCsvPaste: "+ CSV 붙여넣기",
		addXlsxFile: "+ XLSX 파일",
		googleSheetUrlLabel: "구글 시트 URL",
		csvContentLabel: "CSV 내용",
		addSheet: "시트 추가",
		addCsv: "CSV 추가",
		xlsxPick: (name: string) => `${name} — 담을 시트 선택:`,
		rows: (n: number) => `${n}행`,
		addPicked: "선택 시트 추가",
		sheetPrefix: (url: string) => `시트: ${url}`,
		csvSaved: (name: string) => `CSV[${name}] (저장됨)`,
		csvRows: (name: string, n: number) => `CSV[${name}] ${n}행`,
		targetUrl: "테스트 대상 사이트 URL",
		env: "환경",
		testAccount: "테스트 계정 (선택)",
		password: "비밀번호 (선택)",
		id: "아이디",
		passwordPlaceholder: "비밀번호",
		referenceRepo: "참고 프로젝트 repo (선택)",
		referenceRepoHint: "— AI가 앱 맥락 파악에 사용",
		aiStepDefault: "기본으로 AI 스텝 해석 사용",
	},
	en: {
		sourceLabel: "Test sources",
		sourceLabelHint: "— add multiple sheets / CSV / XLSX",
		noSources: "No sources yet.",
		remove: "Remove",
		addGoogleSheet: "+ Google Sheet",
		addCsvPaste: "+ Paste CSV",
		addXlsxFile: "+ XLSX File",
		googleSheetUrlLabel: "Google Sheet URL",
		csvContentLabel: "CSV content",
		addSheet: "Add Sheet",
		addCsv: "Add CSV",
		xlsxPick: (name: string) => `${name} — choose sheets to include:`,
		rows: (n: number) => `${n} row${n === 1 ? "" : "s"}`,
		addPicked: "Add Selected Sheets",
		sheetPrefix: (url: string) => `Sheet: ${url}`,
		csvSaved: (name: string) => `CSV[${name}] (saved)`,
		csvRows: (name: string, n: number) => `CSV[${name}] ${n} row${n === 1 ? "" : "s"}`,
		targetUrl: "Test target site URL",
		env: "Environment",
		testAccount: "Test account (optional)",
		password: "Password (optional)",
		id: "Username",
		passwordPlaceholder: "Password",
		referenceRepo: "Reference project repo (optional)",
		referenceRepoHint: "— used by AI to understand app context",
		aiStepDefault: "Use AI step interpretation by default",
	},
} as const;

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

function sourceSummary(sheet: TestSheet, t: (typeof S)["ko" | "en"]): string {
	if (sheet.kind === "sheet") return t.sheetPrefix(sheet.sheetUrl.slice(0, 60));
	if (sheet.csvText) return t.csvRows(sheet.name, sheet.csvText.split("\n").filter((line) => line.trim()).length);
	return t.csvSaved(sheet.name);
}

export function ProjectSourceSection(props: SourceSectionProps) {
	const t = S[useLang()];
	return (
		<>
			<span className="field-label source-label">{t.sourceLabel} <span className="muted">{t.sourceLabelHint}</span></span>
			<div className="detail source-list">
				{props.draft.sheets.length === 0 ? t.noSources : props.draft.sheets.map((sheet, index) => (
					<div className="plist-item compact-item" key={sheet.id}>
						<span className="detail">{sourceSummary(sheet, t)}</span>
						<button className="mini" type="button" onClick={() => props.onRemoveSheet(index)}>{t.remove}</button>
					</div>
				))}
			</div>
			<div className="source-actions">
				<button className="mini" type="button" onClick={() => props.onAddMode(props.addMode === "sheet" ? "" : "sheet")}>{t.addGoogleSheet}</button>
				<button className="mini" type="button" onClick={() => props.onAddMode(props.addMode === "csv" ? "" : "csv")}>{t.addCsvPaste}</button>
				<label className="mini file-picker">{t.addXlsxFile}<input type="file" accept=".xlsx,.xls" onChange={(event) => { const file = event.target.files?.[0]; if (file) props.onFile(file); event.target.value = ""; }} /></label>
			</div>
			{props.addMode === "sheet" && <div className="inline-source"><input aria-label={t.googleSheetUrlLabel} type="text" value={props.sheetUrl} onChange={(event) => props.onSheetUrl(event.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" /><button className="mini" type="button" onClick={props.onAddSheet}>{t.addSheet}</button></div>}
			{props.addMode === "csv" && <div className="inline-source"><textarea aria-label={t.csvContentLabel} rows={3} value={props.csvText} onChange={(event) => props.onCsvText(event.target.value)} placeholder="Test ID,Title,Steps,Expected&#10;…" /><button className="mini" type="button" onClick={props.onAddCsv}>{t.addCsv}</button></div>}
			{props.xlsxSheets && (
				<div className="xlsx-picker">
					<p className="detail">{t.xlsxPick(props.xlsxName)}</p>
					{props.xlsxSheets.map((sheet, index) => <label key={sheet.name}><input type="checkbox" checked={Boolean(props.pick[index])} onChange={(event) => props.onPick(index, event.target.checked)} /> {sheet.name} ({t.rows(sheet.rows)})</label>)}
					<button className="mini" type="button" onClick={props.onAddPicked}>{t.addPicked}</button>
				</div>
			)}
		</>
	);
}

export function ProjectEnvironmentSection({ draft, onUpdate }: { readonly draft: ProjectDraft; readonly onUpdate: (patch: Partial<ProjectDraft>) => void }) {
	const t = S[useLang()];
	return (
		<>
			<div className="row field-row">
				<label htmlFor="project-base-url">{t.targetUrl}<input id="project-base-url" type="text" value={draft.baseUrl} onChange={(event) => onUpdate({ baseUrl: event.target.value })} placeholder="https://your.app" /></label>
				<label htmlFor="project-env">{t.env}<input id="project-env" type="text" value={draft.env} onChange={(event) => onUpdate({ env: event.target.value })} placeholder="staging" /></label>
			</div>
			<div className="row">
				<label htmlFor="project-username">{t.testAccount}<input id="project-username" type="text" value={draft.username} onChange={(event) => onUpdate({ username: event.target.value })} placeholder={t.id} /></label>
				<label htmlFor="project-password">{t.password}<input id="project-password" type="password" value={draft.password} onChange={(event) => onUpdate({ password: event.target.value })} placeholder={t.passwordPlaceholder} autoComplete="off" /></label>
			</div>
			<label htmlFor="project-reference-repo">{t.referenceRepo} <span className="muted">{t.referenceRepoHint}</span></label>
			<input id="project-reference-repo" type="text" value={draft.referenceRepo} onChange={(event) => onUpdate({ referenceRepo: event.target.value })} placeholder="https://github.com/org/app" />
			<label className="check-label"><input type="checkbox" checked={draft.aiInterpret} onChange={(event) => onUpdate({ aiInterpret: event.target.checked })} /><span>{t.aiStepDefault}</span></label>
		</>
	);
}

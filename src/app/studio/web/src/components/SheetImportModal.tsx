import { useState } from "react";
import { api } from "../api";
import { getLang, useLang } from "../i18n";
import type { TestSheet, XlsxSheet } from "../types";
import { ModalShell } from "./ModalShell";

const S = {
	ko: {
		title: "XLSX 가져오기",
		intro: "워크북의 각 시트를 개별 테스트 시트로 가져옵니다. TC 시트는 자동 선택됩니다.",
		chooseFile: "XLSX 파일 선택",
		parsing: "XLSX 파싱 중…",
		parseFail: (m: string) => `변환 실패: ${m} — 파일 형식을 확인하세요.`,
		pick: (name: string) => `${name} — 가져올 시트:`,
		rows: (n: number) => `${n}행`,
		nonTc: "비TC?",
		importSelected: (n: number) => (n > 0 ? `선택 ${n}개 가져오기` : "선택 시트 가져오기"),
		importing: "가져오는 중…",
		none: "가져올 시트를 하나 이상 선택하세요.",
		cancel: "취소",
	},
	en: {
		title: "Import XLSX",
		intro: "Import each workbook sheet as a separate test sheet. TC sheets are auto-selected.",
		chooseFile: "Choose XLSX file",
		parsing: "Parsing XLSX…",
		parseFail: (m: string) => `Conversion failed: ${m} — check the file format.`,
		pick: (name: string) => `${name} — sheets to import:`,
		rows: (n: number) => `${n} row${n === 1 ? "" : "s"}`,
		nonTc: "non-TC?",
		importSelected: (n: number) => (n > 0 ? `Import ${n} selected` : "Import selected"),
		importing: "Importing…",
		none: "Select at least one sheet to import.",
		cancel: "Cancel",
	},
} as const;

export function SheetImportModal({ onImported, onClose }: { onImported: (sheets: TestSheet[]) => void; onClose: () => void }) {
	const t = S[useLang()];
	const [sheets, setSheets] = useState<XlsxSheet[] | null>(null);
	const [fileName, setFileName] = useState("");
	const [pick, setPick] = useState<Record<number, boolean>>({});
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState("");
	const [err, setErr] = useState(false);

	async function onFile(file: File) {
		setBusy(true);
		setErr(false);
		setMsg(S[getLang()].parsing);
		try {
			const base64 = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
				reader.onerror = reject;
				reader.readAsDataURL(file);
			});
			const result = await api.xlsxConvert(base64);
			setSheets(result.sheets);
			setFileName(file.name);
			setPick(Object.fromEntries(result.sheets.map((sheet, index) => [index, Boolean(sheet.isTc)])));
			setMsg("");
		} catch (error) {
			setErr(true);
			setMsg(S[getLang()].parseFail((error as Error).message));
		} finally {
			setBusy(false);
		}
	}

	const pickedCount = sheets ? sheets.filter((_, index) => pick[index]).length : 0;

	function doImport() {
		if (!sheets) return;
		const picked: TestSheet[] = [];
		for (const [index, sheet] of sheets.entries()) {
			if (pick[index]) picked.push({ id: `sh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, kind: "csv", name: sheet.name, sheetUrl: "", csvText: sheet.csv, origin: "xlsx" });
		}
		if (picked.length === 0) {
			setErr(true);
			setMsg(S[getLang()].none);
			return;
		}
		onImported(picked);
	}

	return (
		<ModalShell label={t.title} onClose={onClose}>
			<h2 className="sec">{t.title}</h2>
			<p className="detail">{t.intro}</p>
			<div className="source-actions">
				<label className="button secondary file-picker">{t.chooseFile}<input type="file" accept=".xlsx,.xls" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onFile(file); event.target.value = ""; }} /></label>
			</div>
			{sheets && (
				<div className="xlsx-picker" style={{ marginTop: 12 }}>
					<p className="detail">{t.pick(fileName)}</p>
					<div className="xlsx-sheets">
						{sheets.map((sheet, index) => <label key={sheet.name}><input type="checkbox" checked={Boolean(pick[index])} onChange={(event) => setPick((current) => ({ ...current, [index]: event.target.checked }))} /> {sheet.name} ({t.rows(sheet.rows)}){sheet.isTc === false ? <span className="muted"> · {t.nonTc}</span> : null}</label>)}
					</div>
				</div>
			)}
			<div className="editor-actions" style={{ marginTop: 14 }}>
				<button className="run" style={{ marginTop: 0 }} type="button" disabled={busy || !sheets} onClick={doImport}>{busy ? t.importing : t.importSelected(pickedCount)}</button>
				<button className="button secondary" type="button" onClick={onClose}>{t.cancel}</button>
				{msg && <span className={err ? "err" : "muted"}>{msg}</span>}
			</div>
		</ModalShell>
	);
}

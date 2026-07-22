import type { Project } from "../types";
import { useLang } from "../i18n";
import { EmptyMotif } from "./DashboardParts";
import { Icon } from "./Icon";

const S = {
	ko: {
		noTarget: "대상 미설정",
		sheets: (n: number) => `시트 ${n}개`,
		firstSheetTitle: "첫 테스트 시트를 추가하세요",
		firstSheetBody: "시트를 추가하면 AI가 해석안을 제안하고 대화로 규칙을 다듬은 뒤 실행합니다.",
		newSheet: "새 시트",
		googleSheet: "구글 시트",
	},
	en: {
		noTarget: "No target set",
		sheets: (n: number) => `${n} sheet${n === 1 ? "" : "s"}`,
		firstSheetTitle: "Add your first test sheet",
		firstSheetBody: "Once you add a sheet, AI proposes an interpretation, you refine the rules by chat, then run it.",
		newSheet: "New Sheet",
		googleSheet: "Google Sheet",
	},
} as const;

export function ProjectHome({
	project,
	onSelectSheet,
	onAddSheet,
}: {
	readonly project: Project;
	readonly onSelectSheet: (id: string) => void;
	readonly onAddSheet: () => void;
}) {
	const t = S[useLang()];
	return (
		<section>
			<div className="dash-head">
				<h2 className="sec">{project.name}</h2>
				<span className="ctx">{project.baseUrl || t.noTarget} · {t.sheets(project.sheets.length)}</span>
			</div>
			{project.sheets.length === 0 ? (
				<div className="card dash-empty">
					<div className="empty-signal">
						<EmptyMotif />
					</div>
					<div>
						<h3>{t.firstSheetTitle}</h3>
						<p>{t.firstSheetBody}</p>
						<button className="button primary" type="button" onClick={onAddSheet}>
							<Icon name="add" />{t.newSheet}
						</button>
					</div>
				</div>
			) : (
				<div className="sheet-grid">
					{project.sheets.map((sheet) => (
						<button key={sheet.id} className="sheet-card" type="button" onClick={() => onSelectSheet(sheet.id)}>
							<Icon name="sheet" />
							<b>{sheet.name}</b>
							<div className="detail">{sheet.kind === "sheet" ? t.googleSheet : "CSV"}{sheet.env ? ` · ${sheet.env}` : ""}</div>
						</button>
					))}
					{project.id !== "sample" && (
						<button className="sheet-card sheet-card-add" type="button" onClick={onAddSheet}>
							<Icon name="add" />{t.newSheet}
						</button>
					)}
				</div>
			)}
		</section>
	);
}

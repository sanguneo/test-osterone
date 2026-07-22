import type { TestSheet } from "../types";
import { useLang } from "../i18n";

const S = {
	ko: {
		defaultsHint: "대상·계정은 프로젝트 기본값이며, 시트에서 개별 지정하면 그 값이 우선합니다.",
		targetUrl: "테스트 대상 사이트 URL (기본값)",
		env: "환경 (기본값)",
		testAccount: "테스트 계정 아이디 (기본값)",
		password: "테스트 계정 비밀번호 (기본값)",
		id: "아이디",
		passwordPlaceholder: "비밀번호",
		referenceRepo: "참고 프로젝트 repo (선택)",
		referenceRepoHint: "— AI가 앱 맥락 파악에 사용",
		aiStepDefault: "기본으로 AI 스텝 해석 사용",
	},
	en: {
		defaultsHint: "Target and account here are project defaults; a sheet can override them individually.",
		targetUrl: "Test target site URL (default)",
		env: "Environment (default)",
		testAccount: "Test account username (default)",
		password: "Test account password (default)",
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

export function ProjectEnvironmentSection({ draft, onUpdate }: { readonly draft: ProjectDraft; readonly onUpdate: (patch: Partial<ProjectDraft>) => void }) {
	const t = S[useLang()];
	return (
		<>
			<p className="detail" style={{ marginTop: 10 }}>{t.defaultsHint}</p>
			<div className="row field-row">
				<label htmlFor="project-base-url">{t.targetUrl}<input id="project-base-url" type="text" value={draft.baseUrl} onChange={(event) => onUpdate({ baseUrl: event.target.value })} placeholder="https://your.app" /></label>
				<label htmlFor="project-env">{t.env}<input id="project-env" type="text" value={draft.env} onChange={(event) => onUpdate({ env: event.target.value })} placeholder="staging" /></label>
			</div>
			<div className="row">
				<label htmlFor="project-username">{t.testAccount}<input id="project-username" type="text" value={draft.username} onChange={(event) => onUpdate({ username: event.target.value })} placeholder={t.id} autoComplete="off" /></label>
				<label htmlFor="project-password">{t.password}<input id="project-password" type="password" value={draft.password} onChange={(event) => onUpdate({ password: event.target.value })} placeholder={t.passwordPlaceholder} autoComplete="off" /></label>
			</div>
			<label htmlFor="project-reference-repo">{t.referenceRepo} <span className="muted">{t.referenceRepoHint}</span></label>
			<input id="project-reference-repo" type="text" value={draft.referenceRepo} onChange={(event) => onUpdate({ referenceRepo: event.target.value })} placeholder="https://github.com/org/app" />
			<label className="check-label"><input type="checkbox" checked={draft.aiInterpret} onChange={(event) => onUpdate({ aiInterpret: event.target.checked })} /><span>{t.aiStepDefault}</span></label>
		</>
	);
}

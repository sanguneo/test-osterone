import type { Account, TestSheet } from "../types";
import { useLang } from "../i18n";

const S = {
	ko: {
		defaultsHint: "대상·환경은 프로젝트 기본값이며, 시트에서 개별 지정하면 그 값이 우선합니다.",
		targetUrl: "테스트 대상 사이트 URL (기본값)",
		env: "환경 (기본값)",
		accountsLabel: "테스트 계정",
		accountsHint: "— 시트가 기본 계정을 연결하고, 케이스는 role이 일치하는 계정으로 자동 로그인",
		acctRole: "권한(role)",
		acctUser: "아이디",
		acctPass: "비밀번호",
		addAccount: "+ 계정 추가",
		remove: "제거",
		noAccounts: "아직 계정이 없습니다. 권한별로 계정을 추가하세요.",
		referenceRepo: "참고 프로젝트 repo (선택)",
		referenceRepoHint: "— AI가 앱 맥락 파악에 사용",
		aiStepDefault: "기본으로 AI 스텝 해석 사용",
	},
	en: {
		defaultsHint: "Target and environment are project defaults; a sheet can override them individually.",
		targetUrl: "Test target site URL (default)",
		env: "Environment (default)",
		accountsLabel: "Test accounts",
		accountsHint: "— sheets link a default account; cases auto-login with the account whose role matches",
		acctRole: "Role",
		acctUser: "Username",
		acctPass: "Password",
		addAccount: "+ Add account",
		remove: "Remove",
		noAccounts: "No accounts yet. Add one per role.",
		referenceRepo: "Reference project repo (optional)",
		referenceRepoHint: "— used by AI to understand app context",
		aiStepDefault: "Use AI step interpretation by default",
	},
} as const;

function newAccount(): Account {
	return { id: `acct_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, role: "", username: "", password: "" };
}

export interface ProjectDraft {
	readonly id: string;
	readonly name: string;
	readonly sheets: TestSheet[];
	readonly baseUrl: string;
	readonly env: string;
	readonly accounts: Account[];
	readonly referenceRepo: string;
	readonly aiInterpret: boolean;
}

export function ProjectEnvironmentSection({ draft, onUpdate }: { readonly draft: ProjectDraft; readonly onUpdate: (patch: Partial<ProjectDraft>) => void }) {
	const t = S[useLang()];
	const patchAccount = (index: number, patch: Partial<Account>) => onUpdate({ accounts: draft.accounts.map((account, i) => (i === index ? { ...account, ...patch } : account)) });
	const addAccount = () => onUpdate({ accounts: [...draft.accounts, newAccount()] });
	const removeAccount = (index: number) => onUpdate({ accounts: draft.accounts.filter((_, i) => i !== index) });
	return (
		<>
			<p className="detail" style={{ marginTop: 10 }}>{t.defaultsHint}</p>
			<div className="row field-row">
				<label htmlFor="project-base-url">{t.targetUrl}<input id="project-base-url" type="text" value={draft.baseUrl} onChange={(event) => onUpdate({ baseUrl: event.target.value })} placeholder="https://your.app" /></label>
				<label htmlFor="project-env">{t.env}<input id="project-env" type="text" value={draft.env} onChange={(event) => onUpdate({ env: event.target.value })} placeholder="staging" /></label>
			</div>

			<span className="field-label" style={{ marginTop: 10 }}>{t.accountsLabel} <span className="muted">{t.accountsHint}</span></span>
			<div className="accounts-editor">
				{draft.accounts.length === 0 && <p className="detail">{t.noAccounts}</p>}
				{draft.accounts.map((account, index) => (
					<div className="account-row" key={account.id}>
						<input aria-label={t.acctRole} type="text" value={account.role} onChange={(event) => patchAccount(index, { role: event.target.value })} placeholder={t.acctRole} />
						<input aria-label={t.acctUser} type="text" value={account.username} onChange={(event) => patchAccount(index, { username: event.target.value })} placeholder={t.acctUser} autoComplete="off" />
						<input aria-label={t.acctPass} type="password" value={account.password} onChange={(event) => patchAccount(index, { password: event.target.value })} placeholder={t.acctPass} autoComplete="off" />
						<button className="button secondary compact acct-remove" type="button" onClick={() => removeAccount(index)}>{t.remove}</button>
					</div>
				))}
				<button className="button secondary compact" type="button" onClick={addAccount}>{t.addAccount}</button>
			</div>

			<label htmlFor="project-reference-repo" style={{ marginTop: 10 }}>{t.referenceRepo} <span className="muted">{t.referenceRepoHint}</span></label>
			<input id="project-reference-repo" type="text" value={draft.referenceRepo} onChange={(event) => onUpdate({ referenceRepo: event.target.value })} placeholder="https://github.com/org/app" />
			<label className="check-label"><input type="checkbox" checked={draft.aiInterpret} onChange={(event) => onUpdate({ aiInterpret: event.target.checked })} /><span>{t.aiStepDefault}</span></label>
		</>
	);
}

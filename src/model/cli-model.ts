/**
 * The model a command-line tool may use, resolved the way Studio resolves it, without a browser.
 *
 * An explicit API key wins (`OPENAI_API_KEY`, optional `OPENAI_BASE_URL` / `TEST_OSTERONE_MODEL`), so CI
 * can pin one. Next, `TEST_OSTERONE_MODEL_COMMAND` names a command-line agent in print mode
 * (`omo -p --no-tools`, `claude -p`) whose own login answers. Otherwise the local Codex/ChatGPT login
 * Studio auto-restores is reused. No model is a legitimate answer: callers fall back to rule
 * interpretation or refuse, they never guess.
 */
import { readCodexLogin, readCodexModel } from "./codex-auth.ts";
import { CommandModelClient } from "./command-model.ts";
import { ApiKeyModelClient, DEFAULT_APIKEY_MODEL, type ModelClient } from "./model-client.ts";
import { DEFAULT_OAUTH_MODEL, OAuthProxyModelClient } from "./oauth-proxy.ts";

export interface CliModel {
	client: ModelClient;
	/** Human-readable source + model, for a run header. Never contains a credential. */
	label: string;
}

export function resolveCliModel(env: NodeJS.ProcessEnv = process.env): CliModel | null {
	const apiKey = env.OPENAI_API_KEY?.trim();
	const pinned = env.TEST_OSTERONE_MODEL?.trim() || undefined;
	if (apiKey) {
		const model = pinned ?? DEFAULT_APIKEY_MODEL;
		const baseUrl = env.OPENAI_BASE_URL?.trim() || undefined;
		return { client: new ApiKeyModelClient({ apiKey, model, baseUrl }), label: `api-key · ${model}` };
	}
	const command = env.TEST_OSTERONE_MODEL_COMMAND?.trim();
	if (command) return { client: new CommandModelClient(command), label: `command · ${command}` };
	const login = readCodexLogin();
	if (!login) return null;
	const model = pinned ?? readCodexModel() ?? DEFAULT_OAUTH_MODEL;
	return {
		client: new OAuthProxyModelClient({ accessToken: login.accessToken, model }),
		label: `codex login · ${model}`,
	};
}

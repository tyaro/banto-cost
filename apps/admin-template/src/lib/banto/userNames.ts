/**
 * Client for the business user-name list (`GET /api/user-names` / Tauri
 * `user_names_list`): every account's id and display name, for the project
 * manager and the fixed-cost employee pickers. Unlike usersAdmin.ts it needs
 * no `admin` role - the server lets any company member (`ViewMasters`) read
 * it - and it carries no login name or role.
 *
 * Demo mode has no backend: the call rejects like pipelineAdmin.ts, and the
 * pickers fall back to the numeric id input.
 */
import { demoModeError, httpRequest, invokeCommand, isPipelineAvailable } from './pipelineAdmin';
import { getBantoMode } from './setup';

/** Mirrors `admin_template_core::user_names::UserName`. */
export interface UserName {
	id: number;
	displayName: string;
}

export async function listUserNames(): Promise<UserName[]> {
	if (!isPipelineAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') return invokeCommand<UserName[]>('user_names_list');
	return httpRequest<UserName[]>('/api/user-names', { method: 'GET' });
}

/**
 * Select options in the server's order (display name, then id). A display
 * name that two accounts share gets the id appended, so the two can be told
 * apart without showing the login name.
 */
export function userNameOptions(names: readonly UserName[]): { value: number; label: string }[] {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name.displayName, (counts.get(name.displayName) ?? 0) + 1);
	return names.map((name) => ({
		value: name.id,
		label:
			(counts.get(name.displayName) ?? 0) > 1
				? `${name.displayName} (#${name.id})`
				: name.displayName
	}));
}

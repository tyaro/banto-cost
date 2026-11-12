/**
 * Client for a user's business capabilities (能力, design 第2章, ADR-0028).
 * Same transport split as fixedCostsAdmin.ts: the Tauri webview calls
 * `invoke()` (`authz_capabilities_get` / `authz_capabilities_set`,
 * apps/admin-template/src-tauri/src/lib.rs) and a LAN browser calls `fetch()`
 * against `GET` / `PUT /api/users/{id}/capabilities`
 * (apps/admin-template/core/src/rest/authz.rs). Both are `admin`-only and the
 * write is audited (`update capabilities`).
 *
 * The capabilities are separate from the Banto role on purpose: an `admin`
 * gets none by default (`amount.view` in particular), so a fresh install's
 * first account has to be given them here before the business screens show
 * any amounts.
 *
 * Demo mode has no backend: every export rejects like pipelineAdmin.ts.
 */
import { getBantoMode } from './setup';
import { demoModeError, httpRequest, invokeCommand, isPipelineAvailable } from './pipelineAdmin';

/** Mirrors `banto_admin_services::authz::Capability` (serialized as the dotted name). */
export type Capability =
	| 'time.entry'
	| 'pipeline.edit'
	| 'project.manage'
	| 'finance.rate'
	| 'finance.close'
	| 'report.all'
	| 'amount.view';

/** Display order on the users screen (design 第2章's table order). */
export const CAPABILITIES: readonly Capability[] = [
	'time.entry',
	'pipeline.edit',
	'project.manage',
	'finance.rate',
	'finance.close',
	'report.all',
	'amount.view'
];

function guard(): void {
	if (!isPipelineAvailable()) throw demoModeError();
}

const tauri = () => getBantoMode() === 'tauri';

/** The user's current capabilities. */
export async function getUserCapabilities(id: number): Promise<Capability[]> {
	guard();
	if (tauri()) return invokeCommand<Capability[]>('authz_capabilities_get', { id });
	return httpRequest<Capability[]>(`/api/users/${id}/capabilities`, { method: 'GET' });
}

/** Replace the user's capabilities; resolves to what the server stored. */
export async function setUserCapabilities(
	id: number,
	capabilities: readonly Capability[]
): Promise<Capability[]> {
	guard();
	if (tauri()) {
		return invokeCommand<Capability[]>('authz_capabilities_set', {
			id,
			capabilities: [...capabilities]
		});
	}
	return httpRequest<Capability[]>(`/api/users/${id}/capabilities`, {
		method: 'PUT',
		body: { capabilities: [...capabilities] }
	});
}

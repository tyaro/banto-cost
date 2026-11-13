/**
 * Client for project members (案件の担当者, review F-2, ADR-0028) and for the
 * caller's own grants (`authz/me`, review D-4).
 *
 * Same transport split as capabilitiesAdmin.ts: the Tauri webview calls
 * `invoke()` (`project_members_list` / `project_members_add` /
 * `project_members_remove` / `authz_me`, apps/admin-template/src-tauri/src/lib.rs)
 * and a LAN browser calls `fetch()` against `/api/projects/{id}/members` and
 * `/api/authz/me` (apps/admin-template/core/src/rest/authz.rs).
 *
 * Reading a project's members needs the `admin` role or `ViewProject` on that
 * project; adding and removing one is `admin`-only and audited. The manager
 * (責任者) row follows the project's `managerUserId` (the server keeps it in
 * the same transaction), so the screen changes it there, not here.
 *
 * Demo mode has no backend: every export rejects like pipelineAdmin.ts.
 */
import type { Capability } from './capabilitiesAdmin';
import { getBantoMode } from './setup';
import { demoModeError, httpRequest, invokeCommand, isPipelineAvailable } from './pipelineAdmin';

/** Mirrors `banto_admin_services::authz::MemberKind`. */
export type MemberKind = 'sales' | 'manager' | 'worker';

/** The kinds the members section adds and removes (the manager is the project's field). */
export const EDITABLE_MEMBER_KINDS: readonly MemberKind[] = ['sales', 'worker'];

/** Mirrors `banto_admin_services::authz::ProjectMember`. */
export interface ProjectMember {
	projectId: number;
	userId: number;
	kind: MemberKind;
}

/** `GET /api/authz/me` / Tauri `authz_me`. */
export interface MyAuthz {
	capabilities: Capability[];
	memberships: ProjectMember[];
}

function guard(): void {
	if (!isPipelineAvailable()) throw demoModeError();
}

const tauri = () => getBantoMode() === 'tauri';

/**
 * `signal` cancels the HTTP request; a Tauri command cannot be cancelled and
 * runs to its end (myAuthz.svelte.ts never stacks a second one on it).
 */
export async function getMyAuthz(signal?: AbortSignal): Promise<MyAuthz> {
	guard();
	if (tauri()) return invokeCommand<MyAuthz>('authz_me');
	return httpRequest<MyAuthz>('/api/authz/me', { method: 'GET', signal });
}

export async function listProjectMembers(projectId: number): Promise<ProjectMember[]> {
	guard();
	if (tauri()) return invokeCommand<ProjectMember[]>('project_members_list', { projectId });
	return httpRequest<ProjectMember[]>(`/api/projects/${projectId}/members`, { method: 'GET' });
}

/** Idempotent add; resolves to the project's members after it. */
export async function addProjectMember(
	projectId: number,
	userId: number,
	kind: MemberKind
): Promise<ProjectMember[]> {
	guard();
	if (tauri()) {
		return invokeCommand<ProjectMember[]>('project_members_add', { projectId, userId, kind });
	}
	return httpRequest<ProjectMember[]>(`/api/projects/${projectId}/members/${userId}/${kind}`, {
		method: 'PUT'
	});
}

export async function removeProjectMember(
	projectId: number,
	userId: number,
	kind: MemberKind
): Promise<void> {
	guard();
	if (tauri()) {
		await invokeCommand<void>('project_members_remove', { projectId, userId, kind });
		return;
	}
	await httpRequest<void>(`/api/projects/${projectId}/members/${userId}/${kind}`, {
		method: 'DELETE'
	});
}

const KIND_ORDER: Record<MemberKind, number> = { manager: 0, sales: 1, worker: 2 };

/** The members by kind (責任者・担当営業・作業者), then by the order the names came in. */
export function sortMembers(
	members: readonly ProjectMember[],
	nameOrder: ReadonlyMap<number, number>
): ProjectMember[] {
	const rank = (id: number) => nameOrder.get(id) ?? Number.MAX_SAFE_INTEGER;
	return [...members].sort(
		(a, b) =>
			KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
			rank(a.userId) - rank(b.userId) ||
			a.userId - b.userId
	);
}

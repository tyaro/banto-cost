/**
 * What the signed-in person may do on one project's page (review D-4,
 * §8-15): `GET /api/projects/{id}/actions` / Tauri `project_actions`
 * (`admin_template_core::ops::projects::project_actions`). The server makes
 * the same decisions as the writes themselves (`authorize`, without
 * auditing the probe), so the page and the server cannot drift apart.
 *
 * DISPLAY ONLY: the project page hides (or disables) the buttons of the
 * actions that are `false`. Every write still asks the server, which decides
 * and audits it. Unknown - demo mode, a failed or not-yet-finished read - is
 * `null`, and then only the role floor (`canWrite`) hides anything, as before.
 *
 * Same transport split as projectMembersAdmin.ts.
 */
import { getBantoMode } from './setup';
import { demoModeError, httpRequest, invokeCommand, isPipelineAvailable } from './pipelineAdmin';

/** Mirrors `admin_template_core::ops::projects::ProjectActions`. */
export interface ProjectActions {
	editProject: boolean;
	editMembers: boolean;
	editOrder: boolean;
	decideOrderChange: boolean;
	recognizeRevenue: boolean;
	editPipeline: boolean;
	manageProject: boolean;
	approveBudget: boolean;
	adoptForecast: boolean;
	settle: boolean;
	enterCost: boolean;
	editPurchaseOrder: boolean;
	/** The calc-basis items the person may override on this project. */
	overrideCalcItems: string[];
}

/** The boolean actions (everything but the item list). */
export type ProjectActionKey = Exclude<keyof ProjectActions, 'overrideCalcItems'>;

export async function getProjectActions(projectId: number): Promise<ProjectActions> {
	if (!isPipelineAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') {
		return invokeCommand<ProjectActions>('project_actions', { id: projectId });
	}
	return httpRequest<ProjectActions>(`/api/projects/${projectId}/actions`, { method: 'GET' });
}

/**
 * May the person do `key`? The role floor first (`canWrite`: `editor` or
 * above), then the server's answer; unknown (`null`) leaves it to the floor.
 */
export function allows(
	actions: ProjectActions | null,
	canWrite: boolean,
	key: ProjectActionKey
): boolean {
	return canWrite && (actions === null || actions[key]);
}

/**
 * The calc-basis items the person may override, or `null` when unknown (the
 * section then offers every overridable item, as before).
 */
export function overridableItems(
	actions: ProjectActions | null,
	canWrite: boolean
): ReadonlySet<string> | null {
	if (!canWrite) return new Set();
	return actions ? new Set(actions.overrideCalcItems) : null;
}

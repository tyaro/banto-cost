/**
 * Module-level registry for the running Banto app: data/auth providers,
 * notifier, and resource definitions (spec §3.1, §3.4). A single admin app
 * runs one instance of this registry, so a module singleton is sufficient;
 * `initBanto` may be called again (e.g. between tests) to fully replace it.
 */
import type { AuthProvider, DataProvider, NotificationKind, Notifier } from './provider';
import { bindDefaultSessionProvider } from './sessionController.svelte';

export interface ResourceDefinition {
	name: string;
	label: string;
	icon?: string;
	/**
	 * Schema-driven form definition (spec §7). Typed as `unknown` so
	 * admin-core has no dependency on @banto/forms; apps pass a `FormSchema`
	 * from @banto/forms here and cast when reading it back (see
	 * apps/admin-template's resource setup).
	 */
	schema?: unknown;
	capabilities?: { list?: boolean; create?: boolean; edit?: boolean; delete?: boolean };
}

export interface InitBantoConfig {
	dataProvider: DataProvider;
	authProvider: AuthProvider;
	notifier?: Notifier;
	resources: ResourceDefinition[];
}

let dataProvider: DataProvider | null = $state(null);
let authProvider: AuthProvider | null = $state(null);
let notifier: Notifier | null = $state(null);
let resources: ResourceDefinition[] = $state([]);

const NOT_INITIALIZED_MESSAGE =
	'initBanto() has not been called yet — call it once at app startup before using admin-core composables.';

/**
 * Register providers/resources for the app. Safe to call again (e.g. in
 * tests) to replace them.
 *
 * Issue #260: also binds the default `SessionController`
 * (`getSessionController()`) to `authProvider`. Since v2.0.0 the provider
 * must implement `resolve`/`credentialRevision`/`onCredentialChanged`
 * (a `TypeError` otherwise, before anything is replaced). A pre-v2 provider
 * can be passed through `adaptLegacyAuthProvider` - see that adapter's doc
 * for what it cannot guarantee (no cross-tab switch detection, no
 * compare-and-set). Calling this again with a DIFFERENT `authProvider`
 * puts the session on hold (unknown) and confirms it with the new one.
 */
export function initBanto(config: InitBantoConfig): void {
	bindDefaultSessionProvider(config.authProvider);
	dataProvider = config.dataProvider;
	authProvider = config.authProvider;
	notifier = config.notifier ?? null;
	resources = config.resources;
}

export function getDataProvider(): DataProvider {
	if (!dataProvider) throw new Error(NOT_INITIALIZED_MESSAGE);
	return dataProvider;
}

export function getAuthProvider(): AuthProvider {
	if (!authProvider) throw new Error(NOT_INITIALIZED_MESSAGE);
	return authProvider;
}

export function getResource(name: string): ResourceDefinition {
	const found = resources.find((entry) => entry.name === name);
	if (!found) {
		throw new Error(`Unknown resource "${name}". Did you register it in initBanto({ resources })?`);
	}
	return found;
}

export function listResources(): ResourceDefinition[] {
	return resources;
}

/** No-op when no notifier was registered. */
export function notify(kind: NotificationKind, message: string): void {
	notifier?.notify(kind, message);
}

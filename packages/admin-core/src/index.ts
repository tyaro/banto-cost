/**
 * Public entry point for @banto/admin-core (spec §3).
 * M2 Phase A scope: resource registry, DataProvider/AuthProvider contracts,
 * list/form composables, invalidate bus, InMemoryDataProvider.
 * M2 Phase B adds createTauriDataProvider/createTauriAuthProvider, backed
 * by the Rust service layer (spec §10).
 */
export type {
	SortDirection,
	SortState,
	FilterOp,
	FilterState,
	Pagination,
	ListParams,
	ListResult
} from './types';

export type {
	DataProvider,
	AuthProvider,
	AuthOperationResult,
	CredentialRevision,
	Identity,
	LegacyAuthProvider,
	NotificationKind,
	Notifier,
	ResolvedAuth,
	SessionKind,
	StandardAuthProvider
} from './provider';

export type { FieldError, ErrorBody } from './errors';
export {
	ProviderError,
	isProviderError,
	notFound,
	validation,
	StaleAnswerError,
	isStaleAnswerError
} from './errors';

export type { ResourceDefinition, InitBantoConfig } from './registry.svelte';
export {
	initBanto,
	getDataProvider,
	getAuthProvider,
	getResource,
	listResources,
	notify
} from './registry.svelte';

export { onInvalidate, invalidate, invalidateAll } from './invalidate';
export type { InvalidateReason } from './invalidate';

export {
	createSessionController,
	getSessionController,
	resolveSettled,
	grantFallback,
	DEFAULT_GRANT_RETRIES,
	SessionTimeoutError,
	SessionProviderMissingError,
	SessionChangedError,
	type GrantFallbackOptions,
	type GrantStatus,
	type SessionController,
	type SessionControllerDeps,
	type SessionResolveOptions,
	type SessionSnapshot,
	type SessionTicket,
	type ResolveResult
} from './sessionController.svelte';
export { onSessionEnded } from './sessionEnded';

export { ListResource, createListResource, type CreateListResourceOptions } from './list.svelte';
export {
	WindowedListResource,
	createWindowedListResource,
	DEFAULT_WINDOWED_REQUEST_TIMEOUT_MS,
	type CreateWindowedListResourceOptions,
	type WindowedParams
} from './windowed.svelte';
export {
	ListBlockError,
	isListBlockError,
	defaultListBlockMessages,
	type ListBlockErrorFailure,
	type ListBlockFailureCode,
	type ListBlockMessages,
	type ListBlockNotify
} from './blockFetch';
export {
	SnapshotListResource,
	createSnapshotListResource,
	defaultSnapshotListMessages,
	type CreateSnapshotListResourceOptions,
	type SnapshotListFailure,
	type SnapshotListExpiredFailure,
	type SnapshotListMessages,
	type SnapshotListFetcher,
	type SnapshotListRequest,
	type SnapshotListResult
} from './snapshot.svelte';
export { FormResource, createFormResource, type SubmitResult } from './form.svelte';
// Stale async results and temporary resources (spec §3; shared-primitives-upstream-plan
// §3.1・D1, conventions §8). The contract table is tests/contracts/request-owner.json.
export {
	createRequestOwner,
	DEFAULT_REQUEST_KEY,
	type RequestOwner,
	type RequestHandle
} from './request.svelte';

// UI setting current vs saved snapshot on top of UiSettingsProvider (spec §12.1;
// shared-primitives-upstream-plan §3.4, Issue #437).
export {
	createSavedSetting,
	type SavedSetting,
	type SavedSettingOptions,
	type SavedSettingMode,
	type SavedSettingLoad
} from './savedSetting.svelte';

export {
	createInMemoryDataProvider,
	type InMemorySeed,
	type InMemoryDataProviderOptions
} from './providers/inMemory';

export {
	createTauriDataProvider,
	createTauriAuthProvider,
	type TauriInvokeOptions,
	type TauriAuthProviderOptions
} from './providers/tauri';

export { adaptLegacyAuthProvider, ADAPTER_REVISION } from './providers/legacyAdapter';

export {
	createHttpDataProvider,
	createHttpAuthProvider,
	type HttpDataProviderOptions,
	type HttpAuthProviderOptions
} from './providers/http';

export {
	createLocalUiSettings,
	createTauriUiSettings,
	createHttpUiSettings,
	type UiSettingsProvider,
	type LocalUiSettingsOptions,
	type TauriUiSettingsOptions,
	type HttpUiSettingsOptions
} from './providers/uiSettings';

export type {
	AppEvent,
	EventProvider,
	EventSubscriptionHooks,
	TauriEventListenOptions,
	SseEventProviderOptions
} from './events';
export { createTauriEventProvider, createSseEventProvider, connectEvents } from './events';

export type { SseParser } from './sse-parser';
export { createSseParser } from './sse-parser';

export type { PaletteCommand } from './commands';
export { searchCommands } from './commands';

export type { ListViewSnapshot, LastEditedRecord } from './listViewState';
export {
	saveListViewState,
	loadListViewState,
	clearListViewState,
	clearAllListViewState,
	saveActiveListMode,
	loadActiveListMode,
	saveLastOpenedId,
	loadLastOpenedId,
	noteLastEditedRecord,
	takeLastEditedRecord
} from './listViewState';

export type { SessionScope } from './sessionScope.svelte';
export {
	currentSessionScope,
	isCurrentSessionScope,
	isSessionEstablished,
	sessionGeneration,
	sessionOwnerKey
} from './sessionScope.svelte';

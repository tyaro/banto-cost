<script lang="ts">
	/**
	 * `@banto/ui` catalog page (Issue #220, ADR-0018 §6): the main states of
	 * the shared components on one screen, for review and as the visual
	 * regression target of the package (e2e/visual DIAGONAL_PAGES). Deliberately
	 * light - not a catalog framework.
	 *
	 * The sidebar / command-palette entry exists only in the demo build
	 * (`demoOnly` in navigation.ts); the route itself is reachable by URL in
	 * every build. All page chrome is Paraglide (`raw-jp-in-app`). Samples are
	 * static and deterministic (the only state is a click counter), so the
	 * screenshot never depends on timing; the skeleton pulse is stopped by
	 * `prefers-reduced-motion` (the visual project forces it).
	 *
	 * The Menu card (phase 2a), the CommandPalette card (phase 2b), the
	 * Toast card (phase 2c) and the Modal / Drawer card (phase 4) are closed /
	 * empty on load, so the screenshot shows only their triggers; opening,
	 * keyboard and focus behaviour are covered by the package's jsdom tests
	 * (and the open Modal / Drawer by the axe scan in e2e/visual/a11y.spec.ts),
	 * not by the visual suite. The Toast card pushes
	 * into the app's own store (shown by the root layout's ToastHost).
	 *
	 * Not in the API on purpose (ADR-0018 §2): `IconButton` has no `disabled`
	 * prop in phase 1, so no disabled sample.
	 */
	import {
		CommandPalette,
		Drawer,
		EmptyState,
		ErrorState,
		IconButton,
		LoadingState,
		Menu,
		MenuGroup,
		MenuItem,
		MenuSeparator,
		Modal,
		PageHeader,
		StatusBadge,
		SurfaceCard,
		type CommandPaletteItem,
		type StatusBadgeVariant
	} from '@banto/ui';
	import {
		ChevronDown,
		Copy,
		FilePlus,
		Pencil,
		Plus,
		RefreshCw,
		Save,
		SearchX,
		ServerCrash,
		Star,
		Trash2,
		X
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { toastStore } from '#lib/toast.svelte.js';

	const variants: StatusBadgeVariant[] = ['neutral', 'success', 'warning', 'danger', 'info'];

	function variantLabel(variant: StatusBadgeVariant): string {
		switch (variant) {
			case 'neutral':
				return m['uiDemo.badge.neutral']();
			case 'success':
				return m['uiDemo.badge.success']();
			case 'warning':
				return m['uiDemo.badge.warning']();
			case 'danger':
				return m['uiDemo.badge.danger']();
			case 'info':
				return m['uiDemo.badge.info']();
		}
	}

	let clicks = $state(0);
	let undone = $state(0);

	// Modal / Drawer card (phase 4): a modal, and a drawer whose note field
	// makes it dirty (Esc / backdrop blocked, × discards) and which can stack
	// a confirm modal on top - the Esc layering in one place.
	let modalOpen = $state(false);
	let drawerOpen = $state(false);
	let nestedOpen = $state(false);
	let drawerNote = $state('');
	let overlayClosed = $state(0);
	const overlayMessages = { overlayClose: () => m['common.close']() };

	function closeDrawer(): void {
		drawerOpen = false;
		nestedOpen = false;
		drawerNote = '';
		overlayClosed += 1;
	}
	let selected = $state<string | undefined>(undefined);

	// Static sample commands: two groups, an icon, a shortcut hint and a
	// disabled row. The palette's own text reuses the app's palette messages;
	// only the dialog label differs from the global (Ctrl+K) palette.
	let paletteOpen = $state(false);
	let executed = $state<string | undefined>(undefined);
	const paletteItems = $derived<CommandPaletteItem[]>([
		{
			id: 'create',
			title: m['uiDemo.palette.create'](),
			group: m['uiDemo.palette.groupFile'](),
			icon: FilePlus
		},
		{
			id: 'save',
			title: m['uiDemo.palette.save'](),
			group: m['uiDemo.palette.groupFile'](),
			icon: Save,
			shortcut: 'Ctrl+S'
		},
		{
			id: 'unavailable',
			title: m['uiDemo.palette.unavailable'](),
			group: m['uiDemo.palette.groupFile'](),
			disabled: true
		},
		{
			id: 'refresh',
			title: m['uiDemo.palette.refresh'](),
			group: m['uiDemo.palette.groupView'](),
			icon: RefreshCw
		}
	]);
</script>

<div class="page">
	<PageHeader hideTitle title={m['nav.uiDemo']()} description={m['uiDemo.intro']()}>
		{#snippet actions()}
			<button type="button" class="banto-btn banto-btn--secondary">{m['common.cancel']()}</button>
			<button type="button" class="banto-btn banto-btn--primary">{m['common.save']()}</button>
		{/snippet}
	</PageHeader>

	<SurfaceCard title="PageHeader" description={m['uiDemo.header.desc']()}>
		<!-- Extra headers on the same page: the real one above already owns
		     `view-transition-name: page-header`, and a duplicate name voids the
		     page transition - so the samples opt out of it. -->
		<div class="stack samples-header">
			<div class="sample">
				<span class="caption">{m['uiDemo.header.titleOnly']()}</span>
				<PageHeader title={m['uiDemo.header.sampleTitle']()} />
			</div>
			<div class="sample">
				<span class="caption">{m['uiDemo.header.withDescription']()}</span>
				<PageHeader
					title={m['uiDemo.header.sampleTitle']()}
					description={m['uiDemo.header.sampleDescription']()}
				/>
			</div>
			<div class="sample">
				<span class="caption">{m['uiDemo.header.withActions']()}</span>
				<PageHeader
					title={m['uiDemo.header.sampleTitle']()}
					description={m['uiDemo.header.sampleDescription']()}
				>
					{#snippet actions()}
						<button type="button" class="banto-btn banto-btn--secondary">
							{m['common.cancel']()}
						</button>
						<button type="button" class="banto-btn banto-btn--primary">{m['common.save']()}</button>
					{/snippet}
				</PageHeader>
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard title="SurfaceCard" description={m['uiDemo.card.desc']()}>
		<div class="grid">
			<div class="sample">
				<span class="caption">{m['uiDemo.card.titleOnly']()}</span>
				<SurfaceCard title={m['uiDemo.card.sampleTitle']()}>
					<p class="body-text">{m['uiDemo.card.sampleBody']()}</p>
				</SurfaceCard>
			</div>
			<div class="sample">
				<span class="caption">{m['uiDemo.card.withDescription']()}</span>
				<SurfaceCard
					title={m['uiDemo.card.sampleTitle']()}
					description={m['uiDemo.card.sampleDescription']()}
				>
					<p class="body-text">{m['uiDemo.card.sampleBody']()}</p>
				</SurfaceCard>
			</div>
			<div class="sample">
				<span class="caption">{m['uiDemo.card.bodyOnly']()}</span>
				<SurfaceCard>
					<p class="body-text">{m['uiDemo.card.sampleBody']()}</p>
				</SurfaceCard>
			</div>
			<div class="sample">
				<span class="caption">{m['uiDemo.card.withFooter']()}</span>
				<SurfaceCard title={m['uiDemo.card.sampleTitle']()}>
					<p class="body-text">{m['uiDemo.card.sampleBody']()}</p>
					{#snippet footer()}
						<button type="button" class="banto-btn banto-btn--ghost">{m['common.cancel']()}</button>
						<button type="button" class="banto-btn banto-btn--primary">{m['common.save']()}</button>
					{/snippet}
				</SurfaceCard>
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard title="StatusBadge" description={m['uiDemo.badge.desc']()}>
		<div class="row">
			{#each variants as variant (variant)}
				<StatusBadge {variant} label={variantLabel(variant)} />
			{/each}
		</div>
		<div class="row row--spaced">
			<span class="caption">{m['uiDemo.customIcon']()}</span>
			<StatusBadge variant="info" label={m['uiDemo.badge.customIconLabel']()} icon={Star} />
		</div>
	</SurfaceCard>

	<SurfaceCard title="IconButton" description={m['uiDemo.iconButton.desc']()}>
		<div class="row">
			<span class="caption">md</span>
			<IconButton label={m['common.close']()} icon={X} onclick={() => (clicks += 1)} />
			<span class="caption">sm</span>
			<IconButton label={m['common.close']()} icon={X} size="sm" onclick={() => (clicks += 1)} />
			<span class="caption">{m['uiDemo.customIcon']()}</span>
			<IconButton label={m['uiDemo.iconButton.add']()} icon={Plus} onclick={() => (clicks += 1)} />
			<span class="caption" data-testid="ui-demo-clicks">
				{m['uiDemo.iconButton.clicks']()}: {clicks}
			</span>
		</div>
	</SurfaceCard>

	<SurfaceCard title="Menu" description={m['uiDemo.menu.desc']()}>
		<div class="row">
			<Menu label={m['uiDemo.menu.label']()} placement="bottom-start">
				{#snippet trigger(props)}
					<button {...props} type="button" class="banto-btn banto-btn--secondary">
						{m['uiDemo.menu.trigger']()}
						<ChevronDown size={14} aria-hidden="true" />
					</button>
				{/snippet}
				<MenuGroup label={m['uiDemo.menu.group']()}>
					<MenuItem
						icon={Pencil}
						label={m['uiDemo.menu.edit']()}
						onSelect={() => (selected = m['uiDemo.menu.edit']())}
					/>
					<MenuItem
						icon={Copy}
						label={m['uiDemo.menu.duplicate']()}
						onSelect={() => (selected = m['uiDemo.menu.duplicate']())}
					/>
					<MenuItem label={m['uiDemo.menu.unavailable']()} disabled onSelect={() => {}} />
				</MenuGroup>
				<MenuSeparator />
				<MenuItem
					icon={Trash2}
					label={m['uiDemo.menu.delete']()}
					danger
					onSelect={() => (selected = m['uiDemo.menu.delete']())}
				/>
			</Menu>
			<span class="caption" data-testid="ui-demo-menu-selected">
				{m['uiDemo.menu.selected']()}: {selected ?? m['uiDemo.menu.none']()}
			</span>
		</div>
	</SurfaceCard>

	<SurfaceCard title="CommandPalette" description={m['uiDemo.palette.desc']()}>
		<div class="row">
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={() => (paletteOpen = true)}
			>
				{m['uiDemo.palette.open']()}
			</button>
			<span class="caption" data-testid="ui-demo-palette-executed">
				{m['uiDemo.palette.executed']()}: {executed ?? m['uiDemo.menu.none']()}
			</span>
		</div>
	</SurfaceCard>

	<SurfaceCard title="Modal / Drawer" description={m['uiDemo.overlay.desc']()}>
		<div class="row">
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				data-testid="ui-demo-open-modal"
				onclick={() => (modalOpen = true)}
			>
				{m['uiDemo.overlay.openModal']()}
			</button>
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				data-testid="ui-demo-open-drawer"
				onclick={() => (drawerOpen = true)}
			>
				{m['uiDemo.overlay.openDrawer']()}
			</button>
			<span class="caption" data-testid="ui-demo-overlay-closed">
				{m['uiDemo.overlay.closedCount']()}: {overlayClosed}
			</span>
		</div>
	</SurfaceCard>

	<SurfaceCard title="ToastHost" description={m['uiDemo.toast.desc']()}>
		<div class="row">
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={() => toastStore.push('success', m['uiDemo.toast.messageSuccess']())}
			>
				{m['uiDemo.toast.success']()}
			</button>
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={() => toastStore.push('error', m['uiDemo.toast.messageError']())}
			>
				{m['uiDemo.toast.error']()}
			</button>
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={() => toastStore.push('info', m['uiDemo.toast.messageInfo']())}
			>
				{m['uiDemo.toast.info']()}
			</button>
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={() => toastStore.push('warning', m['uiDemo.toast.messageWarning']())}
			>
				{m['uiDemo.toast.warning']()}
			</button>
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				onclick={() =>
					toastStore.push('info', m['uiDemo.toast.messageAction'](), {
						action: { label: m['uiDemo.toast.undo'](), onAction: () => (undone += 1) },
						durationMs: 8000
					})}
			>
				{m['uiDemo.toast.withAction']()}
			</button>
			<span class="caption" data-testid="ui-demo-toast-undone">
				{m['uiDemo.toast.undone']()}: {undone}
			</span>
		</div>
	</SurfaceCard>

	<SurfaceCard title="EmptyState" description={m['uiDemo.empty.desc']()}>
		<div class="grid">
			<div class="sample sample--frame">
				<span class="caption">{m['uiDemo.default']()}</span>
				<EmptyState
					title={m['uiDemo.empty.title']()}
					description={m['uiDemo.empty.description']()}
				/>
			</div>
			<div class="sample sample--frame">
				<span class="caption">{m['uiDemo.customIcon']()} + action</span>
				<EmptyState
					icon={SearchX}
					title={m['uiDemo.empty.customTitle']()}
					description={m['uiDemo.empty.description']()}
				>
					{#snippet action()}
						<button type="button" class="banto-btn banto-btn--secondary">
							{m['common.reload']()}
						</button>
					{/snippet}
				</EmptyState>
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard title="ErrorState" description={m['uiDemo.error.desc']()}>
		<div class="grid">
			<div class="sample sample--frame">
				<span class="caption">{m['uiDemo.default']()}</span>
				<ErrorState
					title={m['uiDemo.error.title']()}
					description={m['uiDemo.error.description']()}
				/>
			</div>
			<div class="sample sample--frame">
				<span class="caption">{m['uiDemo.customIcon']()} + action</span>
				<ErrorState
					icon={ServerCrash}
					title={m['uiDemo.error.customTitle']()}
					description={m['uiDemo.error.description']()}
				>
					{#snippet action()}
						<button type="button" class="banto-btn banto-btn--secondary">
							<RefreshCw size={14} aria-hidden="true" />
							{m['common.reload']()}
						</button>
					{/snippet}
				</ErrorState>
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard title="LoadingState" description={m['uiDemo.loading.desc']()}>
		<div class="grid">
			<div class="sample sample--frame">
				<span class="caption">label = common.loading</span>
				<LoadingState label={m['common.loading']()} />
			</div>
			<div class="sample sample--frame">
				<span class="caption">{m['uiDemo.loading.customLabel']()}</span>
				<LoadingState label={m['uiDemo.loading.customLabelText']()} />
			</div>
			<div class="sample sample--frame">
				<span class="caption">lines = 1</span>
				<LoadingState label={m['common.loading']()} lines={1} />
			</div>
			<div class="sample sample--frame">
				<span class="caption">lines = 5</span>
				<LoadingState label={m['common.loading']()} lines={5} />
			</div>
		</div>
	</SurfaceCard>
</div>

<!-- Outside the cards: under the glass preset SurfaceCard has a
     backdrop-filter, which would make it the containing block of the
     palette's (and the Modal / Drawer's) fixed overlay. -->
<Modal
	open={modalOpen}
	title={m['uiDemo.overlay.modalTitle']()}
	messages={overlayMessages}
	onclose={() => {
		modalOpen = false;
		overlayClosed += 1;
	}}
>
	<p class="body-text">{m['uiDemo.overlay.modalBody']()}</p>
</Modal>

<Drawer
	open={drawerOpen}
	title={m['uiDemo.overlay.drawerTitle']()}
	messages={overlayMessages}
	dirty={drawerNote !== ''}
	onBlockedClose={() => toastStore.push('info', m['uiDemo.overlay.blocked']())}
	onclose={closeDrawer}
>
	<div class="stack">
		<p class="body-text">{m['uiDemo.overlay.drawerBody']()}</p>
		<label class="field">
			<span class="caption">{m['uiDemo.overlay.drawerField']()}</span>
			<input class="banto-input" data-testid="ui-demo-drawer-note" bind:value={drawerNote} />
		</label>
		<div class="row">
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				data-testid="ui-demo-open-nested"
				onclick={() => (nestedOpen = true)}
			>
				{m['uiDemo.overlay.openNested']()}
			</button>
		</div>
	</div>
	<!-- Rendered inside the drawer's body on purpose: a nested layer with its
	     own z-index is "above" its parent (@banto/ui layering.ts). -->
	<Modal
		open={nestedOpen}
		title={m['uiDemo.overlay.nestedTitle']()}
		messages={overlayMessages}
		onclose={() => (nestedOpen = false)}
	>
		<p class="body-text">{m['uiDemo.overlay.nestedBody']()}</p>
	</Modal>
</Drawer>

<CommandPalette
	bind:open={paletteOpen}
	items={paletteItems}
	onExecute={(item) => {
		executed = item.title;
	}}
	messages={{
		commandPaletteLabel: () => m['uiDemo.palette.label'](),
		commandPalettePlaceholder: () => m['commandPalette.placeholder'](),
		commandPaletteListLabel: () => m['commandPalette.listLabel'](),
		commandPaletteEmpty: () => m['commandPalette.empty']()
	}}
/>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
		gap: 1rem;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
	}

	.row--spaced {
		margin-top: 0.75rem;
	}

	.sample {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		min-width: 0;
	}

	.sample--frame {
		padding: 0.75rem;
		border: 1px dashed var(--banto-border);
		border-radius: var(--banto-radius-md);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.caption {
		color: var(--banto-text-muted);
		font-size: 0.75rem;
	}

	.body-text {
		margin: 0;
		font-size: 0.85rem;
	}

	/* Samples must not claim the page-level view-transition name (see the
	   comment above the PageHeader samples). */
	.samples-header :global(.page-header) {
		view-transition-name: none;
	}
</style>

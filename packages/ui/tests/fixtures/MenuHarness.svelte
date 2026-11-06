<script lang="ts">
	// Test harness: a trigger button + Menu with a group, a plain item, a
	// disabled item, a separator and a danger item. Callbacks are passed in
	// so the test can assert which item was activated.
	import { Menu, MenuGroup, MenuItem, MenuSeparator } from '../../src/index';
	import CustomIcon from './CustomIcon.svelte';

	let {
		onProfile,
		onDisabled,
		onLogout,
		placement
	}: {
		onProfile: () => void;
		onDisabled: () => void;
		onLogout: () => void;
		placement?: 'bottom-start' | 'bottom-end';
	} = $props();
</script>

<Menu label="User menu" {placement}>
	{#snippet trigger(props)}
		<button {...props} type="button">Open</button>
	{/snippet}
	<MenuGroup label="Account">
		<MenuItem label="Profile" icon={CustomIcon} onSelect={onProfile} />
		<MenuItem label="Billing" disabled onSelect={onDisabled} />
	</MenuGroup>
	<MenuSeparator />
	<MenuItem label="Log out" danger onSelect={onLogout} />
</Menu>

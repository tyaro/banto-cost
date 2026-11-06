import { mount } from 'svelte';
import Harness from './Harness.svelte';
import './settings';

mount(Harness, {
	target: document.getElementById('app')!,
	props: { settings: window.gridErrorFixture }
});

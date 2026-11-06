<script lang="ts">
	/**
	 * アカウントカテゴリのルート（settings-routes step 2）: section の markup/
	 * state/CSS は AccountSection.svelte（段階 1 のまま co-located、移動なし）。
	 */
	import * as m from '#lib/paraglide/messages.js';
	import AccountSection from '../AccountSection.svelte';
</script>

<section id="account" class="settings-section" aria-labelledby="account-heading">
	<h2 id="account-heading" class="section-heading">{m['settings.sectionAccount']()}</h2>
	<AccountSection />
</section>

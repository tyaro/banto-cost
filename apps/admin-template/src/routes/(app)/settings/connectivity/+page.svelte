<script lang="ts">
	/**
	 * サーバ・接続カテゴリのルート（settings-routes step 2）: section の
	 * markup/state/CSS は ConnectivitySection.svelte（段階 1 のまま
	 * co-located、移動なし）。
	 */
	import * as m from '#lib/paraglide/messages.js';
	import ConnectivitySection from '../ConnectivitySection.svelte';
</script>

<section id="connectivity" class="settings-section" aria-labelledby="connectivity-heading">
	<h2 id="connectivity-heading" class="section-heading">{m['settings.sectionConnectivity']()}</h2>
	<ConnectivitySection />
</section>

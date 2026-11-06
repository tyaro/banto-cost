<script lang="ts">
	/**
	 * データ管理カテゴリのルート（settings-routes step 2）: section の
	 * markup/state/CSS は DataSection.svelte（段階 1 のまま co-located、
	 * 移動なし）。
	 */
	import * as m from '#lib/paraglide/messages.js';
	import DataSection from '../DataSection.svelte';
</script>

<section id="data" class="settings-section" aria-labelledby="data-heading">
	<h2 id="data-heading" class="section-heading">{m['settings.sectionData']()}</h2>
	<DataSection />
</section>

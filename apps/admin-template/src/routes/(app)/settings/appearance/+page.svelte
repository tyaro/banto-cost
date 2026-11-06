<script lang="ts">
	/**
	 * 外観・言語カテゴリのルート（settings-routes step 2）: section の markup/
	 * state/CSS は AppearanceSection.svelte（段階 1 のまま co-located、
	 * 移動なし）。
	 */
	import * as m from '#lib/paraglide/messages.js';
	import AppearanceSection from '../AppearanceSection.svelte';
</script>

<section id="appearance" class="settings-section" aria-labelledby="appearance-heading">
	<h2 id="appearance-heading" class="section-heading">{m['settings.sectionAppearance']()}</h2>
	<AppearanceSection />
</section>

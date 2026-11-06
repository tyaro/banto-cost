<script lang="ts">
	/**
	 * セキュリティカテゴリのルート（settings-routes step 2）: section の
	 * markup/state/CSS は SecuritySection.svelte（段階 1 のまま co-located、
	 * 移動なし）。
	 */
	import * as m from '#lib/paraglide/messages.js';
	import SecuritySection from '../SecuritySection.svelte';
</script>

<section id="security" class="settings-section" aria-labelledby="security-heading">
	<h2 id="security-heading" class="section-heading">{m['settings.sectionSecurity']()}</h2>
	<SecuritySection />
</section>

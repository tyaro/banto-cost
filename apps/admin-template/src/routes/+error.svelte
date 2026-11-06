<script lang="ts">
	/**
	 * App-wide error page. Also where the (app) route guard lands when the
	 * server could not VERIFY the session (Issue #204, `(app)/+layout.ts`): the
	 * stored token is kept, so "retry" simply re-runs the guard - the session
	 * resumes as soon as the server can answer again.
	 *
	 * Issue #260 実装-3 (design §6.1, S-81, I-24): "retry" re-runs the loads
	 * IN this document (`refreshAll()`), keeping the SessionController - and
	 * with it a change of user confirmed while this page was shown
	 * (`pendingOwnerChange`), which the protected layout reports when it
	 * mounts again. A full reload (`location.reload()`, as before) would
	 * recreate the controller and lose that record; it is still what the
	 * browser's own reload does, and that case is not guaranteed.
	 */
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { SurfaceCard } from '@banto/ui';

	// Never disabled while a retry runs: a retry that hangs must not take the
	// way out with it (pressing again starts a new one; the browser reload
	// stays available too).
	function retry(): void {
		void refreshAll();
	}
</script>

<div class="error-page" role="alert">
	<SurfaceCard title={m['app.error.title']()} description={`${page.status}`}>
		<p class="message">{page.error?.message ?? ''}</p>
		<div class="actions">
			<button type="button" class="banto-btn banto-btn--primary" onclick={retry}>
				{m['app.error.retry']()}
			</button>
			<a class="banto-btn banto-btn--ghost" href={resolve('/')}>{m['app.error.home']()}</a>
		</div>
	</SurfaceCard>
</div>

<style>
	.error-page {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 1.5rem;
	}

	.message {
		margin: 0 0 1rem;
		color: var(--banto-text-muted);
	}

	.actions {
		display: flex;
		gap: 0.5rem;
	}
</style>

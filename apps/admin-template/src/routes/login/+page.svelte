<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { getAuthProvider, isProviderError, notify } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { bantoReady, getBantoMode } from '#lib/banto/setup.js';
	import { applyAuthSettings } from '#lib/banto/authAdmin.js';
	import { SurfaceCard } from '@banto/ui';

	// Undecided until `status()` resolves (or is absent, treated as
	// "already initialized" - see below): render nothing rather than
	// flashing one form then the other.
	let mode: 'loading' | 'setup' | 'login' = $state('loading');

	let username = $state('');
	let password = $state('');
	let displayName = $state('');
	let passwordConfirm = $state('');
	let error: string | null = $state(null);
	let submitting = $state(false);

	// "ログイン状態を保持する" (spec M11 "LAN Remember me"): only meaningful
	// for a LAN browser client (`createHttpAuthProvider` switches its token's
	// storage between sessionStorage/localStorage based on this flag). Inside
	// the Tauri webview a session already lives exactly as long as the window
	// does, and the plain-browser demo provider has no persistence story at
	// all - showing the checkbox there would offer a choice that does
	// nothing, so it's gated on `getBantoMode() === 'server'`. Set once
	// `bantoReady` resolves (below) - `getBantoMode()` reads the real
	// environment only after that probe finishes, same as `mode`.
	let showRemember = $state(false);
	let remember = $state(false);

	// The demo-credentials panel only applies where those credentials
	// actually work (plain-browser demo mode) - on a Tauri/LAN login they
	// would be misleading noise.
	let showDemoNote = $state(false);

	// Setup-skip / no-login start (choiapp-feedback-2026-09 §5): Tauri only,
	// like the rest of M11 - a LAN browser's first run is already a
	// multi-device context where no-login mode is prohibited, and the
	// plain-browser demo has no real backend to configure.
	let showSkipLogin = $state(false);
	let skippingLogin = $state(false);

	// "閲覧のみで続ける" (viewer-public-plan §3.1-6, ADR-0012): LAN browser
	// only (`server` mode, same gate as `showRemember`) - a Tauri window has
	// no LAN-facing viewer-public surface (M11 already covers "no login in
	// this window") and the plain-browser demo has no backend to mint a
	// token from. Set once `status()` resolves below.
	let showContinueAsViewer = $state(false);

	$effect(() => {
		void (async () => {
			await bantoReady; // provider selection (spec §11.1's three-way probe) must finish first
			showRemember = getBantoMode() === 'server';
			showDemoNote = getBantoMode() === 'demo';
			showSkipLogin = getBantoMode() === 'tauri';
			const status = await getAuthProvider().status?.();
			// No `status()` on this provider (an older/custom AuthProvider,
			// spec §3.3's members are optional for backward compatibility):
			// behave as if an account already exists, i.e. the normal login
			// form.
			mode = status && !status.initialized ? 'setup' : 'login';
			showContinueAsViewer = getBantoMode() === 'server' && status?.grants?.publicViewer === true;
		})();
	});

	// The (app) route guard mints the synthetic viewer session itself
	// (`+layout.ts`'s `grantFallback` -> `enterGrant('publicViewer')`) - this just needs to land
	// on a gated route so that guard runs.
	function continueAsViewer(): void {
		goto(resolve(`dashboard`));
	}

	async function submitLogin(event: SubmitEvent) {
		event.preventDefault();
		error = null;
		submitting = true;
		try {
			const params: Record<string, unknown> = { username, password };
			// Only sent when the checkbox is actually shown (LAN browser mode -
			// see `showRemember` above); omitting it elsewhere keeps the wire
			// body identical to the pre-M11 shape.
			if (showRemember && remember) params.remember = true;
			const result = await getAuthProvider().login(params);
			if (result.success) {
				goto(resolve(`dashboard`));
			} else if (result.superseded) {
				// Issue #260 (design §6.1): another login/logout finished first
				// (here or in another tab) and this one stored nothing. The
				// protected guard confirms whatever session is stored now.
				notify('info', m['auth.loginSuperseded']());
				goto(resolve(`dashboard`));
			} else {
				error = result.error ?? m['auth.loginFailed']();
			}
		} finally {
			submitting = false;
		}
	}

	async function submitSetup(event: SubmitEvent) {
		event.preventDefault();
		error = null;

		if (password.length < 8) {
			error = m['auth.passwordTooShort']();
			return;
		}
		if (password !== passwordConfirm) {
			error = m['auth.passwordMismatch']();
			return;
		}

		submitting = true;
		try {
			const setup = getAuthProvider().setup;
			if (!setup) {
				error = m['auth.setupUnsupported']();
				return;
			}
			const result = await setup({ username, password, displayName });
			if (result.success) {
				goto(resolve(`dashboard`));
			} else if (result.superseded) {
				notify('info', m['auth.loginSuperseded']());
				goto(resolve(`dashboard`));
			} else {
				error = result.error ?? m['auth.setupFailed']();
			}
		} finally {
			submitting = false;
		}
	}

	// Choi-app default path (choiapp-feedback-2026-09 §5): enable no-login
	// mode straight from the first-run screen instead of creating an
	// account. `auth_config_apply`'s zero-users bootstrap window authorizes
	// this exact call and synthesizes the session, so the goto lands on a
	// live dashboard with no restart. Role is `admin` - a choi-app's single
	// operator needs everything; it stays changeable later under
	// 設定 → セキュリティ.
	async function skipLogin(): Promise<void> {
		if (!window.confirm(m['settings.authDisableConfirm']())) return;
		error = null;
		skippingLogin = true;
		try {
			await applyAuthSettings(true, 'admin');
			goto(resolve(`dashboard`));
		} catch (err) {
			error = isProviderError(err) ? err.message : m['auth.skipLoginFailed']();
		} finally {
			skippingLogin = false;
		}
	}
</script>

<div class="login-page">
	<div class="login-card">
		<!-- Brand pane (visual-refresh-design.md §9): 3 fixed slots (logo mark,
		     app name, one-line tagline) so a template user rebranding this page
		     only ever touches these three. Purely decorative/duplicate of the
		     real <h1> below - hidden from assistive tech and hidden entirely
		     under 960px. -->
		<aside class="brand-pane" aria-hidden="true">
			<span class="brand-mark">
				<svg viewBox="0 0 24 24" width="22" height="22">
					<rect x="10" y="3" width="4" height="2" rx="1" />
					<circle cx="12" cy="12" r="6" />
					<rect x="10" y="19" width="4" height="2" rx="1" />
				</svg>
			</span>
			<p class="brand-name">Banto Cost</p>
			<p class="tagline">{m['auth.tagline']()}</p>
		</aside>

		<div class="form-pane">
			{#if mode === 'setup'}
				<form onsubmit={submitSetup}>
					<h1>Banto Cost</h1>
					<p class="note">{m['auth.setupNote']()}</p>

					<label class="banto-field banto-field--stacked">
						<input
							class="banto-field-control"
							type="text"
							placeholder=" "
							bind:value={displayName}
							autocomplete="name"
						/>
						<span class="banto-field-label">{m['common.displayName']()}</span>
					</label>

					<label class="banto-field">
						<input
							class="banto-field-control"
							type="text"
							placeholder=" "
							bind:value={username}
							autocomplete="username"
						/>
						<span class="banto-field-label">{m['common.username']()}</span>
					</label>

					<label class="banto-field banto-field--stacked">
						<input
							class="banto-field-control"
							type="password"
							bind:value={password}
							autocomplete="new-password"
						/>
						<span class="banto-field-label">{m['common.passwordMinLabel']()}</span>
					</label>

					<label class="banto-field banto-field--stacked">
						<input
							class="banto-field-control"
							type="password"
							bind:value={passwordConfirm}
							autocomplete="new-password"
						/>
						<span class="banto-field-label">{m['auth.passwordConfirmLabel']()}</span>
					</label>

					{#if error}
						<p class="error" role="alert">{error}</p>
					{/if}

					<!-- Also locked while the skip path runs (Copilot review on PR
					     #182): the two paths mutate the same auth state, so
					     neither may start while the other is in flight - mirrors
					     the skip button's own `submitting || skippingLogin`. -->
					<button
						type="submit"
						class="banto-btn banto-btn--primary"
						disabled={submitting || skippingLogin}
					>
						{m['auth.createAccount']()}
					</button>

					{#if showSkipLogin}
						<div class="skip-login">
							<button
								type="button"
								class="banto-btn banto-btn--secondary"
								onclick={skipLogin}
								disabled={submitting || skippingLogin}
							>
								{m['auth.skipLoginButton']()}
							</button>
							<p class="note">{m['auth.skipLoginNote']()}</p>
						</div>
					{/if}
				</form>
			{:else if mode === 'login'}
				<form onsubmit={submitLogin}>
					<h1>Banto Cost</h1>
					<p class="note">
						{m['auth.loginNote']()}
					</p>

					<label class="banto-field">
						<input
							class="banto-field-control"
							type="text"
							placeholder=" "
							bind:value={username}
							autocomplete="username"
						/>
						<span class="banto-field-label">{m['common.username']()}</span>
					</label>

					<label class="banto-field">
						<input
							class="banto-field-control"
							type="password"
							placeholder=" "
							bind:value={password}
							autocomplete="current-password"
						/>
						<span class="banto-field-label">{m['common.password']()}</span>
					</label>

					{#if showRemember}
						<label class="remember">
							<input type="checkbox" bind:checked={remember} />
							{m['auth.remember']()}
						</label>
					{/if}

					{#if error}
						<p class="error" role="alert">{error}</p>
					{/if}

					<button type="submit" class="banto-btn banto-btn--primary" disabled={submitting}>
						{m['auth.login']()}
					</button>

					{#if showContinueAsViewer}
						<button
							type="button"
							class="banto-btn banto-btn--ghost continue-as-viewer"
							onclick={continueAsViewer}
						>
							{m['auth.continueAsViewer']()}
						</button>
					{/if}
				</form>

				{#if showDemoNote}
					<SurfaceCard title={m['auth.demoTitle']()}>
						<p class="demo-note">
							{m['auth.demoNotePrefix']()}<strong>admin / admin</strong>{m['auth.demoNoteSuffix']()}
						</p>
					</SurfaceCard>
				{/if}
			{/if}
		</div>
	</div>
</div>

<style>
	.login-page {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 1.5rem;
	}

	.login-card {
		width: min(320px, 100%);
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-md);
		overflow: hidden;
		/* Glass preset (spec M12): no-op under standard (--banto-backdrop: none). */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
	}

	.brand-pane {
		display: none;
	}

	.form-pane {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 2rem;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	h1 {
		margin: 0;
		text-align: center;
		font-size: 1.5rem;
		font-feature-settings: 'palt';
		text-wrap: balance;
	}

	.note {
		margin: 0;
		text-align: center;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
		text-wrap: pretty;
	}

	.demo-note {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
		text-wrap: pretty;
	}

	.remember {
		display: flex;
		font-size: var(--banto-font-size-md);
		color: var(--banto-text-muted);
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
		cursor: pointer;
	}

	.remember input {
		padding: 0;
		width: auto;
	}

	.error {
		margin: 0;
		text-align: center;
		color: var(--banto-danger);
		font-size: 0.8rem;
	}

	.skip-login {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 0.25rem;
		padding-top: 1rem;
		border-top: 1px solid var(--banto-border);
	}

	.skip-login .banto-btn--secondary {
		justify-content: center;
	}

	.banto-btn--primary {
		justify-content: center;
		min-height: var(--banto-control-height-lg);
		height: auto;
		padding: var(--banto-space-2) var(--banto-space-3);
	}

	.continue-as-viewer {
		justify-content: center;
	}

	/* Glass preset accent (spec M12): the submit button gets the accent
	   gradient; hover brightens it instead of swapping to the flat hover
	   color (a gradient has no single hover counterpart). Same pattern the
	   pre-refresh login page used with its own `button` selector. */
	:global([data-banto-preset='glass']) .banto-btn--primary {
		background: var(--banto-accent-gradient);
	}

	:global([data-banto-preset='glass']) .banto-btn--primary:hover:not(:disabled) {
		background: var(--banto-accent-gradient);
		filter: brightness(1.08);
	}

	/* Keep room for values and translated labels inside the card at narrow
	   widths and enlarged text; the shared field styles need no overrides. */
	@media (max-width: 960px) {
		.login-page {
			padding: var(--banto-space-3);
		}

		.form-pane {
			padding: var(--banto-space-4);
		}
	}

	@media (min-width: 961px) {
		.login-card {
			width: min(960px, 100%);
			display: grid;
			grid-template-columns: 5fr 4fr;
		}

		.brand-pane {
			display: flex;
			position: relative;
			flex-direction: column;
			justify-content: center;
			gap: 0.6rem;
			padding: 3rem;
			overflow: hidden;
			color: #fff;
			/* Background generated with no image assets (design.md §9): two
			   radial gradients + a conic mesh. The warm accent (rgb 237 106 52,
			   evoking the Banto lantern) and the dark conic base are the one
			   exception to token-only colors, scoped to this decorative pane. */
			background:
				radial-gradient(
					60% 80% at 20% 20%,
					color-mix(in srgb, var(--banto-primary) 28%, transparent),
					transparent
				),
				radial-gradient(50% 60% at 80% 90%, rgb(237 106 52 / 0.18), transparent),
				conic-gradient(from 210deg at 60% 40%, #171c26, #10131a);
		}

		.brand-pane::after {
			content: '';
			position: absolute;
			inset: 0;
			opacity: 0.05;
			mix-blend-mode: overlay;
			pointer-events: none;
			/* Inline SVG feTurbulence noise (design.md §9) - a data URI instead
			   of a shipped image asset. */
			background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
		}

		.brand-mark {
			position: relative;
			z-index: 1;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 44px;
			height: 44px;
			border-radius: var(--banto-radius-lg);
			background: var(--banto-accent-gradient);
		}

		.brand-mark svg {
			fill: #fff;
		}

		.brand-name {
			position: relative;
			z-index: 1;
			margin: 0.5rem 0 0;
			font-size: 1.75rem;
			font-weight: 700;
			font-feature-settings: 'palt';
		}

		.tagline {
			position: relative;
			z-index: 1;
			margin: 0;
			color: rgb(255 255 255 / 0.75);
			font-size: 0.9rem;
			text-wrap: pretty;
		}

		.form-pane {
			justify-content: center;
			/* Reserve input space as text grows inside the two-column card. */
			padding: min(var(--banto-space-8), 12%);
		}
	}
</style>

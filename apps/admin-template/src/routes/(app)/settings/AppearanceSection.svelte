<script lang="ts">
	/**
	 * 外観・言語カテゴリ（choiapp-feedback-2026-09 §3）: テーマ / 言語 /
	 * ナビゲーション（サイドバー / ドック、nav-launcher-plan.md §3）/
	 * キオスク / ウィンドウ効果(vibrancy)。`+page.svelte` の
	 * `<section id="appearance">` ラッパーから描画される（settings-split
	 * refactor: markup/state/CSS の移動のみ、挙動は変えない）。
	 */
	import type { Component } from 'svelte';
	import type { ThemeDensity, ThemePreset } from '@banto/theme';
	import {
		Check,
		Languages,
		MonitorPlay,
		Palette,
		PanelBottom,
		PanelLeft,
		PanelRight,
		PanelTop,
		PanelsTopLeft,
		Rows3,
		Sparkles,
		Rows4
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale, locales, setLocale, type Locale } from '#lib/paraglide/runtime.js';
	import { SurfaceCard } from '@banto/ui';
	import {
		LAUNCHER_OPACITY_MAX,
		LAUNCHER_OPACITY_MIN,
		LAUNCHER_OPACITY_STEP,
		settings,
		type LauncherPosition,
		type NavLayout
	} from '#lib/settings.svelte.js';
	import { applyVibrancy, getVibrancyStatus, type VibrancyStatus } from '#lib/banto/vibrancy.js';
	import { toastStore } from '#lib/toast.svelte.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { isAdmin } from '#lib/permissions.js';
	import { errorMessage, tauri } from './shared';

	// M12 preset axis (standard/glass), orthogonal to light/dark (which is
	// switched from the header's sun/moon button, not on this page).
	const presets: { value: ThemePreset; label: string }[] = [
		{ value: 'standard', label: m['settings.presetStandard']() },
		{ value: 'glass', label: m['settings.presetGlass']() }
	];

	// Density axis (visual-refresh-design.md §4.3), orthogonal to
	// theme/preset. settings.setThemeDensity() persistence is unchanged -
	// this page only adds the picker UI.
	const densities: { value: ThemeDensity; label: string }[] = [
		{ value: 'standard', label: m['settings.densityStandard']() },
		{ value: 'compact', label: m['settings.densityCompact']() }
	];

	// Navigation layout (nav-launcher-plan.md §3, D1: shown as "Dock", the
	// value is 'launcher'). The opacity slider only matters for the dock.
	const navLayouts: { value: NavLayout; label: string; icon: Component }[] = [
		{ value: 'sidebar', label: m['settings.navLayoutSidebar'](), icon: PanelLeft },
		{ value: 'launcher', label: m['settings.navLayoutLauncher'](), icon: PanelBottom }
	];

	// The dock's screen edge (D4); <=900px is always the bottom tab bar (D5).
	const launcherPositions: { value: LauncherPosition; label: string; icon: Component }[] = [
		{ value: 'top', label: m['settings.launcherPositionTop'](), icon: PanelTop },
		{ value: 'bottom', label: m['settings.launcherPositionBottom'](), icon: PanelBottom },
		{ value: 'left', label: m['settings.launcherPositionLeft'](), icon: PanelLeft },
		{ value: 'right', label: m['settings.launcherPositionRight'](), icon: PanelRight }
	];

	const densityIcons: Record<ThemeDensity, Component> = { standard: Rows3, compact: Rows4 };

	// --- i18n layer ② (ADR-0005): the language picker ---------
	// Locale labels are shown in each language's OWN native name (日本語 /
	// English) rather than translated - a picker reads better when each option
	// names itself, so these two keys hold the same value in en.json and ja.json.
	// `getLocale()` is the resolved locale for this page load; changing it goes
	// through Paraglide's `setLocale()`, whose custom-banto strategy (locale.ts)
	// persists to localStorage + the M12 provider and reloads so every screen
	// re-renders in the new locale (the reload is Paraglide's default).
	const localeLabels: Record<Locale, () => string> = {
		ja: m['settings.languageJa'],
		en: m['settings.languageEn']
	};

	function changeLocale(next: Locale): void {
		if (next === getLocale()) return;
		setLocale(next);
	}

	// --- M12: window vibrancy (Tauri only, admin only, Windows only) --------
	// The whole section renders only when `vibrancy_status()` reports
	// `supported: true` (spec §11.3: capability-hide, don't grey out).
	let vibrancyStatus = $state<VibrancyStatus | null>(null);
	let applyingVibrancy = $state(false);

	$effect(() => {
		if (!tauri || !isAdmin(sessionStore.role)) return;
		void (async () => {
			try {
				vibrancyStatus = await getVibrancyStatus();
			} catch {
				// An older backend without the command (Phase A not deployed
				// yet) or any failure: keep the section hidden, never broken.
				vibrancyStatus = null;
			}
		})();
	});

	async function toggleVibrancy(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const next = input.checked;
		applyingVibrancy = true;
		try {
			const enabled = await applyVibrancy(next);
			if (vibrancyStatus) vibrancyStatus = { ...vibrancyStatus, enabled };
		} catch (err) {
			toastStore.push('error', errorMessage(err));
			input.checked = vibrancyStatus?.enabled ?? false;
		} finally {
			applyingVibrancy = false;
		}
	}
</script>

<div class="settings-grid">
	<SurfaceCard>
		<div class="card-head">
			<Palette size={20} aria-hidden="true" />
			<div>
				<h3>{m['settings.themeHeading']()}</h3>
				<p>{m['settings.themeDesc']()}</p>
			</div>
		</div>

		<h4>{m['settings.presetHeading']()}</h4>
		<div
			class="options preset-options"
			role="radiogroup"
			aria-label={m['settings.presetGroupAria']()}
		>
			{#each presets as preset (preset.value)}
				<label class="theme-option" class:selected={settings.themePreset === preset.value}>
					<input
						type="radio"
						name="theme-preset"
						value={preset.value}
						checked={settings.themePreset === preset.value}
						onchange={() => settings.setThemePreset(preset.value)}
					/>
					<span class="preset-preview" data-preset={preset.value} aria-hidden="true"></span>
					{preset.label}
					{#if settings.themePreset === preset.value}
						<Check size={14} aria-hidden="true" />
					{/if}
				</label>
			{/each}
		</div>

		<h4>{m['settings.densityHeading']()}</h4>
		<div
			class="options density-options"
			role="radiogroup"
			aria-label={m['settings.densityHeading']()}
		>
			{#each densities as density (density.value)}
				{@const DensityIcon = densityIcons[density.value]}
				<label class="theme-option" class:selected={settings.themeDensity === density.value}>
					<input
						type="radio"
						name="density"
						value={density.value}
						checked={settings.themeDensity === density.value}
						onchange={() => settings.setThemeDensity(density.value)}
					/>
					<DensityIcon size={16} aria-hidden="true" />{density.label}
					{#if settings.themeDensity === density.value}
						<Check size={14} aria-hidden="true" />
					{/if}
				</label>
			{/each}
		</div>

		<p class="note">
			{m['settings.themeNote']()}
		</p>
	</SurfaceCard>

	<SurfaceCard>
		<div class="card-head">
			<PanelsTopLeft size={20} aria-hidden="true" />
			<div>
				<h3>{m['settings.navLayoutHeading']()}</h3>
				<p>{m['settings.navLayoutDesc']()}</p>
			</div>
		</div>

		<div
			class="options nav-layout-options"
			role="radiogroup"
			aria-label={m['settings.navLayoutGroupAria']()}
		>
			{#each navLayouts as layout (layout.value)}
				{@const LayoutIcon = layout.icon}
				<label class="theme-option" class:selected={settings.navLayout === layout.value}>
					<input
						type="radio"
						name="nav-layout"
						value={layout.value}
						checked={settings.navLayout === layout.value}
						onchange={() => settings.setNavLayout(layout.value)}
					/>
					<span class="nav-layout-preview" data-nav-layout={layout.value} aria-hidden="true">
						<span class="preview-nav"></span>
					</span>
					<LayoutIcon size={14} aria-hidden="true" />{layout.label}
					{#if settings.navLayout === layout.value}
						<Check size={14} aria-hidden="true" />
					{/if}
				</label>
			{/each}
		</div>

		{#if settings.navLayout === 'launcher'}
			<h4>{m['settings.launcherPositionHeading']()}</h4>
			<div
				class="options launcher-position-options"
				role="radiogroup"
				aria-label={m['settings.launcherPositionHeading']()}
			>
				{#each launcherPositions as option (option.value)}
					{@const PositionIcon = option.icon}
					<label class="theme-option" class:selected={settings.launcherPosition === option.value}>
						<input
							type="radio"
							name="launcher-position"
							value={option.value}
							checked={settings.launcherPosition === option.value}
							onchange={() => settings.setLauncherPosition(option.value)}
						/>
						<PositionIcon size={16} aria-hidden="true" />{option.label}
						{#if settings.launcherPosition === option.value}
							<Check size={14} aria-hidden="true" />
						{/if}
					</label>
				{/each}
			</div>

			<div class="launcher-opacity">
				<label class="field">
					<span class="launcher-opacity-label">
						{m['settings.launcherOpacityLabel']()}
						<span class="launcher-opacity-value"
							>{m['settings.launcherOpacityValue']({ value: settings.launcherOpacity })}</span
						>
					</span>
					<input
						type="range"
						min={LAUNCHER_OPACITY_MIN}
						max={LAUNCHER_OPACITY_MAX}
						step={LAUNCHER_OPACITY_STEP}
						value={settings.launcherOpacity}
						oninput={(event) => settings.previewLauncherOpacity(event.currentTarget.valueAsNumber)}
						onchange={(event) => settings.setLauncherOpacity(event.currentTarget.valueAsNumber)}
					/>
				</label>
				<!-- D7 preview: the dock sits at the bottom edge of this page where its
				     see-through is hard to judge, so a sample bar over striped
				     "content" follows the slider. The token is overridden on the
				     preview itself (the root's --banto-shell-launcher-bg is computed
				     at :root and cannot be re-resolved here). -->
				<span
					class="launcher-preview"
					style:--banto-shell-launcher-opacity="{settings.launcherOpacity}%"
					aria-hidden="true"
				>
					<span class="launcher-preview-bar">
						<span></span>
						<span></span>
						<span></span>
					</span>
				</span>
			</div>
			<p class="note launcher-opaque-note">{m['settings.launcherOpaqueNote']()}</p>
		{/if}
	</SurfaceCard>

	<SurfaceCard>
		<div class="card-head">
			<Languages size={20} aria-hidden="true" />
			<div>
				<h3>{m['settings.languageHeading']()}</h3>
				<p>{m['settings.languageDesc']()}</p>
			</div>
		</div>

		<label class="banto-field banto-field--stacked">
			<select
				class="banto-field-control"
				value={getLocale()}
				onchange={(event) => changeLocale(event.currentTarget.value as Locale)}
			>
				{#each locales as loc (loc)}
					<option value={loc}>{localeLabels[loc]()}</option>
				{/each}
			</select>
			<span class="banto-field-label">{m['settings.languageLabel']()}</span>
		</label>

		<p class="note">
			{m['settings.languageNote']()}
		</p>
	</SurfaceCard>

	<SurfaceCard>
		<div class="card-head">
			<MonitorPlay size={20} aria-hidden="true" />
			<div>
				<h3>{m['settings.kioskHeading']()}</h3>
				<p>{m['settings.kioskDesc']()}</p>
			</div>
		</div>
		<label class="banto-switch-field">
			<input
				type="checkbox"
				role="switch"
				class="banto-switch"
				checked={settings.kiosk}
				onchange={(event) => settings.setKiosk(event.currentTarget.checked)}
			/>
			{m['settings.kioskToggle']()}
		</label>
	</SurfaceCard>

	{#if tauri && isAdmin(sessionStore.role) && vibrancyStatus?.supported}
		<SurfaceCard>
			<div class="card-head">
				<Sparkles size={20} aria-hidden="true" />
				<div>
					<h3>{m['settings.vibrancyHeading']()}</h3>
					<p>{m['settings.vibrancyDesc']()}</p>
				</div>
			</div>
			<label class="banto-switch-field">
				<input
					type="checkbox"
					role="switch"
					class="banto-switch"
					checked={vibrancyStatus.enabled}
					disabled={applyingVibrancy}
					onchange={toggleVibrancy}
				/>
				{m['settings.vibrancyToggle']()}
			</label>
			<p class="note">
				{m['settings.vibrancyNote']()}
			</p>
		</SurfaceCard>
	{/if}
</div>

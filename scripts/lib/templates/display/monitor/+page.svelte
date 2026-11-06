<script lang="ts">
	/**
	 * 表示専用アプリのホーム画面（`scripts/scaffold.mjs --preset display` が
	 * `src/routes/(app)/monitor/+page.svelte` として複製する雛形。
	 * docs/design/display-preset-plan.md §3.2）。
	 *
	 * このファイルは **書き換えられる前提の出発点**。`load()` を自分の読み取り
	 * （`getDataProvider().getList(...)` / `fetch()` など）に差し替えて、下の
	 * カードに好きな指標を並べる。ポーリングは `$effect` + 世代トークン
	 * （`generation`）で、多重起動・アンマウント後の遅延レスポンスの取り違えを
	 * 防ぐ（conventions §8 Svelte 5 runes の落とし穴）。
	 *
	 * display プリセットは `package.json` の `banto.i18n` を `"raw"` にする
	 * （conventions §13 の opt-out）ので、このページは単一言語アプリとして
	 * 日本語を直書きしてよい。多言語化するなら `banto.i18n` を `"keys"` に
	 * 戻し、文言を `messages/{ja,en}.json` に移すこと。
	 *
	 * 権限: 初回起動シードで `server.viewer_public = true` が入るため、LAN の
	 * 未ログイン端末は合成 `viewer` セッションでこの画面に入る（ADR-0012）。
	 * ここから呼ぶのは **読み取りだけ**にすること（書き込みは RBAC の
	 * `viewer` 床で 403 になる）。
	 */
	import { PageHeader, SurfaceCard } from '@banto/ui';

	/** ポーリング間隔（ミリ秒）。常設表示なので短くしすぎない。 */
	const POLL_INTERVAL_MS = 5000;

	interface MonitorData {
		updatedAt: Date;
	}

	/**
	 * ここを自分の読み取りに差し替える（viewer ロールで通る読み取り専用の
	 * 取得に限ること）。例:
	 *   const { rows } = await getDataProvider().getList('lines', {});
	 *   return { updatedAt: new Date(), rows };
	 */
	async function load(): Promise<MonitorData> {
		return { updatedAt: new Date() };
	}

	let now = $state(new Date());
	let data = $state<MonitorData | null>(null);

	const timeText = $derived(
		`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
	);
	const dateText = $derived(
		`${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（${'日月火水木金土'[now.getDay()]}）`
	);
	const updatedText = $derived(
		data ? `${data.updatedAt.toLocaleTimeString('ja-JP')} に更新` : '読み込み中…'
	);

	// 時計（1秒）。
	$effect(() => {
		const timer = setInterval(() => {
			now = new Date();
		}, 1000);
		return () => clearInterval(timer);
	});

	// データのポーリング（世代トークン方式）。エフェクトが張り直されるたびに
	// `generation` を進め、古い世代の遅延レスポンスは捨てる — これをやらないと
	// 「前の世代の応答が後から届いて新しい値を上書きする」競合が起きる。
	let generation = 0;
	$effect(() => {
		const gen = ++generation;
		void (async () => {
			const first = await load();
			if (gen === generation) data = first;
		})();
		const timer = setInterval(async () => {
			const next = await load();
			if (gen !== generation) return;
			data = next;
		}, POLL_INTERVAL_MS);
		return () => {
			clearInterval(timer);
			generation++;
		};
	});
</script>

<div class="page">
	<PageHeader
		title="モニター"
		description="常時表示用の画面。内容はこのファイルを書き換えて作る。"
	/>

	<SurfaceCard>
		<div class="clock">
			<p class="time">{timeText}</p>
			<p class="date">{dateText}</p>
		</div>
	</SurfaceCard>

	<SurfaceCard title="状態">
		<p class="updated">最終更新: {updatedText}</p>
	</SurfaceCard>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.clock {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
	}

	.time {
		margin: 0;
		font-size: clamp(3rem, 12vw, 7rem);
		font-weight: 600;
		line-height: 1.05;
		font-variant-numeric: tabular-nums;
		color: var(--banto-text);
	}

	.date {
		margin: 0;
		font-size: 1rem;
		color: var(--banto-text-muted);
	}

	.updated {
		margin: 0;
		font-size: 0.9rem;
		color: var(--banto-text-muted);
		font-variant-numeric: tabular-nums;
	}
</style>

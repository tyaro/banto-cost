# @banto/forms

Banto のスキーマ駆動フォーム。定義オブジェクト（`FormSchema`）から
入力 UI・バリデーション・状態管理を自動生成する（spec §7）。text/
textarea/number/date/select/checkbox/password の各フィールド
コンポーネントを同梱する。

## 使用例

```svelte
<script lang="ts">
	import { BantoForm, createFormStore, type FormSchema } from '@banto/forms';

	const schema: FormSchema = {
		fields: [{ name: 'name', label: '商品名', type: 'text', required: true }]
	};
	const store = createFormStore(schema);

	async function handleSubmit(values: Record<string, unknown>) {
		console.log(values);
	}
</script>

<BantoForm {schema} {store} onSubmit={handleSubmit} />
```

## 下線型表示を選ぶ（次リリース、ADR-0024）

`BantoForm` に `appearance="underline"` を渡すと、対応版の `@banto/theme/css` の共有スタイルを使う。
forms と theme は同じ対応版へ更新し、アプリで theme CSS を読み込む。
省略または `appearance="default"` は従来の枠型表示。背景は両表示・直接利用とも既定で透明（ADR-0025）。
新しい依存・パッケージ間 import はない。

```svelte
<BantoForm {schema} {store} onSubmit={handleSubmit} appearance="underline" />
```

下線型では、すべての項目名を入力の上に固定して全文の高さを確保する。
text / password / number / select / date / textarea が対象で、checkbox はネイティブの形を使う。
checkbox の寸法は `--banto-checkbox-size`（既定・fallback とも `1.1rem`）で列表示メニューと揃える。
Space 操作・readonly の disabled fallback・送信対象の扱いは維持する（ADR-0026）。
placeholder・日付のネイティブ UI・textarea の4行と縦リサイズを維持し、浮動ラベルにはしない。
`FieldDef` や送信データ、検証・エラー関連付け、readonly / disabled の扱いは変わらない。
下線型の操作欄は折り返し、送信ボタンと直下の `.banto-btn` は文字に応じて高さが伸びる。

8種類の field は任意の `class` をネイティブ要素へ渡せる。checkbox を除く field で直接共通スタイルを使うときは、
実際の `label.banto-field.banto-field--stacked` 内に field（`class="banto-field-control"`）、
`span.banto-field-label` の順で置く。エラーは label 外へ描画し、ID・ARIA は呼び出し側で関連付ける。
`DraftNumberField` も class を受け取るが、`BantoForm` の number は従来の `NumberField` を使う。

## ラベル・エラー・読み取り専用（Issue #495）

`BantoForm` はフォームごとに入力とエラーの DOM ID を生成し、ラベルの `for` と
入力の `aria-describedby` を対応させる。同じスキーマを複数表示しても ID が重複しない。
エラーが消えると参照も外れる。`FieldDef.name` と store のキー・送信データは変わらない。
DOM の参照は項目名の `#id` ではなく、ラベルやフォーム内の要素から行う。

各 field 部品を直接使う場合、既定の ID は従来どおり `def.name`。任意の `id` と
`aria-describedby` も渡せる。補足・エラー要素の描画とその ID の一意性は呼び出し側が管理する。

- text / password / textarea / number / date と `DraftNumberField` の `def.readonly` は、
  ネイティブの readonly 属性を使う。フォーカス可能で、テキスト入力では値を選択できる。
- `disabled` は別の状態で、送信中などの操作を無効にするときに使う。
- select / checkbox はネイティブ readonly がないため、`def.readonly` でも従来どおり disabled にする。
- readonly / disabled の field は入力・変更・blur の callback を呼ばない。
  `DraftNumberField` は raw の更新・blur / Enter での確定・`onCommit` も行わない。
  編集途中から切り替えた場合も draft の値・未完成文字列・エラーを保つ。
- readonly 値は従来どおり検証・送信対象。store / draft の API による更新は可能で、
  UI の readonly は認可やデータの書き込み禁止を保証するものではない。

各 field のフォーカス枠は、通常のテーマの影に加えて透明な outline を持つ。
forced-colors で影が無効になってもシステム色の outline が残る。

## 未保存の変更の確認（issue #214）

保存型の画面では、`guardUnsavedChanges` をコンポーネントの初期化中に呼ぶと、
未保存のまま別の画面へ移ろうとしたときに確認を出す（再読み込み・タブを閉じる
ときはブラウザ標準の確認）。このパッケージは SvelteKit に依存しないため、
`beforeNavigate` は呼び出し側が渡す。

```svelte
<script lang="ts">
	import { beforeNavigate, goto } from '$app/navigation';
	import {
		BantoForm,
		UnsavedChangesNotice,
		createFormStore,
		guardUnsavedChanges
	} from '@banto/forms';

	const store = createFormStore(schema);
	let saving = $state(false);
	const guard = guardUnsavedChanges({
		isDirty: () => store.isDirty,
		isSaving: () => saving,
		beforeNavigate,
		message: () => '保存していない変更があります。変更を破棄して移動しますか？',
		isForced: (nav) => nav.to?.url.pathname === '/login'
	});

	async function handleSubmit(values: Record<string, unknown>) {
		saving = true;
		try {
			await save(values);
		} finally {
			saving = false; // 保存中のままだと、次の goto でも確認が出る
		}
		store.markClean(); // 移動の前に「保存済み」にする（確認を出さない）
		// 別の画面を選んだあと（遷移先の読み込み中も含む）は、自動で一覧へ戻らない
		if (guard.canAutoNavigate) await goto('/list');
	}
</script>

<BantoForm {schema} {store} onSubmit={handleSubmit}>
	<UnsavedChangesNotice pending={guard.pending} label="未保存の変更があります" />
</BantoForm>
```

同じ画面に複数のガードがあっても確認は 1 回。`hasUnsavedChanges()` はどれか
1 つでも未保存なら `true` を返すリアクティブな関数で、ルーターを通らない終了
（Tauri のウィンドウを閉じる等）の判定に使う。

## pane より長生きする draft と複数フォームの適用（issue #432）

ドックの pane は dock / undock で中身が作り直される。未適用の入力を残すには、
pane の外（ページや controller）で `createFormDraft` を作り、pane は mount のたびに
借りる。`DraftCoordinator` は複数のフォームの適用 / 破棄 / キャンセルを 1 回の確認で
まとめ、登録は `guardUnsavedChanges` の登録簿にもつながる（ルーターの離脱・
`hasUnsavedChanges()` が同じ draft を見る。確認は 1 つの navigation に 1 回のまま）。
設計は [shared-primitives-upstream-plan §3.5](../../docs/design/shared-primitives-upstream-plan.md)。

```svelte
<!-- ページ（pane より長生きする側） -->
<script lang="ts">
	import { beforeNavigate } from '$app/navigation';
	import {
		createDraftCoordinator,
		createFormDraft,
		draftSourceFrom,
		guardUnsavedChanges
	} from '@banto/forms';

	const coordinator = createDraftCoordinator({ message: () => m.unsaved_drafts() });
	const memo = createFormDraft({ key: 'memo', schema, initial: loaded });
	// FormDraft の登録は draft の寿命（ページ）に合わせる。pane の effect で登録すると、
	// keepMounted なしの hide / tab-switch で pane が消えた dirty な draft が pending でも
	// settle の対象でもなくなり、離脱時に未適用の入力を失う
	$effect(() => coordinator.register(draftSourceFrom(memo, (values) => save(values))));
	// ルーターの離脱でも確認するなら、画面のどこかで guard を mount しておく
	guardUnsavedChanges({
		isDirty: () => coordinator.pending,
		isSaving: () => coordinator.settling,
		beforeNavigate,
		message: () => m.unsaved_drafts()
	});

	// dock の lifecycle（@banto/dock-svelte 側）とのつなぎ方は遷移ごとに分ける:
	// - dock / undock / move-docked / tab-switch / hide: coordinator.capture([panelId]) して進める（確認しない）
	// - close: settle の結果が 'clean' / 'applied' / 'discarded' のときだけ閉じる
	async function canClose(panelId: string): Promise<boolean> {
		const result = await coordinator.settle([panelId], (dirtyKeys) =>
			askApplyDiscardCancel(dirtyKeys)
		);
		return result === 'clean' || result === 'applied' || result === 'discarded';
	}
</script>
```

```svelte
<!-- pane（mount のたびに作り直される側）: 欄を描くだけ。source の登録・解除はしない -->
<script lang="ts">
	import { DraftNumberField } from '@banto/forms';

	let { draft } = $props();
</script>

<DraftNumberField def={qtyField} {draft} />
```

- **適用**: `draftSourceFrom` の `apply` は、全欄を確定 → `snapshotForApply()` → 送信 →
  成功したときだけ `markApplied(snapshot)`。baseline になるのは**適用を始めた時点の
  snapshot** で、適用の待機中に打った入力は dirty のまま残る。自前で書くときも同じ順で。
- **`settle` の結果**: `'applied'` / `'discarded'` は「解決した時点で対象がすべて clean」。
  待機中に入力があれば `'dirty-again'`、適用の失敗は `'failed'`、待機中に対象が
  入れ替わった（再登録・登録解除・同じ key の別の settle・dispose）ら `'stale'`。
  中身を捨ててよいのは `'clean'` / `'applied'` / `'discarded'` のときだけ。
- **登録の寿命**: `FormDraft` の source は**ページ（draft の寿命）で**登録し、pane の mount /
  unmount では消さない。非表示のままページを離れても pending で、`settle([key])` の対象になる。
- **自作フォーム**: pane と一緒に生きて消える状態を持つ `DraftSource`（`isDirty` / `apply` /
  `discard` と `capture` / `restore`）は pane の effect で `register` し、BantoForm にしなくてよい。`capture([key])` で
  取ったものは、同じ key の次の `register` で `restore` に渡る（rebind）。
- **数値欄**: `DraftNumberField` は `type="text"` + `inputmode="decimal"` で、`1e` のような
  未完成の文字列も draft に残す（確定は blur / Enter）。スピンボタンは無い。
  既存の `NumberField`（`type="number"`）は変わらない。
- 文言（`message`・検証の `messages.notANumber`）は解決済みの文字列で渡す。

## 日付の入力と注入（date-time-pickers PR-3）

`type: 'date'` の値は `YYYY-MM-DD`（実在の日）か、空なら **`null`**（`''` ではない。
[docs/design/date-time-pickers.md](../../docs/design/date-time-pickers.md) D6）。

- **検証**: `validateField` は正規の形でない値を `dateInvalid` にする。`min` / `max` は正規の文字列で、両端を含む
  （`min: '2026-11-02'`）。`isDateDisabled(date)` が `true` の日は `dateDisabled`。順は必須 → 形式 → 範囲 →
  無効日 → `validate`。`min` / `max` は型ごとに読み、型に合わない側の値（date の数値など）は無視する。
- **ピッカーの注入**: forms は `@banto/ui` を import しない（docs/conventions.md §4）。アプリが部品を渡す。

  ```svelte
  <!-- +layout.svelte: 下のすべての BantoForm / DraftDateField に効く -->
  <script lang="ts">
  	import { provideFieldInputs } from '@banto/forms';
  	import FormDateInput from '#lib/components/FormDateInput.svelte'; // DateInput + messages + locale

  	provideFieldInputs({ date: FormDateInput });
  </script>
  ```

  フォームごとに替えるときは `<BantoForm fieldInputs={{ date: OtherInput }} … />`（型ごとに context より優先）。
  渡される props は `DateFieldInputProps`（`@banto/ui` の `DateInput` の props の一部）。注入が無ければネイティブの
  `<input type="date">` のまま。

- **FormStore の経路**（`BantoForm`）: 打った文字列はそのまま値に入り、blur・Enter で部品が正規の形に直す。
  解析できない文字列は値のまま残って形式のエラーになる（古い日付が黙って送信されない）。検証（`touch`）は
  フォーカスが部品全体（入力欄・ボタン・カレンダー）から出たときだけ走る。
- **FormDraft の経路**（`DraftDateField`）: 打った文字列は `draft.raw` に入り、`commit` が寛容な形（`2026/11/7`・
  全角・`11/7` は今年）を `YYYY-MM-DD` に直して検証する。カレンダーで選んだ日はすぐに確定する。
- `appearance="underline"` のフォームでも、注入した部品は自分の枠のまま（下線にならない）。ラベルは上に並ぶ。

## 時刻・日時の型（date-time-pickers PR-5）

`type: 'time'` の値は `HH:mm`（00:00〜23:59）、`type: 'datetime'` は `YYYY-MM-DDTHH:mm`（タイムゾーンを持たない
壁時計の時刻、[設計書](../../docs/design/date-time-pickers.md) D4）。空は date と同じく `null`。

- **検証**: 形式 → `min` / `max`（正規の文字列、両端を含む）→（datetime のみ）`isDateDisabled`（値の日で判定）→
  `step`（分。0:00 からの刻みに合うか。省略・正でない整数なら検査しない）。文言は `ValidationMessages` の任意の
  `timeInvalid` / `timeMin` / `timeMax` / `timeStep` / `dateTimeInvalid` / `dateTimeMin` / `dateTimeMax`
  （datetime の `min` / `max` は空白区切りで文言に渡す）。Rust の `banto_core::datetime` が同じ規則・同じ既定の文言。
- **ピッカーの注入**: `provideFieldInputs({ date, time, datetime })`。渡される props は `TimeFieldInputProps` /
  `DateTimeFieldInputProps`（`@banto/ui` の `TimeInput` / `DateTimeInput` の props の一部。`step` も渡る）。注入が無ければ
  ネイティブの `<input type="time">` / `<input type="datetime-local">`（`step` は秒に直して渡す）。
- **経路**: `BantoForm`（FormStore）も `DraftDateField`（FormDraft。`def.type` に合う部品を使う）も date と同じ流れ。
  `FormDraft.commit` は `930` → `09:30`、`2026/11/7 9:30` → `2026-11-07T09:30` に直す。秒付き・`24:00`・日付だけの
  datetime は形式のエラー。datetime の入力欄は空白区切り（`2026-11-07 09:30`）で見せる。

## 依存

`dependencies`/`peerDependencies` は空。`@banto/*` 間の import もゼロ
（コアパッケージのためオプション側への依存も持たない、docs/conventions.md §4・§5）。

## 導入方法

npm レジストリには公開していない。モノレポ内では `workspace:*`、
外部リポジトリからは git サブディレクトリ依存で消費する。詳細は
[../../docs/publishing.md](../../docs/publishing.md) を参照。

## 関連ドキュメント

- 本体リポジトリ: https://github.com/tyaro/banto
- 仕様: [docs/ui-framework-spec.md §7](../../docs/ui-framework-spec.md)（汎用フォーム仕様）

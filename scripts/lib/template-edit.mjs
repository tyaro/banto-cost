/**
 * テンプレート編集エンジン（improvement-plan-2026-07.md P2-1 / P4-9）。
 *
 * `scripts/rename.mjs`（名称・識別子の一括書き換え）と
 * `scripts/scaffold.mjs`（プリセット＝オプション資産の削除）が共有する、
 * 「現在値を読んでから書き換える・再実行安全・`--dry-run` 対応・見つからない
 * パターンは明示的に失敗」というファイル編集の規律をここに一本化する。
 * 依存を足さない文化（conventions §3 / ADR-0002）に従い Node 標準のみ。
 *
 * 契約（`edit` コールバックの戻り値）:
 *   - `null`      … 既に目的の状態（再実行・適用済み）。スキップとして報告。
 *   - `undefined` … 期待したパターンが見つからない。明示的な失敗として報告。
 *   - 文字列      … 書き換え後の新しい内容。
 *
 * 削除系（`dropBlock` / `cut` / `cutToEnd`）の `null` は「適用済み」と
 * 「アンカーのずれ」を区別できないので、呼び出し側は `editRemoval()` を通し、
 * `beginStep()` で渡した工程の印（その工程が消すファイル）で振り分ける
 * （印がまだ在る＝初回適用なら `null` も失敗）。
 *
 * `createEditor()` は変更ログ（`changes`）と失敗数（`failures`）を閉じ込めた
 * エディタを返す。呼び出し側は `report()` で結果を出力し、`failures > 0` なら
 * 非0終了する（テンプレートの構造が変わったことの検出）。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * `s` 中の `from` 全出現を `to` に置換。0件なら `undefined`（失敗）、
 * `from === to` なら `null`（適用済み）。
 */
export function replaceAll(s, from, to) {
	if (from === to) return null;
	if (!s.includes(from)) return undefined;
	return s.split(from).join(to);
}

/**
 * 削除系エディット向けの純関数: `block` を丸ごと取り除く。
 * `block` が既に無ければ `null`（適用済み＝再実行安全）を返す。削除は
 * `removeFile`/`removeDir` と同じく「既に消えていれば静かにスキップ」する冪等
 * 操作なので、見つからない＝適用済みとして扱う（`replaceAll` の「見つからない
 * ＝失敗」とは意図的に区別する）。ただし `null` は「アンカーのずれ」とも
 * 区別できないので、エディタからは `editRemoval()` を通して使う（初回適用では
 * 失敗に読み替わる。`cut` / `cutToEnd` の `null` も同じ）。
 */
export function dropBlock(s, block) {
	if (!s.includes(block)) return null;
	return s.split(block).join('');
}

/**
 * 削除系エディット向けの純関数: `start` から `end`（両端含む）までの連続領域を
 * 丸ごと取り除く。短い一意なアンカーだけで巨大なブロックを消せるので、資産の
 * 配線（章立てされた script/markup/CSS ブロック）除去に向く。
 * - `start` が無ければ `null`（適用済み＝再実行安全）。
 * - `start` はあるが `start` 以降に `end` が無ければ `undefined`（構造が
 *   変わった＝明示的失敗）。
 */
export function cut(s, start, end) {
	const i = s.indexOf(start);
	if (i === -1) return null;
	const j = s.indexOf(end, i + start.length);
	if (j === -1) return undefined;
	return s.slice(0, i) + s.slice(j + end.length);
}

/**
 * 削除系エディット向けの純関数: `marker` の最初の出現から**ファイル末尾まで**を
 * 丸ごと取り除く。ファイル末尾に付く章末セクション（独自の付録的ブロック）を
 * EOF ごと消すのに向く。結果は必ず単一の改行で終える（rustfmt/prettier 整合）。
 * - `marker` が無ければ `null`（適用済み＝再実行安全。`cut`/`dropBlock` と同じ
 *   「見つからない＝適用済み」規約。`replaceAll` の「見つからない＝失敗」とは
 *   意図的に区別する）。
 * - `marker` があれば、その手前までを残し末尾の空白を単一改行に整えて返す。
 */
export function cutToEnd(s, marker) {
	const i = s.indexOf(marker);
	if (i === -1) return null;
	return s.slice(0, i).replace(/\s+$/, '') + '\n';
}

/**
 * 変換系エディット向けの純関数: `from` を `to` に置換するが、**冪等**。
 * - `from` があれば置換（1回目）。
 * - `from` が無く `to` があれば `null`（適用済み・2回目以降）。
 * - どちらも無ければ `undefined`（構造が変わった＝明示的失敗）。
 * `to` は削除後に必ず現れる「置換後の目印」を含む文字列であること。
 */
export function swap(s, from, to) {
	if (s.includes(from)) return s.split(from).join(to);
	if (s.includes(to)) return null;
	return undefined;
}

/**
 * 変更ログと失敗数を閉じ込めたエディタを生成する。
 *
 * `strict` は「pristine なコピー上での適用」専用モード: 削除系の
 * 「見つからない＝適用済み（null）」と removeFile/removeDir の「既に無い」を
 * **失敗に昇格**する。出荷ツリーには全アンカーが必ず在るはずなので、null は
 * アンカードリフト（対象ファイル側の変更に scaffold が追随していない）の
 * 兆候になる。再実行安全性が要る通常運用では strict を付けないこと
 * （template-acceptance の presets ジョブが唯一の想定利用者）。
 * @param {{ repoRoot: string, dryRun?: boolean, strict?: boolean }} options
 */
export function createEditor({ repoRoot, dryRun = false, strict = false }) {
	/** 実行予定/実行済みの変更ログ（`--dry-run` 共用）。 */
	const changes = [];
	/**
	 * 編集（editFile / jsonField）の対象にしたリポジトリ相対パス（存在しなくても記録する）。
	 * verify-architecture の scaffold-acceptance-paths が、template-acceptance.yml の
	 * `paths` との一致を検査するため、scaffold 自身から「触るファイル」を得る記録。
	 * `addFile`（新規作成）は対象外 — 作るファイルはアンカーではない。
	 */
	const touched = new Set();
	/** 削除（removeFile / removeDir）の対象。消すだけなのでアンカーは無く、一致検査の対象外。 */
	const removed = new Set();
	let failures = 0;

	/**
	 * `relPath` を読み、`edit(before)` の戻り値で書き換える（契約は本ファイル
	 * 冒頭のとおり）。`--dry-run` では書き込まない。
	 *
	 * **対象ファイルが無い場合は「適用済み」扱い**（`removeFile`/`removeDir` と
	 * 同じ規約）。そのファイルを丸ごと消す remover が先に走った後の再実行では、
	 * 個別の行編集は既に用済みだからで、これが無いと「ディレクトリごと消す
	 * remover を含むプリセット（display）の2回目の実行」が常に赤くなる。
	 * パス綴りの誤りを見逃さないための担保は `--strict`: pristine コピーには
	 * 対象ファイルが必ず在るはずなので、そこでは失敗に昇格する（CI の
	 * template-acceptance は `--strict` で走る）。
	 */
	function editFile(relPath, label, edit) {
		touched.add(relPath);
		const abs = path.join(repoRoot, relPath);
		let before;
		try {
			before = fs.readFileSync(abs, 'utf8');
		} catch {
			if (strict) {
				console.error(`  ✗ ${relPath}: ${label} — strict: ファイルが見つかりません`);
				failures++;
				return;
			}
			changes.push(`  = ${relPath}: ${label}（対象ファイルなし・適用済み）`);
			return;
		}
		const result = edit(before);
		if (result === null) {
			if (strict) {
				// pristine コピーに「適用済み」は在り得ない = アンカードリフトの疑い。
				console.error(
					`  ✗ ${relPath}: ${label} — strict: 適用済み扱い（null）はアンカー不一致の疑い`
				);
				failures++;
				return;
			}
			// 既に目的の値（再実行）— スキップとして報告。
			changes.push(`  = ${relPath}: ${label}（変更なし・適用済み）`);
			return;
		}
		if (result === undefined) {
			console.error(
				`  ✗ ${relPath}: ${label} — 期待したパターンが見つかりません（構造が変わった可能性）`
			);
			failures++;
			return;
		}
		changes.push(`  ✔ ${relPath}: ${label}`);
		if (!dryRun) fs.writeFileSync(abs, result);
	}

	/**
	 * 現在の工程（scaffold の remover 1 つ）。`beginStep()` が工程の開始時に
	 * 「初回適用か」を 1 度だけ判定して固定する（工程の途中で印のファイルを
	 * 消しても、その工程の残りの削除は初回適用として扱う）。
	 * @type {{ marker: string | null, firstApply: boolean } | null}
	 */
	let step = null;

	/**
	 * 工程を始める。`markerRel` は**その工程が消すファイル/ディレクトリ**で、
	 * 「適用済みか」を判定する別の印になる。在れば初回適用、無ければ適用済み
	 * （再実行）とみなす。`editRemoval()` はこの判定で、削除系の「見つからない
	 * （null）」を失敗と適用済みに振り分ける。削除系の編集を持たない工程
	 * （足すだけの工程など）は `null` を渡す — その工程で `editRemoval()` を
	 * 呼ぶと投げる。
	 * @param {string | null} markerRel
	 */
	function beginStep(markerRel) {
		step = {
			marker: markerRel,
			firstApply: markerRel !== null && fs.existsSync(path.join(repoRoot, markerRel))
		};
	}

	/**
	 * 削除系エディット（`dropBlock` / `cut` / `cutToEnd` など、見つからないと
	 * `null` を返す純関数）用の `editFile`。
	 *
	 * 削除では「消したい塊が無い」が、再実行（適用済み）とアンカーのずれ
	 * （テンプレート側が変わって塊が別の書き方になった）のどちらでも起きる。
	 * `null` をそのまま `editFile` に渡すと後者も「適用済み」として黙って先へ
	 * 進み、消したファイルへの import が残るツリーでも `--dry-run` が緑になる
	 * （#325 PR2 で塞いだ穴）。そこで `beginStep()` の印で振り分ける:
	 *   - 初回適用（印がまだ在る）… `null` を `undefined` に読み替え、
	 *     `swap` のどちらも無いときと同じ「期待したパターンが見つかりません」の
	 *     明示的な失敗にする（`--strict` の有無に関係なく）。
	 *   - 再実行（印が既に無い）… `null` のまま＝適用済み（再実行安全）。
	 *     `--strict` では従来どおり失敗に昇格する。
	 * 工程が始まっていない、または印の無い工程では判定できないので、プログラムの
	 * 誤りとして投げる。
	 */
	function editRemoval(relPath, label, edit) {
		if (step === null || step.marker === null)
			throw new Error(
				`editRemoval(${relPath}): 削除系の編集は、印を渡した beginStep() の後でだけ呼べます`
			);
		const { firstApply } = step;
		editFile(relPath, label, (s) => {
			const result = edit(s);
			return result === null && firstApply ? undefined : result;
		});
	}

	/** JSON ファイルの文字列フィールドを、整形を保ったまま書き換える。 */
	function jsonField(relPath, field, to) {
		editFile(relPath, `${field} → "${to}"`, (s) => {
			const current = JSON.parse(s)[field];
			if (typeof current !== 'string') return undefined;
			if (current === to) return null;
			return replaceAll(s, JSON.stringify(current), JSON.stringify(to));
		});
	}

	/**
	 * ファイルを冪等に削除する。既に無ければ静かにスキップ（適用済みとして
	 * 報告）。`--dry-run` では削除しない。
	 */
	function removeFile(relPath, label) {
		removed.add(relPath);
		const abs = path.join(repoRoot, relPath);
		if (!fs.existsSync(abs)) {
			if (strict) {
				console.error(`  ✗ ${relPath}: ${label} — strict: 削除対象が存在しません`);
				failures++;
				return;
			}
			changes.push(`  = ${relPath}: ${label}（削除済み）`);
			return;
		}
		changes.push(`  ✔ ${relPath}: ${label}（ファイル削除）`);
		if (!dryRun) fs.rmSync(abs, { force: true });
	}

	/**
	 * ディレクトリを冪等に再帰削除する。既に無ければ静かにスキップ。
	 * `--dry-run` では削除しない。
	 */
	function removeDir(relPath, label) {
		removed.add(relPath);
		const abs = path.join(repoRoot, relPath);
		if (!fs.existsSync(abs)) {
			if (strict) {
				console.error(`  ✗ ${relPath}: ${label} — strict: 削除対象が存在しません`);
				failures++;
				return;
			}
			changes.push(`  = ${relPath}: ${label}（削除済み）`);
			return;
		}
		changes.push(`  ✔ ${relPath}: ${label}（ディレクトリ削除）`);
		if (!dryRun) fs.rmSync(abs, { recursive: true, force: true });
	}

	/**
	 * ファイルを冪等に**作成**する（プリセットの「足す」工程用。
	 * display-preset-plan.md §3.2 / scaffold.mjs の `applyDisplayDefaults`）。
	 *
	 * 削除系の「見つからない＝適用済み」の鏡像として:
	 * - 既に**同じ内容**で在る … 適用済み（`--strict` では失敗＝2回目の適用を
	 *   pristine コピー検査に紛れ込ませない）。
	 * - 既に**違う内容**で在る … 明示的失敗（想定外の衝突を黙って上書きしない）。
	 * - 無い … 作成（`--dry-run` では書かない）。親ディレクトリは作る。
	 */
	function addFile(relPath, label, content) {
		const abs = path.join(repoRoot, relPath);
		if (fs.existsSync(abs)) {
			if (fs.readFileSync(abs, 'utf8') === content) {
				if (strict) {
					console.error(`  ✗ ${relPath}: ${label} — strict: 既に同内容で存在します（適用済み）`);
					failures++;
					return;
				}
				changes.push(`  = ${relPath}: ${label}（変更なし・適用済み）`);
				return;
			}
			console.error(`  ✗ ${relPath}: ${label} — 既存ファイルと内容が異なります（上書きしません）`);
			failures++;
			return;
		}
		changes.push(`  ✔ ${relPath}: ${label}（ファイル作成）`);
		if (!dryRun) {
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, content);
		}
	}

	/** 結果を標準出力へ。失敗があれば true を返す（呼び出し側で非0終了）。 */
	function report(header) {
		console.log(header);
		for (const line of changes) console.log(line);
		if (failures > 0) {
			console.error(
				`\n${failures} 件の編集が適用できませんでした。テンプレートの構造が変わった場合は本スクリプトも更新してください。`
			);
			return true;
		}
		return false;
	}

	return {
		changes,
		touched,
		removed,
		addFile,
		beginStep,
		editFile,
		editRemoval,
		jsonField,
		removeFile,
		removeDir,
		report,
		get failures() {
			return failures;
		}
	};
}

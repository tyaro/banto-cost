# 配布方式の経緯記録: UNLICENSED 化と GitHub Packages 案（2026-07、決着済み）

[publishing.md](../publishing.md) から 2026-08-13 に切り出した経緯の記録
（maintenance-review-2026-08 §2.3 Phase 2）。**現行の規範は publishing.md 側**
（git タグ参照 + `path:` 指定・レジストリ非公開・全 MIT）。本書は「なぜ他の案を
退けたか」を保持する凍結文書で、以後更新しない。

## 方針転換の背景（UNLICENSED 化とその取り消し）

industrial-plan.md §2 の権利の建付け（banto は自社著作物として保持し、
案件アプリには利用許諾で提供する）に合わせ、`@banto/*` パッケージは
**公開 npm レジストリではなく GitHub Packages の private/restricted
レジストリ**へ配布する方針を一度採り、各 `packages/*/package.json` の
`license` を `MIT` から **`UNLICENSED`** に変更した。

> **2026-07-12 再改訂**: banto リポジトリの **public 化 + 全 MIT 統一**を
> 決定したため、上記の UNLICENSED 化は取り消し、`packages/*` も
> ルート LICENSE（MIT）に揃えた（package-local の LICENSE ファイルも削除 —
> pnpm がルートの MIT を自動同梱する挙動がそのまま望ましい状態になった）。
> 権利留保の防衛線は banto ではなく **banto-industrial 側**（非公開・
> 独自ライセンス）に置く。

UNLICENSED 期には各パッケージに専用の `LICENSE`（"All rights reserved" 文言）
も追加していた — pnpm はワークスペース内パッケージに `LICENSE` が無いと
**ルートの `LICENSE`（MIT）を自動的にタルボールへコピーする**ため、これを
入れておかないと `license: "UNLICENSED"` と矛盾する MIT 全文が配布物に
混入する（`pnpm publish --dry-run` で実際に確認した）。MIT 統一の際に
package-local LICENSE は削除済み。

## `@banto` スコープと GitHub Packages の制約

> **2026-07-12 決着**: 下記の選択肢 1（org `banto` 作成）は **GitHub 上で
> 名前が既に取得されており不可能**と判明。選択肢 2（改名）は影響過大、
> 3（publish しない）では banto-industrial 連携が塞がるため、
> **第4の方式 = git 依存 + `path:` 指定**（publishing.md 冒頭の決定節）を
> 採用した。

**GitHub Packages の npm レジストリは、スコープ名が GitHub の
ユーザー/Organizationアカウント名と一致している必要がある**
（`@NAMESPACE/PACKAGE-NAME` の `NAMESPACE` が公開先アカウント名そのもの。
GitHub公式ドキュメント準拠）。本リポジトリの所有者は GitHub ユーザー
`tyaro`（`origin` = `https://github.com/tyaro/banto.git`）であり、
`banto` という名前の GitHub org/user は存在しない。

つまり**パッケージ名 `@banto/*` のままでは GitHub Packages に publish
できない**（スコープに対応するアカウントが無く、認証・権限解決の時点で
失敗する）。`pnpm publish --dry-run` はレジストリ認証を行わない検証
（ローカルのファイル構成チェックのみ）のため全パッケージで成功するが、
実際の `pnpm publish`（dry-runなし）はここで失敗する。

当時提示した選択肢:

1. **GitHub Organization `banto` を新規作成**し、そちらの権限で publish
   する（リポジトリ自体は `tyaro/banto` のままでも、publish 先アカウントを
   org にすれば `@banto/*` の名前を維持できる）。org 作成・招待管理という
   運用コストが増える
2. **npmスコープを `@tyaro/*` にリネーム**する。パッケージ名の変更は
   `admin-template` 内の全 import・`package.json` の依存関係名・
   banto-industrial 側の将来的な参照を含む広範囲な変更になるため影響が大きい
3. **当面 publish しない**（社内はモノレポ内 `workspace:*` 参照のまま、
   banto-industrial 側の連携が必要になった時点で 1 か 2 を選ぶ）

## GitHub Packages 案を再開する場合の手順（現在不要）

消費側の認証設定:

```ini
# .npmrc（消費側リポジトリ、例: banto-industrial）
@banto:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

（`GITHUB_TOKEN` は `read:packages` 権限）

公開手順:

```sh
cd packages/<name>
pnpm publish --no-git-checks   # dist を生成しない（ソース配布のため build 不要）
```

パッケージ間の依存が無いため公開順序に制約はない。CI での自動 publish は
M18 の非スコープ（初回は手動）。再開する場合は上記スコープ制約の解決
（org 作成 or 改名）を先に判断すること。

# ADR-0001: REST と Tauri を同格の二経路にし、単一サービス層を対称に通す

> English: [0001-rest-tauri-two-path-symmetry.en.md](0001-rest-tauri-two-path-symmetry.en.md)

- 状態: Accepted
- 日付: 2026-07-19（判断自体は M6/M10/M14 で確立、遡及記録）
- 関連: [conventions.md §1・§2](../conventions.md)、spec §11、
  `apps/admin-template/core/src/rest/mod.rs`、`src-tauri/src/lib.rs`

## コンテキスト

Banto は2つの形態で同じ管理画面を提供する: (1) Tauri デスクトップ
（webview から `invoke()` でローカル Rust を呼ぶ）、(2) 同一 LAN 内の
別端末のブラウザ（組み込み axum サーバへ REST + SSE）。両形態は同じ
CRUD・認可・監査を提供する必要がある。この「フロント→サービス層→DB が
貫通する」ことこそテンプレートの価値（spec §2.1）であり、どう二形態を
両立させるかが基盤判断になった。

## 決定

**すべての mutating 操作を、単一の transport 非依存サービス層
（`ItemsService` 等）を通す。認可・監査は REST 経路（`rest/mod.rs` の
`RoleGuard` + `record_write`）と Tauri 経路（`lib.rs` の `require_role` +
`audit.record`）の両方で対称に付け、`origin`（`"rest"`/`"tauri"`）だけを
変える。** サービス層は axum/tauri/RBAC/HTTP を知らない
（conventions §1・§2 の不変条件）。

## 検討した代替案

- **案A（採用）: 単一サービス層 + 両経路対称の wiring。** サービスは
  `Result<_, BantoError>` を返す純粋なドメイン層に保ち、認可・監査は
  各経路の薄い wiring が付ける。利点: ロジック二重化ゼロ、サービスを
  `:memory:` プールで直接テストできる。欠点: 新 mutating 操作ごとに
  両経路 + 両経路の denied テストをペアで書く義務が生じる。
- **案B（不採用）: Tauri のみ対応し、LAN 形態を捨てる。** 実装は最小だが、
  「同一 LAN の別端末から使える」という Banto の中核価値（spec §11）を
  失う。テンプレートの差別化要素が消えるため却下。
- **案C（不採用）: 各経路に独立したハンドラ + 各自のロジック。** 初速は
  出るが、REST と Tauri で認可・監査・バリデーションが時間とともに乖離し、
  「LAN では通るが Tauri では弾かれる」類の不整合を生む。まさにこれを
  防ぐのが本 ADR の目的なので却下。

## 帰結

- 新しい mutating コマンド（create/update/delete/import/…）は**片方の経路に
  だけ足せない**。両経路 + 両経路の denied を必ずペアで実装・テストする
  （conventions §1、recipes/add-resource.md のチェックリスト step 3–6）。
- サービス層に `use axum` / `use tauri` を持ち込むと対称性が壊れるため
  禁止し、`pnpm verify:architecture` の `service-layer` ルールで機械検査
  している（conventions §2 [機械検査済み]）。
- 読み取り系（list/get）は両経路とも監査しない、という判断も両側で揃える。
- この対称性の維持コスト（テストの二重化）は、二形態の恒久的な一貫性と
  引き換えに許容する。

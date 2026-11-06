# レシピ: 通知（トースト）

作成日: 2026-08-14（README から切り出し。トラックB＝アプリ作者向け）

画面右下にトーストを出す通知シンクが標準装備されている（`@banto/admin-core`
の `Notifier`、`@banto/ui` の `ToastHost` が描画）。種類は **`success` / `error` / `info` /
`warning`** の4種。

**(a) 自タブにトーストを出す** — アプリのどこからでも `notify()` を呼ぶ:

```ts
import { notify } from '@banto/admin-core';

notify('warning', '在庫が下限を下回りました');
```

**(b) 接続中の全クライアントへ一斉に出す** — サーバ側（Tauri コマンドや
`banto-serve` のハンドラ、サービス層に注入した `events` チャネル）から
`ServerEvent::Notice` をブロードキャストする。LAN ブラウザには SSE
（`GET /api/events`）、Tauri ウィンドウには転送タスク経由で届き、いずれも
`connectEvents` が `notify()` に橋渡しして同じトーストになる。`level` は上記
4種のいずれかにマップし、未知の値は `info` にフォールバックする。

```rust
use banto_server::ServerEvent;

// `events` は ItemsService のミューテーションが使うのと同じ broadcast::Sender。
// 受信者がいなくても send は Err を返すだけで無害。
let _ = events.send(ServerEvent::Notice {
    level: "warning".to_string(),
    message: "在庫が下限を下回りました".to_string(),
});
```

トーストの永続化・既読管理・ベル型の履歴 UI（通知センター）は本テンプレートの
スコープ外（実需が出た時点でオプションパッケージとして検討。判断は
[../reviews/feature-review-2026-08.md](../reviews/feature-review-2026-08.md) §2.5）。

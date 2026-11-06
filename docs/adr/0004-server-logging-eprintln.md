# ADR-0004: サーバのログは `eprintln!` を既定に据え、`tracing` は保留する

> English: [0004-server-logging-eprintln.en.md](0004-server-logging-eprintln.en.md)

- 状態: Accepted
- 日付: 2026-07-19
- 関連: [conventions.md §3](../conventions.md)、[ADR-0002](0002-minimal-dependencies.md)、
  improvements.md §9、improvement-plan-2026-07.md P1-5/B

## コンテキスト

`banto-server`（LAN サーバ）のトラブルシュートには何らかのログが要る。
現状は `eprintln!`（`audit.rs` 等）で、レベル・構造化フィールド・フィルタは
無い。構造化ログの定番は `tracing` + `tracing-subscriber` だが、これは
conventions §3 が明示的に「入れない依存」として挙げたもの（`tracing` →
`eprintln!`）で、採用は依存最小化（ADR-0002）の抑制対象にあたる。

## 決定

**サーバログは当面 `eprintln!`（最小実装）を既定に据える。`tracing` の
導入は保留し、下記の再検討条件（P1-5 基準）を満たした時点で判断する。**

## 検討した代替案

- **案A（採用）: `eprintln!` / 最小ログ。** 利点: 新規依存ゼロ、テンプレート
  利用者に log 設定サーフェスを継承させない、バイナリ肥大なし。欠点:
  ログレベル・構造化フィールド・実行時フィルタが無く、フィールド運用での
  トラブルシュートは弱い。
- **案B（保留）: `tracing` + `tracing-subscriber`。** 利点: レベル付き・
  構造化・フィルタ可能でエコシステム標準、非同期コンテキストの追跡が容易。
  欠点: 依存追加（conventions §3 の「no」を覆す）、ログレベル/フォーマットの
  設定サーフェス増設、テンプレート利用者全員がその依存を継承。`eprintln!`
  で足りている現状では総保守コストに見合わない。
- **案C（不採用）: `log` ファサード + 任意バックエンド。** 依存コストは
  `tracing` と同程度なのに、非同期・構造化の表現力で劣る。ログ基盤を足すなら
  `tracing` の方が目標に近いので、`log` は選ばない。

## 帰結

- conventions §3 の表は `tracing → eprintln!` のまま維持する。
- **再検討条件（P1-5 基準）**: フィールド配備や複数クライアント環境の
  トラブルシュートが `eprintln!` で明確に足りなくなった（構造化ログ・レベル
  フィルタが実運用で必要になった）とき。採用する場合は **feature ゲート**して
  最小ビルドは依存ゼロを保つ（ADR-0002 の一般則）。監査ログ（M14、
  `audit_log` テーブル）は「誰が何をしたか」の永続記録であり、本 ADR が扱う
  診断ログ（サーバの動作追跡）とは役割が別 — 監査は引き続き DB に残す。

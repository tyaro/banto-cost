# ADR-0021: 段階 2 のファイアウォールの許可は、UAC で昇格する補助プログラムが実行ファイル単位のルール 1 本だけを足し外しする

> English: [0021-firewall-elevated-helper.en.md](0021-firewall-elevated-helper.en.md)

- 状態: Accepted（2026-10-22。決定 1〜4 はオーナーの決定。決定 5 以降は E2〜E4（#474・#475・#476）のレビューと Windows 実機の試験で確かめた）
- 日付: 2026-10-22
- 関連: Issue #219（2026-10-11 の設計レビュー・2026-10-21 の進め方の計画とセキュリティ監査・同日の追記「ポートの自動選択との組み合わせ」・2026-10-22 の範囲の変更）/ #459 / #460 /
  [conventions.md](../conventions.md) §1・§3・§6 /
  [ADR-0001](0001-rest-tauri-two-path-symmetry.md)・[ADR-0002](0002-minimal-dependencies.md) /
  段階 1: `apps/admin-template/src/routes/(app)/settings/firewallInfo.ts`・`apps/admin-template/src-tauri/src/firewall_status.rs`

## コンテキスト

Banto の内蔵サーバーを LAN に公開すると、Windows では標準ファイアウォール（Windows Defender
ファイアウォール）の受信の許可が要る。Issue #219 はこれを 2 段階で支援する。

- **段階 1（昇格なし、実装済み）**: 「サーバ・接続」に、許可に必要な情報（実行ファイルの絶対パス・
  受信・TCP ポート・プロファイル・接続元の範囲）と管理者向けの PowerShell を表示・コピーする。
  Banto のルールがあるかを読み取りだけで表示し（`firewall_rule_status`）、別の端末からの到達確認を
  記録する。ルール名は `<identifier>.lan.tcp.program` / `<identifier>.lan.tcp.port`、
  グループは `<identifier>`（`firewallInfo.ts` の `firewallRuleNames`、`firewall_status.rs` の `rule_names`）。
- **段階 2（この ADR）**: アプリの中から、UAC の承認 1 回で許可ルールを足し外しできるようにする。
  本体は通常の権限のまま動き、昇格するのは固定の操作だけを受ける小さな補助プログラム（以下 helper）だけにする。

決めなければならないことは次のとおり。

- **ルールの形。** v6.8.0 で、起動時に保存したポートが使用中なら +1〜+19 の範囲から空いている
  ポートを選んで保存するようになった（#460、`crates/banto-server/src/server.rs` の `PORT_FALLBACK_SPAN`）。
  この切り替えは UAC なしで起きるので、ポートを決め打ちにしたルールは黙って古くなる。
  一方、2026-10-21 の監査（優先 3）が指摘したとおり、実行ファイル単位のルールは
  「ポートの追随を省く」のではなく「許可の範囲を広げる」判断になる。
- **helper とその隣の exe を信頼できる根拠。** 同じフォルダにある・インストール先の下にある、という
  文字列の条件だけでは、一般ユーザーによる helper・本体・DLL の差し替えを防げない（監査の優先 2）。
  テンプレートの Tauri の設定には現在 NSIS の指定が無く、既定の currentUser（`%LOCALAPPDATA%` の下、
  利用者が書き換えられる）でインストールされる。これは昇格する helper の信頼の前提とぶつかる。
- **アプリ内の認可・監査と UAC の関係**（2026-10-11 の設計レビュー 1）、**確認した対象と実際に作る
  ルールのずれ**（同 2、監査の優先 4）、**所有していないルールの扱い**（監査の優先 4）。
- **依存。** UAC での起動とマニフェストの埋め込みには Win32 API とリソースのコンパイルが要る
  （[conventions.md](../conventions.md) §3、[ADR-0002](0002-minimal-dependencies.md)）。

手本は banto-industrial の `apps/chronogazer/elev`（`chronogazer-elev`）と
`crates/banto-service-elev`（`launch.rs`）。banto は industrial に依存できないので、
汎用部分は banto に還元して使う。ただし監査のとおり、`launch.rs` は引数の検証と runas の起動の部品で、
exe の真正性を保証するものではない。また industrial の Hub の helper 探索にある親フォルダや CWD への
fallback は持ち込まない。

## 決定

### 1. ルールは実行ファイル単位の 1 本にする（オーナー決定）

helper が作るルールは次の 1 本だけ。

| 項目               | 値                                |
| ------------------ | --------------------------------- |
| Direction / Action | Inbound / Allow                   |
| Program            | 本体の exe（helper の隣、決定 8） |
| Protocol           | TCP                               |
| LocalPort          | **指定しない**                    |
| Profile            | Private                           |
| RemoteAddress      | LocalSubnet                       |

理由:

- ポートの自動選択（#460）は UAC なしで起きる。ポートを決め打ちにすると、ルールは黙って古くなる。
  実行ファイル単位ならポートが変わってもルールは 1 本のままで、ポートを変えるたびに UAC を出さない。
- 足し外しが UAC 1 回で済み、所有の判定を exe のパスで行いやすい（決定 6）。インストーラからも
  同じ形で扱える（決定 3）。

**代償として、許可の範囲はその exe が開く全ての TCP ポートに広がる**（同じ exe が別のポートで
待ち受けても通る）。実際に届くのは待ち受け中のポートだけだが、それはルールではなく本体の作りで
決まる。そこで、確認画面には次の 2 点を必ず表示する。

- 「この実行ファイルが待ち受ける**全ての TCP ポート**を、プライベート ネットワークから許可します」
- 「接続元の範囲『ローカル サブネット』は、PC に複数のネットワーク アダプターや VPN があると、
  そのそれぞれのサブネットを含むことがあります」（選んだ NIC 1 つだけ、とは同じではない）

段階 1 が表示・コピーするポート単位の案（`<identifier>.lan.tcp.port`）は、管理者が手で使うための
ものとして残し、段階 2 の helper はポート単位のルールを作らない。

### 2. テンプレートの既定のインストール形態を perMachine にする（オーナー決定）

`apps/admin-template/src-tauri/tauri.conf.json` の NSIS の既定を perMachine（Program Files の下）にする。
段階 2 は **Program Files の下に perMachine でインストールしたとき**だけ働く。portable・per-user・
移動したコピーでは helper が「前提が無い」（終了コード 2）で止まり、画面は段階 1 の案内に戻る。

派生アプリへの影響（インストール先が Program Files に変わる、インストール時に UAC が出る、
既存の per-user のインストールからの移り方）は、実装の PR で `docs/upgrading.md` に書く。

### 3. NSIS のフックは解除だけにする（オーナー決定）

- インストール時には許可ルールを作らない。許可はアプリの中で admin が明示的に行う。
- PREUNINSTALL のフックで helper に所有するルールだけを外させる。起動するのはインストール先の helper ではなく、
  アンインストーラに埋め込んだ helper の写し（`firewall-remove-installed`、決定 8・10）。
- 外せなくてもアンインストールは止めない。`DetailPrint` で、ルールを手で外す方法（ルール名）を案内する。

### 4. 接続元は LocalSubnet に固定する（オーナー決定）

helper は CIDR などの接続元の指定を受けない。引数の検証を単純に保つため。ほかの範囲が要る環境は、
段階 1 のコピーした PowerShell を管理者が直して使う。

### 5. 識別子は段階 1 のものを引き継ぎ、helper にビルド時に持たせる

- ルール名は `<identifier>.lan.tcp.program`、グループは `<identifier>`（段階 1 と同じ）。
  段階 1 の読み取り（`firewall_rule_status`）がそのまま段階 2 のルールを見つけられる。
- identifier（Tauri の bundle identifier）は helper にビルド時の定数として持たせ、引数では受けない。
  派生アプリごとに名前が分かれ、別のアプリのルールを操作する引数がそもそも無い。

代替: identifier を引数で受けて検証する — 検証すべき入力が増え、別アプリのルールを指せてしまうので退けた。

### 6. 自分のルールかどうかは、名前だけでなく中身で判定する

次のすべてが一致したときだけ「所有するルール」とみなす。決定 1 のルールの形を決める項目は、
一つ残らず比べる。

- Name = `<identifier>.lan.tcp.program`、Group = `<identifier>`
- Program のパスが helper の隣の本体 exe と一致する
- Direction = Inbound、Action = Allow、Protocol = TCP
- Profile = Private だけ（Public や Domain が含まれていない）
- RemoteAddress = LocalSubnet だけ
- LocalPort = Any（指定なし）
- そのほかの絞り込みの条件が既定のまま（LocalAddress・RemotePort・InterfaceType・Service など。
  比べる項目は実装で列挙する）
- Enabled = True
- PolicyStoreSource がローカルの PersistentStore（GPO などから来たものではない）

一つでも違えば「競合」（終了コード 4）とする。`firewall-allow` は「既にある」とは言わず、
`firewall-remove` は消さない。
同じ名前で中身が違う、別のインストールのパスを指す、管理者が変えた（Profile を Public に広げた、
RemoteAddress を Any にした、LocalPort を足した、無効にした、など）といったルールは
**「競合」（終了コード 4）で止め、上書きも削除もしない**。Banto が所有しない block ルール、
プロファイルの設定、ファイアウォール全体の有効・無効は変えない。

代替: 名前（または接頭辞）だけで判定する — 派生アプリ・複数インストール・管理者が変えたルールを
「既にあるから成功」と扱ってしまう（監査の優先 4）ので退けた。

### 7. helper は独立した crate にし、runas の起動は src-tauri の小さなモジュールにする

- helper は `apps/admin-template/elev`（例）に、bin と純関数の lib を持つ独立した crate として置く。
  exe 名は `<app>-fw-elev.exe` 相当にし、scaffold と名前を変えるレシピが追随する。
- マニフェスト（`requireAdministrator`）は embed-resource の `compile_for` で bin にだけ埋め込み、
  `manifest_required()` で埋め込み漏れをビルドの失敗にする（テストの実行ファイルには付かない）。
- `main` の冒頭で `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)` を呼び、DLL の探索を
  System32 に限る。
- ファイアウォールの操作は trait 越しにし、テストは偽の実装で行う（テストで実機の状態を変えない）。
  引数の解釈・所有の判定・終了コードの対応などの純関数は `cfg(windows)` の外に置き、Linux の CI で
  テストできるようにする。
- runas の起動は banto-industrial の `crates/banto-service-elev/src/launch.rs` の型
  （`ShellExecuteExW` の `runas` ＋ `SEE_MASK_NOCLOSEPROCESS` ＋ 終了待ち ＋ `GetExitCodeProcess`、
  1223 = UAC の取消）を、`apps/admin-template/src-tauri` の小さなモジュールとしてコピーして汎用化する。

代替:

- src-tauri の 2 個目の bin にする — tauri-build が埋め込むマニフェストとぶつかるおそれがあり、
  本体の依存を helper が丸ごと引くので退けた。
- 共有の crate を新しく作る — 使うのが admin-template だけのうちは、置き場所を増やす利点が無いので
  見送る。使う側が増えたら改めて考える。

### 8. 信頼の根拠は「隣の固定名」と、昇格の前後に検査する実効 ACL に置く

- helper は本体の exe を引数で受けない。`current_exe()` の親フォルダにある固定名の exe だけを対象にする。
  CWD や親フォルダへの fallback はしない。本体側も helper を自分の隣の固定名でだけ探す。唯一の例外は
  アンインストーラが起動する写しの `firewall-remove-installed`（下の「NSIS のアンインストールのフックからの
  起動」）で、インストール先のフォルダを受け、そこにある固定名の本体 exe のルールを外すことだけができる。
- helper と本体の両方が Program Files の下にある（パスの要素の境界で比べ、大文字小文字を区別しない）
  ことを確かめ、そうでなければ終了コード 2 で止める。Program Files の場所は環境変数ではなく OS の
  既知のフォルダ（KNOWNFOLDERID）から得る。
- ただし文字列の条件だけでは足りない。ベンダーが一般利用者に書き込みを許した Program Files の下の
  フォルダに portable のコピーを置けば、文字列の条件は通ってしまう。**信頼の本体は実効 ACL の検査**で、
  本体が昇格を求める前と helper の起動時の両方で行う（下の「昇格を求める前の検査」）。
  - 検査の対象: helper 自身の exe、隣の本体 exe、それらを含むフォルダから Program Files の既知の
    フォルダまでの各階層のフォルダ。
  - 所有者が Administrators・SYSTEM・TrustedInstaller 以外なら、終了コード 2（前提が無い）で止める。
  - 書き込み系の権限（WRITE_DATA / APPEND_DATA / WRITE_DAC / WRITE_OWNER / DELETE /
    FILE_DELETE_CHILD / GENERIC_WRITE / GENERIC_ALL など）を許す ACE の SID が、Administrators・
    SYSTEM・TrustedInstaller 以外にあれば、終了コード 2 で止める（CREATOR OWNER の継承専用の ACE は
    対象のオブジェクト自身には効かないので除いてよい）。
  - 経路のどこかに reparse point（ジャンクション・シンボリックリンク）があれば、終了コード 2 で止める。
  - パスを差し替えられる隙（TOCTOU）を作らないため、ハンドルを開いてから検査し、検査したハンドルの
    ファイルをそのまま扱う（本体 exe のパスもそのハンドルから得る）。
- 更新時の差し替えはインストーラ（昇格済み）だけが行える。ACE の列挙の方法などの実装の細部は E1 の
  PR で決めるが、上の判定の規則を変えるなら ADR を更新する。

昇格を求める前の検査:

- helper の起動後の検査だけでは足りない。helper が差し替えられていれば、UAC を承認した時点で
  差し替え後のコードが管理者で動くので、helper 自身の検査は手遅れになる。
- そのため本体（通常権限の Tauri 側、E2 の起動のモジュール）も、`ShellExecuteExW` の `runas` で
  昇格を求める前に、helper と同じ検査を行う。対象（helper の exe、隣の本体 exe、それらのフォルダから
  Program Files の既知のフォルダまでの各階層）と規則（文字列の Program Files の条件、所有者、
  書き込み系の ACE、経路の reparse point）は上と同一にする。
- 満たさなければ helper を起動せず、UAC も出さず、段階 1 の案内に戻す。結果は「前提が無い」
  （終了コード 2 相当、決定 11）として監査に残し、画面に出す。
- 判定の規則は 1 か所で定義し、本体側と helper 側で同じ純関数・同じテストを共有する（E1 の helper の
  crate の lib を本体からも使う、など。実装の細部は E1・E2 で決める）。
- 位置づけ: **起動前の検査が主たる防御**（差し替えられた helper に UAC で管理者権限を渡さない）で、
  helper の起動後の検査は多重の防御として残す（直接の起動や NSIS のフックからの起動もあるため）。
- 残るリスク: 検査から runas の起動までの間の差し替え（TOCTOU）。`ShellExecuteExW` はパスで起動する
  ので、検査したハンドルを起動に固定できない。ただし ACL の検査に通ったということは、一般利用者は
  その経路に書けないということなので、検査の後に差し替えられるのは既に管理者権限を持つ者だけで、
  昇格の境界を越える攻撃にはならない。この理由で受け入れる。
- NSIS のアンインストールのフック（E4）からの起動: **インストール先の helper は起動しない**。ACL は
  ファイルごとに付くので、フォルダと `uninstall.exe` が守られていても、helper の exe だけに一般利用者の
  書き込み（FILE_WRITE_DATA など）が許されていれば、パスも reparse point も変わらないまま中身を
  書き換えられ、昇格済みのアンインストーラがそれを管理者として動かしてしまう（helper の起動後の検査は
  手遅れ）。そこでアンインストーラは helper の写しを自分の中に持つ。ビルドの時に、インストーラが同梱する
  のと同じファイル（`src-tauri/binaries/<helper>-<target triple>.exe`、Tauri の `externalBin` の元）を
  Uninstall のセクションの `File` で `uninstall.exe` に埋め込み、実行時に `InitPluginsDir` した
  `$PLUGINSDIR` に展開して、その写しを `firewall-remove-installed "$INSTDIR"` で起動する。写しは本体の
  隣に無いので上の配置の検査は当てはまらず、代わりに `$INSTDIR` の固定名の本体 exe をハンドルで開き、
  ファイルであること・reparse point でないこと・Program Files の既知のフォルダの下にあることを確かめ、
  そのハンドルの最終パスを Program とする自分のルール（決定 6 の中身の判定）だけを外す。本体 exe の
  ACL は問わない（外すことは許可を狭めるだけで、別のルールには触れないため）。展開・起動ができない、
  または helper を同梱しないビルド（素の `tauri build`）で写しが無いときは、ルールを変えずに理由と手で
  外す方法を表示してアンインストールを続ける。
  - 採らなかった案: NSIS 側で `check_object` 相当の実効 ACL の検査をしてからインストール先の helper を
    起動する。検査とパスでの起動の間に差し替えられる隙（TOCTOU）が残り、しかも差し替えられるのは
    まさに一般利用者が書ける場合なので、上の runas の場合のような「検査に通れば管理者しか差し替え
    られない」という理由が成り立たない。
  - 残るリスク: `$PLUGINSDIR` は昇格したユーザーの `%TEMP%` の下に新しく作られるフォルダで、管理者が
    自分の UAC を承認した場合は、同じユーザーの昇格していないプロセスもそこに書ける。展開から起動までの
    間にそこを書き換えられれば、写しが差し替えられる。ただし NSIS のアンインストーラはもともと自分を
    `%TEMP%` に写してその写しを動かすので、これはアンインストーラ自身が既に負っているのと同じ水準の
    リスクで、新たに増えるものではない（別の管理者の資格情報で承認した場合は、その管理者の `%TEMP%`
    なので一般利用者は書けない）。

代替:

- Authenticode の署名を検証する — 派生アプリが署名するとは限らないので必須にはしない。
  署名がある場合に追加で確かめるのは、将来の余地として残す。
- helper の起動後の検査だけにする — UAC を承認した時点で差し替え後のコードが管理者で動き、
  手遅れになるので退けた。

### 9. ファイアウォールの操作は、環境を固定した PowerShell で行う（推奨、実装で見直す余地を残す）

- `GetSystemDirectoryW` から得た絶対パスの `powershell.exe` を、`-NoProfile -NonInteractive
-EncodedCommand` で起動する。スクリプトは helper に埋め込んだ固定の文面で、値は決定 5・8 で
  helper 自身が決めたものだけ（利用者の入力は入らない）。
- 子プロセスの環境は最小に固定し、`PSModulePath` などの利用者の環境変数を引き継がない。NetSecurity
  モジュールは絶対パスで Import する。

代替:

- COM の `INetFwPolicy2` — 子プロセスが要らないが、windows crate の feature（COM のラッパー）が要る。
  実装の PR で、依存と安全の面で COM の方が良いと分かれば、この ADR を更新して切り替える。
- `netsh advfirewall` — 出力がロケールに依存し、所有の判定（決定 6）に要る属性を確実に読めないので退けた。

### 10. 受ける操作と引数は固定する

- 操作は `firewall-allow` / `firewall-remove` / `firewall-status` の 3 つだけ。決定 1・4・5・8 により、
  操作の名前以外の引数は要らない（**引数は操作名 1 つだけ**）。
- 例外はアンインストーラの写しが使う `firewall-remove-installed <インストール先のフォルダ>` の 1 つだけ
  （決定 3・8）。受けるのはフォルダだけで、対象はそこにある固定名の本体 exe、できるのは所有するルールを
  外すことだけ。ほかの操作に 2 つ目の引数を付けたものは使い方の誤り（64）のまま。
- 引数の個数の違い・未知の操作・重複・空の引数・UTF-8 でない引数は、すべて「使い方の誤り」（64）にする。
- helper は Windows の管理者が直接起動することもある前提で検証する（アプリの admin の認可とは別の境界）。

### 11. 結果は終了コードで返し、呼ぶ側は必ず読み直す

| コード | 意味                                                                                                                                                                                                                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      | 完了（`firewall-allow` で作った、`firewall-remove` で外した・元から無かった、`firewall-status` で所有ルールが無い）                                                                                                         |
| 3      | 既にある（所有ルールが期待どおりにある。`firewall-allow` と `firewall-status`）                                                                                                                                             |
| 4      | 競合（所有していない同名のルールなど、決定 6。何も変えていない）                                                                                                                                                            |
| 5      | ポリシーで反映されない（GPO でローカルのルールの併合が無効など。既存の所有ルールがあっても 5。`firewall-allow` はルールが無ければ作らずに 5、作成後の読み直しで反映されなければ作ったまま 5。5 でも変更が無いとは限らない） |
| 2      | 前提が無い（配置が信頼できない、決定 8）                                                                                                                                                                                    |
| 1      | 失敗（上のどれにも当たらない失敗）                                                                                                                                                                                          |
| 64     | 使い方の誤り（決定 10）                                                                                                                                                                                                     |

UAC の取消は helper の終了コードではなく、起動側の `ERROR_CANCELLED`（1223）で区別する。

どの結果でも、呼ぶ側は段階 1 の読み取り（`firewall_rule_status`）で実際の状態を読み直して表示する。
終了コード 0 やルールがあることを「接続できる」とは表示しない。到達できるかは段階 1 の到達確認で示す。

### 12. アプリ内の認可と監査は UAC と別に行う

- Tauri のコマンドは `require_role(Admin)` を通った後にだけ helper を起動する。ロールが足りなければ
  起動しない。
- 成功・失敗・UAC の取消を監査に記録する。既存の規約どおり、`denied` はロール不足のときだけ記録し、
  セッションが無いときは記録しない。action 名は新しく `firewall_change` を設ける（既存の
  `settings_change` の流儀に合わせた名前）。
- 新しいコマンドは `scripts/verify-architecture.mjs` の `DESKTOP_ONLY` に分類し、REST には変更の API を
  足さない（[conventions.md](../conventions.md) §1 の対称性の例外は、既存の desktop-only と同じ扱い）。

### 13. 確認した対象と、作るルールの対象を照合する

- 確認画面に出した対象（本体 exe のパスと、サーバーの適用済みの状態の generation）を Tauri のコマンドに
  渡す。コマンドは helper を起動する直前に照合し、違えば起動せずに再確認を求める。
- helper の終了後にも照合し、変わっていれば結果を「古い」として扱って読み直す。
- UAC の承認を待つ間、ロックは持たない（待ちの長さを利用者が決めるため）。
- 同じプロセス内のファイアウォール変更は、サーバーのロックとは独立した実行中ガードで 1 つずつにする。重なった要求は何も起動せず `busy` で答える（監査しない。読み直しは付ける）。別プロセス同士は対象外。

### 14. 依存は既に lock にある版を、helper と起動のモジュールに限って足す

`windows-sys` と `embed-resource` を、helper の crate と起動のモジュールにだけ、feature を絞った直接の
依存として足す。どちらも既に `Cargo.lock` に推移的に入っている版（`windows-sys` 0.61.2、
`embed-resource` 3.0.11）に揃えるので、**ビルドに入る crate は増えない**。これを
[ADR-0002](0002-minimal-dependencies.md) と [conventions.md](../conventions.md) §3 の「足す側の例外」の
理由とする（Paraglide・sysinfo に続く 3 件目）。

代替: 必要な Win32 API を自前の `extern "system"` で宣言する — 依存は増えないが、構造体の
レイアウトや定数を手で持つことになり、誤りを型で防げないので退けた。マニフェストの埋め込みは
自前では難しい。

### 15. 受入試験の否定ケース

2026-10-21 の監査の「受入試験で外せない否定ケース」のうち、段階 2 と実ネットワークの分を
完了条件にする。

- helper: 書き換えられる・不正な helper の配置（一般利用者が書き込める Program Files の下のフォルダを
  含む。本体が昇格を求める前の検査で止めて UAC を出さないこと、helper を直接起動しても決定 8 の
  ACL の検査で終了コード 2 になること）、CWD の囮、CLI からの直接の入力、不正な引数、
  同じ ID で中身が違うルール、複数のインストール、UAC の取消、UAC 待ちの間の設定変更、
  追加・削除の部分的な失敗。
- 実ネットワーク: 指定外の TCP ポート（待ち受けていないもの）・UDP・Public プロファイル・許可外の
  送信元からは届かないこと。明示の block・GPO のローカルの併合の無効で、許可の作成の成功を
  到達の成功と誤って表示しないこと。

Windows 実機での追加・解除・UAC の取消・ポート変更の確認はオーナーが行う。ベンダー製の
セキュリティ製品は対象外とし、段階 1 の共通の案内と注意だけを出す（2026-10-22 の範囲の変更）。

## 検討した代替案

- **ルールの形**
  - **案A（採用）: 実行ファイル単位**（決定 1）。ポートの自動選択で古くならない。代償は全 TCP ポートへの拡大で、確認画面に明示する。
  - **案B（不採用）: exe ＋ 適用済みのポート**（監査の推奨）。範囲は最も狭いが、ポートを変えるたびに UAC が要り、UAC なしで起きる自動選択（#460）のたびに黙って古くなる。
  - **案C（不採用）: exe ＋ 保存ポート〜+19 の範囲**。自動選択には追随するが、基準のポートを変えるとルールの入れ替え（UAC）が要り、範囲の分だけ広げる点では案A と程度の差しかない。
  - **案D（不採用）: ポートだけ**。ほかの exe も同じポートで通ってしまう。
- **インストール形態**
  - **案A（採用）: perMachine を既定にし、それ以外では段階 2 を止める**（決定 2）。
  - **案B（不採用）: per-user のまま helper を使う**。`%LOCALAPPDATA%` は利用者が書き換えられ、UAC で承認する対象の真正性を保てない（監査の優先 2）。
- **NSIS のフック**
  - **案A（採用）: 解除だけ**（決定 3）。
  - **案B（不採用）: インストール時にも許可を作る**。LAN に公開するかを admin がアプリで決める前に穴を開けることになる。
- **接続元**
  - **案A（採用）: LocalSubnet に固定**（決定 4）。
  - **案B（不採用）: CIDR を引数で受ける**。検証すべき入力が増え、不正な値から Any への fallback の危険を抱える。
- **helper の置き方・操作の方法・依存**: 決定 7・8・9・14 の各項に代替と理由を書いた。

## 帰結

- 許可の範囲は、その exe の全 TCP ポート・プライベート プロファイル・ローカル サブネット（複数 NIC・
  VPN を含みうる）になる。確認画面はこれを言葉どおりに表示し続ける義務を負う。
- テンプレートの既定のインストール先が Program Files に変わり、インストール時に UAC が出る。
  派生アプリは次の更新でこれを受け取る（実装の PR で `docs/upgrading.md` に追記）。portable・per-user
  では段階 2 は使えず、段階 1 の案内だけになる。
- helper の crate・起動のモジュール・NSIS のフックが増え、scaffold と名前を変えるレシピが helper の
  exe 名と identifier に追随する必要がある（構造の変更なので scaffold の dry-run で確かめる）。
- `windows-sys` と `embed-resource` が直接の依存になる（新しい crate は増えない）。版を上げるときは
  lock の推移的な版と揃える。
- 実装の PR の分け方の見通し（**実装はこの ADR のレビュー後に始める**）:
  1. E1: helper の crate（純関数と偽の実装でのテスト）。配置の判定（決定 8）は本体からも使える
     lib の純関数として置く
  2. E2: 起動のモジュールの還元、昇格を求める前の配置の検査（E1 の判定を共有）、Tauri のコマンド・
     監査・世代の照合
  3. E3: 画面（確認画面の表示、結果と読み直し）
  4. E4: perMachine の既定と NSIS のフック、scaffold の追随、`docs/upgrading.md`

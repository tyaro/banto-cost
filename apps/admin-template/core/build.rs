// `sqlx::migrate!`（db.rs・テスト）は migration の SQL をマクロ展開時に
// 埋め込む。既存のファイルは `include_str!` で追跡されるが、安定版の sqlx は
// **新しい migration ファイルの追加**をビルドの依存として検知しない。新しい
// migration を足しただけの増分ビルドが、それを含まない古い一覧を埋め込まない
// よう、ディレクトリ単位で再実行を指示する（sqlx の公式の案内: ディレクトリの
// rerun-if-changed は新規ファイルの追加も検知する）。Issue #340。
fn main() {
    println!("cargo:rerun-if-changed=migrations-sqlite");
    println!("cargo:rerun-if-changed=migrations-postgres");
}

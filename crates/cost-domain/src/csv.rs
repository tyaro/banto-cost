//! CSV 出力（仕様9章「CSVには表示と同じ権限を適用し、集計条件と出力日時を付ける。
//! 表計算ソフトで式として実行される文字列を無害化する」、T12）。
//!
//! - 先頭に UTF-8 の BOM を付ける（日本語版の表計算ソフトが Shift_JIS と読み違えない）。
//! - 1行目から「出力日時」と「集計条件」（項目名と値の組）を出し、空行を挟んで見出しと明細を出す。
//! - 行区切りは CRLF、RFC 4180 に従って `"`・`,`・改行を含む欄を引用符で囲む。
//! - 文字列の欄は、先頭が `=` `+` `-` `@`、タブ、改行、全角の `＝` `＋` `－` `＠` なら先頭に `'`
//!   を付けて式として実行されないようにする。数値の欄（負の金額を含む）は変えない。
//!   集計条件・見出しにも同じ規則を当てる（案件名・顧客名など利用者が入力した文字列が入るため）。
//!
//! 権限の絞り込みは呼び出し側（サービス層）が `visible_projects` / `amount_projects` で行い、
//! このモジュールは渡された行だけを書く。

const BOM: char = '\u{feff}';

/// 1つの欄。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cell {
    Text(String),
    Int(i64),
    /// 率（千分率）を百分率の小数第1位で書く（275 → `27.5`、-50 → `-5.0`）。
    Permille(i64),
    /// 空欄（未設定・算出不可・権限外）。0 にしない。
    Empty,
}

impl Cell {
    pub fn text(s: impl Into<String>) -> Self {
        Self::Text(s.into())
    }

    /// `None` は空欄。
    pub fn opt_int(v: Option<i64>) -> Self {
        v.map_or(Self::Empty, Self::Int)
    }

    /// `None` は空欄。
    pub fn opt_text(v: Option<impl Into<String>>) -> Self {
        v.map_or(Self::Empty, |s| Self::Text(s.into()))
    }
}

impl From<&str> for Cell {
    fn from(s: &str) -> Self {
        Self::Text(s.to_string())
    }
}

impl From<String> for Cell {
    fn from(s: String) -> Self {
        Self::Text(s)
    }
}

impl From<i64> for Cell {
    fn from(v: i64) -> Self {
        Self::Int(v)
    }
}

/// 表計算ソフトが式の始まりとみなす文字で始まる。
fn starts_like_formula(s: &str) -> bool {
    s.chars().next().is_some_and(|c| {
        matches!(
            c,
            '=' | '+' | '-' | '@' | '\t' | '\r' | '\n' | '＝' | '＋' | '－' | '＠'
        )
    })
}

/// 式として実行されないよう、必要なら先頭に `'` を付ける。
pub fn neutralize(s: &str) -> String {
    if starts_like_formula(s) {
        format!("'{s}")
    } else {
        s.to_string()
    }
}

/// RFC 4180 の引用。
fn quote(s: &str) -> String {
    if s.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// 1つの欄を CSV の文字列にする（文字列は無害化してから引用）。
pub fn field(cell: &Cell) -> String {
    match cell {
        Cell::Text(s) => quote(&neutralize(s)),
        Cell::Int(v) => v.to_string(),
        Cell::Permille(p) => {
            let sign = if *p < 0 { "-" } else { "" };
            let a = p.unsigned_abs();
            format!("{sign}{}.{}", a / 10, a % 10)
        }
        Cell::Empty => String::new(),
    }
}

/// 出力する表。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CsvTable {
    /// 出力日時（表示用の文字列）。
    pub generated_at: String,
    /// 集計条件（項目名, 値）。
    pub conditions: Vec<(String, String)>,
    pub header: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
}

impl CsvTable {
    pub fn new(generated_at: impl Into<String>, header: &[&str]) -> Self {
        Self {
            generated_at: generated_at.into(),
            conditions: Vec::new(),
            header: header.iter().map(|h| h.to_string()).collect(),
            rows: Vec::new(),
        }
    }

    pub fn condition(&mut self, name: impl Into<String>, value: impl Into<String>) -> &mut Self {
        self.conditions.push((name.into(), value.into()));
        self
    }

    pub fn push(&mut self, row: Vec<Cell>) {
        self.rows.push(row);
    }

    /// BOM つきの CSV 文字列。
    pub fn render(&self) -> String {
        let line = |cells: Vec<Cell>| cells.iter().map(field).collect::<Vec<_>>().join(",");
        let mut lines = vec![line(vec![
            Cell::text("出力日時"),
            Cell::text(self.generated_at.clone()),
        ])];
        for (k, v) in &self.conditions {
            lines.push(line(vec![
                Cell::text("集計条件"),
                Cell::text(k.clone()),
                Cell::text(v.clone()),
            ]));
        }
        lines.push(String::new());
        lines.push(line(self.header.iter().cloned().map(Cell::Text).collect()));
        for r in &self.rows {
            lines.push(line(r.clone()));
        }
        let mut out = String::new();
        out.push(BOM);
        out.push_str(&lines.join("\r\n"));
        out.push_str("\r\n");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn t12_式として実行される文字列を無害化する() {
        for s in [
            "=SUM(A1)", "+1", "-1+2", "@cmd", "\tx", "\rx", "\nx", "＝1", "＋1", "－1", "＠x",
        ] {
            assert!(neutralize(s).starts_with('\''), "{s:?}");
        }
        for s in ["案件A", "1-2", "", "a=b", "'x"] {
            assert_eq!(neutralize(s), s);
        }
    }

    #[test]
    fn t12_数値の負の金額は変えず空欄は0にしない() {
        assert_eq!(field(&Cell::Int(-5_000)), "-5000");
        assert_eq!(field(&Cell::Empty), "");
        assert_eq!(field(&Cell::opt_int(None)), "");
        assert_eq!(field(&Cell::text("-5000")), "'-5000");
        assert_eq!(field(&Cell::Permille(275)), "27.5");
        assert_eq!(field(&Cell::Permille(-50)), "-5.0");
        assert_eq!(field(&Cell::Permille(-5)), "-0.5");
    }

    #[test]
    fn t12_引用符_カンマ_改行を含む欄を引用する() {
        assert_eq!(field(&Cell::text("a,b")), "\"a,b\"");
        assert_eq!(field(&Cell::text("say \"hi\"")), "\"say \"\"hi\"\"\"");
        assert_eq!(field(&Cell::text("a\nb")), "\"a\nb\"");
        // 無害化してから引用する。
        assert_eq!(field(&Cell::text("=1,2")), "\"'=1,2\"");
    }

    #[test]
    fn t12_出力日時と集計条件を先頭に付ける() {
        let mut t = CsvTable::new("2026-11-07 10:00", &["コード", "金額"]);
        t.condition("対象", "=危険な名前");
        t.push(vec![Cell::text("P-1"), Cell::Int(100)]);
        t.push(vec![Cell::text("P-2"), Cell::Empty]);
        let csv = t.render();
        assert!(csv.starts_with('\u{feff}'));
        let body: Vec<&str> = csv.trim_start_matches('\u{feff}').split("\r\n").collect();
        assert_eq!(
            body,
            [
                "出力日時,2026-11-07 10:00",
                "集計条件,対象,'=危険な名前",
                "",
                "コード,金額",
                "P-1,100",
                "P-2,",
                "",
            ]
        );
    }
}

//! 案件台帳の状態と入力の検査（仕様5.1）。

use crate::calendar::Date;
use crate::pipeline::Stage;

/// 案件の状態。「引合 → 見積中 → 交渉中 → 受注 → 進行中 → 作業完了 → 精算完了」と、
/// 失注・中止・保留。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProjectStatus {
    Lead,
    Quoting,
    Negotiating,
    Ordered,
    InProgress,
    WorkDone,
    Settled,
    Lost,
    Cancelled,
    OnHold,
}

impl ProjectStatus {
    pub const ALL: [ProjectStatus; 10] = [
        Self::Lead,
        Self::Quoting,
        Self::Negotiating,
        Self::Ordered,
        Self::InProgress,
        Self::WorkDone,
        Self::Settled,
        Self::Lost,
        Self::Cancelled,
        Self::OnHold,
    ];

    /// DB・通信で使う文字列。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lead => "lead",
            Self::Quoting => "quoting",
            Self::Negotiating => "negotiating",
            Self::Ordered => "ordered",
            Self::InProgress => "in_progress",
            Self::WorkDone => "work_done",
            Self::Settled => "settled",
            Self::Lost => "lost",
            Self::Cancelled => "cancelled",
            Self::OnHold => "on_hold",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|status| status.as_str() == s)
    }

    /// 受注済みの側（受注・進行中・作業完了・精算完了）。
    pub fn is_ordered(self) -> bool {
        matches!(
            self,
            Self::Ordered | Self::InProgress | Self::WorkDone | Self::Settled
        )
    }

    /// 受注済みで精算前（受注・進行中・作業完了）。予算の承認・完了見込の採用ができる状態。
    pub fn is_ordered_open(self) -> bool {
        matches!(self, Self::Ordered | Self::InProgress | Self::WorkDone)
    }

    /// 精算完了にできる状態か。作業完了の案件だけを、精算完了の検査（T17、
    /// `closeout::check_closeout`）を通して精算完了にする。
    pub fn settleable(self) -> bool {
        self == Self::WorkDone
    }

    /// 精算完了を取り消したとき（再開）に戻す状態。精算完了の案件だけが取り消せ、
    /// 理由を残して作業完了へ戻す（2026-11-07 ユーザー決定）。それ以外は `None`。
    pub fn reopened_to(self) -> Option<Self> {
        (self == Self::Settled).then_some(Self::WorkDone)
    }

    /// 受注転換を取り消したときに戻す状態。受注の案件だけが取り消せ、転換前の状態
    /// （受注前で有効な状態か保留）へ戻す（T40）。それ以外は `None`。
    pub fn unconverted_to(self, previous: ProjectStatus) -> Option<Self> {
        (self == Self::Ordered && previous.convertible()).then_some(previous)
    }

    /// 一部受注の受注転換を取り消したとき、残りの範囲の案件を移す状態（T40）。受注前で
    /// 有効な状態と保留は中止にする。失注・中止はそのまま（`None`）。受注済みの側の
    /// 案件は取消の検査で止めるので、ここでも `None`。
    pub fn remainder_closed_to(self) -> Option<Self> {
        self.convertible().then_some(Self::Cancelled)
    }

    /// 案件の編集画面から直接選べる状態か。受注済みの側へは受注転換（P3b）で、
    /// 精算完了へは精算完了の検査（T17）で移すため、ここでは選ばせない。
    pub fn settable_directly(self) -> bool {
        !self.is_ordered()
    }

    /// 受注転換できる状態か（受注前で有効な状態と保留）。失注・中止は状態を戻してから転換する。
    pub fn convertible(self) -> bool {
        matches!(
            self,
            Self::Lead | Self::Quoting | Self::Negotiating | Self::OnHold
        )
    }

    /// 案件の編集画面から `self` を `to` へ変えてよいか。受注前の側は受注前の状態どうし、
    /// 受注済みの側は受注・進行中・作業完了の間だけ動かせる。受注済みへは受注転換で、
    /// 精算完了へは精算完了の検査（T17）で移すため、ここでは選ばせない。
    pub fn can_edit_to(self, to: ProjectStatus) -> bool {
        if self == to {
            return true;
        }
        if self.is_ordered() {
            matches!(to, Self::Ordered | Self::InProgress | Self::WorkDone) && self != Self::Settled
        } else {
            to.settable_directly()
        }
    }

    /// 案件見込の集計に使う段階。未受注で有効な案件は採用版の営業段階をそのまま使い、
    /// 失注・中止・保留・受注済みは案件の状態が優先する（T24）。
    pub fn pipeline_stage(self, version_stage: Stage) -> Stage {
        match self {
            Self::Lost => Stage::Lost,
            Self::Cancelled => Stage::Cancelled,
            Self::OnHold => Stage::OnHold,
            s if s.is_ordered() => Stage::Ordered,
            _ => version_stage,
        }
    }
}

/// 案件の入力（共通の必須項目は案件ID・案件名・顧客・責任者・状態）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectInput<'a> {
    pub code: &'a str,
    pub name: &'a str,
    pub status: ProjectStatus,
    pub planned_start: Option<Date>,
    pub planned_end: Option<Date>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectIssue {
    CodeRequired,
    NameRequired,
    /// 受注後は予定開始日・完了日が必須（受注前は未定を許可）。
    PlannedDatesRequired,
    EndBeforeStart,
}

/// 案件の入力を検査する。
pub fn validate_project(input: &ProjectInput<'_>) -> Vec<ProjectIssue> {
    let mut issues = Vec::new();
    if input.code.trim().is_empty() {
        issues.push(ProjectIssue::CodeRequired);
    }
    if input.name.trim().is_empty() {
        issues.push(ProjectIssue::NameRequired);
    }
    if input.status.is_ordered() && (input.planned_start.is_none() || input.planned_end.is_none()) {
        issues.push(ProjectIssue::PlannedDatesRequired);
    }
    if let (Some(start), Some(end)) = (input.planned_start, input.planned_end) {
        if end < start {
            issues.push(ProjectIssue::EndBeforeStart);
        }
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn t17_精算完了にできるのは作業完了の案件だけ() {
        let settleable: Vec<_> = ProjectStatus::ALL
            .into_iter()
            .filter(|s| s.settleable())
            .collect();
        assert_eq!(settleable, vec![ProjectStatus::WorkDone]);
        // 編集画面からは精算完了へ動かせない。
        assert!(!ProjectStatus::WorkDone.can_edit_to(ProjectStatus::Settled));
        assert!(!ProjectStatus::Settled.can_edit_to(ProjectStatus::WorkDone));
    }

    #[test]
    fn t17_精算完了の取消は作業完了へ戻す() {
        for s in ProjectStatus::ALL {
            let expected = (s == ProjectStatus::Settled).then_some(ProjectStatus::WorkDone);
            assert_eq!(s.reopened_to(), expected, "{s:?}");
        }
        // 戻した状態は再び精算完了にできる。
        assert!(ProjectStatus::Settled.reopened_to().unwrap().settleable());
    }

    fn input(
        status: ProjectStatus,
        start: Option<&str>,
        end: Option<&str>,
    ) -> ProjectInput<'static> {
        ProjectInput {
            code: "P-001",
            name: "制御盤更新",
            status,
            planned_start: start.map(|s| Date::parse(s).unwrap()),
            planned_end: end.map(|s| Date::parse(s).unwrap()),
        }
    }

    #[test]
    fn 状態の文字列は往復する() {
        for status in ProjectStatus::ALL {
            assert_eq!(ProjectStatus::parse(status.as_str()), Some(status));
        }
        assert_eq!(ProjectStatus::parse("done"), None);
    }

    #[test]
    fn 受注前は予定日が未定でよく_受注後は必須() {
        assert!(validate_project(&input(ProjectStatus::Lead, None, None)).is_empty());
        assert_eq!(
            validate_project(&input(ProjectStatus::Ordered, Some("2026-12-01"), None)),
            vec![ProjectIssue::PlannedDatesRequired]
        );
        assert!(validate_project(&input(
            ProjectStatus::InProgress,
            Some("2026-12-01"),
            Some("2027-03-31")
        ))
        .is_empty());
    }

    #[test]
    fn 必須項目と日付の前後() {
        let mut i = input(
            ProjectStatus::Quoting,
            Some("2027-03-31"),
            Some("2026-12-01"),
        );
        i.code = " ";
        i.name = "";
        assert_eq!(
            validate_project(&i),
            vec![
                ProjectIssue::CodeRequired,
                ProjectIssue::NameRequired,
                ProjectIssue::EndBeforeStart
            ]
        );
    }

    #[test]
    fn 受注済みの側へは直接変更しない() {
        assert!(ProjectStatus::Negotiating.settable_directly());
        assert!(ProjectStatus::OnHold.settable_directly());
        assert!(!ProjectStatus::Ordered.settable_directly());
        assert!(!ProjectStatus::Settled.settable_directly());
    }

    #[test]
    fn 受注済みの案件は受注前の状態へ戻さない() {
        assert!(ProjectStatus::Lead.can_edit_to(ProjectStatus::Lost));
        assert!(!ProjectStatus::Lead.can_edit_to(ProjectStatus::Ordered));
        assert!(ProjectStatus::Ordered.can_edit_to(ProjectStatus::InProgress));
        assert!(ProjectStatus::InProgress.can_edit_to(ProjectStatus::WorkDone));
        assert!(!ProjectStatus::Ordered.can_edit_to(ProjectStatus::Lost));
        assert!(!ProjectStatus::WorkDone.can_edit_to(ProjectStatus::Settled));
        assert!(!ProjectStatus::Settled.can_edit_to(ProjectStatus::WorkDone));
        assert!(ProjectStatus::Settled.can_edit_to(ProjectStatus::Settled));
    }

    #[test]
    fn t24_失注中止保留と受注済みは案件の状態が集計段階に優先する() {
        assert_eq!(
            ProjectStatus::Negotiating.pipeline_stage(Stage::Informal),
            Stage::Informal
        );
        assert_eq!(
            ProjectStatus::Lost.pipeline_stage(Stage::Negotiating),
            Stage::Lost
        );
        assert_eq!(
            ProjectStatus::OnHold.pipeline_stage(Stage::Negotiating),
            Stage::OnHold
        );
        assert_eq!(
            ProjectStatus::InProgress.pipeline_stage(Stage::Negotiating),
            Stage::Ordered
        );
    }
}

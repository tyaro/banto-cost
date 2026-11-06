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

    /// 案件の編集画面から直接選べる状態か。受注済みの側へは受注転換（P3b）で、
    /// 精算完了へは精算完了の検査（T17）で移すため、ここでは選ばせない。
    pub fn settable_directly(self) -> bool {
        !self.is_ordered()
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

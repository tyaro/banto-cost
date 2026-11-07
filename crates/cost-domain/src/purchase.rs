//! 発注と実績化。発注・請求・支払は同じ取引の段階であり、原価を二重に作らない（仕様3.2、6.3）。

use crate::money::Yen;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PurchaseOrder {
    pub amount: Yen,
    pub cancelled: Yen,
    /// 実績化済み額（対応する直接費明細の合計）。
    pub realized: Yen,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PurchaseError {
    /// 実績化・取消の合計が発注額を超える。差額の理由と承認が必要。
    ExceedsOrder {
        excess: Yen,
    },
    NegativeAmount,
    /// 取消・変更の金額が0以下。
    NotPositive,
    /// 変更後の発注額が、取消済み額と実績化済み額の合計を下回る。
    BelowUsed {
        used: Yen,
    },
}

impl PurchaseOrder {
    pub fn new(amount: Yen) -> Self {
        Self {
            amount,
            cancelled: 0,
            realized: 0,
        }
    }

    /// 未実績発注残 ＝ 発注額 − 取消額 − 実績化済み額。
    pub fn remaining(&self) -> Yen {
        self.amount - self.cancelled - self.realized
    }

    /// 検収などで実績化する。超過は拒否し、呼び出し側で理由・承認つきの処理に回す。
    pub fn realize(&mut self, amount: Yen) -> Result<(), PurchaseError> {
        if amount < 0 {
            return Err(PurchaseError::NegativeAmount);
        }
        if amount > self.remaining() {
            return Err(PurchaseError::ExceedsOrder {
                excess: amount - self.remaining(),
            });
        }
        self.realized += amount;
        Ok(())
    }

    /// 不要になった発注残を取り消す（理由は呼び出し側で残す）。未実績残を超えては取り消せない。
    pub fn cancel(&mut self, amount: Yen) -> Result<(), PurchaseError> {
        if amount <= 0 {
            return Err(PurchaseError::NotPositive);
        }
        if amount > self.remaining() {
            return Err(PurchaseError::ExceedsOrder {
                excess: amount - self.remaining(),
            });
        }
        self.cancelled += amount;
        Ok(())
    }

    /// 値上がり・追加などで発注額を見直す。取消済みと実績化済みの合計を下回る額にはできない。
    pub fn change_amount(&mut self, amount: Yen) -> Result<(), PurchaseError> {
        if amount <= 0 {
            return Err(PurchaseError::NotPositive);
        }
        let used = self.cancelled + self.realized;
        if amount < used {
            return Err(PurchaseError::BelowUsed { used });
        }
        self.amount = amount;
        Ok(())
    }

    /// 仮計上を請求確定額で置き換える。新しい原価は作らず、差額だけ実績化済み額を動かす。
    pub fn replace_provisional(
        &mut self,
        provisional: Yen,
        confirmed: Yen,
    ) -> Result<(), PurchaseError> {
        if confirmed < 0 || provisional < 0 || provisional > self.realized {
            return Err(PurchaseError::NegativeAmount);
        }
        let delta = confirmed - provisional;
        if delta > self.remaining() {
            return Err(PurchaseError::ExceedsOrder {
                excess: delta - self.remaining(),
            });
        }
        self.realized += delta;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn t05_外注500000円のうち300000円を実績化() {
        let mut po = PurchaseOrder::new(500_000);
        po.realize(300_000).unwrap();
        assert_eq!(po.realized, 300_000);
        assert_eq!(po.remaining(), 200_000);
        // 同額の請求書が届いても、仮計上の置き換えなので実績は600,000円にならない。
        po.replace_provisional(300_000, 300_000).unwrap();
        assert_eq!(po.realized, 300_000);
        assert_eq!(po.remaining(), 200_000);
    }

    #[test]
    fn 請求確定額との差額だけ動く() {
        let mut po = PurchaseOrder::new(500_000);
        po.realize(300_000).unwrap();
        po.replace_provisional(300_000, 320_000).unwrap();
        assert_eq!((po.realized, po.remaining()), (320_000, 180_000));
    }

    #[test]
    fn t05_不要な発注残の取消と発注額の見直し() {
        let mut po = PurchaseOrder::new(500_000);
        po.realize(300_000).unwrap();
        assert_eq!(
            po.cancel(250_000),
            Err(PurchaseError::ExceedsOrder { excess: 50_000 })
        );
        assert_eq!(po.cancel(0), Err(PurchaseError::NotPositive));
        po.cancel(50_000).unwrap();
        assert_eq!(po.remaining(), 150_000);
        assert_eq!(
            po.change_amount(340_000),
            Err(PurchaseError::BelowUsed { used: 350_000 })
        );
        po.change_amount(600_000).unwrap();
        assert_eq!(po.remaining(), 250_000);
    }

    #[test]
    fn 発注額を超える実績化は拒否() {
        let mut po = PurchaseOrder::new(500_000);
        po.cancelled = 100_000;
        assert_eq!(
            po.realize(450_000),
            Err(PurchaseError::ExceedsOrder { excess: 50_000 })
        );
        assert_eq!(po.realized, 0);
    }
}

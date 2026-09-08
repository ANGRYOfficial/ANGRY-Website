use anchor_lang::prelude::*;

use crate::{
    constants::{BPS_DENOMINATOR, ENGINE_VERSION},
    errors::EngineError,
};

#[account]
pub struct EngineConfig {
    // Current administrative authority.
    pub authority: Pubkey,

    // Immutable authority used when deriving the config PDA at initialization.
    // This keeps the PDA discoverable even after a two-step authority rotation.
    pub seed_authority: Pubkey,

    // Two-step authority rotation. Pubkey::default() means no transfer pending.
    pub pending_authority: Pubkey,

    pub project: Pubkey,
    pub development_wallet: Pubkey,

    pub buyback_bps: u16,
    pub liquidity_bps: u16,
    pub development_bps: u16,

    pub buyback_threshold: u64,
    pub liquidity_threshold: u64,
    pub development_threshold: u64,

    pub buyback_reserve: u64,
    pub liquidity_reserve: u64,
    pub development_reserve: u64,

    // Current creator-fee SOL still represented by the three reserves.
    pub accounted_balance: u64,

    // Lifetime creator-fee SOL accepted by this Engine config.
    pub total_received: u64,

    // Lifetime creator-fee SOL removed from current reserves by completed actions.
    pub total_development_settled: u64,
    pub total_buyback_processed: u64,
    pub total_liquidity_deployed: u64,

    // Cumulative allocation epoch. This prevents integer rounding from depending
    // on how often fees are synced. Reset only after a settings/BPS update.
    pub epoch_received: u64,
    pub epoch_buyback_allocated: u64,
    pub epoch_liquidity_allocated: u64,
    pub epoch_development_allocated: u64,

    pub paused: bool,
    pub version: u8,
    pub config_bump: u8,
    pub vault_bump: u8,

    // Pre-allocated room for future backwards-compatible state fields.
    pub reserved: [u8; 256],
}

impl EngineConfig {
    pub const LEN: usize =
        32 + // authority
        32 + // seed_authority
        32 + // pending_authority
        32 + // project
        32 + // development_wallet
        2 + 2 + 2 + // BPS
        8 + 8 + 8 + // thresholds
        8 + 8 + 8 + // reserves
        8 + // accounted_balance
        8 + // total_received
        8 + // total_development_settled
        8 + // total_buyback_processed
        8 + // total_liquidity_deployed
        8 + // epoch_received
        8 + // epoch_buyback_allocated
        8 + // epoch_liquidity_allocated
        8 + // epoch_development_allocated
        1 + // paused
        1 + // version
        1 + // config_bump
        1 + // vault_bump
        256; // reserved

    pub fn reserve_total(&self) -> Result<u64> {
        self.buyback_reserve
            .checked_add(self.liquidity_reserve)
            .and_then(|v| v.checked_add(self.development_reserve))
            .ok_or_else(|| EngineError::MathOverflow.into())
    }

    pub fn lifetime_processed_total(&self) -> Result<u64> {
        self.total_development_settled
            .checked_add(self.total_buyback_processed)
            .and_then(|v| v.checked_add(self.total_liquidity_deployed))
            .ok_or_else(|| EngineError::MathOverflow.into())
    }

    pub fn assert_invariant(&self) -> Result<()> {
        require!(
            self.version == ENGINE_VERSION,
            EngineError::AccountingInvariantBroken
        );

        Self::validate_allocation(
            self.buyback_bps,
            self.liquidity_bps,
            self.development_bps,
        )?;

        Self::validate_thresholds(
            self.buyback_threshold,
            self.liquidity_threshold,
            self.development_threshold,
        )?;

        require!(
            self.reserve_total()? == self.accounted_balance,
            EngineError::AccountingInvariantBroken
        );

        let lifetime_conserved = self
            .accounted_balance
            .checked_add(self.lifetime_processed_total()?)
            .ok_or(EngineError::MathOverflow)?;

        require!(
            lifetime_conserved == self.total_received,
            EngineError::AccountingInvariantBroken
        );

        let expected_buyback =
            Self::cumulative_target(self.epoch_received, self.buyback_bps);

        let expected_liquidity =
            Self::cumulative_target(self.epoch_received, self.liquidity_bps);

        let expected_development = self
            .epoch_received
            .checked_sub(expected_buyback)
            .and_then(|v| v.checked_sub(expected_liquidity))
            .ok_or(EngineError::MathOverflow)?;

        require!(
            self.epoch_buyback_allocated == expected_buyback
                && self.epoch_liquidity_allocated == expected_liquidity
                && self.epoch_development_allocated == expected_development,
            EngineError::AccountingInvariantBroken
        );

        Ok(())
    }

    pub fn validate_allocation(
        buyback_bps: u16,
        liquidity_bps: u16,
        development_bps: u16,
    ) -> Result<()> {
        let total = buyback_bps
            .checked_add(liquidity_bps)
            .and_then(|v| v.checked_add(development_bps))
            .ok_or(EngineError::MathOverflow)?;

        require!(
            total == BPS_DENOMINATOR,
            EngineError::InvalidAllocationTotal
        );

        Ok(())
    }

    pub fn validate_thresholds(
        buyback_threshold: u64,
        liquidity_threshold: u64,
        development_threshold: u64,
    ) -> Result<()> {
        require!(
            buyback_threshold > 0
                && liquidity_threshold > 0
                && development_threshold > 0,
            EngineError::InvalidThreshold
        );

        Ok(())
    }

    fn cumulative_target(
        received: u64,
        bps: u16,
    ) -> u64 {
        (
            (received as u128) * (bps as u128)
                / (BPS_DENOMINATOR as u128)
        ) as u64
    }

    pub fn reset_allocation_epoch(&mut self) {
        self.epoch_received = 0;
        self.epoch_buyback_allocated = 0;
        self.epoch_liquidity_allocated = 0;
        self.epoch_development_allocated = 0;
    }

    pub fn allocate_new_fees(
        &mut self,
        new_fees: u64,
    ) -> Result<(u64, u64, u64)> {
        self.assert_invariant()?;

        let next_epoch_received = self
            .epoch_received
            .checked_add(new_fees)
            .ok_or(EngineError::MathOverflow)?;

        let target_buyback =
            Self::cumulative_target(next_epoch_received, self.buyback_bps);

        let target_liquidity =
            Self::cumulative_target(next_epoch_received, self.liquidity_bps);

        // The third bucket receives only the cumulative integer remainder.
        // Because this is cumulative within a settings epoch, splitting one fee
        // deposit into many sync calls cannot change the final percentages.
        let target_development = next_epoch_received
            .checked_sub(target_buyback)
            .and_then(|v| v.checked_sub(target_liquidity))
            .ok_or(EngineError::MathOverflow)?;

        let buyback_amount = target_buyback
            .checked_sub(self.epoch_buyback_allocated)
            .ok_or(EngineError::AccountingInvariantBroken)?;

        let liquidity_amount = target_liquidity
            .checked_sub(self.epoch_liquidity_allocated)
            .ok_or(EngineError::AccountingInvariantBroken)?;

        let development_amount = target_development
            .checked_sub(self.epoch_development_allocated)
            .ok_or(EngineError::AccountingInvariantBroken)?;

        let allocated_now = buyback_amount
            .checked_add(liquidity_amount)
            .and_then(|v| v.checked_add(development_amount))
            .ok_or(EngineError::MathOverflow)?;

        require!(
            allocated_now == new_fees,
            EngineError::AccountingInvariantBroken
        );

        self.buyback_reserve = self
            .buyback_reserve
            .checked_add(buyback_amount)
            .ok_or(EngineError::MathOverflow)?;

        self.liquidity_reserve = self
            .liquidity_reserve
            .checked_add(liquidity_amount)
            .ok_or(EngineError::MathOverflow)?;

        self.development_reserve = self
            .development_reserve
            .checked_add(development_amount)
            .ok_or(EngineError::MathOverflow)?;

        self.accounted_balance = self
            .accounted_balance
            .checked_add(new_fees)
            .ok_or(EngineError::MathOverflow)?;

        self.total_received = self
            .total_received
            .checked_add(new_fees)
            .ok_or(EngineError::MathOverflow)?;

        self.epoch_received = next_epoch_received;
        self.epoch_buyback_allocated = target_buyback;
        self.epoch_liquidity_allocated = target_liquidity;
        self.epoch_development_allocated = target_development;

        self.assert_invariant()?;

        Ok((buyback_amount, liquidity_amount, development_amount))
    }
}

#[account]
pub struct EngineVault {
    pub version: u8,
    pub bump: u8,
    pub reserved: [u8; 30],
}

impl EngineVault {
    pub const LEN: usize = 1 + 1 + 30;
}

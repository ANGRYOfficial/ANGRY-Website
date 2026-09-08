use anchor_lang::prelude::*;

use crate::{
    errors::EngineError,
    state::EngineConfig,
};

#[derive(Clone, Copy, Debug)]
pub struct FeeAllocation {
    pub new_fees: u64,
    pub buyback_amount: u64,
    pub liquidity_amount: u64,
    pub development_amount: u64,
}

pub fn spendable_vault_balance(vault_info: &AccountInfo) -> Result<u64> {
    let rent_floor = Rent::get()?.minimum_balance(vault_info.data_len());

    vault_info
        .lamports()
        .checked_sub(rent_floor)
        .ok_or_else(|| EngineError::InsufficientSpendableVaultBalance.into())
}

pub fn assert_vault_backing(
    config: &EngineConfig,
    vault_info: &AccountInfo,
) -> Result<u64> {
    config.assert_invariant()?;

    let spendable = spendable_vault_balance(vault_info)?;

    require!(
        spendable >= config.accounted_balance,
        EngineError::AccountingBalanceExceedsVault
    );

    Ok(spendable)
}

pub fn pending_fee_balance(
    config: &EngineConfig,
    vault_info: &AccountInfo,
) -> Result<u64> {
    let spendable = assert_vault_backing(config, vault_info)?;

    spendable
        .checked_sub(config.accounted_balance)
        .ok_or_else(|| EngineError::MathOverflow.into())
}

pub fn sync_pending_fees(
    config: &mut EngineConfig,
    vault_info: &AccountInfo,
) -> Result<Option<FeeAllocation>> {
    let new_fees = pending_fee_balance(config, vault_info)?;

    if new_fees == 0 {
        return Ok(None);
    }

    let (buyback_amount, liquidity_amount, development_amount) =
        config.allocate_new_fees(new_fees)?;

    Ok(Some(FeeAllocation {
        new_fees,
        buyback_amount,
        liquidity_amount,
        development_amount,
    }))
}

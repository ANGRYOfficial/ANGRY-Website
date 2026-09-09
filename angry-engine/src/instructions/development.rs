use anchor_lang::prelude::*;

use crate::{
    accounting::{
        spendable_vault_balance,
        sync_pending_fees,
        vault_accounted_balance,
    },
    errors::EngineError,
    events::DevelopmentSettled,
    instructions::sync_fees::emit_sync_event,
    SettleDevelopment,
};

pub fn handler(ctx: Context<SettleDevelopment>) -> Result<()> {
    let config_key = ctx.accounts.config.key();
    let vault_key = ctx.accounts.vault.key();
    let vault_info = ctx.accounts.vault.to_account_info();
    let development_info =
        ctx.accounts.development_wallet.to_account_info();

    let config = &mut ctx.accounts.config;

    require!(!config.paused, EngineError::EnginePaused);

    // Lazy sync: account new creator fees inside this same processing
    // transaction. No mandatory sync transaction is required beforehand.
    if let Some(allocation) =
        sync_pending_fees(config, &vault_info)?
    {
        emit_sync_event(
            config_key,
            config,
            vault_key,
            allocation,
        )?;
    }

    require!(
        config.development_reserve >= config.development_threshold,
        EngineError::DevelopmentThresholdNotReached
    );

    // Settle the whole accumulated development reserve in one batch.
    let amount = config.development_reserve;
    let spendable_balance = spendable_vault_balance(&vault_info)?;

    require!(
        spendable_balance >= vault_accounted_balance(config)?,
        EngineError::AccountingBalanceExceedsVault
    );

    require!(
        spendable_balance >= amount,
        EngineError::InsufficientSpendableVaultBalance
    );

    **vault_info.try_borrow_mut_lamports()? = vault_info
        .lamports()
        .checked_sub(amount)
        .ok_or(EngineError::MathOverflow)?;

    **development_info.try_borrow_mut_lamports()? = development_info
        .lamports()
        .checked_add(amount)
        .ok_or(EngineError::MathOverflow)?;

    config.development_reserve = 0;

    config.accounted_balance = config
        .accounted_balance
        .checked_sub(amount)
        .ok_or(EngineError::MathOverflow)?;

    config.total_development_settled = config
        .total_development_settled
        .checked_add(amount)
        .ok_or(EngineError::MathOverflow)?;

    config.assert_invariant()?;

    emit!(DevelopmentSettled {
        config: config_key,
        vault: vault_key,
        development_wallet: ctx.accounts.development_wallet.key(),
        amount,
        remaining_accounted_balance: config.accounted_balance,
        total_development_settled: config.total_development_settled,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

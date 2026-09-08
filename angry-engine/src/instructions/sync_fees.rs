use anchor_lang::prelude::*;

use crate::{
    accounting::{sync_pending_fees, FeeAllocation},
    constants::VAULT_SEED,
    errors::EngineError,
    events::FeesSynced,
    state::{EngineConfig, EngineVault},
};

#[derive(Accounts)]
pub struct SyncFees<'info> {
    #[account(
        mut,
        has_one = authority
    )]
    pub config: Account<'info, EngineConfig>,

    pub authority: Signer<'info>,

    #[account(
        seeds = [
            VAULT_SEED,
            config.key().as_ref(),
        ],
        bump = config.vault_bump
    )]
    pub vault: Account<'info, EngineVault>,
}

pub fn emit_sync_event(
    config_key: Pubkey,
    config: &EngineConfig,
    vault_key: Pubkey,
    allocation: FeeAllocation,
) -> Result<()> {
    emit!(FeesSynced {
        config: config_key,
        vault: vault_key,
        new_fees: allocation.new_fees,
        buyback_amount: allocation.buyback_amount,
        liquidity_amount: allocation.liquidity_amount,
        development_amount: allocation.development_amount,
        buyback_reserve: config.buyback_reserve,
        liquidity_reserve: config.liquidity_reserve,
        development_reserve: config.development_reserve,
        accounted_balance: config.accounted_balance,
        total_received: config.total_received,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

pub fn handler(ctx: Context<SyncFees>) -> Result<()> {
    // Optional/manual accounting only. It is allowed while paused because it
    // moves no funds. Processing instructions perform lazy sync themselves.
    let config_key = ctx.accounts.config.key();
    let vault_key = ctx.accounts.vault.key();
    let vault_info = ctx.accounts.vault.to_account_info();
    let config = &mut ctx.accounts.config;

    let allocation =
        sync_pending_fees(config, &vault_info)?
            .ok_or(EngineError::NoNewFees)?;

    emit_sync_event(
        config_key,
        config,
        vault_key,
        allocation,
    )
}

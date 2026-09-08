use anchor_lang::prelude::*;

use crate::{
    constants::{CONFIG_SEED, ENGINE_VERSION, VAULT_SEED},
    errors::EngineError,
    events::EngineInitialized,
    state::{EngineConfig, EngineVault},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeEngineArgs {
    pub project: Pubkey,

    pub buyback_bps: u16,
    pub liquidity_bps: u16,
    pub development_bps: u16,

    pub buyback_threshold: u64,
    pub liquidity_threshold: u64,
    pub development_threshold: u64,
}

#[derive(Accounts)]
#[instruction(args: InitializeEngineArgs)]
pub struct InitializeEngine<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    // A System-owned destination prevents configuring a program data account
    // that cannot receive direct SOL settlement.
    pub development_wallet: SystemAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + EngineConfig::LEN,
        seeds = [
            CONFIG_SEED,
            authority.key().as_ref(),
            args.project.as_ref(),
        ],
        bump
    )]
    pub config: Account<'info, EngineConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + EngineVault::LEN,
        seeds = [
            VAULT_SEED,
            config.key().as_ref(),
        ],
        bump
    )]
    pub vault: Account<'info, EngineVault>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeEngine>,
    args: InitializeEngineArgs,
) -> Result<()> {
    require!(
        args.project != Pubkey::default(),
        EngineError::InvalidProject
    );

    EngineConfig::validate_allocation(
        args.buyback_bps,
        args.liquidity_bps,
        args.development_bps,
    )?;

    EngineConfig::validate_thresholds(
        args.buyback_threshold,
        args.liquidity_threshold,
        args.development_threshold,
    )?;

    let config = &mut ctx.accounts.config;

    config.authority = ctx.accounts.authority.key();
    config.seed_authority = ctx.accounts.authority.key();
    config.pending_authority = Pubkey::default();

    config.project = args.project;
    config.development_wallet = ctx.accounts.development_wallet.key();

    config.buyback_bps = args.buyback_bps;
    config.liquidity_bps = args.liquidity_bps;
    config.development_bps = args.development_bps;

    config.buyback_threshold = args.buyback_threshold;
    config.liquidity_threshold = args.liquidity_threshold;
    config.development_threshold = args.development_threshold;

    config.buyback_reserve = 0;
    config.liquidity_reserve = 0;
    config.development_reserve = 0;

    config.accounted_balance = 0;
    config.total_received = 0;
    config.total_development_settled = 0;
    config.total_buyback_processed = 0;
    config.total_liquidity_deployed = 0;

    config.epoch_received = 0;
    config.epoch_buyback_allocated = 0;
    config.epoch_liquidity_allocated = 0;
    config.epoch_development_allocated = 0;

    config.paused = false;
    config.version = ENGINE_VERSION;
    config.config_bump = ctx.bumps.config;
    config.vault_bump = ctx.bumps.vault;
    config.reserved = [0u8; 256];

    let vault = &mut ctx.accounts.vault;
    vault.version = ENGINE_VERSION;
    vault.bump = ctx.bumps.vault;
    vault.reserved = [0u8; 30];

    config.assert_invariant()?;

    emit!(EngineInitialized {
        config: config.key(),
        vault: vault.key(),
        authority: config.authority,
        project: config.project,
        development_wallet: config.development_wallet,
        buyback_bps: config.buyback_bps,
        liquidity_bps: config.liquidity_bps,
        development_bps: config.development_bps,
        buyback_threshold: config.buyback_threshold,
        liquidity_threshold: config.liquidity_threshold,
        development_threshold: config.development_threshold,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

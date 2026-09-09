use anchor_lang::{prelude::*, system_program};

use crate::{
    constants::ENGINE_VERSION,
    errors::EngineError,
    events::EngineInitialized,
    state::{EngineConfig, EngineVault},
    InitializeEngine,
    InitializeEngineArgs,
};

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

    // The Liquidity Authority is a deterministic, data-empty System PDA.
    // It receives a one-time rent buffer paid by the Engine authority.
    // This rent buffer is infrastructure funding and is NEVER included in
    // creator-fee accounting or liquidity_staged.
    let liquidity_authority_info =
        ctx.accounts.liquidity_authority.to_account_info();

    require!(
        *liquidity_authority_info.owner == system_program::ID
            && liquidity_authority_info.data_is_empty(),
        EngineError::InvalidLiquidityAuthorityOwner
    );

    let minimum_rent = Rent::get()?.minimum_balance(0);
    let current_balance = liquidity_authority_info.lamports();

    if current_balance < minimum_rent {
        let rent_top_up = minimum_rent
            .checked_sub(current_balance)
            .ok_or(EngineError::MathOverflow)?;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: liquidity_authority_info.clone(),
                },
            ),
            rent_top_up,
        )?;
    }

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
    config.liquidity_staged = 0;
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
    config.reserved = [0u8; 248];

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

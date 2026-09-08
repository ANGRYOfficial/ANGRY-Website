use anchor_lang::prelude::*;

use crate::{
    accounting::{assert_vault_backing, sync_pending_fees},
    constants::VAULT_SEED,
    errors::EngineError,
    events::{
        AuthorityTransferAccepted,
        AuthorityTransferCancelled,
        AuthorityTransferProposed,
        EnginePauseChanged,
        EngineSettingsUpdated,
    },
    instructions::sync_fees::emit_sync_event,
    state::{EngineConfig, EngineVault},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateEngineSettingsArgs {
    pub buyback_bps: u16,
    pub liquidity_bps: u16,
    pub development_bps: u16,

    pub buyback_threshold: u64,
    pub liquidity_threshold: u64,
    pub development_threshold: u64,
}

#[derive(Accounts)]
pub struct PauseEngine<'info> {
    #[account(
        mut,
        has_one = authority
    )]
    pub config: Account<'info, EngineConfig>,

    pub authority: Signer<'info>,
}

pub fn pause_engine_handler(ctx: Context<PauseEngine>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(
        !config.paused,
        EngineError::PauseStateUnchanged
    );

    // Emergency pause intentionally does not depend on accounting or vault
    // health. It must remain usable when something is wrong.
    config.paused = true;

    emit!(EnginePauseChanged {
        config: config.key(),
        paused: true,
        authority: ctx.accounts.authority.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UnpauseEngine<'info> {
    #[account(
        mut,
        has_one = authority
    )]
    pub config: Account<'info, EngineConfig>,

    #[account(
        seeds = [
            VAULT_SEED,
            config.key().as_ref(),
        ],
        bump = config.vault_bump
    )]
    pub vault: Account<'info, EngineVault>,

    pub authority: Signer<'info>,
}

pub fn unpause_engine_handler(ctx: Context<UnpauseEngine>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(
        config.paused,
        EngineError::PauseStateUnchanged
    );

    // Unlike emergency pause, unpause requires both internal accounting health
    // and real SOL backing for every currently accounted reserve.
    assert_vault_backing(
        config,
        &ctx.accounts.vault.to_account_info(),
    )?;

    config.paused = false;

    emit!(EnginePauseChanged {
        config: config.key(),
        paused: false,
        authority: ctx.accounts.authority.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateEngineSettings<'info> {
    #[account(
        mut,
        has_one = authority
    )]
    pub config: Account<'info, EngineConfig>,

    #[account(
        seeds = [
            VAULT_SEED,
            config.key().as_ref(),
        ],
        bump = config.vault_bump
    )]
    pub vault: Account<'info, EngineVault>,

    pub authority: Signer<'info>,

    pub new_development_wallet: SystemAccount<'info>,
}

pub fn update_settings_handler(
    ctx: Context<UpdateEngineSettings>,
    args: UpdateEngineSettingsArgs,
) -> Result<()> {
    let config_key = ctx.accounts.config.key();
    let vault_key = ctx.accounts.vault.key();
    let vault_info = ctx.accounts.vault.to_account_info();
    let config = &mut ctx.accounts.config;

    require!(config.paused, EngineError::EngineNotPaused);
    config.assert_invariant()?;

    // Lazy-sync all fees already received under the OLD BPS before changing
    // settings. This is atomic and avoids a separate mandatory sync transaction.
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

    config.development_wallet =
        ctx.accounts.new_development_wallet.key();

    config.buyback_bps = args.buyback_bps;
    config.liquidity_bps = args.liquidity_bps;
    config.development_bps = args.development_bps;

    config.buyback_threshold = args.buyback_threshold;
    config.liquidity_threshold = args.liquidity_threshold;
    config.development_threshold = args.development_threshold;

    // All pre-existing pending fees were allocated under the old settings.
    // Future fees begin a clean cumulative rounding epoch under the new BPS.
    config.reset_allocation_epoch();

    config.assert_invariant()?;

    emit!(EngineSettingsUpdated {
        config: config.key(),
        authority: ctx.accounts.authority.key(),
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

#[derive(Accounts)]
pub struct ProposeAuthority<'info> {
    #[account(
        mut,
        has_one = authority
    )]
    pub config: Account<'info, EngineConfig>,

    pub authority: Signer<'info>,
}

pub fn propose_authority_handler(
    ctx: Context<ProposeAuthority>,
    new_authority: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(config.paused, EngineError::EngineNotPaused);
    config.assert_invariant()?;

    require!(
        new_authority != Pubkey::default()
            && new_authority != config.authority,
        EngineError::InvalidNewAuthority
    );

    config.pending_authority = new_authority;

    emit!(AuthorityTransferProposed {
        config: config.key(),
        current_authority: config.authority,
        pending_authority: new_authority,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(mut)]
    pub config: Account<'info, EngineConfig>,

    pub pending_authority: Signer<'info>,
}

pub fn accept_authority_handler(
    ctx: Context<AcceptAuthority>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(config.paused, EngineError::EngineNotPaused);
    config.assert_invariant()?;

    require!(
        config.pending_authority != Pubkey::default(),
        EngineError::NoPendingAuthorityTransfer
    );

    require!(
        ctx.accounts.pending_authority.key()
            == config.pending_authority,
        EngineError::InvalidPendingAuthority
    );

    let previous_authority = config.authority;
    let new_authority = config.pending_authority;

    config.authority = new_authority;
    config.pending_authority = Pubkey::default();

    emit!(AuthorityTransferAccepted {
        config: config.key(),
        previous_authority,
        new_authority,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct CancelAuthorityTransfer<'info> {
    #[account(
        mut,
        has_one = authority
    )]
    pub config: Account<'info, EngineConfig>,

    pub authority: Signer<'info>,
}

pub fn cancel_authority_transfer_handler(
    ctx: Context<CancelAuthorityTransfer>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(config.paused, EngineError::EngineNotPaused);
    config.assert_invariant()?;

    require!(
        config.pending_authority != Pubkey::default(),
        EngineError::NoPendingAuthorityTransfer
    );

    let cancelled_pending_authority =
        config.pending_authority;

    config.pending_authority = Pubkey::default();

    emit!(AuthorityTransferCancelled {
        config: config.key(),
        authority: config.authority,
        cancelled_pending_authority,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

use anchor_lang::prelude::*;

pub mod accounting;
pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use constants::{CONFIG_SEED, VAULT_SEED};
use errors::EngineError;
use state::{EngineConfig, EngineVault};

declare_id!("NmWNEKmU9N7YWKB2QeBMUAJC1NxuiYwSo1dX4NrKo6C");

#[program]
pub mod angry_engine_clean {
    use super::*;

    pub fn initialize_engine(
        ctx: Context<InitializeEngine>,
        args: InitializeEngineArgs,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, args)
    }

    pub fn sync_fees(ctx: Context<SyncFees>) -> Result<()> {
        instructions::sync_fees::handler(ctx)
    }

    pub fn pause_engine(ctx: Context<PauseEngine>) -> Result<()> {
        instructions::admin::pause_engine_handler(ctx)
    }

    pub fn unpause_engine(ctx: Context<UnpauseEngine>) -> Result<()> {
        instructions::admin::unpause_engine_handler(ctx)
    }

    pub fn update_engine_settings(
        ctx: Context<UpdateEngineSettings>,
        args: UpdateEngineSettingsArgs,
    ) -> Result<()> {
        instructions::admin::update_settings_handler(ctx, args)
    }

    pub fn propose_authority(
        ctx: Context<ProposeAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::admin::propose_authority_handler(ctx, new_authority)
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        instructions::admin::accept_authority_handler(ctx)
    }

    pub fn cancel_authority_transfer(
        ctx: Context<CancelAuthorityTransfer>,
    ) -> Result<()> {
        instructions::admin::cancel_authority_transfer_handler(ctx)
    }

    pub fn settle_development(ctx: Context<SettleDevelopment>) -> Result<()> {
        instructions::development::handler(ctx)
    }
}

// Keep all Anchor #[derive(Accounts)] context structs at crate root.
// Anchor's #[program] macro generates crate-root __client_accounts_* modules;
// nesting these structs inside instruction modules can cause E0432 unresolved
// import errors in Anchor builds. Business logic remains modular in src/instructions/.

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

#[derive(Accounts)]
pub struct PauseEngine<'info> {
    #[account(
        mut,
        has_one = authority
    )]
    pub config: Account<'info, EngineConfig>,

    pub authority: Signer<'info>,
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

#[derive(Accounts)]
pub struct ProposeAuthority<'info> {
    #[account(
        mut,
        has_one = authority
    )]
    pub config: Account<'info, EngineConfig>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(mut)]
    pub config: Account<'info, EngineConfig>,

    pub pending_authority: Signer<'info>,
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

#[derive(Accounts)]
pub struct SettleDevelopment<'info> {
    #[account(mut)]
    pub config: Account<'info, EngineConfig>,

    #[account(
        mut,
        seeds = [
            VAULT_SEED,
            config.key().as_ref(),
        ],
        bump = config.vault_bump
    )]
    pub vault: Account<'info, EngineVault>,

    #[account(
        mut,
        address = config.development_wallet @ EngineError::InvalidDevelopmentWallet
    )]
    pub development_wallet: SystemAccount<'info>,
}

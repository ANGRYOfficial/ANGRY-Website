use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint as LegacyMint, Token, TokenAccount as LegacyTokenAccount},
    token_interface::{
        Mint as InterfaceMint,
        TokenAccount as InterfaceTokenAccount,
        TokenInterface,
    },
};

pub mod accounting;
pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use constants::{
    BUYBACK_AUTHORITY_SEED,
    CONFIG_SEED,
    PUMP_FEE_PROGRAM_ID,
    PUMPSWAP_PROGRAM_ID,
    VAULT_SEED,
    WSOL_MINT,
};
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

    pub fn execute_buyback_burn(
        ctx: Context<ExecuteBuybackBurn>,
        quote_amount_in: u64,
        min_base_amount_out: u64,
    ) -> Result<()> {
        instructions::buyback::handler(
            ctx,
            quote_amount_in,
            min_base_amount_out,
        )
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

#[derive(Accounts)]
pub struct ExecuteBuybackBurn<'info> {
    #[account(
        mut,
        has_one = authority
    )]
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

    pub authority: Signer<'info>,

    /// CHECK: deterministic System-owned PDA used only as the PumpSwap user/
    /// token-account authority. Its seeds and owner are verified by this program.
    #[account(
        mut,
        seeds = [
            BUYBACK_AUTHORITY_SEED,
            config.key().as_ref(),
        ],
        bump
    )]
    pub buyback_authority: UncheckedAccount<'info>,

    /// CHECK: PumpSwap validates the Pool account; ANGRY additionally verifies
    /// its owner and base/quote mint fields before moving creator-fee SOL.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: validated against PumpSwap's canonical global_config PDA.
    pub global_config: UncheckedAccount<'info>,

    #[account(mut)]
    pub base_mint: InterfaceAccount<'info, InterfaceMint>,

    #[account(address = WSOL_MINT @ EngineError::InvalidBuybackQuoteMint)]
    pub quote_mint: Account<'info, LegacyMint>,

    #[account(mut)]
    pub buyback_base_token_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    #[account(mut)]
    pub buyback_wsol_account: Account<'info, LegacyTokenAccount>,

    /// CHECK: PumpSwap validates these pool vaults against Pool state.
    #[account(mut)]
    pub pool_base_token_account: UncheckedAccount<'info>,

    /// CHECK: PumpSwap validates these pool vaults against Pool state.
    #[account(mut)]
    pub pool_quote_token_account: UncheckedAccount<'info>,

    /// CHECK: PumpSwap validates this recipient against GlobalConfig.
    pub protocol_fee_recipient: UncheckedAccount<'info>,

    /// CHECK: PumpSwap validates/initializes the canonical quote ATA if needed.
    #[account(mut)]
    pub protocol_fee_recipient_token_account: UncheckedAccount<'info>,

    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    /// CHECK: validated against PumpSwap's __event_authority PDA.
    pub pump_event_authority: UncheckedAccount<'info>,

    /// CHECK: fixed official PumpSwap program ID and executable constraint.
    #[account(address = PUMPSWAP_PROGRAM_ID, executable)]
    pub pump_swap_program: UncheckedAccount<'info>,

    /// CHECK: PumpSwap validates/initializes the creator vault ATA if needed.
    #[account(mut)]
    pub coin_creator_vault_ata: UncheckedAccount<'info>,

    /// CHECK: PumpSwap validates the creator vault authority from Pool state.
    pub coin_creator_vault_authority: UncheckedAccount<'info>,

    /// CHECK: validated against PumpSwap global_volume_accumulator PDA.
    pub global_volume_accumulator: UncheckedAccount<'info>,

    /// CHECK: validated against the buyback PDA's user_volume_accumulator PDA.
    #[account(mut)]
    pub user_volume_accumulator: UncheckedAccount<'info>,

    /// CHECK: validated against Pump Fee fee_config PDA for PumpSwap.
    pub fee_config: UncheckedAccount<'info>,

    /// CHECK: fixed official Pump Fee program ID and executable constraint.
    #[account(address = PUMP_FEE_PROGRAM_ID, executable)]
    pub fee_program: UncheckedAccount<'info>,

    /// CHECK: validated as [b"pool-v2", base_mint] under PumpSwap.
    pub pool_v2: UncheckedAccount<'info>,

    /// CHECK: must be one of Pump's 8 official breaking fee recipients.
    pub breaking_fee_recipient: UncheckedAccount<'info>,

    /// CHECK: validated as the breaking recipient's canonical WSOL ATA.
    #[account(mut)]
    pub breaking_fee_recipient_quote_ata: UncheckedAccount<'info>,
}

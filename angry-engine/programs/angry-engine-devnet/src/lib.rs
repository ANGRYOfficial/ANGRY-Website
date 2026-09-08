use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    system_instruction,
};
use anchor_spl::token::{
    self,
    Burn,
    Mint,
    SyncNative,
    Token,
    TokenAccount,
};

use anchor_spl::token_interface::{
    Mint as InterfaceMint,
    TokenAccount as InterfaceTokenAccount,
    TokenInterface,
};

declare_id!("Asv68hEx77m6yaoKYnMUym1t7MfxidTkZyMh6Ynip4Zt");

const BPS_DENOMINATOR: u16 = 10_000;
const BUYBACK_BURN_BPS: u16 = 4_000; // 40%
const LIQUIDITY_BPS: u16 = 4_000; // 40%
const DEVELOPMENT_BPS: u16 = 2_000; // 20%

// Official PumpSwap program ID:
// pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
const PUMPSWAP_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    12, 20, 222, 252, 130, 94, 198, 118,
    148, 37, 8, 24, 187, 101, 64, 101,
    244, 41, 141, 49, 86, 213, 113, 180,
    212, 248, 9, 12, 24, 233, 168, 99,
]);

// PumpSwap buy_exact_quote_in instruction discriminator.
const PUMPSWAP_BUY_EXACT_QUOTE_IN_DISCRIMINATOR: [u8; 8] = [
    198, 46, 21, 82, 180, 217, 232, 112,
];

#[program]
pub mod angry_engine_devnet {
    use super::*;

    pub fn initialize_engine(ctx: Context<InitializeEngine>) -> Result<()> {
        let total_bps = BUYBACK_BURN_BPS
            .checked_add(LIQUIDITY_BPS)
            .and_then(|value| value.checked_add(DEVELOPMENT_BPS))
            .ok_or(AngryEngineError::MathOverflow)?;

        require!(
            total_bps == BPS_DENOMINATOR,
            AngryEngineError::InvalidAllocation
        );

        let config = &mut ctx.accounts.config;
        let vault = &mut ctx.accounts.vault;

        config.authority = ctx.accounts.authority.key();
        config.development_wallet = ctx.accounts.development_wallet.key();
        config.vault = vault.key();

        config.buyback_burn_bps = BUYBACK_BURN_BPS;
        config.liquidity_bps = LIQUIDITY_BPS;
        config.development_bps = DEVELOPMENT_BPS;

        config.paused = false;
        config.bump = ctx.bumps.config;

        vault.config = config.key();

        vault.total_received = 0;
        vault.buyback_burn_reserve = 0;
        vault.liquidity_reserve = 0;
        vault.development_reserve = 0;

        vault.total_processed = 0;
        vault.accounted_balance = 0;

        vault.bump = ctx.bumps.vault;

        msg!("ANGRY Engine initialized");
        msg!("ANGRY Engine Vault: {}", vault.key());
        msg!("Buyback & Burn: {} bps", BUYBACK_BURN_BPS);
        msg!("Liquidity: {} bps", LIQUIDITY_BPS);
        msg!("Development: {} bps", DEVELOPMENT_BPS);

        Ok(())
    }

    pub fn sync_fees(ctx: Context<SyncFees>) -> Result<()> {
        require!(
            !ctx.accounts.config.paused,
            AngryEngineError::EnginePaused
        );

        let vault_info = ctx.accounts.vault.to_account_info();

        let rent = Rent::get()?;
        let rent_minimum =
            rent.minimum_balance(8 + EngineVault::LEN);

        let current_lamports = vault_info.lamports();

        let spendable_balance = current_lamports
            .checked_sub(rent_minimum)
            .ok_or(AngryEngineError::InvalidVaultBalance)?;

        let vault = &mut ctx.accounts.vault;

        require!(
            spendable_balance >= vault.accounted_balance,
            AngryEngineError::InvalidVaultBalance
        );

        let new_fees = spendable_balance
            .checked_sub(vault.accounted_balance)
            .ok_or(AngryEngineError::MathOverflow)?;

        require!(
            new_fees > 0,
            AngryEngineError::NoNewFees
        );

        let buyback_burn_amount = calculate_bps(
            new_fees,
            ctx.accounts.config.buyback_burn_bps,
        )?;

        let liquidity_amount = calculate_bps(
            new_fees,
            ctx.accounts.config.liquidity_bps,
        )?;

        // Any tiny integer rounding remainder goes to Development.
        // This guarantees every lamport is accounted for.
        let development_amount = new_fees
            .checked_sub(buyback_burn_amount)
            .and_then(|value| value.checked_sub(liquidity_amount))
            .ok_or(AngryEngineError::MathOverflow)?;

        vault.total_received = vault
            .total_received
            .checked_add(new_fees)
            .ok_or(AngryEngineError::MathOverflow)?;

        vault.buyback_burn_reserve = vault
            .buyback_burn_reserve
            .checked_add(buyback_burn_amount)
            .ok_or(AngryEngineError::MathOverflow)?;

        vault.liquidity_reserve = vault
            .liquidity_reserve
            .checked_add(liquidity_amount)
            .ok_or(AngryEngineError::MathOverflow)?;

        vault.development_reserve = vault
            .development_reserve
            .checked_add(development_amount)
            .ok_or(AngryEngineError::MathOverflow)?;

        vault.total_processed = vault
            .total_processed
            .checked_add(new_fees)
            .ok_or(AngryEngineError::MathOverflow)?;

        vault.accounted_balance = spendable_balance;

        let timestamp = Clock::get()?.unix_timestamp;

        emit!(FeesSynced {
            config: ctx.accounts.config.key(),
            vault: vault.key(),
            new_fees,
            buyback_burn_amount,
            liquidity_amount,
            development_amount,
            total_received: vault.total_received,
            total_processed: vault.total_processed,
            timestamp,
        });

        msg!("ANGRY Engine processed new creator fees");
        msg!("New fees: {} lamports", new_fees);
        msg!("Buyback & Burn reserve: {}", buyback_burn_amount);
        msg!("Liquidity reserve: {}", liquidity_amount);
        msg!("Development reserve: {}", development_amount);

        Ok(())
    }

    pub fn settle_development(
        ctx: Context<SettleDevelopment>,
    ) -> Result<()> {
        require!(
            !ctx.accounts.config.paused,
            AngryEngineError::EnginePaused
        );

        let amount = ctx.accounts.vault.development_reserve;

        require!(
            amount > 0,
            AngryEngineError::NoDevelopmentReserve
        );

        let vault_info = ctx.accounts.vault.to_account_info();
        let development_info =
            ctx.accounts.development_wallet.to_account_info();

        let rent = Rent::get()?;
        let rent_minimum =
            rent.minimum_balance(8 + EngineVault::LEN);

        let current_vault_lamports = vault_info.lamports();

        let spendable_balance = current_vault_lamports
            .checked_sub(rent_minimum)
            .ok_or(AngryEngineError::InvalidVaultBalance)?;

        require!(
            spendable_balance >= amount,
            AngryEngineError::InvalidVaultBalance
        );

        require!(
            ctx.accounts.vault.accounted_balance >= amount,
            AngryEngineError::InvalidVaultBalance
        );

        let new_vault_lamports = current_vault_lamports
            .checked_sub(amount)
            .ok_or(AngryEngineError::MathOverflow)?;

        let new_development_lamports = development_info
            .lamports()
            .checked_add(amount)
            .ok_or(AngryEngineError::MathOverflow)?;

        let new_accounted_balance = ctx
            .accounts
            .vault
            .accounted_balance
            .checked_sub(amount)
            .ok_or(AngryEngineError::MathOverflow)?;

        // Transfer lamports directly because the Vault PDA is owned
        // by this ANGRY Engine program.
        {
            let mut vault_lamports =
                vault_info.try_borrow_mut_lamports()?;
            **vault_lamports = new_vault_lamports;
        }

        {
            let mut development_lamports =
                development_info.try_borrow_mut_lamports()?;
            **development_lamports = new_development_lamports;
        }

        let vault = &mut ctx.accounts.vault;

        vault.development_reserve = 0;
        vault.accounted_balance = new_accounted_balance;

        let timestamp = Clock::get()?.unix_timestamp;

        emit!(DevelopmentSettled {
            config: ctx.accounts.config.key(),
            vault: vault.key(),
            development_wallet:
                ctx.accounts.development_wallet.key(),
            amount,
            remaining_development_reserve:
                vault.development_reserve,
            accounted_balance: vault.accounted_balance,
            timestamp,
        });

        msg!("ANGRY Engine development reserve settled");
        msg!("Development amount: {} lamports", amount);
        msg!(
            "Development wallet: {}",
            ctx.accounts.development_wallet.key()
        );
        msg!(
            "Remaining development reserve: {}",
            vault.development_reserve
        );
        msg!(
            "Accounted balance after settlement: {}",
            vault.accounted_balance
        );

        Ok(())
    }

    pub fn stage_buyback_sol(
        ctx: Context<StageBuybackSol>,
        amount: u64,
    ) -> Result<()> {
        require!(
            !ctx.accounts.config.paused,
            AngryEngineError::EnginePaused
        );

        require!(
            amount > 0,
            AngryEngineError::InvalidBuybackAmount
        );

        require!(
            ctx.accounts.vault.buyback_burn_reserve >= amount,
            AngryEngineError::BuybackAmountExceedsReserve
        );

        require!(
            ctx.accounts.vault.accounted_balance >= amount,
            AngryEngineError::InvalidVaultBalance
        );

        let vault_info = ctx.accounts.vault.to_account_info();
        let buyback_sol_info =
            ctx.accounts.buyback_sol_vault.to_account_info();

        let rent = Rent::get()?;
        let rent_minimum =
            rent.minimum_balance(8 + EngineVault::LEN);

        let current_vault_lamports = vault_info.lamports();

        let spendable_balance = current_vault_lamports
            .checked_sub(rent_minimum)
            .ok_or(AngryEngineError::InvalidVaultBalance)?;

        require!(
            spendable_balance >= amount,
            AngryEngineError::InvalidVaultBalance
        );

        let new_vault_lamports = current_vault_lamports
            .checked_sub(amount)
            .ok_or(AngryEngineError::MathOverflow)?;

        let new_buyback_sol_lamports = buyback_sol_info
            .lamports()
            .checked_add(amount)
            .ok_or(AngryEngineError::MathOverflow)?;

        let new_buyback_reserve = ctx
            .accounts
            .vault
            .buyback_burn_reserve
            .checked_sub(amount)
            .ok_or(AngryEngineError::MathOverflow)?;

        let new_accounted_balance = ctx
            .accounts
            .vault
            .accounted_balance
            .checked_sub(amount)
            .ok_or(AngryEngineError::MathOverflow)?;

        {
            let vault = &mut ctx.accounts.vault;
            vault.buyback_burn_reserve = new_buyback_reserve;
            vault.accounted_balance = new_accounted_balance;
        }

        {
            let mut vault_lamports =
                vault_info.try_borrow_mut_lamports()?;
            **vault_lamports = new_vault_lamports;
        }

        {
            let mut buyback_sol_lamports =
                buyback_sol_info.try_borrow_mut_lamports()?;
            **buyback_sol_lamports = new_buyback_sol_lamports;
        }

        let timestamp = Clock::get()?.unix_timestamp;

        emit!(BuybackSolStaged {
            config: ctx.accounts.config.key(),
            vault: ctx.accounts.vault.key(),
            buyback_sol_vault:
                ctx.accounts.buyback_sol_vault.key(),
            amount,
            remaining_buyback_burn_reserve:
                ctx.accounts.vault.buyback_burn_reserve,
            staged_buyback_sol_balance:
                buyback_sol_info.lamports(),
            accounted_balance:
                ctx.accounts.vault.accounted_balance,
            timestamp,
        });

        msg!("ANGRY Engine Buyback SOL staged");
        msg!("Staged amount: {} lamports", amount);
        msg!(
            "Remaining Buyback & Burn reserve: {}",
            ctx.accounts.vault.buyback_burn_reserve
        );
        msg!(
            "Buyback SOL Vault balance: {}",
            buyback_sol_info.lamports()
        );

        Ok(())
    }

    pub fn prepare_buyback_wsol(
        ctx: Context<PrepareBuybackWsol>,
        amount: u64,
    ) -> Result<()> {
        require!(
            !ctx.accounts.config.paused,
            AngryEngineError::EnginePaused
        );

        require!(
            amount > 0,
            AngryEngineError::InvalidBuybackAmount
        );

        let buyback_sol_info =
            ctx.accounts.buyback_sol_vault.to_account_info();

        require!(
            buyback_sol_info.lamports() >= amount,
            AngryEngineError::BuybackAmountExceedsStagedSol
        );

        let buyback_sol_bump =
            ctx.bumps.buyback_sol_vault;

        let buyback_sol_seeds: &[&[u8]] = &[
            b"angry-engine-buyback-sol",
            &[buyback_sol_bump],
        ];

        let signer_seeds = &[buyback_sol_seeds];

        let transfer_instruction =
            system_instruction::transfer(
                &ctx.accounts.buyback_sol_vault.key(),
                &ctx.accounts.buyback_wsol_account.key(),
                amount,
            );

        invoke_signed(
            &transfer_instruction,
            &[
                ctx.accounts
                    .buyback_sol_vault
                    .to_account_info(),
                ctx.accounts
                    .buyback_wsol_account
                    .to_account_info(),
                ctx.accounts
                    .system_program
                    .to_account_info(),
            ],
            signer_seeds,
        )?;

        let sync_accounts = SyncNative {
            account: ctx
                .accounts
                .buyback_wsol_account
                .to_account_info(),
        };

        let sync_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            sync_accounts,
        );

        token::sync_native(sync_ctx)?;

        ctx.accounts.buyback_wsol_account.reload()?;

        let remaining_staged_sol =
            ctx.accounts.buyback_sol_vault.lamports();

        let timestamp = Clock::get()?.unix_timestamp;

        emit!(BuybackWsolPrepared {
            config: ctx.accounts.config.key(),
            vault: ctx.accounts.vault.key(),
            buyback_sol_vault:
                ctx.accounts.buyback_sol_vault.key(),
            buyback_wsol_account:
                ctx.accounts.buyback_wsol_account.key(),
            amount,
            remaining_staged_sol,
            wsol_balance:
                ctx.accounts.buyback_wsol_account.amount,
            timestamp,
        });

        msg!("ANGRY Engine Buyback WSOL prepared");
        msg!("Wrapped amount: {} lamports", amount);
        msg!(
            "Remaining staged SOL: {}",
            remaining_staged_sol
        );
        msg!(
            "Buyback WSOL balance: {}",
            ctx.accounts.buyback_wsol_account.amount
        );

        Ok(())
    }

    pub fn burn_engine_tokens(
        mut ctx: Context<BurnEngineTokens>,
        amount: u64,
    ) -> Result<()> {
        require!(
            !ctx.accounts.config.paused,
            AngryEngineError::EnginePaused
        );

        require!(
            amount > 0,
            AngryEngineError::InvalidBurnAmount
        );

        require!(
            ctx.accounts.engine_token_account.amount >= amount,
            AngryEngineError::BurnAmountExceedsBalance
        );

        let vault_bump = ctx.accounts.vault.bump;

        let vault_seeds: &[&[u8]] = &[
            b"angry-engine-vault",
            &[vault_bump],
        ];

        let signer_seeds = &[vault_seeds];

        let cpi_accounts = Burn {
            mint: ctx.accounts.mint.to_account_info(),
            from: ctx.accounts.engine_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        token::burn(cpi_ctx, amount)?;

        ctx.accounts.engine_token_account.reload()?;
        ctx.accounts.mint.reload()?;

        let timestamp = Clock::get()?.unix_timestamp;

        emit!(TokensBurned {
            config: ctx.accounts.config.key(),
            vault: ctx.accounts.vault.key(),
            mint: ctx.accounts.mint.key(),
            engine_token_account:
                ctx.accounts.engine_token_account.key(),
            amount,
            remaining_engine_balance:
                ctx.accounts.engine_token_account.amount,
            remaining_supply:
                ctx.accounts.mint.supply,
            timestamp,
        });

        msg!("ANGRY Engine burned tokens");
        msg!("Burn amount: {} raw token units", amount);
        msg!(
            "Remaining Engine token balance: {}",
            ctx.accounts.engine_token_account.amount
        );
        msg!(
            "Remaining token supply: {}",
            ctx.accounts.mint.supply
        );

        Ok(())
    }
}

fn calculate_bps(amount: u64, bps: u16) -> Result<u64> {
    amount
        .checked_mul(bps as u64)
        .and_then(|value| value.checked_div(BPS_DENOMINATOR as u64))
        .ok_or(AngryEngineError::MathOverflow.into())
}

#[event]
pub struct FeesSynced {
    pub config: Pubkey,
    pub vault: Pubkey,

    pub new_fees: u64,

    pub buyback_burn_amount: u64,
    pub liquidity_amount: u64,
    pub development_amount: u64,

    pub total_received: u64,
    pub total_processed: u64,

    pub timestamp: i64,
}

#[event]
pub struct DevelopmentSettled {
    pub config: Pubkey,
    pub vault: Pubkey,
    pub development_wallet: Pubkey,

    pub amount: u64,
    pub remaining_development_reserve: u64,
    pub accounted_balance: u64,

    pub timestamp: i64,
}

#[event]
pub struct BuybackSolStaged {
    pub config: Pubkey,
    pub vault: Pubkey,
    pub buyback_sol_vault: Pubkey,

    pub amount: u64,
    pub remaining_buyback_burn_reserve: u64,
    pub staged_buyback_sol_balance: u64,
    pub accounted_balance: u64,

    pub timestamp: i64,
}

#[event]
pub struct BuybackWsolPrepared {
    pub config: Pubkey,
    pub vault: Pubkey,
    pub buyback_sol_vault: Pubkey,
    pub buyback_wsol_account: Pubkey,

    pub amount: u64,
    pub remaining_staged_sol: u64,
    pub wsol_balance: u64,

    pub timestamp: i64,
}

#[event]
pub struct TokensBurned {
    pub config: Pubkey,
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub engine_token_account: Pubkey,

    pub amount: u64,
    pub remaining_engine_balance: u64,
    pub remaining_supply: u64,

    pub timestamp: i64,
}

#[derive(Accounts)]
pub struct InitializeEngine<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK:
    /// Stored only as the development recipient address.
    pub development_wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + EngineConfig::LEN,
        seeds = [b"angry-engine-config"],
        bump
    )]
    pub config: Account<'info, EngineConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + EngineVault::LEN,
        seeds = [b"angry-engine-vault"],
        bump
    )]
    pub vault: Account<'info, EngineVault>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SyncFees<'info> {
    #[account(
        seeds = [b"angry-engine-config"],
        bump = config.bump,
        has_one = vault @ AngryEngineError::InvalidVault
    )]
    pub config: Account<'info, EngineConfig>,

    #[account(
        mut,
        seeds = [b"angry-engine-vault"],
        bump = vault.bump,
        constraint = vault.config == config.key()
            @ AngryEngineError::InvalidConfig
    )]
    pub vault: Account<'info, EngineVault>,
}

#[derive(Accounts)]
pub struct SettleDevelopment<'info> {
    #[account(
        seeds = [b"angry-engine-config"],
        bump = config.bump,
        has_one = vault @ AngryEngineError::InvalidVault,
        has_one = development_wallet
            @ AngryEngineError::InvalidDevelopmentWallet
    )]
    pub config: Account<'info, EngineConfig>,

    #[account(
        mut,
        seeds = [b"angry-engine-vault"],
        bump = vault.bump,
        constraint = vault.config == config.key()
            @ AngryEngineError::InvalidConfig
    )]
    pub vault: Account<'info, EngineVault>,

    /// CHECK:
    /// Must exactly match development_wallet stored in EngineConfig.
    #[account(mut)]
    pub development_wallet: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct StageBuybackSol<'info> {
    #[account(
        seeds = [b"angry-engine-config"],
        bump = config.bump,
        has_one = authority @ AngryEngineError::InvalidAuthority,
        has_one = vault @ AngryEngineError::InvalidVault
    )]
    pub config: Account<'info, EngineConfig>,

    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"angry-engine-vault"],
        bump = vault.bump,
        constraint = vault.config == config.key()
            @ AngryEngineError::InvalidConfig
    )]
    pub vault: Account<'info, EngineVault>,

    /// CHECK:
    /// Deterministic System-owned PDA used only to stage
    /// the Buyback & Burn SOL allocation.
    #[account(
        mut,
        seeds = [b"angry-engine-buyback-sol"],
        bump,
        constraint =
            buyback_sol_vault.owner
                == &anchor_lang::system_program::ID
                @ AngryEngineError::InvalidBuybackSolVault,
        constraint =
            buyback_sol_vault.data_is_empty()
                @ AngryEngineError::InvalidBuybackSolVault
    )]
    pub buyback_sol_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PrepareBuybackWsol<'info> {
    #[account(
        seeds = [b"angry-engine-config"],
        bump = config.bump,
        has_one = authority @ AngryEngineError::InvalidAuthority,
        has_one = vault @ AngryEngineError::InvalidVault
    )]
    pub config: Account<'info, EngineConfig>,

    pub authority: Signer<'info>,

    #[account(
        seeds = [b"angry-engine-vault"],
        bump = vault.bump,
        constraint = vault.config == config.key()
            @ AngryEngineError::InvalidConfig
    )]
    pub vault: Account<'info, EngineVault>,

    /// CHECK:
    /// System-owned PDA holding staged Buyback SOL.
    #[account(
        mut,
        seeds = [b"angry-engine-buyback-sol"],
        bump,
        constraint =
            buyback_sol_vault.owner
                == &anchor_lang::system_program::ID
            @ AngryEngineError::InvalidBuybackSolVault,
        constraint =
            buyback_sol_vault.data_is_empty()
            @ AngryEngineError::InvalidBuybackSolVault
    )]
    pub buyback_sol_vault: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint =
            buyback_wsol_account.owner
                == buyback_sol_vault.key()
            @ AngryEngineError::InvalidBuybackWsolAccount,
        constraint =
            buyback_wsol_account.mint
                == wsol_mint.key()
            @ AngryEngineError::InvalidBuybackWsolAccount
    )]
    pub buyback_wsol_account:
        Account<'info, TokenAccount>,

    #[account(
        address =
            anchor_spl::token::spl_token::native_mint::ID
    )]
    pub wsol_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BurnEngineTokens<'info> {
    #[account(
        seeds = [b"angry-engine-config"],
        bump = config.bump,
        has_one = authority @ AngryEngineError::InvalidAuthority,
        has_one = vault @ AngryEngineError::InvalidVault
    )]
    pub config: Account<'info, EngineConfig>,

    pub authority: Signer<'info>,

    #[account(
        seeds = [b"angry-engine-vault"],
        bump = vault.bump,
        constraint = vault.config == config.key()
            @ AngryEngineError::InvalidConfig
    )]
    pub vault: Account<'info, EngineVault>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = engine_token_account.owner == vault.key()
            @ AngryEngineError::InvalidEngineTokenAccount,
        constraint = engine_token_account.mint == mint.key()
            @ AngryEngineError::InvalidEngineTokenAccount
    )]
    pub engine_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[account]
pub struct EngineConfig {
    pub authority: Pubkey,
    pub development_wallet: Pubkey,
    pub vault: Pubkey,

    pub buyback_burn_bps: u16,
    pub liquidity_bps: u16,
    pub development_bps: u16,

    pub paused: bool,
    pub bump: u8,
}

impl EngineConfig {
    pub const LEN: usize =
        32 +
        32 +
        32 +
        2 +
        2 +
        2 +
        1 +
        1;
}

#[account]
pub struct EngineVault {
    pub config: Pubkey,

    pub total_received: u64,
    pub buyback_burn_reserve: u64,
    pub liquidity_reserve: u64,
    pub development_reserve: u64,

    pub total_processed: u64,

    // Current spendable SOL balance already recognized by the Engine.
    // Every outgoing settlement must reduce this value too.
    pub accounted_balance: u64,

    pub bump: u8,
}

impl EngineVault {
    pub const LEN: usize =
        32 +
        8 +
        8 +
        8 +
        8 +
        8 +
        8 +
        1;
}

#[error_code]
pub enum AngryEngineError {
    #[msg("ANGRY Engine allocation must equal 100%.")]
    InvalidAllocation,

    #[msg("Math overflow.")]
    MathOverflow,

    #[msg("ANGRY Engine is paused.")]
    EnginePaused,

    #[msg("No new creator fees are available to process.")]
    NoNewFees,

    #[msg("Invalid ANGRY Engine vault.")]
    InvalidVault,

    #[msg("Invalid ANGRY Engine config.")]
    InvalidConfig,

    #[msg("Invalid vault balance.")]
    InvalidVaultBalance,

    #[msg("No Development reserve is available to settle.")]
    NoDevelopmentReserve,

    #[msg("Invalid Development wallet.")]
    InvalidDevelopmentWallet,

    #[msg("Invalid ANGRY Engine authority.")]
    InvalidAuthority,

    #[msg("Buyback staging amount must be greater than zero.")]
    InvalidBuybackAmount,

    #[msg("Buyback staging amount exceeds Buyback & Burn reserve.")]
    BuybackAmountExceedsReserve,

    #[msg("Invalid ANGRY Engine Buyback SOL Vault.")]
    InvalidBuybackSolVault,

    #[msg("Buyback amount exceeds staged Buyback SOL.")]
    BuybackAmountExceedsStagedSol,

    #[msg("Invalid ANGRY Engine Buyback WSOL account.")]
    InvalidBuybackWsolAccount,

    #[msg("Burn amount must be greater than zero.")]
    InvalidBurnAmount,

    #[msg("Burn amount exceeds Engine token balance.")]
    BurnAmountExceedsBalance,

    #[msg("Invalid Engine token account.")]
    InvalidEngineTokenAccount,
}

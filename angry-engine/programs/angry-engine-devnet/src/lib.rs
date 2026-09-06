use anchor_lang::prelude::*;

declare_id!("Asv68hEx77m6yaoKYnMUym1t7MfxidTkZyMh6Ynip4Zt");

const BPS_DENOMINATOR: u16 = 10_000;
const BUYBACK_BURN_BPS: u16 = 4_000; // 40%
const LIQUIDITY_BPS: u16 = 4_000;    // 40%
const DEVELOPMENT_BPS: u16 = 2_000;  // 20%

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

        msg!("ANGRY Engine processed new creator fees");
        msg!("New fees: {} lamports", new_fees);
        msg!("Buyback & Burn reserve: {}", buyback_burn_amount);
        msg!("Liquidity reserve: {}", liquidity_amount);
        msg!("Development reserve: {}", development_amount);

        Ok(())
    }
}

fn calculate_bps(amount: u64, bps: u16) -> Result<u64> {
    amount
        .checked_mul(bps as u64)
        .and_then(|value| value.checked_div(BPS_DENOMINATOR as u64))
        .ok_or(AngryEngineError::MathOverflow.into())
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
    // Future outgoing instructions will reduce this value accordingly.
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
}

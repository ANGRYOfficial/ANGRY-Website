use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111");

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

        // Accounting starts at zero.
        // No SOL is processed during initialization.
        vault.total_received = 0;
        vault.buyback_burn_reserve = 0;
        vault.liquidity_reserve = 0;
        vault.development_reserve = 0;
        vault.total_processed = 0;
        vault.bump = ctx.bumps.vault;

        msg!("ANGRY Engine initialized");
        msg!("ANGRY Engine Vault: {}", vault.key());
        msg!("Buyback & Burn: {} bps", BUYBACK_BURN_BPS);
        msg!("Liquidity: {} bps", LIQUIDITY_BPS);
        msg!("Development: {} bps", DEVELOPMENT_BPS);

        Ok(())
    }
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
        32 + // authority
        32 + // development_wallet
        32 + // vault
        2 +  // buyback_burn_bps
        2 +  // liquidity_bps
        2 +  // development_bps
        1 +  // paused
        1;   // bump
}

#[account]
pub struct EngineVault {
    pub config: Pubkey,

    // These fields are accounting records.
    // The actual SOL stays inside this PDA account
    // until future processing instructions are executed.
    pub total_received: u64,
    pub buyback_burn_reserve: u64,
    pub liquidity_reserve: u64,
    pub development_reserve: u64,
    pub total_processed: u64,

    pub bump: u8,
}

impl EngineVault {
    pub const LEN: usize =
        32 + // config
        8 +  // total_received
        8 +  // buyback_burn_reserve
        8 +  // liquidity_reserve
        8 +  // development_reserve
        8 +  // total_processed
        1;   // bump
}

#[error_code]
pub enum AngryEngineError {
    #[msg("ANGRY Engine allocation must equal 100%.")]
    InvalidAllocation,

    #[msg("Math overflow.")]
    MathOverflow,
}

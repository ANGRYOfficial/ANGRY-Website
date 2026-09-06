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

        config.authority = ctx.accounts.authority.key();
        config.development_wallet = ctx.accounts.development_wallet.key();

        config.buyback_burn_bps = BUYBACK_BURN_BPS;
        config.liquidity_bps = LIQUIDITY_BPS;
        config.development_bps = DEVELOPMENT_BPS;

        config.paused = false;
        config.bump = ctx.bumps.config;

        msg!("ANGRY Engine initialized");
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

    /// CHECK: Stored only as the development recipient address.
    pub development_wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + EngineConfig::LEN,
        seeds = [b"angry-engine-config"],
        bump
    )]
    pub config: Account<'info, EngineConfig>,

    pub system_program: Program<'info, System>,
}

#[account]
pub struct EngineConfig {
    pub authority: Pubkey,
    pub development_wallet: Pubkey,

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
        2 +
        2 +
        2 +
        1 +
        1;
}

#[error_code]
pub enum AngryEngineError {
    #[msg("ANGRY Engine allocation must equal 100%.")]
    InvalidAllocation,

    #[msg("Math overflow.")]
    MathOverflow,
}

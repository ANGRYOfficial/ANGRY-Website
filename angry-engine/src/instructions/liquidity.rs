use anchor_lang::{prelude::*, system_program};

use crate::{
    accounting::{
        assert_vault_backing,
        sync_pending_fees,
    },
    errors::EngineError,
    events::LiquidityStaged,
    instructions::sync_fees::emit_sync_event,
    StageLiquidity,
};

pub fn handler(
    mut ctx: Context<StageLiquidity>,
) -> Result<()> {
    require!(
        !ctx.accounts.config.paused,
        EngineError::EnginePaused
    );

    let config_key = ctx.accounts.config.key();
    let vault_key = ctx.accounts.vault.key();
    let vault_info = ctx.accounts.vault.to_account_info();

    // Lazy-sync creator fees before staging liquidity.
    if let Some(allocation) =
        sync_pending_fees(
            &mut ctx.accounts.config,
            &vault_info,
        )?
    {
        emit_sync_event(
            config_key,
            &ctx.accounts.config,
            vault_key,
            allocation,
        )?;
    }

    require!(
        ctx.accounts.config.liquidity_reserve
            >= ctx.accounts.config.liquidity_threshold,
        EngineError::LiquidityThresholdNotReached
    );

    // R1 stages the whole accumulated liquidity reserve.
    let amount = ctx.accounts.config.liquidity_reserve;

    let spendable =
        assert_vault_backing(
            &ctx.accounts.config,
            &vault_info,
        )?;

    require!(
        spendable >= amount,
        EngineError::InsufficientSpendableVaultBalance
    );

    let liquidity_authority_info =
        ctx.accounts.liquidity_authority.to_account_info();

    require!(
        *liquidity_authority_info.owner == system_program::ID
            && liquidity_authority_info.data_is_empty(),
        EngineError::InvalidLiquidityAuthorityOwner
    );

    // Rent is infrastructure funding and must remain separate from
    // creator-fee liquidity accounting. Before accepting another staged
    // batch, the PDA must already back both its rent buffer and every
    // previously staged creator-fee lamport.
    let minimum_rent = Rent::get()?.minimum_balance(0);
    let required_before = minimum_rent
        .checked_add(ctx.accounts.config.liquidity_staged)
        .ok_or(EngineError::MathOverflow)?;

    require!(
        liquidity_authority_info.lamports() >= required_before,
        EngineError::InsufficientLiquidityAuthorityRentBuffer
    );

    // Direct lamport movement happens at the end of the instruction.
    // No CPI is performed after this point.
    **vault_info.try_borrow_mut_lamports()? = vault_info
        .lamports()
        .checked_sub(amount)
        .ok_or(EngineError::MathOverflow)?;

    **liquidity_authority_info.try_borrow_mut_lamports()? =
        liquidity_authority_info
            .lamports()
            .checked_add(amount)
            .ok_or(EngineError::MathOverflow)?;

    let config = &mut ctx.accounts.config;

    config.liquidity_reserve = 0;

    config.liquidity_staged = config
        .liquidity_staged
        .checked_add(amount)
        .ok_or(EngineError::MathOverflow)?;

    let required_after = minimum_rent
        .checked_add(config.liquidity_staged)
        .ok_or(EngineError::MathOverflow)?;

    require!(
        liquidity_authority_info.lamports() >= required_after,
        EngineError::InsufficientLiquidityAuthorityRentBuffer
    );

    // accounted_balance intentionally does NOT decrease here.
    // The creator-fee SOL is still controlled by ANGRY Engine,
    // only moved from EngineVault to the liquidity PDA.
    config.assert_invariant()?;

    // Physical EngineVault backing must now equal accounting
    // excluding the SOL that is staged under the liquidity PDA.
    assert_vault_backing(config, &vault_info)?;

    emit!(LiquidityStaged {
        config: config_key,
        vault: vault_key,
        liquidity_authority:
            ctx.accounts.liquidity_authority.key(),
        amount,
        liquidity_staged: config.liquidity_staged,
        remaining_liquidity_reserve:
            config.liquidity_reserve,
        remaining_accounted_balance:
            config.accounted_balance,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

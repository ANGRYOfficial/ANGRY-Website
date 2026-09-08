use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
        system_instruction,
        system_program,
    },
};
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token::{self, SyncNative},
    token_interface::{self, Burn},
};

use crate::{
    accounting::{assert_vault_backing, sync_pending_fees},
    constants::{
        BUYBACK_AUTHORITY_SEED,
        PUMP_FEE_PROGRAM_ID,
        PUMPSWAP_BREAKING_FEE_RECIPIENTS,
        PUMPSWAP_BUY_EXACT_QUOTE_IN_DISCRIMINATOR,
        PUMPSWAP_POOL_DISCRIMINATOR,
        PUMPSWAP_PROGRAM_ID,
        WSOL_MINT,
    },
    errors::EngineError,
    events::BuybackBurnExecuted,
    instructions::sync_fees::emit_sync_event,
    ExecuteBuybackBurn,
};

const PUMPSWAP_POOL_BASE_MINT_OFFSET: usize = 43;
const PUMPSWAP_POOL_QUOTE_MINT_OFFSET: usize = 75;
const PUMPSWAP_POOL_BASE_TOKEN_ACCOUNT_OFFSET: usize = 139;
const PUMPSWAP_POOL_QUOTE_TOKEN_ACCOUNT_OFFSET: usize = 171;
const PUMPSWAP_POOL_COIN_CREATOR_OFFSET: usize = 211;
const PUBKEY_BYTES: usize = 32;

fn account_pubkey_at(data: &[u8], offset: usize) -> Result<Pubkey> {
    require!(
        data.len() >= offset + PUBKEY_BYTES,
        EngineError::InvalidPumpSwapPool
    );

    let mut bytes = [0u8; PUBKEY_BYTES];
    bytes.copy_from_slice(&data[offset..offset + PUBKEY_BYTES]);
    Ok(Pubkey::new_from_array(bytes))
}

fn require_pda(
    actual: Pubkey,
    seeds: &[&[u8]],
    program_id: &Pubkey,
    error: EngineError,
) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(seeds, program_id);
    require!(actual == expected, error);
    Ok(())
}

fn validate_pumpswap_accounts(ctx: &Context<ExecuteBuybackBurn>) -> Result<()> {
    let buyback_authority = ctx.accounts.buyback_authority.key();
    let base_mint = ctx.accounts.base_mint.key();
    let quote_mint = ctx.accounts.quote_mint.key();

    let buyback_authority_info = ctx.accounts.buyback_authority.to_account_info();
    require!(
        *buyback_authority_info.owner == system_program::ID
            && buyback_authority_info.data_is_empty(),
        EngineError::InvalidBuybackAuthorityOwner
    );

    require!(
        base_mint == ctx.accounts.config.project,
        EngineError::InvalidBuybackBaseMint
    );

    require!(
        quote_mint == WSOL_MINT,
        EngineError::InvalidBuybackQuoteMint
    );

    require!(
        *ctx.accounts.base_mint.to_account_info().owner
            == ctx.accounts.base_token_program.key(),
        EngineError::InvalidBaseTokenProgram
    );

    require!(
        *ctx.accounts.buyback_base_token_account.to_account_info().owner
            == ctx.accounts.base_token_program.key(),
        EngineError::InvalidBaseTokenProgram
    );

    require!(
        ctx.accounts.buyback_base_token_account.owner == buyback_authority
            && ctx.accounts.buyback_base_token_account.mint == base_mint,
        EngineError::InvalidBuybackBaseTokenAccount
    );

    let expected_base_ata = get_associated_token_address_with_program_id(
        &buyback_authority,
        &base_mint,
        &ctx.accounts.base_token_program.key(),
    );

    require!(
        ctx.accounts.buyback_base_token_account.key() == expected_base_ata,
        EngineError::InvalidBuybackBaseTokenAccount
    );

    require!(
        ctx.accounts.buyback_wsol_account.owner == buyback_authority
            && ctx.accounts.buyback_wsol_account.mint == quote_mint,
        EngineError::InvalidBuybackWsolAccount
    );

    let expected_wsol_ata = get_associated_token_address_with_program_id(
        &buyback_authority,
        &quote_mint,
        &ctx.accounts.quote_token_program.key(),
    );

    require!(
        ctx.accounts.buyback_wsol_account.key() == expected_wsol_ata,
        EngineError::InvalidBuybackWsolAccount
    );

    let pool_info = ctx.accounts.pool.to_account_info();
    require!(
        *pool_info.owner == PUMPSWAP_PROGRAM_ID,
        EngineError::InvalidPumpSwapPool
    );

    let pool_data = pool_info.try_borrow_data()?;
    require!(
        pool_data.len() >= 8
            && pool_data[..8] == PUMPSWAP_POOL_DISCRIMINATOR,
        EngineError::InvalidPumpSwapPool
    );

    let pool_base_mint = account_pubkey_at(
        &pool_data,
        PUMPSWAP_POOL_BASE_MINT_OFFSET,
    )?;
    let pool_quote_mint = account_pubkey_at(
        &pool_data,
        PUMPSWAP_POOL_QUOTE_MINT_OFFSET,
    )?;
    let pool_base_token_account = account_pubkey_at(
        &pool_data,
        PUMPSWAP_POOL_BASE_TOKEN_ACCOUNT_OFFSET,
    )?;
    let pool_quote_token_account = account_pubkey_at(
        &pool_data,
        PUMPSWAP_POOL_QUOTE_TOKEN_ACCOUNT_OFFSET,
    )?;
    let pool_coin_creator = account_pubkey_at(
        &pool_data,
        PUMPSWAP_POOL_COIN_CREATOR_OFFSET,
    )?;

    require!(
        pool_base_mint == base_mint && pool_quote_mint == quote_mint,
        EngineError::InvalidPumpSwapPool
    );

    require!(
        pool_base_token_account == ctx.accounts.pool_base_token_account.key()
            && pool_quote_token_account
                == ctx.accounts.pool_quote_token_account.key(),
        EngineError::InvalidPumpSwapPoolVault
    );
    drop(pool_data);

    let expected_protocol_fee_ata =
        get_associated_token_address_with_program_id(
            &ctx.accounts.protocol_fee_recipient.key(),
            &quote_mint,
            &ctx.accounts.quote_token_program.key(),
        );
    require!(
        ctx.accounts.protocol_fee_recipient_token_account.key()
            == expected_protocol_fee_ata,
        EngineError::InvalidPumpSwapProtocolFeeAta
    );

    let (expected_creator_vault_authority, _) = Pubkey::find_program_address(
        &[b"creator_vault", pool_coin_creator.as_ref()],
        &PUMPSWAP_PROGRAM_ID,
    );
    require!(
        ctx.accounts.coin_creator_vault_authority.key()
            == expected_creator_vault_authority,
        EngineError::InvalidPumpSwapCreatorVault
    );

    let expected_creator_vault_ata =
        get_associated_token_address_with_program_id(
            &expected_creator_vault_authority,
            &quote_mint,
            &ctx.accounts.quote_token_program.key(),
        );
    require!(
        ctx.accounts.coin_creator_vault_ata.key()
            == expected_creator_vault_ata,
        EngineError::InvalidPumpSwapCreatorVault
    );

    require_pda(
        ctx.accounts.global_config.key(),
        &[b"global_config"],
        &PUMPSWAP_PROGRAM_ID,
        EngineError::InvalidPumpSwapGlobalConfig,
    )?;

    require_pda(
        ctx.accounts.pump_event_authority.key(),
        &[b"__event_authority"],
        &PUMPSWAP_PROGRAM_ID,
        EngineError::InvalidPumpSwapEventAuthority,
    )?;

    require_pda(
        ctx.accounts.global_volume_accumulator.key(),
        &[b"global_volume_accumulator"],
        &PUMPSWAP_PROGRAM_ID,
        EngineError::InvalidPumpGlobalVolumeAccumulator,
    )?;

    require_pda(
        ctx.accounts.user_volume_accumulator.key(),
        &[b"user_volume_accumulator", buyback_authority.as_ref()],
        &PUMPSWAP_PROGRAM_ID,
        EngineError::InvalidPumpUserVolumeAccumulator,
    )?;

    require_pda(
        ctx.accounts.fee_config.key(),
        &[b"fee_config", PUMPSWAP_PROGRAM_ID.as_ref()],
        &PUMP_FEE_PROGRAM_ID,
        EngineError::InvalidPumpFeeConfig,
    )?;

    require_pda(
        ctx.accounts.pool_v2.key(),
        &[b"pool-v2", base_mint.as_ref()],
        &PUMPSWAP_PROGRAM_ID,
        EngineError::InvalidPumpSwapPoolV2,
    )?;

    let breaking_fee_recipient =
        ctx.accounts.breaking_fee_recipient.key();

    require!(
        PUMPSWAP_BREAKING_FEE_RECIPIENTS
            .iter()
            .any(|candidate| *candidate == breaking_fee_recipient),
        EngineError::InvalidBreakingFeeRecipient
    );

    let expected_breaking_fee_ata =
        get_associated_token_address_with_program_id(
            &breaking_fee_recipient,
            &quote_mint,
            &ctx.accounts.quote_token_program.key(),
        );

    require!(
        ctx.accounts.breaking_fee_recipient_quote_ata.key()
            == expected_breaking_fee_ata,
        EngineError::InvalidBreakingFeeRecipientAta
    );

    Ok(())
}

fn pumpswap_buy_exact_quote_in<'info>(
    ctx: &Context<'_, '_, '_, 'info, ExecuteBuybackBurn<'info>>,
    spendable_quote_in: u64,
    min_base_amount_out: u64,
) -> Result<()> {
    // PumpSwap OptionBool is a one-field Borsh struct containing bool.
    // We intentionally set track_volume=false for Engine buybacks:
    // no cashback side path, fewer moving pieces, deterministic 26-account layout.
    let mut data = Vec::with_capacity(25);
    data.extend_from_slice(&PUMPSWAP_BUY_EXACT_QUOTE_IN_DISCRIMINATOR);
    data.extend_from_slice(&spendable_quote_in.to_le_bytes());
    data.extend_from_slice(&min_base_amount_out.to_le_bytes());
    data.push(0u8);

    let accounts = vec![
        AccountMeta::new(ctx.accounts.pool.key(), false),
        AccountMeta::new(ctx.accounts.buyback_authority.key(), true),
        AccountMeta::new_readonly(ctx.accounts.global_config.key(), false),
        AccountMeta::new_readonly(ctx.accounts.base_mint.key(), false),
        AccountMeta::new_readonly(ctx.accounts.quote_mint.key(), false),
        AccountMeta::new(ctx.accounts.buyback_base_token_account.key(), false),
        AccountMeta::new(ctx.accounts.buyback_wsol_account.key(), false),
        AccountMeta::new(ctx.accounts.pool_base_token_account.key(), false),
        AccountMeta::new(ctx.accounts.pool_quote_token_account.key(), false),
        AccountMeta::new_readonly(ctx.accounts.protocol_fee_recipient.key(), false),
        AccountMeta::new(ctx.accounts.protocol_fee_recipient_token_account.key(), false),
        AccountMeta::new_readonly(ctx.accounts.base_token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.quote_token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.associated_token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.pump_event_authority.key(), false),
        AccountMeta::new_readonly(ctx.accounts.pump_swap_program.key(), false),
        AccountMeta::new(ctx.accounts.coin_creator_vault_ata.key(), false),
        AccountMeta::new_readonly(ctx.accounts.coin_creator_vault_authority.key(), false),
        AccountMeta::new_readonly(ctx.accounts.global_volume_accumulator.key(), false),
        AccountMeta::new(ctx.accounts.user_volume_accumulator.key(), false),
        AccountMeta::new_readonly(ctx.accounts.fee_config.key(), false),
        AccountMeta::new_readonly(ctx.accounts.fee_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.pool_v2.key(), false),
        AccountMeta::new_readonly(ctx.accounts.breaking_fee_recipient.key(), false),
        AccountMeta::new(ctx.accounts.breaking_fee_recipient_quote_ata.key(), false),
    ];

    let instruction = Instruction {
        program_id: PUMPSWAP_PROGRAM_ID,
        accounts,
        data,
    };

    let account_infos = vec![
        ctx.accounts.pool.to_account_info(),
        ctx.accounts.buyback_authority.to_account_info(),
        ctx.accounts.global_config.to_account_info(),
        ctx.accounts.base_mint.to_account_info(),
        ctx.accounts.quote_mint.to_account_info(),
        ctx.accounts.buyback_base_token_account.to_account_info(),
        ctx.accounts.buyback_wsol_account.to_account_info(),
        ctx.accounts.pool_base_token_account.to_account_info(),
        ctx.accounts.pool_quote_token_account.to_account_info(),
        ctx.accounts.protocol_fee_recipient.to_account_info(),
        ctx.accounts.protocol_fee_recipient_token_account.to_account_info(),
        ctx.accounts.base_token_program.to_account_info(),
        ctx.accounts.quote_token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.associated_token_program.to_account_info(),
        ctx.accounts.pump_event_authority.to_account_info(),
        ctx.accounts.pump_swap_program.to_account_info(),
        ctx.accounts.coin_creator_vault_ata.to_account_info(),
        ctx.accounts.coin_creator_vault_authority.to_account_info(),
        ctx.accounts.global_volume_accumulator.to_account_info(),
        ctx.accounts.user_volume_accumulator.to_account_info(),
        ctx.accounts.fee_config.to_account_info(),
        ctx.accounts.fee_program.to_account_info(),
        ctx.accounts.pool_v2.to_account_info(),
        ctx.accounts.breaking_fee_recipient.to_account_info(),
        ctx.accounts.breaking_fee_recipient_quote_ata.to_account_info(),
    ];

    let config_key = ctx.accounts.config.key();
    let bump = ctx.bumps.buyback_authority;
    let signer_seeds: &[&[u8]] = &[
        BUYBACK_AUTHORITY_SEED,
        config_key.as_ref(),
        &[bump],
    ];

    invoke_signed(
        &instruction,
        &account_infos,
        &[signer_seeds],
    )?;

    Ok(())
}

pub fn handler(
    mut ctx: Context<ExecuteBuybackBurn>,
    quote_amount_in: u64,
    min_base_amount_out: u64,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, EngineError::EnginePaused);
    require!(
        min_base_amount_out > 0,
        EngineError::InvalidBuybackMinimumOut
    );

    validate_pumpswap_accounts(&ctx)?;

    let config_key = ctx.accounts.config.key();
    let vault_key = ctx.accounts.vault.key();
    let vault_info = ctx.accounts.vault.to_account_info();

    // Lazy sync: fee accounting and buyback happen atomically in one Engine tx.
    if let Some(allocation) =
        sync_pending_fees(&mut ctx.accounts.config, &vault_info)?
    {
        emit_sync_event(
            config_key,
            &ctx.accounts.config,
            vault_key,
            allocation,
        )?;
    }

    require!(
        ctx.accounts.config.buyback_reserve
            >= ctx.accounts.config.buyback_threshold,
        EngineError::BuybackThresholdNotReached
    );

    require!(
        quote_amount_in > 0
            && quote_amount_in >= ctx.accounts.config.buyback_threshold,
        EngineError::InvalidBuybackAmount
    );

    require!(
        quote_amount_in <= ctx.accounts.config.buyback_reserve,
        EngineError::BuybackAmountExceedsReserve
    );

    let spendable_before = assert_vault_backing(
        &ctx.accounts.config,
        &vault_info,
    )?;

    require!(
        spendable_before >= quote_amount_in,
        EngineError::InsufficientSpendableVaultBalance
    );

    let wsol_before = ctx.accounts.buyback_wsol_account.amount;
    let base_before = ctx.accounts.buyback_base_token_account.amount;
    let mint_supply_before = ctx.accounts.base_mint.supply;

    let buyback_authority_info =
        ctx.accounts.buyback_authority.to_account_info();

    // Move only this batch out of the program-owned EngineVault.
    // The System-owned buyback PDA may hold an externally funded operational
    // buffer for one-time PumpSwap account rent. That buffer is not creator fee
    // and is intentionally outside Engine accounting.
    **vault_info.try_borrow_mut_lamports()? = vault_info
        .lamports()
        .checked_sub(quote_amount_in)
        .ok_or(EngineError::MathOverflow)?;

    **buyback_authority_info.try_borrow_mut_lamports()? =
        buyback_authority_info
            .lamports()
            .checked_add(quote_amount_in)
            .ok_or(EngineError::MathOverflow)?;

    let config_key_for_seeds = ctx.accounts.config.key();
    let buyback_bump = ctx.bumps.buyback_authority;
    let buyback_signer: &[&[u8]] = &[
        BUYBACK_AUTHORITY_SEED,
        config_key_for_seeds.as_ref(),
        &[buyback_bump],
    ];

    // Wrap exactly the creator-fee batch into the canonical WSOL ATA.
    invoke_signed(
        &system_instruction::transfer(
            &ctx.accounts.buyback_authority.key(),
            &ctx.accounts.buyback_wsol_account.key(),
            quote_amount_in,
        ),
        &[
            ctx.accounts.buyback_authority.to_account_info(),
            ctx.accounts.buyback_wsol_account.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[buyback_signer],
    )?;

    token::sync_native(CpiContext::new(
        ctx.accounts.quote_token_program.to_account_info(),
        SyncNative {
            account: ctx.accounts.buyback_wsol_account.to_account_info(),
        },
    ))?;

    ctx.accounts.buyback_wsol_account.reload()?;

    let expected_wrapped = wsol_before
        .checked_add(quote_amount_in)
        .ok_or(EngineError::MathOverflow)?;

    require!(
        ctx.accounts.buyback_wsol_account.amount == expected_wrapped,
        EngineError::BuybackWsolBalanceMismatch
    );

    pumpswap_buy_exact_quote_in(
        &ctx,
        quote_amount_in,
        min_base_amount_out,
    )?;

    ctx.accounts.buyback_wsol_account.reload()?;
    ctx.accounts.buyback_base_token_account.reload()?;
    ctx.accounts.base_mint.reload()?;

    let quote_spent = expected_wrapped
        .checked_sub(ctx.accounts.buyback_wsol_account.amount)
        .ok_or(EngineError::BuybackQuoteSpendMismatch)?;

    require!(
        quote_spent == quote_amount_in,
        EngineError::BuybackQuoteSpendMismatch
    );

    require!(
        ctx.accounts.buyback_wsol_account.amount == wsol_before,
        EngineError::BuybackWsolBalanceMismatch
    );

    let base_received = ctx.accounts
        .buyback_base_token_account
        .amount
        .checked_sub(base_before)
        .ok_or(EngineError::BuybackNoTokensReceived)?;

    require!(base_received > 0, EngineError::BuybackNoTokensReceived);
    require!(
        base_received >= min_base_amount_out,
        EngineError::BuybackBelowMinimum
    );

    // Burn only the tokens received from this buyback. Any unrelated dust that
    // somebody sent to the PDA ATA beforehand is preserved and cannot grief the
    // Engine or be accidentally burned.
    token_interface::burn(
        CpiContext::new_with_signer(
            ctx.accounts.base_token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.base_mint.to_account_info(),
                from: ctx.accounts.buyback_base_token_account.to_account_info(),
                authority: ctx.accounts.buyback_authority.to_account_info(),
            },
            &[buyback_signer],
        ),
        base_received,
    )?;

    ctx.accounts.buyback_base_token_account.reload()?;
    ctx.accounts.base_mint.reload()?;

    require!(
        ctx.accounts.buyback_base_token_account.amount == base_before,
        EngineError::BuybackBurnBalanceMismatch
    );

    let expected_supply_after = mint_supply_before
        .checked_sub(base_received)
        .ok_or(EngineError::MathOverflow)?;

    require!(
        ctx.accounts.base_mint.supply == expected_supply_after,
        EngineError::BuybackMintSupplyMismatch
    );

    let event_authority = ctx.accounts.authority.key();
    let event_buyback_authority = ctx.accounts.buyback_authority.key();
    let event_pool = ctx.accounts.pool.key();
    let event_base_mint = ctx.accounts.base_mint.key();
    let mint_supply_after = ctx.accounts.base_mint.supply;

    // Accounting changes happen only after wrap + PumpSwap + burn all succeed.
    // Solana transaction atomicity rolls the lazy sync and every lamport/token
    // movement back if any later step fails.
    let config = &mut ctx.accounts.config;

    config.buyback_reserve = config
        .buyback_reserve
        .checked_sub(quote_amount_in)
        .ok_or(EngineError::MathOverflow)?;

    config.accounted_balance = config
        .accounted_balance
        .checked_sub(quote_amount_in)
        .ok_or(EngineError::MathOverflow)?;

    config.total_buyback_processed = config
        .total_buyback_processed
        .checked_add(quote_amount_in)
        .ok_or(EngineError::MathOverflow)?;

    config.assert_invariant()?;
    assert_vault_backing(config, &vault_info)?;

    emit!(BuybackBurnExecuted {
        config: config_key,
        vault: vault_key,
        authority: event_authority,
        buyback_authority: event_buyback_authority,
        pool: event_pool,
        base_mint: event_base_mint,
        quote_amount_in,
        base_amount_received: base_received,
        base_amount_burned: base_received,
        mint_supply_before,
        mint_supply_after,
        remaining_buyback_reserve: config.buyback_reserve,
        remaining_accounted_balance: config.accounted_balance,
        total_buyback_processed: config.total_buyback_processed,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

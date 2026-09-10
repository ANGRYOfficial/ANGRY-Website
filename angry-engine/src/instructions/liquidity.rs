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
};

use crate::{
    accounting::{
        assert_vault_backing,
        sync_pending_fees,
    },
    constants::{
        LIQUIDITY_AUTHORITY_SEED,
        PUMP_FEE_PROGRAM_ID,
        PUMPSWAP_BREAKING_FEE_RECIPIENTS,
        PUMPSWAP_BUY_EXACT_QUOTE_IN_DISCRIMINATOR,
        PUMPSWAP_DEPOSIT_DISCRIMINATOR,
        PUMPSWAP_POOL_DISCRIMINATOR,
        PUMPSWAP_PROGRAM_ID,
        WSOL_MINT,
    },
    errors::EngineError,
    events::{
        LiquidityDeployed,
        LiquidityStaged,
    },
    instructions::sync_fees::emit_sync_event,
    DeployLiquidity,
    StageLiquidity,
};

const PUMPSWAP_POOL_BASE_MINT_OFFSET: usize = 43;
const PUMPSWAP_POOL_QUOTE_MINT_OFFSET: usize = 75;
const PUMPSWAP_POOL_LP_MINT_OFFSET: usize = 107;
const PUMPSWAP_POOL_BASE_TOKEN_ACCOUNT_OFFSET: usize = 139;
const PUMPSWAP_POOL_QUOTE_TOKEN_ACCOUNT_OFFSET: usize = 171;
const PUMPSWAP_POOL_COIN_CREATOR_OFFSET: usize = 211;
const PUBKEY_BYTES: usize = 32;

fn account_pubkey_at(
    data: &[u8],
    offset: usize,
) -> Result<Pubkey> {
    require!(
        data.len() >= offset + PUBKEY_BYTES,
        EngineError::InvalidPumpSwapPool
    );

    let mut bytes = [0u8; PUBKEY_BYTES];
    bytes.copy_from_slice(
        &data[offset..offset + PUBKEY_BYTES]
    );

    Ok(Pubkey::new_from_array(bytes))
}

fn require_pda(
    actual: Pubkey,
    seeds: &[&[u8]],
    program_id: &Pubkey,
    error: EngineError,
) -> Result<()> {
    let (expected, _) =
        Pubkey::find_program_address(seeds, program_id);

    if actual != expected {
        return Err(error.into());
    }

    Ok(())
}

pub fn handler(
    mut ctx: Context<StageLiquidity>,
) -> Result<()> {
    require!(
        !ctx.accounts.config.paused,
        EngineError::EnginePaused
    );

    let config_key = ctx.accounts.config.key();
    let vault_key = ctx.accounts.vault.key();
    let vault_info =
        ctx.accounts.vault.to_account_info();

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

    // Stage the whole accumulated liquidity reserve.
    let amount =
        ctx.accounts.config.liquidity_reserve;

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
        ctx.accounts
            .liquidity_authority
            .to_account_info();

    require!(
        *liquidity_authority_info.owner
            == system_program::ID
            && liquidity_authority_info.data_is_empty(),
        EngineError::InvalidLiquidityAuthorityOwner
    );

    let minimum_rent =
        Rent::get()?.minimum_balance(0);

    let required_before = minimum_rent
        .checked_add(
            ctx.accounts.config.liquidity_staged
        )
        .ok_or(EngineError::MathOverflow)?;

    require!(
        liquidity_authority_info.lamports()
            >= required_before,
        EngineError::InsufficientLiquidityAuthorityRentBuffer
    );

    // Direct lamport movement remains the last operation
    // before state accounting. No CPI follows this transfer.
    **vault_info.try_borrow_mut_lamports()? =
        vault_info
            .lamports()
            .checked_sub(amount)
            .ok_or(EngineError::MathOverflow)?;

    **liquidity_authority_info
        .try_borrow_mut_lamports()? =
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
        liquidity_authority_info.lamports()
            >= required_after,
        EngineError::InsufficientLiquidityAuthorityRentBuffer
    );

    config.assert_invariant()?;
    assert_vault_backing(config, &vault_info)?;

    emit!(LiquidityStaged {
        config: config_key,
        vault: vault_key,
        liquidity_authority:
            ctx.accounts.liquidity_authority.key(),
        amount,
        liquidity_staged:
            config.liquidity_staged,
        remaining_liquidity_reserve:
            config.liquidity_reserve,
        remaining_accounted_balance:
            config.accounted_balance,
        timestamp:
            Clock::get()?.unix_timestamp,
    });

    Ok(())
}

fn validate_deploy_accounts(
    ctx: &Context<DeployLiquidity>,
) -> Result<()> {
    let liquidity_authority =
        ctx.accounts.liquidity_authority.key();

    let base_mint =
        ctx.accounts.base_mint.key();

    let quote_mint =
        ctx.accounts.quote_mint.key();

    let lp_mint =
        ctx.accounts.lp_mint.key();

    let liquidity_authority_info =
        ctx.accounts
            .liquidity_authority
            .to_account_info();

    require!(
        *liquidity_authority_info.owner
            == system_program::ID
            && liquidity_authority_info.data_is_empty(),
        EngineError::InvalidLiquidityAuthorityOwner
    );

    require!(
        base_mint == ctx.accounts.config.project,
        EngineError::InvalidLiquidityBaseMint
    );

    require!(
        *ctx.accounts.base_mint.to_account_info().owner
            == ctx.accounts.base_token_program.key(),
        EngineError::InvalidLiquidityBaseMint
    );

    require!(
        quote_mint == WSOL_MINT,
        EngineError::InvalidLiquidityQuoteMint
    );

    require!(
        ctx.accounts
            .liquidity_base_token_account
            .owner
            == liquidity_authority
            && ctx.accounts
                .liquidity_base_token_account
                .mint
                == base_mint,
        EngineError::InvalidLiquidityBaseTokenAccount
    );

    require!(
        *ctx.accounts
            .liquidity_base_token_account
            .to_account_info()
            .owner
            == ctx.accounts.base_token_program.key(),
        EngineError::InvalidLiquidityBaseTokenAccount
    );

    let expected_base_ata =
        get_associated_token_address_with_program_id(
            &liquidity_authority,
            &base_mint,
            &ctx.accounts.base_token_program.key(),
        );

    require!(
        ctx.accounts
            .liquidity_base_token_account
            .key()
            == expected_base_ata,
        EngineError::InvalidLiquidityBaseTokenAccount
    );

    require!(
        ctx.accounts.liquidity_wsol_account.owner
            == liquidity_authority
            && ctx.accounts
                .liquidity_wsol_account
                .mint
                == quote_mint,
        EngineError::InvalidLiquidityWsolAccount
    );

    let expected_wsol_ata =
        get_associated_token_address_with_program_id(
            &liquidity_authority,
            &quote_mint,
            &ctx.accounts.token_program.key(),
        );

    require!(
        ctx.accounts
            .liquidity_wsol_account
            .key()
            == expected_wsol_ata,
        EngineError::InvalidLiquidityWsolAccount
    );

    require!(
        *ctx.accounts
            .lp_mint
            .to_account_info()
            .owner
            == ctx.accounts.token_2022_program.key(),
        EngineError::InvalidLiquidityLpMint
    );

    require!(
        *ctx.accounts
            .liquidity_lp_token_account
            .to_account_info()
            .owner
            == ctx.accounts.token_2022_program.key()
            && ctx.accounts
                .liquidity_lp_token_account
                .owner
                == liquidity_authority
            && ctx.accounts
                .liquidity_lp_token_account
                .mint
                == lp_mint,
        EngineError::InvalidLiquidityLpTokenAccount
    );

    let expected_lp_ata =
        get_associated_token_address_with_program_id(
            &liquidity_authority,
            &lp_mint,
            &ctx.accounts.token_2022_program.key(),
        );

    require!(
        ctx.accounts
            .liquidity_lp_token_account
            .key()
            == expected_lp_ata,
        EngineError::InvalidLiquidityLpTokenAccount
    );

    let pool_info =
        ctx.accounts.pool.to_account_info();

    require!(
        *pool_info.owner == PUMPSWAP_PROGRAM_ID,
        EngineError::InvalidPumpSwapPool
    );

    let pool_data =
        pool_info.try_borrow_data()?;

    require!(
        pool_data.len() >= 8
            && pool_data[..8]
                == PUMPSWAP_POOL_DISCRIMINATOR,
        EngineError::InvalidPumpSwapPool
    );

    let pool_base_mint =
        account_pubkey_at(
            &pool_data,
            PUMPSWAP_POOL_BASE_MINT_OFFSET,
        )?;

    let pool_quote_mint =
        account_pubkey_at(
            &pool_data,
            PUMPSWAP_POOL_QUOTE_MINT_OFFSET,
        )?;

    let pool_lp_mint =
        account_pubkey_at(
            &pool_data,
            PUMPSWAP_POOL_LP_MINT_OFFSET,
        )?;

    let pool_base_token_account =
        account_pubkey_at(
            &pool_data,
            PUMPSWAP_POOL_BASE_TOKEN_ACCOUNT_OFFSET,
        )?;

    let pool_quote_token_account =
        account_pubkey_at(
            &pool_data,
            PUMPSWAP_POOL_QUOTE_TOKEN_ACCOUNT_OFFSET,
        )?;

    let pool_coin_creator =
        account_pubkey_at(
            &pool_data,
            PUMPSWAP_POOL_COIN_CREATOR_OFFSET,
        )?;

    require!(
        pool_base_mint == base_mint
            && pool_quote_mint == quote_mint,
        EngineError::InvalidPumpSwapPool
    );

    require!(
        pool_lp_mint == lp_mint,
        EngineError::InvalidLiquidityLpMint
    );

    require!(
        pool_base_token_account
            == ctx.accounts
                .pool_base_token_account
                .key()
            && pool_quote_token_account
                == ctx.accounts
                    .pool_quote_token_account
                    .key(),
        EngineError::InvalidPumpSwapPoolVault
    );

    drop(pool_data);

    let expected_protocol_fee_ata =
        get_associated_token_address_with_program_id(
            &ctx.accounts
                .protocol_fee_recipient
                .key(),
            &quote_mint,
            &ctx.accounts.token_program.key(),
        );

    require!(
        ctx.accounts
            .protocol_fee_recipient_token_account
            .key()
            == expected_protocol_fee_ata,
        EngineError::InvalidPumpSwapProtocolFeeAta
    );

    let (
        expected_creator_vault_authority,
        _,
    ) = Pubkey::find_program_address(
        &[
            b"creator_vault",
            pool_coin_creator.as_ref(),
        ],
        &PUMPSWAP_PROGRAM_ID,
    );

    require!(
        ctx.accounts
            .coin_creator_vault_authority
            .key()
            == expected_creator_vault_authority,
        EngineError::InvalidPumpSwapCreatorVault
    );

    let expected_creator_vault_ata =
        get_associated_token_address_with_program_id(
            &expected_creator_vault_authority,
            &quote_mint,
            &ctx.accounts.token_program.key(),
        );

    require!(
        ctx.accounts
            .coin_creator_vault_ata
            .key()
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
        ctx.accounts
            .global_volume_accumulator
            .key(),
        &[b"global_volume_accumulator"],
        &PUMPSWAP_PROGRAM_ID,
        EngineError::InvalidPumpGlobalVolumeAccumulator,
    )?;

    require_pda(
        ctx.accounts
            .user_volume_accumulator
            .key(),
        &[
            b"user_volume_accumulator",
            liquidity_authority.as_ref(),
        ],
        &PUMPSWAP_PROGRAM_ID,
        EngineError::InvalidPumpUserVolumeAccumulator,
    )?;

    require_pda(
        ctx.accounts.fee_config.key(),
        &[
            b"fee_config",
            PUMPSWAP_PROGRAM_ID.as_ref(),
        ],
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
        ctx.accounts
            .breaking_fee_recipient
            .key();

    require!(
        PUMPSWAP_BREAKING_FEE_RECIPIENTS
            .iter()
            .any(
                |candidate|
                    *candidate
                        == breaking_fee_recipient
            ),
        EngineError::InvalidBreakingFeeRecipient
    );

    let expected_breaking_fee_ata =
        get_associated_token_address_with_program_id(
            &breaking_fee_recipient,
            &quote_mint,
            &ctx.accounts.token_program.key(),
        );

    require!(
        ctx.accounts
            .breaking_fee_recipient_quote_ata
            .key()
            == expected_breaking_fee_ata,
        EngineError::InvalidBreakingFeeRecipientAta
    );

    Ok(())
}

fn pumpswap_buy_for_liquidity(
    ctx: &Context<DeployLiquidity>,
    quote_amount_in: u64,
    expected_base_amount_out: u64,
) -> Result<()> {
    let mut data =
        Vec::with_capacity(25);

    data.extend_from_slice(
        &PUMPSWAP_BUY_EXACT_QUOTE_IN_DISCRIMINATOR
    );

    data.extend_from_slice(
        &quote_amount_in.to_le_bytes()
    );

    // We deliberately use the exact expected amount as
    // PumpSwap's minimum. The Engine additionally verifies
    // the exact post-swap balance below.
    data.extend_from_slice(
        &expected_base_amount_out.to_le_bytes()
    );

    // track_volume = false
    data.push(0u8);

    let accounts = vec![
        AccountMeta::new(
            ctx.accounts.pool.key(),
            false,
        ),
        AccountMeta::new(
            ctx.accounts.liquidity_authority.key(),
            true,
        ),
        AccountMeta::new_readonly(
            ctx.accounts.global_config.key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts.base_mint.key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts.quote_mint.key(),
            false,
        ),
        AccountMeta::new(
            ctx.accounts
                .liquidity_base_token_account
                .key(),
            false,
        ),
        AccountMeta::new(
            ctx.accounts
                .liquidity_wsol_account
                .key(),
            false,
        ),
        AccountMeta::new(
            ctx.accounts
                .pool_base_token_account
                .key(),
            false,
        ),
        AccountMeta::new(
            ctx.accounts
                .pool_quote_token_account
                .key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts
                .protocol_fee_recipient
                .key(),
            false,
        ),
        AccountMeta::new(
            ctx.accounts
                .protocol_fee_recipient_token_account
                .key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts.base_token_program.key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts.token_program.key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts.system_program.key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts
                .associated_token_program
                .key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts
                .pump_event_authority
                .key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts.pump_swap_program.key(),
            false,
        ),
        AccountMeta::new(
            ctx.accounts
                .coin_creator_vault_ata
                .key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts
                .coin_creator_vault_authority
                .key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts
                .global_volume_accumulator
                .key(),
            false,
        ),
        AccountMeta::new(
            ctx.accounts
                .user_volume_accumulator
                .key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts.fee_config.key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts.fee_program.key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts.pool_v2.key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts
                .breaking_fee_recipient
                .key(),
            false,
        ),
        AccountMeta::new(
            ctx.accounts
                .breaking_fee_recipient_quote_ata
                .key(),
            false,
        ),
    ];

    let instruction = Instruction {
        program_id: PUMPSWAP_PROGRAM_ID,
        accounts,
        data,
    };

    let account_infos = vec![
        ctx.accounts.pool.to_account_info(),
        ctx.accounts
            .liquidity_authority
            .to_account_info(),
        ctx.accounts.global_config.to_account_info(),
        ctx.accounts.base_mint.to_account_info(),
        ctx.accounts.quote_mint.to_account_info(),
        ctx.accounts
            .liquidity_base_token_account
            .to_account_info(),
        ctx.accounts
            .liquidity_wsol_account
            .to_account_info(),
        ctx.accounts
            .pool_base_token_account
            .to_account_info(),
        ctx.accounts
            .pool_quote_token_account
            .to_account_info(),
        ctx.accounts
            .protocol_fee_recipient
            .to_account_info(),
        ctx.accounts
            .protocol_fee_recipient_token_account
            .to_account_info(),
        ctx.accounts.base_token_program.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts
            .associated_token_program
            .to_account_info(),
        ctx.accounts
            .pump_event_authority
            .to_account_info(),
        ctx.accounts
            .pump_swap_program
            .to_account_info(),
        ctx.accounts
            .coin_creator_vault_ata
            .to_account_info(),
        ctx.accounts
            .coin_creator_vault_authority
            .to_account_info(),
        ctx.accounts
            .global_volume_accumulator
            .to_account_info(),
        ctx.accounts
            .user_volume_accumulator
            .to_account_info(),
        ctx.accounts.fee_config.to_account_info(),
        ctx.accounts.fee_program.to_account_info(),
        ctx.accounts.pool_v2.to_account_info(),
        ctx.accounts.pool_v2.to_account_info(),
        ctx.accounts
            .breaking_fee_recipient
            .to_account_info(),
        ctx.accounts
            .breaking_fee_recipient_quote_ata
            .to_account_info(),
    ];

    let config_key =
        ctx.accounts.config.key();

    let bump =
        ctx.bumps.liquidity_authority;

    let signer_seeds: &[&[u8]] = &[
        LIQUIDITY_AUTHORITY_SEED,
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

fn pumpswap_deposit(
    ctx: &Context<DeployLiquidity>,
    lp_token_amount_out: u64,
    max_base_amount_in: u64,
    max_quote_amount_in: u64,
) -> Result<()> {
    let mut data =
        Vec::with_capacity(32);

    data.extend_from_slice(
        &PUMPSWAP_DEPOSIT_DISCRIMINATOR
    );

    data.extend_from_slice(
        &lp_token_amount_out.to_le_bytes()
    );

    data.extend_from_slice(
        &max_base_amount_in.to_le_bytes()
    );

    data.extend_from_slice(
        &max_quote_amount_in.to_le_bytes()
    );

    // Exact account order from PumpSwap deposit IDL.
    let accounts = vec![
        AccountMeta::new(
            ctx.accounts.pool.key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts.global_config.key(),
            false,
        ),
        AccountMeta::new(
            ctx.accounts.liquidity_authority.key(),
            true,
        ),
        AccountMeta::new_readonly(
            ctx.accounts.base_mint.key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts.quote_mint.key(),
            false,
        ),
        AccountMeta::new(
            ctx.accounts.lp_mint.key(),
            false,
        ),
        AccountMeta::new(
            ctx.accounts
                .liquidity_base_token_account
                .key(),
            false,
        ),
        AccountMeta::new(
            ctx.accounts
                .liquidity_wsol_account
                .key(),
            false,
        ),
        AccountMeta::new(
            ctx.accounts
                .liquidity_lp_token_account
                .key(),
            false,
        ),
        AccountMeta::new(
            ctx.accounts
                .pool_base_token_account
                .key(),
            false,
        ),
        AccountMeta::new(
            ctx.accounts
                .pool_quote_token_account
                .key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts.token_program.key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts.token_2022_program.key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts
                .pump_event_authority
                .key(),
            false,
        ),
        AccountMeta::new_readonly(
            ctx.accounts.pump_swap_program.key(),
            false,
        ),
    ];

    let instruction = Instruction {
        program_id: PUMPSWAP_PROGRAM_ID,
        accounts,
        data,
    };

    let account_infos = vec![
        ctx.accounts.pool.to_account_info(),
        ctx.accounts.global_config.to_account_info(),
        ctx.accounts
            .liquidity_authority
            .to_account_info(),
        ctx.accounts.base_mint.to_account_info(),
        ctx.accounts.quote_mint.to_account_info(),
        ctx.accounts.lp_mint.to_account_info(),
        ctx.accounts
            .liquidity_base_token_account
            .to_account_info(),
        ctx.accounts
            .liquidity_wsol_account
            .to_account_info(),
        ctx.accounts
            .liquidity_lp_token_account
            .to_account_info(),
        ctx.accounts
            .pool_base_token_account
            .to_account_info(),
        ctx.accounts
            .pool_quote_token_account
            .to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts
            .token_2022_program
            .to_account_info(),
        ctx.accounts
            .pump_event_authority
            .to_account_info(),
        ctx.accounts
            .pump_swap_program
            .to_account_info(),
    ];

    let config_key =
        ctx.accounts.config.key();

    let bump =
        ctx.bumps.liquidity_authority;

    let signer_seeds: &[&[u8]] = &[
        LIQUIDITY_AUTHORITY_SEED,
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

pub fn deploy_handler(
    mut ctx: Context<DeployLiquidity>,
    quote_amount_to_buy: u64,
    expected_base_amount_out: u64,
    quote_amount_to_deposit: u64,
    lp_token_amount_out: u64,
) -> Result<()> {
    require!(
        !ctx.accounts.config.paused,
        EngineError::EnginePaused
    );

    require!(
        quote_amount_to_buy > 0
            && expected_base_amount_out > 0
            && quote_amount_to_deposit > 0
            && lp_token_amount_out > 0,
        EngineError::InvalidLiquidityExecutionAmount
    );

    validate_deploy_accounts(&ctx)?;

    let total_quote_amount =
        quote_amount_to_buy
            .checked_add(quote_amount_to_deposit)
            .ok_or(EngineError::MathOverflow)?;

    require!(
        total_quote_amount
            <= ctx.accounts.config.liquidity_staged,
        EngineError::LiquidityAmountExceedsStaged
    );

    let vault_info =
        ctx.accounts.vault.to_account_info();

    assert_vault_backing(
        &ctx.accounts.config,
        &vault_info,
    )?;

    let liquidity_authority_info =
        ctx.accounts
            .liquidity_authority
            .to_account_info();

    let minimum_rent =
        Rent::get()?.minimum_balance(0);

    let required_before =
        minimum_rent
            .checked_add(
                ctx.accounts.config.liquidity_staged
            )
            .ok_or(EngineError::MathOverflow)?;

    require!(
        liquidity_authority_info.lamports()
            >= required_before,
        EngineError::InsufficientLiquidityAuthorityRentBuffer
    );

    let base_before =
        ctx.accounts
            .liquidity_base_token_account
            .amount;

    let wsol_before =
        ctx.accounts
            .liquidity_wsol_account
            .amount;

    let lp_before =
        ctx.accounts
            .liquidity_lp_token_account
            .amount;

    let config_key =
        ctx.accounts.config.key();

    let liquidity_bump =
        ctx.bumps.liquidity_authority;

    let liquidity_signer: &[&[u8]] = &[
        LIQUIDITY_AUTHORITY_SEED,
        config_key.as_ref(),
        &[liquidity_bump],
    ];

    // Wrap the exact total creator-fee budget for this
    // atomic swap + LP deposit.
    invoke_signed(
        &system_instruction::transfer(
            &ctx.accounts.liquidity_authority.key(),
            &ctx.accounts
                .liquidity_wsol_account
                .key(),
            total_quote_amount,
        ),
        &[
            ctx.accounts
                .liquidity_authority
                .to_account_info(),
            ctx.accounts
                .liquidity_wsol_account
                .to_account_info(),
            ctx.accounts
                .system_program
                .to_account_info(),
        ],
        &[liquidity_signer],
    )?;

    token::sync_native(
        CpiContext::new(
            ctx.accounts
                .token_program
                .to_account_info(),
            SyncNative {
                account:
                    ctx.accounts
                        .liquidity_wsol_account
                        .to_account_info(),
            },
        ),
    )?;

    ctx.accounts
        .liquidity_wsol_account
        .reload()?;

    let expected_wrapped =
        wsol_before
            .checked_add(total_quote_amount)
            .ok_or(EngineError::MathOverflow)?;

    require!(
        ctx.accounts
            .liquidity_wsol_account
            .amount
            == expected_wrapped,
        EngineError::LiquidityWsolBalanceMismatch
    );

    // First leg: buy the project token from PumpSwap.
    pumpswap_buy_for_liquidity(
        &ctx,
        quote_amount_to_buy,
        expected_base_amount_out,
    )?;

    ctx.accounts
        .liquidity_wsol_account
        .reload()?;

    ctx.accounts
        .liquidity_base_token_account
        .reload()?;

    let expected_wsol_after_buy =
        expected_wrapped
            .checked_sub(quote_amount_to_buy)
            .ok_or(EngineError::MathOverflow)?;

    require!(
        ctx.accounts
            .liquidity_wsol_account
            .amount
            == expected_wsol_after_buy,
        EngineError::LiquidityWsolBalanceMismatch
    );

    let base_received =
        ctx.accounts
            .liquidity_base_token_account
            .amount
            .checked_sub(base_before)
            .ok_or(
                EngineError::LiquidityBaseAmountMismatch
            )?;

    // Exact matching keeps creator-fee accounting deterministic.
    // If the pool moved before execution, fail atomically and
    // let the keeper re-quote.
    require!(
        base_received == expected_base_amount_out,
        EngineError::LiquidityBaseAmountMismatch
    );

    // Second leg: deposit all tokens just bought plus the
    // exact remaining quote allocation into PumpSwap.
    pumpswap_deposit(
        &ctx,
        lp_token_amount_out,
        base_received,
        quote_amount_to_deposit,
    )?;

    ctx.accounts
        .liquidity_base_token_account
        .reload()?;

    ctx.accounts
        .liquidity_wsol_account
        .reload()?;

    ctx.accounts
        .liquidity_lp_token_account
        .reload()?;

    // No project tokens from this execution may remain
    // outside the LP position.
    require!(
        ctx.accounts
            .liquidity_base_token_account
            .amount
            == base_before,
        EngineError::LiquidityDepositBaseBalanceMismatch
    );

    // No creator-fee WSOL from this execution may remain.
    // Any pre-existing harmless dust is preserved exactly.
    require!(
        ctx.accounts
            .liquidity_wsol_account
            .amount
            == wsol_before,
        EngineError::LiquidityDepositQuoteBalanceMismatch
    );

    let lp_received =
        ctx.accounts
            .liquidity_lp_token_account
            .amount
            .checked_sub(lp_before)
            .ok_or(
                EngineError::LiquidityLpAmountMismatch
            )?;

    require!(
        lp_received == lp_token_amount_out
            && lp_received > 0,
        EngineError::LiquidityLpAmountMismatch
    );

    // All PumpSwap CPIs succeeded. Only now settle
    // creator-fee accounting.
    let config =
        &mut ctx.accounts.config;

    config.liquidity_staged = config
        .liquidity_staged
        .checked_sub(total_quote_amount)
        .ok_or(EngineError::MathOverflow)?;

    config.accounted_balance = config
        .accounted_balance
        .checked_sub(total_quote_amount)
        .ok_or(EngineError::MathOverflow)?;

    config.total_liquidity_deployed = config
        .total_liquidity_deployed
        .checked_add(total_quote_amount)
        .ok_or(EngineError::MathOverflow)?;

    config.assert_invariant()?;

    let required_after =
        minimum_rent
            .checked_add(config.liquidity_staged)
            .ok_or(EngineError::MathOverflow)?;

    require!(
        liquidity_authority_info.lamports()
            >= required_after,
        EngineError::InsufficientLiquidityAuthorityRentBuffer
    );

    // Vault-backed accounting is unchanged by deploy:
    // accounted_balance and liquidity_staged fall together.
    assert_vault_backing(
        config,
        &vault_info,
    )?;

    emit!(LiquidityDeployed {
        config: config_key,
        vault: ctx.accounts.vault.key(),
        authority: ctx.accounts.authority.key(),
        liquidity_authority:
            ctx.accounts.liquidity_authority.key(),
        pool: ctx.accounts.pool.key(),
        base_mint: ctx.accounts.base_mint.key(),
        lp_mint: ctx.accounts.lp_mint.key(),
        quote_amount_to_buy,
        base_amount_bought: base_received,
        quote_amount_to_deposit,
        lp_tokens_received: lp_received,
        processed_quote_amount:
            total_quote_amount,
        remaining_liquidity_staged:
            config.liquidity_staged,
        remaining_accounted_balance:
            config.accounted_balance,
        total_liquidity_deployed:
            config.total_liquidity_deployed,
        timestamp:
            Clock::get()?.unix_timestamp,
    });

    Ok(())
}

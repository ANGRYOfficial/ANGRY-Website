use anchor_lang::prelude::*;

#[error_code]
pub enum EngineError {
    #[msg("Allocation basis points must total 10000.")]
    InvalidAllocationTotal,

    #[msg("Project public key cannot be the default public key.")]
    InvalidProject,

    #[msg("All processing thresholds must be greater than zero.")]
    InvalidThreshold,

    #[msg("The engine is paused.")]
    EnginePaused,

    #[msg("The engine must be paused for this administrative operation.")]
    EngineNotPaused,

    #[msg("The requested pause state is already active.")]
    PauseStateUnchanged,

    #[msg("No new creator fees are available to sync.")]
    NoNewFees,

    #[msg("Arithmetic overflow or underflow.")]
    MathOverflow,

    #[msg("The accounting balance is greater than the vault's spendable balance.")]
    AccountingBalanceExceedsVault,

    #[msg("Reserve totals or cumulative accounting are inconsistent.")]
    AccountingInvariantBroken,

    #[msg("Development reserve has not reached its settlement threshold.")]
    DevelopmentThresholdNotReached,

    #[msg("Vault does not contain enough spendable SOL for this operation.")]
    InsufficientSpendableVaultBalance,

    #[msg("The supplied development wallet is not the configured development wallet.")]
    InvalidDevelopmentWallet,

    #[msg("New authority cannot be the default key or the current authority.")]
    InvalidNewAuthority,

    #[msg("No authority transfer is pending.")]
    NoPendingAuthorityTransfer,

    #[msg("The signer is not the pending authority.")]
    InvalidPendingAuthority,

    #[msg("Buyback reserve has not reached its configured threshold.")]
    BuybackThresholdNotReached,

    #[msg("Buyback quote amount must be greater than zero and at least the configured threshold.")]
    InvalidBuybackAmount,

    #[msg("Requested buyback amount exceeds the current buyback reserve.")]
    BuybackAmountExceedsReserve,

    #[msg("Minimum base token output must be greater than zero.")]
    InvalidBuybackMinimumOut,

    #[msg("The buyback authority PDA must remain a System Program account.")]
    InvalidBuybackAuthorityOwner,

    #[msg("The configured project key must equal the base token mint being bought and burned.")]
    InvalidBuybackBaseMint,

    #[msg("The quote mint must be wrapped SOL.")]
    InvalidBuybackQuoteMint,

    #[msg("The base mint is not owned by the supplied base token program.")]
    InvalidBaseTokenProgram,

    #[msg("The buyback base token account is invalid or is not the canonical ATA for the buyback PDA.")]
    InvalidBuybackBaseTokenAccount,

    #[msg("The buyback WSOL token account is invalid or is not the canonical ATA for the buyback PDA.")]
    InvalidBuybackWsolAccount,

    #[msg("The PumpSwap pool account is invalid for this base mint / WSOL pair.")]
    InvalidPumpSwapPool,

    #[msg("The supplied PumpSwap pool token vaults do not match the Pool account.")]
    InvalidPumpSwapPoolVault,

    #[msg("The supplied PumpSwap protocol fee token account is not the canonical quote ATA.")]
    InvalidPumpSwapProtocolFeeAta,

    #[msg("The supplied PumpSwap creator vault authority or quote ATA is invalid.")]
    InvalidPumpSwapCreatorVault,

    #[msg("The PumpSwap global config PDA is invalid.")]
    InvalidPumpSwapGlobalConfig,

    #[msg("The PumpSwap event authority PDA is invalid.")]
    InvalidPumpSwapEventAuthority,

    #[msg("The PumpSwap pool-v2 PDA is invalid.")]
    InvalidPumpSwapPoolV2,

    #[msg("The Pump global volume accumulator PDA is invalid.")]
    InvalidPumpGlobalVolumeAccumulator,

    #[msg("The Pump user volume accumulator PDA is invalid.")]
    InvalidPumpUserVolumeAccumulator,

    #[msg("The Pump fee config PDA is invalid.")]
    InvalidPumpFeeConfig,

    #[msg("The supplied breaking fee recipient is not in Pump's official allowlist.")]
    InvalidBreakingFeeRecipient,

    #[msg("The breaking fee recipient WSOL ATA is invalid.")]
    InvalidBreakingFeeRecipientAta,

    #[msg("PumpSwap did not spend exactly the requested quote budget.")]
    BuybackQuoteSpendMismatch,

    #[msg("PumpSwap returned no base tokens to burn.")]
    BuybackNoTokensReceived,

    #[msg("PumpSwap returned fewer base tokens than the caller's minimum output.")]
    BuybackBelowMinimum,

    #[msg("The base token balance after burn does not match the pre-buyback balance.")]
    BuybackBurnBalanceMismatch,

    #[msg("The base mint supply did not decrease by exactly the burned amount.")]
    BuybackMintSupplyMismatch,

    #[msg("The WSOL balance after the buyback did not return to its pre-buyback balance.")]
    BuybackWsolBalanceMismatch,

    #[msg("The buyback authority operational buffer is smaller than the requested buyback batch.")]
    InsufficientBuybackOperationalBuffer,

    #[msg("The liquidity reserve has not reached its configured threshold.")]
    LiquidityThresholdNotReached,

    #[msg("The liquidity authority PDA must remain a System Program account.")]
    InvalidLiquidityAuthorityOwner,
}

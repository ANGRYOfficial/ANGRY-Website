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
}

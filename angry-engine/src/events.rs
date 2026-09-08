use anchor_lang::prelude::*;

#[event]
pub struct EngineInitialized {
    pub config: Pubkey,
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub project: Pubkey,
    pub development_wallet: Pubkey,
    pub buyback_bps: u16,
    pub liquidity_bps: u16,
    pub development_bps: u16,
    pub buyback_threshold: u64,
    pub liquidity_threshold: u64,
    pub development_threshold: u64,
    pub timestamp: i64,
}

#[event]
pub struct FeesSynced {
    pub config: Pubkey,
    pub vault: Pubkey,
    pub new_fees: u64,
    pub buyback_amount: u64,
    pub liquidity_amount: u64,
    pub development_amount: u64,
    pub buyback_reserve: u64,
    pub liquidity_reserve: u64,
    pub development_reserve: u64,
    pub accounted_balance: u64,
    pub total_received: u64,
    pub timestamp: i64,
}

#[event]
pub struct EnginePauseChanged {
    pub config: Pubkey,
    pub paused: bool,
    pub authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct EngineSettingsUpdated {
    pub config: Pubkey,
    pub authority: Pubkey,
    pub development_wallet: Pubkey,
    pub buyback_bps: u16,
    pub liquidity_bps: u16,
    pub development_bps: u16,
    pub buyback_threshold: u64,
    pub liquidity_threshold: u64,
    pub development_threshold: u64,
    pub timestamp: i64,
}

#[event]
pub struct DevelopmentSettled {
    pub config: Pubkey,
    pub vault: Pubkey,
    pub development_wallet: Pubkey,
    pub amount: u64,
    pub remaining_accounted_balance: u64,
    pub total_development_settled: u64,
    pub timestamp: i64,
}

#[event]
pub struct AuthorityTransferProposed {
    pub config: Pubkey,
    pub current_authority: Pubkey,
    pub pending_authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct AuthorityTransferAccepted {
    pub config: Pubkey,
    pub previous_authority: Pubkey,
    pub new_authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct AuthorityTransferCancelled {
    pub config: Pubkey,
    pub authority: Pubkey,
    pub cancelled_pending_authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct BuybackBurnExecuted {
    pub config: Pubkey,
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub buyback_authority: Pubkey,
    pub pool: Pubkey,
    pub base_mint: Pubkey,
    pub quote_amount_in: u64,
    pub base_amount_received: u64,
    pub base_amount_burned: u64,
    pub mint_supply_before: u64,
    pub mint_supply_after: u64,
    pub remaining_buyback_reserve: u64,
    pub remaining_accounted_balance: u64,
    pub total_buyback_processed: u64,
    pub timestamp: i64,
}

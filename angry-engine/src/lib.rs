use anchor_lang::prelude::*;

pub mod accounting;
pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

pub use instructions::*;

// PLACEHOLDER ONLY.
// Replace exactly once with the new ANGRY Engine Clean Devnet program ID before
// the first Build/Deploy. Then create and audit a fresh full snapshot.
declare_id!("NmWNEKmU9N7YWKB2QeBMUAJC1NxuiYwSo1dX4NrKo6C");

#[program]
pub mod angry_engine_clean {
    use super::*;

    pub fn initialize_engine(
        ctx: Context<InitializeEngine>,
        args: InitializeEngineArgs,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, args)
    }

    pub fn sync_fees(ctx: Context<SyncFees>) -> Result<()> {
        instructions::sync_fees::handler(ctx)
    }

    pub fn pause_engine(ctx: Context<PauseEngine>) -> Result<()> {
        instructions::admin::pause_engine_handler(ctx)
    }

    pub fn unpause_engine(ctx: Context<UnpauseEngine>) -> Result<()> {
        instructions::admin::unpause_engine_handler(ctx)
    }

    pub fn update_engine_settings(
        ctx: Context<UpdateEngineSettings>,
        args: UpdateEngineSettingsArgs,
    ) -> Result<()> {
        instructions::admin::update_settings_handler(ctx, args)
    }

    pub fn propose_authority(
        ctx: Context<ProposeAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::admin::propose_authority_handler(
            ctx,
            new_authority,
        )
    }

    pub fn accept_authority(
        ctx: Context<AcceptAuthority>,
    ) -> Result<()> {
        instructions::admin::accept_authority_handler(ctx)
    }

    pub fn cancel_authority_transfer(
        ctx: Context<CancelAuthorityTransfer>,
    ) -> Result<()> {
        instructions::admin::cancel_authority_transfer_handler(ctx)
    }

    pub fn settle_development(
        ctx: Context<SettleDevelopment>,
    ) -> Result<()> {
        instructions::development::handler(ctx)
    }
}

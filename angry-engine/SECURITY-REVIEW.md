# ANGRY Engine Security Review

**Status:** Devnet security-review checkpoint  
**Review date:** 2026-09-12  
**Network tested:** Solana Devnet  
**Program ID:** `NmWNEKmU9N7YWKB2QeBMUAJC1NxuiYwSo1dX4NrKo6C`  
**Branch:** `angry-engine-liquidity-token2022-r1`  
**Checkpoint before this report:** `e3b2c9cd4a87f11c1faba02af3f3fa89370b37e4`

> This document records the internal source review,
> adversarial regression testing, and real Devnet
> runtime verification performed on ANGRY Engine.
>
> It is not a guarantee of perfect security and is
> not a substitute for an independent professional audit.

---

## 1. Review Result

At this checkpoint:

- No known Critical finding remains open in the reviewed scope.
- No known High finding remains open in the reviewed scope.
- No known Medium finding remains open in the reviewed scope.
- Informational and operational considerations remain documented.
- Real Devnet verification passed for accounting, authority controls,
  pause/unpause, settings transitions, authority rotation,
  development settlement, buyback/burn, liquidity staging,
  liquidity deployment, PumpSwap validation, pool-mode rejection,
  and production-style buyback slippage policy.

This result applies only to the source, deployment,
configuration, dependencies, and tests reviewed at this checkpoint.

---

## 2. Public Instructions Reviewed

The reviewed ANGRY Engine entrypoints are:

1. `initialize_engine`
2. `sync_fees`
3. `pause_engine`
4. `unpause_engine`
5. `update_engine_settings`
6. `propose_authority`
7. `accept_authority`
8. `cancel_authority_transfer`
9. `settle_development`
10. `stage_liquidity`
11. `deploy_liquidity`
12. `execute_buyback_burn`

---

## 3. Core Accounting Review

EngineConfig tracks the important Engine state including:

- current authority
- immutable seed authority
- pending authority
- project mint
- development wallet
- allocation BPS
- processing thresholds
- buyback reserve
- liquidity reserve
- staged liquidity
- development reserve
- accounted balance
- total received
- lifetime processed totals
- allocation epoch totals
- pause state
- PDA bumps
- version

The primary reserve invariant reviewed is:

```text
buybackReserve
+ liquidityReserve
+ liquidityStaged
+ developmentReserve
= accountedBalance
```

The lifetime accounting invariant is:

```text
accountedBalance
+ totalDevelopmentSettled
+ totalBuybackProcessed
+ totalLiquidityDeployed
= totalReceived
```

Allocation uses checked arithmetic and cumulative epoch accounting.
Fee splitting across multiple sync calls does not change final BPS allocation.

---

## 4. Vault and Custody Review

Engine accounting separates rent-exempt SOL, creator-fee accounting,
staged liquidity custody, and operational PDA buffers.

EngineVault must back all non-staged accounted balance.
Liquidity Authority PDA must back rent plus liquidityStaged.

Runtime verification confirmed both custody checks after state transitions.

---

## 5. Authority and Administration Review

Reviewed administration properties include:

- pause_engine requires the current authority.
- unpause_engine requires current authority and valid vault backing.
- update_engine_settings requires the Engine to be paused.
- pending fees are synchronized under OLD BPS before settings change.
- allocation epoch resets after new settings become active.
- existing reserves are not retroactively reallocated.
- authority transfer uses propose and accept.
- pending authority transfer can be cancelled.
- only the exact pending signer can accept authority.
- old authority loses privileged access after rotation.
- seed_authority remains unchanged after authority rotation.
- Engine PDA addresses remain stable across authority rotation.
- staged liquidity remains attached to the same Engine configuration.

Real Devnet testing confirmed propose -> cancel -> propose -> accept.
After acceptance, old authority was rejected and new authority worked.

---

## 6. Development Settlement Review

settle_development is intentionally permissionless to trigger.
The caller cannot redirect funds to an arbitrary recipient.
The recipient must match config.development_wallet.

Runtime testing confirmed:

- settlement is rejected while Engine is paused.
- obsolete development wallet is rejected.
- configured wallet receives the exact development reserve.
- development reserve becomes zero after settlement.
- lifetime settlement accounting increases by the exact amount.

If development_wallet changes before settlement, existing unsettled
development reserve follows the currently configured wallet.
This is configuration behavior, not a theft vector.

---

## 7. Buyback and Burn Review

execute_buyback_burn was reviewed for:

- authority signer enforcement
- Engine pause enforcement
- project/base mint matching
- canonical base token account
- canonical WSOL token account
- PumpSwap program ownership and pool discriminator
- pool mint and vault relationships
- protocol fee account validation
- creator vault authority and ATA validation
- global configuration and event-authority PDAs
- global and user volume accumulator PDAs
- fee configuration and Pool V2 PDAs
- breaking-fee-recipient whitelist
- Mayhem mode rejection
- Cashback mode rejection

Runtime checks confirmed exact quote spending and minimum base output.
Only newly purchased base tokens are burned.
Pre-existing token-account dust is preserved.
Mint supply decreases by the exact burned amount.

Engine accounting is updated only after swap and burn checks succeed.

The Buyback Authority operational SOL buffer is outside creator-fee accounting.
Insufficient operational buffer is a liveness issue, not a reserve-ownership change.

---

## 8. Production Buyback Slippage Policy

Production client policy currently uses a default slippage of 200 bps (2%).
The configured policy maximum is 500 bps (5%).

Production flow reviewed:

1. Fetch a fresh PumpSwap quote.
2. Calculate expected base output.
3. Derive minBaseOut from the configured slippage.
4. Simulate using that minBaseOut.
5. Refresh the quote immediately before real send.
6. Calculate the final minBaseOut again.
7. Run final simulation.
8. Send using the same final minBaseOut.

If final simulation fails, slippage is not widened automatically.
The client must fetch a fresh quote and repeat the decision process.

The 2% value is an operational default, not a guarantee against
all market movement, MEV, or sudden liquidity changes.

---

## 9. Liquidity Staging Review

stage_liquidity was reviewed for:

- authority signer requirement
- Engine pause protection
- lazy fee synchronization
- liquidity threshold enforcement
- EngineVault backing
- System-owned and data-empty Liquidity Authority PDA
- Liquidity Authority rent buffer
- exact reserve movement

The state transition is:

liquidityReserve -> liquidityStaged

accountedBalance remains unchanged during staging because the SOL
remains inside ANGRY-controlled accounting custody.

Runtime testing confirmed staged liquidity survives settings changes
and authority rotation without disappearing or being double-counted.

---

## 10. PumpSwap Liquidity Deployment Review

deploy_liquidity validates the ANGRY authority, pause state,
project/base mint, quote mint, token programs, canonical ATAs,
PumpSwap pool ownership/discriminator, pool mints and vaults,
LP mint/account, creator accounts, fee accounts, and required PDAs.

Mayhem and Cashback pool modes are rejected before PumpSwap CPI.

Successful deployment requires exact WSOL spending, exact base output,
exact LP delta, and restoration of temporary base/WSOL balances.

After successful deployment:

- liquidityStaged decreases by the exact deployed amount.
- accountedBalance decreases by the exact deployed amount.
- totalLiquidityDeployed increases by the exact deployed amount.

---

## 11. PumpSwap Pool-Mode Hardening

PumpSwap pool data offsets reviewed:

- Mayhem mode byte: 243
- Cashback coin byte: 244

ANGRY rejects either unsupported mode using:

UnsupportedPumpSwapPoolMode

The rejection occurs before PumpSwap CPI.

Real Devnet Mayhem and Cashback pools were used in negative testing.
Both unsupported modes were rejected by ANGRY before PumpSwap execution.

---

## 12. Account-Substitution Regression Testing

Part 3B adversarial regression tests exercised substitution of external
PumpSwap-related accounts supplied to the ANGRY instructions.

Invalid substitutions were rejected before PumpSwap CPI.
The valid control configuration reached PumpSwap correctly.

This coverage reduces the risk of callers supplying valid-looking but
unrelated external accounts to redirect or corrupt the intended operation.

---

## 13. Final State-Machine Runtime Verification

Verifier:

client/part3b/verify-engine-state-machine.mjs

Committed in:

e3b2c9cd4a87f11c1faba02af3f3fa89370b37e4

SHA-256:

f98c021f38d32a2836609b9c1e56c87a874852fb1c6ae09d10508631cee5458d

The real Devnet state-machine test passed all targeted checks.

Initial 25/15/60 allocation was exact.
Liquidity staging preserved accountedBalance.
Development settlement was rejected while paused.
Liquidity staging was rejected while paused.

A fee arriving while paused was synchronized using OLD 25/15/60 BPS
before update_engine_settings activated the new configuration.

The new allocation epoch then used 30/20/50.
Existing reserves and staged liquidity remained intact.

Authority rotation passed propose -> cancel -> propose -> accept.
seed_authority remained unchanged.
Old authority was rejected after rotation.
New authority successfully controlled and unpaused the Engine.

Direct SOL sent to EngineVault entered the active accounting epoch.
Cumulative allocation rounding remained exact.

Permissionless development settlement paid only the configured wallet.
The obsolete development wallet was rejected.

Final staged liquidity equaled old staged liquidity plus new staging.

---

## 14. Final Runtime Invariants

The final state-machine verifier confirmed:

- reserve total == accountedBalance
- accountedBalance + processed totals == totalReceived
- epoch buyback allocation exact
- epoch liquidity allocation exact
- epoch development allocation exact
- EngineVault backing passed
- Liquidity Authority PDA backing plus rent passed
- final authority remained the new signer
- seed_authority remained immutable
- final development wallet remained correct

Final verifier banner:

ANGRY ENGINE DEVNET STATE-MACHINE VERIFIED
PAUSE / SETTINGS / AUTHORITY / ACCOUNTING / DEVELOPMENT / STAGING PASSED

RPC 429 responses observed during testing were Devnet rate limits.
Retries completed successfully and did not invalidate the passing invariants.

---

## 15. Other Verifier Evidence

Part 3 verifier:
client/part3b/verify-part3.mjs
SHA-256: 75e809208564aef15849c6d942a8ef753ff4d98a66c5010e23c49138d0808e9e

Known successful Part 3B Devnet transaction:
3SdVMyHdP85KpczZBGyV15aKWK48o8YTua8Xwfx3uU4eH23sEXzmyYxdPhBVYBuLPUuZ7rkGJTLUNq1UGR7Sk8iw

Production buyback verifier:
client/part3b/verify-buyback-production-slippage.mjs
SHA-256: 1bb6abdac3591ed5c76bd4807c46f4ee2e4811c720a0581194f07131af5f5fc6

Production quote helper:
client/part3b/buyback-production-quote.mjs
SHA-256: c0bd7c129a13a9ec4f68fea2fc6d0a736be49dbcde8ab4cd91f1f1ebbc5dbecb

The production quote helper is read-only and does not expose send APIs.

---

## 16. Relevant Security Hardening Commits

Liquidity PumpSwap pool-mode hardening:
1791cc8604a92d1916476756bcdf2e6dca28993f

Liquidity adversarial regression tests:
1306050f28a391bd267e7fa983fec545b86ea915

Buyback PumpSwap pool-mode hardening:
24fa04daf5ac15af88f15be1e7bc8f4bd29bbe73

Buyback pool-mode regression test:
0c820674c573d39b53f550b14a8496247f6e1bd9

Production buyback slippage verifier:
0044e3ab5d5442664f9a81ec37a5d0dcd14021fa

Final state-machine verifier:
e3b2c9cd4a87f11c1faba02af3f3fa89370b37e4

---

## 17. Informational and Operational Considerations

I-01: Direct SOL transfers to EngineVault are treated as incoming fees.
The sender contributes their own SOL, but this can affect threshold timing.

I-02: Development settlement timing is permissionless.
The caller can trigger settlement but cannot redirect the recipient.

I-03: Existing unsettled development reserve follows the current
development_wallet after an authorized settings update.

I-04: Strict liquidity output checks may require a fresh quote when
normal pool movement changes expected execution.

I-05: The production 2% buyback slippage setting is an operational default,
not a universal guarantee for every market condition.

I-06: Buyback Authority requires an operational SOL buffer.
Insufficient buffer can stop execution but does not change reserve ownership.

I-07: ANGRY_DIAG_* development logs should be reviewed and unnecessary
diagnostic logging removed before the final mainnet build.

I-08: liquidity.rs.part3a-backup is not compiled, but it should be moved
out of src or deleted before mainnet to avoid reviewer/scanner ambiguity.

---

## 18. Static Source Sweep

The reviewed active source did not expose unexpected uses of:

- unwrap
- expect
- panic
- unreachable
- unsafe
- wrapping arithmetic
- saturating arithmetic

Active direct lamport mutations were limited to reviewed custody paths:

- development settlement
- buyback reimbursement
- liquidity staging

Unchecked PumpSwap/PDA accounts were reviewed for explicit validation
or deterministic address constraints before CPI.

---

## 19. Mainnet Cleanup Checklist

- [ ] Remove or relocate liquidity.rs.part3a-backup from src.
- [ ] Review and remove unnecessary ANGRY_DIAG_* logs.
- [ ] Confirm cleanup introduces no accounting/state changes.
- [ ] Re-run static source sweep.
- [ ] Rebuild the Solana SBF program from clean source.
- [ ] Confirm Program ID.
- [ ] Confirm upgrade authority.
- [ ] Re-run state-machine verifier after cleanup.
- [ ] Re-run Buyback/Burn verifier after cleanup.
- [ ] Re-run Part 3B liquidity verifier after cleanup.
- [ ] Re-run unsupported pool-mode negative tests.
- [ ] Record final source commit used for deployment.
- [ ] Record final binary/build provenance.
- [ ] Consider independent third-party audit before material mainnet value.

---

## 20. Scope Limitations

This review does not prove that:

- future PumpSwap changes will remain compatible.
- RPC infrastructure cannot fail.
- markets cannot move beyond configured slippage.
- MEV is eliminated.
- dependencies contain no undiscovered vulnerability.
- operator or private-key compromise is impossible.
- future code changes preserve the reviewed security properties.

Any change to source code, dependencies, SDK behavior, program configuration,
authority configuration, or external protocol behavior requires appropriate
re-review and regression testing.

---

## 21. Conclusion

Within the reviewed scope and tested Devnet configuration, ANGRY Engine
completed source-level security review, adversarial regression testing,
and real runtime verification without a known open Critical, High, or
Medium severity finding at this checkpoint.

This is not a claim of perfect security and is not a replacement for an
independent professional audit.

The next phase is mainnet cleanup, followed by a fresh build and full
post-cleanup regression cycle before any mainnet deployment decision.


# ANGRY Engine Security Review

**Status:** Post-cleanup Devnet security-review checkpoint
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

### Post-cleanup deployment checkpoint

Cleanup source commit deployed to Devnet:

`6d4db23f4eae118ea80be1bdbf36476c82275f41`

Program ID remained:

`NmWNEKmU9N7YWKB2QeBMUAJC1NxuiYwSo1dX4NrKo6C`

ProgramData account:

`DpNQ6n8CTbG1du3v6ADfSC4tWadyGFh9B87yAamwQrhr`

Post-cleanup deployment slot:

`497073535`

Upgrade authority remained:

`GJScfY4ZwpsDyLTFzNEzNBA4iWKfUSduKNQwQzT7mGYT`

The post-cleanup SBF build completed successfully in Solana Playground before
the Devnet upgrade. No contract source changes were made after cleanup commit
`6d4db23`; later commits in this branch modify verifier/test harness code only.

### Post-cleanup state-machine regression

Final state-machine verifier:

`client/part3b/verify-engine-state-machine.mjs`

SHA-256:

`17eb2b63eeb639ac573e2c0b4a10c2e20bce5fecb5ac52f0b56399b44ecbdc50`

Verifier RPC-hardening commit:

`17809f5d68592ed7302b60a0085eb868e678c579`

Post-cleanup runtime result:

- pause/unpause passed
- settings update and old-BPS lazy sync passed
- authority propose/cancel/accept passed
- old authority rejected after rotation
- new authority accepted after rotation
- accounting and epoch rounding passed
- development settlement passed
- staged liquidity survived authority rotation
- final EngineVault and Liquidity PDA backing passed

Final banners:

`ANGRY ENGINE DEVNET STATE-MACHINE VERIFIED`

`PAUSE / SETTINGS / AUTHORITY / ACCOUNTING / DEVELOPMENT / STAGING PASSED`

### Post-cleanup production Buyback/Burn regression

Production Buyback verifier:

`client/part3b/verify-buyback-production-slippage.mjs`

SHA-256:

`e1f27b380e11aa31d05cf39ec3214045c8d004fe65178adb05a40b950d40a72f`

Verifier RPC/rebroadcast-hardening commit:

`c2164f92572cf1bcacaa03bf16d83251281b36e0`

Production slippage policy remained:

- default: 200 bps (2%)
- no automatic slippage widening
- fresh live quote immediately before real send

The deliberate impossible-minimum rollback transaction was recorded on-chain
after same-signed-transaction rebroadcast and reached ANGRY -> PumpSwap before
failing.

Rollback transaction:

`3PGDi49TQhVq9DWuTpzwpaaWb9v3nrgwmFNqLbkjjCjmszMevELDHjEFXhsGuKksciVkw3KJS1eVA3evd52s5GGY`

Atomic rollback was verified across:

- Engine accounting
- EngineVault SOL
- project-token balance
- WSOL balance
- mint supply

Post-cleanup real Buyback -> PumpSwap -> Burn transaction:

`t6mZsjajKfVQmnTAcWb254ev14PPYC4XG8ShP5eTYtkRMQeYYHnFeaAZruZLCG7B8PE3gpMWtCUbg3LvPS3ogaW`

Observed burn:

`1166166762163` raw project-token units

The mint supply decreased on-chain, the Buyback token ATA and WSOL ATA returned
to their original balances, Buyback reserve accounting changed only after the
successful swap+burn, and 25/15/60 accounting remained conserved.

Final banners:

`ANGRY PART 3 R1 DEVNET VERIFIED — LIQUIDITY STAGING PASSED`

`ANGRY PART 2 DEVNET VERIFIED — PUMPSWAP -> BUYBACK -> BURN PASSED`

### Post-cleanup Part 3B liquidity deployment regression

Part 3B verifier:

`client/part3b/verify-part3.mjs`

SHA-256:

`d7976a7848e0a30e94752b75fd4a639dfdee9b42de2ce8ad2df58fbb633994ba`

Verifier RPC/rebroadcast-hardening commit:

`5966e8f2a75587b00259cb4e4b9ca05c939a6600`

Real post-cleanup PumpSwap liquidity deployment transaction:

`5La7wpuWkwTSpx9Mu3Du6EbEskXW8c3as2PsstPGin3ZGWdBmRTFdCXho6tjTVrDvXQsFTVHHBQXtuWDuJNHAyFt`

Observed deployment:

- quote used for buy: `211740` lamports
- project token bought and fully deposited: `246504160971` raw units
- quote deposited to LP: `209186` lamports
- Token-2022 LP received: `226212933` raw units
- total staged liquidity processed: `420926` lamports
- remaining liquidityStaged: `179074` lamports
- base ATA returned exactly to its pre-deploy balance
- WSOL ATA returned exactly to its pre-deploy balance
- Buyback and Development reserves were untouched
- reserve and lifetime accounting conservation passed
- PumpSwap LP mint supply increased exactly by LP received

Final banner:

`ANGRY PART 3B DEVNET VERIFIED — BUY -> PUMPSWAP LP DEPLOY PASSED`

### Post-cleanup unsupported pool-mode regression

Real Devnet Mayhem pool:

`91KCx8VWb8fVTGTjgExFWuXaP9BoJjgAGfx37b9aRJn`

Real Devnet Cashback pool:

`12BKwF4BCneqB2ZicinDXCq9jcFLQop4ByDnb9jABimD`

Part 3B results:

- Mayhem: error 6061 `UnsupportedPumpSwapPoolMode`
- Cashback: error 6061 `UnsupportedPumpSwapPoolMode`
- both: `ANGRY=true`, `PUMPSWAP=false`
- passed: 2/2

Buyback results:

- Mayhem: error 6061 `UnsupportedPumpSwapPoolMode`
- Cashback: error 6061 `UnsupportedPumpSwapPoolMode`
- both: `ANGRY=true`, `PUMPSWAP=false`
- passed: 2/2

All four negative tests were simulation-only and confirmed ANGRY rejected the
unsupported pool mode before PumpSwap CPI.

Production quote helper:

`client/part3b/buyback-production-quote.mjs`

SHA-256:

`c0bd7c129a13a9ec4f68fea2fc6d0a736be49dbcde8ab4cd91f1f1ebbc5dbecb`

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

Final security-review document:
c311856dc47900dff73bcea3bba461829e3a3b6f

Cleanup diagnostic-log removal:
6d4db23f4eae118ea80be1bdbf36476c82275f41

State-machine verifier RPC confirmation hardening:
17809f5d68592ed7302b60a0085eb868e678c579

Buyback verifier RPC/rebroadcast hardening:
c2164f92572cf1bcacaa03bf16d83251281b36e0

Part 3B verifier RPC/rebroadcast hardening:
5966e8f2a75587b00259cb4e4b9ca05c939a6600

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

I-07: RESOLVED IN CLEANUP — active `ANGRY_DIAG_*` development logs were
removed from the tracked contract source in cleanup commit `6d4db23`.

I-08: RESOLVED IN CLEANUP — `liquidity.rs.part3a-backup` is not tracked
under `angry-engine/src`; the local backup was relocated outside active source.

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

- [x] Remove or relocate liquidity.rs.part3a-backup from active src.
- [x] Review and remove unnecessary ANGRY_DIAG_* logs.
- [x] Confirm cleanup introduces no accounting/state changes.
- [x] Re-run static source sweep.
- [x] Rebuild the Solana SBF program from clean source.
- [x] Confirm Program ID.
- [x] Confirm upgrade authority.
- [x] Re-run state-machine verifier after cleanup.
- [x] Re-run Buyback/Burn verifier after cleanup.
- [x] Re-run Part 3B liquidity verifier after cleanup.
- [x] Re-run unsupported pool-mode negative tests.
- [x] Record final source commit used for the Devnet cleanup deployment.
- [ ] Record an independent final binary artifact hash/build provenance package.
- [ ] Consider independent third-party audit before material mainnet value.

Cleanup source deployed to Devnet:

`6d4db23f4eae118ea80be1bdbf36476c82275f41`

Current branch checkpoint after verifier-only hardening:

`5966e8f2a75587b00259cb4e4b9ca05c939a6600`

There are no tracked contract-source differences between the deployed cleanup
commit and the current branch checkpoint.

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
cleanup, a fresh SBF build, a Devnet upgrade, and a full post-cleanup
runtime regression cycle without a known open Critical, High, or Medium
severity finding at this checkpoint.

The post-cleanup regression cycle covered the Engine state machine,
production-style Buyback -> PumpSwap -> Burn with 2% slippage policy,
actual PumpSwap liquidity deployment and Token-2022 LP accounting, and
real Devnet Mayhem/Cashback rejection for both liquidity deployment and
Buyback paths.

The deployed cleanup contract source is commit
`6d4db23f4eae118ea80be1bdbf36476c82275f41`. Later commits through
`5966e8f2a75587b00259cb4e4b9ca05c939a6600` modify verifier/test harness
code only; the tracked contract source is unchanged from the deployed
cleanup commit.

This is not a claim of perfect security and is not a replacement for an
independent professional audit. A reproducible final binary artifact
hash/build provenance package and independent third-party review remain
recommended before placing material mainnet value at risk.


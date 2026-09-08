const assert = {
  equal(actual: unknown, expected: unknown, message?: string) {
    if (actual !== expected) {
      throw new Error(
        message ?? `Assertion failed: expected ${String(actual)} to equal ${String(expected)}`
      );
    }
  },

  include(actual: string, expected: string, message?: string) {
    if (!actual.includes(expected)) {
      throw new Error(
        message ?? `Assertion failed: expected "${actual}" to include "${expected}"`
      );
    }
  },

  isTrue(value: unknown, message?: string) {
    if (value !== true) {
      throw new Error(
        message ?? `Assertion failed: expected true but got ${String(value)}`
      );
    }
  },
};

describe("ANGRY Engine Clean - Core R5 Playground", () => {
  // Solana Playground provides pg, web3, BN and Buffer globally.
  const program = pg.program;
  const authority = pg.wallet.publicKey;

  const developmentWallet = web3.Keypair.generate();
  const intruder = web3.Keypair.generate();
  const newAuthority = web3.Keypair.generate();

  const BUYBACK_BPS = 2500;
  const LIQUIDITY_BPS = 1500;
  const DEVELOPMENT_BPS = 6000;

  const BUYBACK_THRESHOLD = new BN(1_000_000);
  const LIQUIDITY_THRESHOLD = new BN(1_000_000);
  const DEVELOPMENT_THRESHOLD = new BN(1_000_000);

  function derive(project: web3.PublicKey, seedAuthority = authority) {
    const [config] = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("angry-engine-config"),
        seedAuthority.toBuffer(),
        project.toBuffer(),
      ],
      program.programId
    );

    const [vault] = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("angry-engine-vault"),
        config.toBuffer(),
      ],
      program.programId
    );

    return { config, vault };
  }

  async function fund(pubkey: web3.PublicKey, lamports: number) {
    const tx = new web3.Transaction().add(
      web3.SystemProgram.transfer({
        fromPubkey: authority,
        toPubkey: pubkey,
        lamports,
      })
    );

    await web3.sendAndConfirmTransaction(pg.connection, tx, [pg.wallet.keypair]);
  }

  async function expectFailure(
    action: () => Promise<unknown>,
    expectedText?: string
  ) {
    let failed = false;

    try {
      await action();
    } catch (error: any) {
      failed = true;

      if (expectedText) {
        const rendered = String(error?.message ?? error);
        assert.include(rendered, expectedText);
      }
    }

    assert.isTrue(failed, "Expected transaction to fail");
  }

  before(async () => {
    // Ensure these test addresses exist on Devnet.
    await fund(developmentWallet.publicKey, 1_000_000);
    await fund(intruder.publicKey, 1_000_000);
    await fund(newAuthority.publicKey, 1_000_000);
  });

  it("rejects invalid allocation and zero thresholds", async () => {
    const invalidProjectA = web3.Keypair.generate().publicKey;
    const invalidA = derive(invalidProjectA);

    await expectFailure(
      () =>
        program.methods
          .initializeEngine({
            project: invalidProjectA,
            buybackBps: 2500,
            liquidityBps: 1500,
            developmentBps: 5900,
            buybackThreshold: BUYBACK_THRESHOLD,
            liquidityThreshold: LIQUIDITY_THRESHOLD,
            developmentThreshold: DEVELOPMENT_THRESHOLD,
          })
          .accounts({
            authority,
            developmentWallet: developmentWallet.publicKey,
            config: invalidA.config,
            vault: invalidA.vault,
            systemProgram: web3.SystemProgram.programId,
          })
          .rpc(),
      "Allocation basis points must total 10000"
    );

    const invalidProjectB = web3.Keypair.generate().publicKey;
    const invalidB = derive(invalidProjectB);

    await expectFailure(
      () =>
        program.methods
          .initializeEngine({
            project: invalidProjectB,
            buybackBps: BUYBACK_BPS,
            liquidityBps: LIQUIDITY_BPS,
            developmentBps: DEVELOPMENT_BPS,
            buybackThreshold: new BN(0),
            liquidityThreshold: LIQUIDITY_THRESHOLD,
            developmentThreshold: DEVELOPMENT_THRESHOLD,
          })
          .accounts({
            authority,
            developmentWallet: developmentWallet.publicKey,
            config: invalidB.config,
            vault: invalidB.vault,
            systemProgram: web3.SystemProgram.programId,
          })
          .rpc(),
      "All processing thresholds must be greater than zero"
    );
  });

  it("keeps 25 / 15 / 60 stable across tiny sync batches", async () => {
    const project = web3.Keypair.generate().publicKey;
    const pda = derive(project);

    await program.methods
      .initializeEngine({
        project,
        buybackBps: BUYBACK_BPS,
        liquidityBps: LIQUIDITY_BPS,
        developmentBps: DEVELOPMENT_BPS,
        buybackThreshold: new BN(1),
        liquidityThreshold: new BN(1),
        developmentThreshold: new BN(1),
      })
      .accounts({
        authority,
        developmentWallet: developmentWallet.publicKey,
        config: pda.config,
        vault: pda.vault,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

    await fund(pda.vault, 1);

    await program.methods
      .syncFees()
      .accounts({
        config: pda.config,
        authority,
        vault: pda.vault,
      })
      .rpc();

    await fund(pda.vault, 3);

    await program.methods
      .syncFees()
      .accounts({
        config: pda.config,
        authority,
        vault: pda.vault,
      })
      .rpc();

    const config = await program.account.engineConfig.fetch(pda.config);

    // Cumulative 4 lamports at 25/15/60 => 1 / 0 / 3.
    assert.equal(config.buybackReserve.toString(), "1");
    assert.equal(config.liquidityReserve.toString(), "0");
    assert.equal(config.developmentReserve.toString(), "3");
    assert.equal(config.accountedBalance.toString(), "4");
    assert.equal(config.totalReceived.toString(), "4");
    assert.equal(config.epochReceived.toString(), "4");
    assert.equal(config.epochBuybackAllocated.toString(), "1");
    assert.equal(config.epochLiquidityAllocated.toString(), "0");
    assert.equal(config.epochDevelopmentAllocated.toString(), "3");
  });

  it("rolls back lazy sync if development threshold is not reached", async () => {
    const project = web3.Keypair.generate().publicKey;
    const pda = derive(project);

    await program.methods
      .initializeEngine({
        project,
        buybackBps: BUYBACK_BPS,
        liquidityBps: LIQUIDITY_BPS,
        developmentBps: DEVELOPMENT_BPS,
        buybackThreshold: BUYBACK_THRESHOLD,
        liquidityThreshold: LIQUIDITY_THRESHOLD,
        developmentThreshold: DEVELOPMENT_THRESHOLD,
      })
      .accounts({
        authority,
        developmentWallet: developmentWallet.publicKey,
        config: pda.config,
        vault: pda.vault,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

    await fund(pda.vault, 100);

    await expectFailure(
      () =>
        program.methods
          .settleDevelopment()
          .accounts({
            config: pda.config,
            vault: pda.vault,
            developmentWallet: developmentWallet.publicKey,
          })
          .rpc(),
      "Development reserve has not reached"
    );

    const rolledBack = await program.account.engineConfig.fetch(pda.config);

    // The failed transaction must not persist the lazy accounting mutation.
    assert.equal(rolledBack.totalReceived.toString(), "0");
    assert.equal(rolledBack.accountedBalance.toString(), "0");
    assert.equal(rolledBack.buybackReserve.toString(), "0");
    assert.equal(rolledBack.liquidityReserve.toString(), "0");
    assert.equal(rolledBack.developmentReserve.toString(), "0");

    await expectFailure(() =>
      program.methods
        .syncFees()
        .accounts({
          config: pda.config,
          authority: intruder.publicKey,
          vault: pda.vault,
        })
        .signers([intruder])
        .rpc()
    );

    // The legitimate authority can still account the pending 100 lamports.
    await program.methods
      .syncFees()
      .accounts({
        config: pda.config,
        authority,
        vault: pda.vault,
      })
      .rpc();

    const synced = await program.account.engineConfig.fetch(pda.config);
    assert.equal(synced.totalReceived.toString(), "100");
    assert.equal(synced.accountedBalance.toString(), "100");
  });

  it("runs the main Core flow with batching, pause and atomic settings update", async () => {
    const project = web3.Keypair.generate().publicKey;
    const pda = derive(project);

    await program.methods
      .initializeEngine({
        project,
        buybackBps: BUYBACK_BPS,
        liquidityBps: LIQUIDITY_BPS,
        developmentBps: DEVELOPMENT_BPS,
        buybackThreshold: BUYBACK_THRESHOLD,
        liquidityThreshold: LIQUIDITY_THRESHOLD,
        developmentThreshold: DEVELOPMENT_THRESHOLD,
      })
      .accounts({
        authority,
        developmentWallet: developmentWallet.publicKey,
        config: pda.config,
        vault: pda.vault,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

    let config = await program.account.engineConfig.fetch(pda.config);

    assert.equal(config.authority.toBase58(), authority.toBase58());
    assert.equal(config.seedAuthority.toBase58(), authority.toBase58());
    assert.equal(config.pendingAuthority.toBase58(), web3.PublicKey.default.toBase58());
    assert.equal(config.project.toBase58(), project.toBase58());
    assert.equal(config.developmentWallet.toBase58(), developmentWallet.publicKey.toBase58());
    assert.equal(config.buybackBps, 2500);
    assert.equal(config.liquidityBps, 1500);
    assert.equal(config.developmentBps, 6000);
    assert.equal(config.totalReceived.toString(), "0");
    assert.equal(config.totalDevelopmentSettled.toString(), "0");
    assert.equal(config.totalBuybackProcessed.toString(), "0");
    assert.equal(config.totalLiquidityDeployed.toString(), "0");
    assert.equal(config.paused, false);

    await expectFailure(() =>
      program.methods
        .pauseEngine()
        .accounts({
          config: pda.config,
          authority: intruder.publicKey,
        })
        .signers([intruder])
        .rpc()
    );

    await expectFailure(
      () =>
        program.methods
          .updateEngineSettings({
            buybackBps: 2000,
            liquidityBps: 2000,
            developmentBps: 6000,
            buybackThreshold: BUYBACK_THRESHOLD,
            liquidityThreshold: LIQUIDITY_THRESHOLD,
            developmentThreshold: DEVELOPMENT_THRESHOLD,
          })
          .accounts({
            config: pda.config,
            vault: pda.vault,
            authority,
            newDevelopmentWallet: developmentWallet.publicKey,
          })
          .rpc(),
      "engine must be paused"
    );

    await fund(pda.vault, 10_000_000);

    await program.methods
      .syncFees()
      .accounts({
        config: pda.config,
        authority,
        vault: pda.vault,
      })
      .rpc();

    config = await program.account.engineConfig.fetch(pda.config);

    assert.equal(config.buybackReserve.toString(), "2500000");
    assert.equal(config.liquidityReserve.toString(), "1500000");
    assert.equal(config.developmentReserve.toString(), "6000000");
    assert.equal(config.accountedBalance.toString(), "10000000");
    assert.equal(config.totalReceived.toString(), "10000000");

    await expectFailure(
      () =>
        program.methods
          .syncFees()
          .accounts({
            config: pda.config,
            authority,
            vault: pda.vault,
          })
          .rpc(),
      "No new creator fees are available to sync"
    );

    const devBefore = await pg.connection.getBalance(
      developmentWallet.publicKey,
      "confirmed"
    );

    await program.methods
      .settleDevelopment()
      .accounts({
        config: pda.config,
        vault: pda.vault,
        developmentWallet: developmentWallet.publicKey,
      })
      .rpc();

    const devAfter = await pg.connection.getBalance(
      developmentWallet.publicKey,
      "confirmed"
    );

    assert.equal(devAfter - devBefore, 6_000_000);

    config = await program.account.engineConfig.fetch(pda.config);
    assert.equal(config.buybackReserve.toString(), "2500000");
    assert.equal(config.liquidityReserve.toString(), "1500000");
    assert.equal(config.developmentReserve.toString(), "0");
    assert.equal(config.accountedBalance.toString(), "4000000");
    assert.equal(config.totalReceived.toString(), "10000000");
    assert.equal(config.totalDevelopmentSettled.toString(), "6000000");

    await program.methods
      .pauseEngine()
      .accounts({
        config: pda.config,
        authority,
      })
      .rpc();

    await expectFailure(
      () =>
        program.methods
          .settleDevelopment()
          .accounts({
            config: pda.config,
            vault: pda.vault,
            developmentWallet: developmentWallet.publicKey,
          })
          .rpc(),
      "The engine is paused"
    );

    // Fees arrive while paused. updateEngineSettings must account these under
    // OLD 25/15/60 and update settings in one transaction.
    await fund(pda.vault, 3_000_000);

    await program.methods
      .updateEngineSettings({
        buybackBps: 2000,
        liquidityBps: 2000,
        developmentBps: 6000,
        buybackThreshold: BUYBACK_THRESHOLD,
        liquidityThreshold: LIQUIDITY_THRESHOLD,
        developmentThreshold: DEVELOPMENT_THRESHOLD,
      })
      .accounts({
        config: pda.config,
        vault: pda.vault,
        authority,
        newDevelopmentWallet: developmentWallet.publicKey,
      })
      .rpc();

    config = await program.account.engineConfig.fetch(pda.config);

    // The pending 3m was allocated under OLD 25/15/60:
    // +750k buyback, +450k liquidity, +1.8m development.
    assert.equal(config.buybackReserve.toString(), "3250000");
    assert.equal(config.liquidityReserve.toString(), "1950000");
    assert.equal(config.developmentReserve.toString(), "1800000");
    assert.equal(config.accountedBalance.toString(), "7000000");
    assert.equal(config.totalReceived.toString(), "13000000");

    assert.equal(config.buybackBps, 2000);
    assert.equal(config.liquidityBps, 2000);
    assert.equal(config.developmentBps, 6000);

    // New settings start a new cumulative rounding epoch.
    assert.equal(config.epochReceived.toString(), "0");
    assert.equal(config.epochBuybackAllocated.toString(), "0");
    assert.equal(config.epochLiquidityAllocated.toString(), "0");
    assert.equal(config.epochDevelopmentAllocated.toString(), "0");
    assert.equal(config.paused, true);

    // Unpause now also verifies real vault backing, not only internal counters.
    await program.methods
      .unpauseEngine()
      .accounts({
        config: pda.config,
        vault: pda.vault,
        authority,
      })
      .rpc();

    await expectFailure(() =>
      program.methods
        .settleDevelopment()
        .accounts({
          config: pda.config,
          vault: pda.vault,
          developmentWallet: authority,
        })
        .rpc()
    );

    // No separate sync. Settlement must lazy-sync the new 10m under NEW
    // 20/20/60, then settle the whole accumulated developer reserve.
    await fund(pda.vault, 10_000_000);

    const secondDevBefore = await pg.connection.getBalance(
      developmentWallet.publicKey,
      "confirmed"
    );

    await program.methods
      .settleDevelopment()
      .accounts({
        config: pda.config,
        vault: pda.vault,
        developmentWallet: developmentWallet.publicKey,
      })
      .rpc();

    const secondDevAfter = await pg.connection.getBalance(
      developmentWallet.publicKey,
      "confirmed"
    );

    assert.equal(secondDevAfter - secondDevBefore, 7_800_000);

    config = await program.account.engineConfig.fetch(pda.config);

    assert.equal(config.buybackReserve.toString(), "5250000");
    assert.equal(config.liquidityReserve.toString(), "3950000");
    assert.equal(config.developmentReserve.toString(), "0");
    assert.equal(config.accountedBalance.toString(), "9200000");
    assert.equal(config.totalReceived.toString(), "23000000");
    assert.equal(config.totalDevelopmentSettled.toString(), "13800000");
    assert.equal(config.totalBuybackProcessed.toString(), "0");
    assert.equal(config.totalLiquidityDeployed.toString(), "0");

    // Lifetime creator-fee conservation:
    // 23m received = 9.2m still reserved + 13.8m development settled.
    assert.equal(
      Number(config.accountedBalance.toString()) +
        Number(config.totalDevelopmentSettled.toString()),
      Number(config.totalReceived.toString())
    );
  });

  it("rotates authority with two-step acceptance while preserving the same PDAs", async () => {
    const project = web3.Keypair.generate().publicKey;
    const pda = derive(project);

    await program.methods
      .initializeEngine({
        project,
        buybackBps: BUYBACK_BPS,
        liquidityBps: LIQUIDITY_BPS,
        developmentBps: DEVELOPMENT_BPS,
        buybackThreshold: BUYBACK_THRESHOLD,
        liquidityThreshold: LIQUIDITY_THRESHOLD,
        developmentThreshold: DEVELOPMENT_THRESHOLD,
      })
      .accounts({
        authority,
        developmentWallet: developmentWallet.publicKey,
        config: pda.config,
        vault: pda.vault,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .pauseEngine()
      .accounts({
        config: pda.config,
        authority,
      })
      .rpc();

    await program.methods
      .proposeAuthority(newAuthority.publicKey)
      .accounts({
        config: pda.config,
        authority,
      })
      .rpc();

    let config = await program.account.engineConfig.fetch(pda.config);
    assert.equal(config.pendingAuthority.toBase58(), newAuthority.publicKey.toBase58());
    assert.equal(config.seedAuthority.toBase58(), authority.toBase58());

    await expectFailure(() =>
      program.methods
        .acceptAuthority()
        .accounts({
          config: pda.config,
          pendingAuthority: intruder.publicKey,
        })
        .signers([intruder])
        .rpc()
    );

    await program.methods
      .acceptAuthority()
      .accounts({
        config: pda.config,
        pendingAuthority: newAuthority.publicKey,
      })
      .signers([newAuthority])
      .rpc();

    config = await program.account.engineConfig.fetch(pda.config);
    assert.equal(config.authority.toBase58(), newAuthority.publicKey.toBase58());
    assert.equal(config.seedAuthority.toBase58(), authority.toBase58());
    assert.equal(config.pendingAuthority.toBase58(), web3.PublicKey.default.toBase58());

    // Old authority can no longer unpause.
    await expectFailure(() =>
      program.methods
        .unpauseEngine()
        .accounts({
          config: pda.config,
          vault: pda.vault,
          authority,
        })
        .rpc()
    );

    // New authority controls the same config/vault PDA.
    await program.methods
      .unpauseEngine()
      .accounts({
        config: pda.config,
        vault: pda.vault,
        authority: newAuthority.publicKey,
      })
      .signers([newAuthority])
      .rpc();

    await program.methods
      .pauseEngine()
      .accounts({
        config: pda.config,
        authority: newAuthority.publicKey,
      })
      .signers([newAuthority])
      .rpc();

    await program.methods
      .proposeAuthority(intruder.publicKey)
      .accounts({
        config: pda.config,
        authority: newAuthority.publicKey,
      })
      .signers([newAuthority])
      .rpc();

    await program.methods
      .cancelAuthorityTransfer()
      .accounts({
        config: pda.config,
        authority: newAuthority.publicKey,
      })
      .signers([newAuthority])
      .rpc();

    config = await program.account.engineConfig.fetch(pda.config);
    assert.equal(config.pendingAuthority.toBase58(), web3.PublicKey.default.toBase58());
    assert.equal(config.authority.toBase58(), newAuthority.publicKey.toBase58());
  });
});

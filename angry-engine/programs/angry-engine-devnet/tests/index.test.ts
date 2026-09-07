describe("ANGRY Engine v0.6B Buyback SOL Staging Test", () => {
  it("Processes creator fees and stages Buyback SOL on real Devnet", async () => {
    const payer = pg.wallet.keypair;

    const ANGRY_V06B_PROGRAM_ID = new web3.PublicKey(
      "9LeVEqRxnkaTGWkkQoNSdjb8PLcLbjnecQTkBcqsAS92"
    );

    assert.equal(
      pg.PROGRAM_ID.toString(),
      ANGRY_V06B_PROGRAM_ID.toString(),
      "Wrong Playground Program ID. Open the ANGRY Engine v06B Build project."
    );

    const [configPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("angry-engine-config")],
      ANGRY_V06B_PROGRAM_ID
    );

    const [vaultPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("angry-engine-vault")],
      ANGRY_V06B_PROGRAM_ID
    );

    const [buybackSolPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("angry-engine-buyback-sol")],
      ANGRY_V06B_PROGRAM_ID
    );

    console.log(
      "ANGRY v0.6B Program:",
      ANGRY_V06B_PROGRAM_ID.toString()
    );
    console.log("Config PDA:", configPda.toString());
    console.log("Vault PDA:", vaultPda.toString());
    console.log("Buyback SOL PDA:", buybackSolPda.toString());
    console.log("Authority:", pg.wallet.publicKey.toString());

    // Initialize only on the first run.
    const configInfoBefore =
      await pg.connection.getAccountInfo(
        configPda,
        "confirmed"
      );

    if (configInfoBefore === null) {
      console.log("Initializing temporary ANGRY Engine v0.6B...");

      const initializeSignature =
        await pg.program.methods
          .initializeEngine()
          .accounts({
            authority: pg.wallet.publicKey,
            developmentWallet: pg.wallet.publicKey,
            config: configPda,
            vault: vaultPda,
            systemProgram: web3.SystemProgram.programId,
          })
          .rpc();

      console.log(
        "Initialize TX:",
        initializeSignature
      );

      await pg.connection.confirmTransaction(
        initializeSignature,
        "confirmed"
      );
    } else {
      console.log(
        "Existing temporary v0.6B config found — initialization skipped"
      );
    }

    const config =
      await pg.program.account.engineConfig.fetch(
        configPda
      );

    assert(
      config.authority.equals(pg.wallet.publicKey),
      "Playground wallet is not v0.6B authority"
    );

    assert.equal(
      config.buybackBurnBps.toString(),
      "4000"
    );

    assert.equal(
      config.liquidityBps.toString(),
      "4000"
    );

    assert.equal(
      config.developmentBps.toString(),
      "2000"
    );

    console.log("✅ v0.6B CONFIG VERIFIED: 40 / 40 / 20");

    const vaultBefore =
      await pg.program.account.engineVault.fetch(
        vaultPda
      );

    const TEST_CREATOR_FEE = 5_000_000;
    const EXPECTED_BUYBACK = 2_000_000;
    const EXPECTED_LIQUIDITY = 2_000_000;
    const EXPECTED_DEVELOPMENT = 1_000_000;

    console.log(
      "Sending creator fee:",
      TEST_CREATOR_FEE,
      "lamports"
    );

    const transferTransaction =
      new web3.Transaction().add(
        web3.SystemProgram.transfer({
          fromPubkey: pg.wallet.publicKey,
          toPubkey: vaultPda,
          lamports: TEST_CREATOR_FEE,
        })
      );

    const transferSignature =
      await web3.sendAndConfirmTransaction(
        pg.connection,
        transferTransaction,
        [payer],
        {
          commitment: "confirmed",
        }
      );

    console.log(
      "Creator Fee TX:",
      transferSignature
    );

    const syncSignature =
      await pg.program.methods
        .syncFees()
        .accounts({
          config: configPda,
          vault: vaultPda,
        })
        .rpc();

    console.log("Sync Fees TX:", syncSignature);

    await pg.connection.confirmTransaction(
      syncSignature,
      "confirmed"
    );

    const vaultAfterSync =
      await pg.program.account.engineVault.fetch(
        vaultPda
      );

    assert.equal(
      vaultAfterSync.totalReceived.toString(),
      new BN(vaultBefore.totalReceived.toString())
        .add(new BN(TEST_CREATOR_FEE))
        .toString()
    );

    assert.equal(
      vaultAfterSync.buybackBurnReserve.toString(),
      new BN(vaultBefore.buybackBurnReserve.toString())
        .add(new BN(EXPECTED_BUYBACK))
        .toString()
    );

    assert.equal(
      vaultAfterSync.liquidityReserve.toString(),
      new BN(vaultBefore.liquidityReserve.toString())
        .add(new BN(EXPECTED_LIQUIDITY))
        .toString()
    );

    assert.equal(
      vaultAfterSync.developmentReserve.toString(),
      new BN(vaultBefore.developmentReserve.toString())
        .add(new BN(EXPECTED_DEVELOPMENT))
        .toString()
    );

    assert.equal(
      vaultAfterSync.accountedBalance.toString(),
      new BN(vaultBefore.accountedBalance.toString())
        .add(new BN(TEST_CREATOR_FEE))
        .toString()
    );

    console.log(
      "✅ CREATOR FEE SPLIT VERIFIED:"
    );
    console.log(
      "Buyback/Burn +",
      EXPECTED_BUYBACK
    );
    console.log(
      "Liquidity +",
      EXPECTED_LIQUIDITY
    );
    console.log(
      "Development +",
      EXPECTED_DEVELOPMENT
    );

    const buybackSolBalanceBefore =
      await pg.connection.getBalance(
        buybackSolPda,
        "confirmed"
      );

    console.log(
      "Buyback SOL balance BEFORE staging:",
      buybackSolBalanceBefore
    );

    const stageSignature =
      await pg.program.methods
        .stageBuybackSol(
          new BN(EXPECTED_BUYBACK)
        )
        .accounts({
          config: configPda,
          authority: pg.wallet.publicKey,
          vault: vaultPda,
          buybackSolVault: buybackSolPda,
        })
        .rpc();

    console.log(
      "Stage Buyback SOL TX:",
      stageSignature
    );

    await pg.connection.confirmTransaction(
      stageSignature,
      "confirmed"
    );

    const vaultAfterStage =
      await pg.program.account.engineVault.fetch(
        vaultPda
      );

    const buybackSolBalanceAfter =
      await pg.connection.getBalance(
        buybackSolPda,
        "confirmed"
      );

    console.log(
      "Buyback reserve AFTER staging:",
      vaultAfterStage.buybackBurnReserve.toString()
    );

    console.log(
      "Liquidity reserve:",
      vaultAfterStage.liquidityReserve.toString()
    );

    console.log(
      "Development reserve:",
      vaultAfterStage.developmentReserve.toString()
    );

    console.log(
      "Accounted balance AFTER staging:",
      vaultAfterStage.accountedBalance.toString()
    );

    console.log(
      "Buyback SOL balance AFTER staging:",
      buybackSolBalanceAfter
    );

    assert.equal(
      vaultAfterStage.buybackBurnReserve.toString(),
      new BN(
        vaultAfterSync.buybackBurnReserve.toString()
      )
        .sub(new BN(EXPECTED_BUYBACK))
        .toString()
    );

    assert.equal(
      vaultAfterStage.liquidityReserve.toString(),
      vaultAfterSync.liquidityReserve.toString()
    );

    assert.equal(
      vaultAfterStage.developmentReserve.toString(),
      vaultAfterSync.developmentReserve.toString()
    );

    assert.equal(
      vaultAfterStage.accountedBalance.toString(),
      new BN(
        vaultAfterSync.accountedBalance.toString()
      )
        .sub(new BN(EXPECTED_BUYBACK))
        .toString()
    );

    assert.equal(
      buybackSolBalanceAfter.toString(),
      (
        buybackSolBalanceBefore +
        EXPECTED_BUYBACK
      ).toString()
    );

    console.log(
      "✅ ANGRY ENGINE v0.6B BUYBACK SOL STAGING PASSED"
    );
  });
});

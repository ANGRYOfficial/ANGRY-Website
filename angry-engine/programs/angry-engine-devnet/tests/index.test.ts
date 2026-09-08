describe("ANGRY Engine v0.6C WSOL Buyback Preparation Test", () => {
  it("Converts staged Buyback SOL into WSOL on real Devnet", async () => {
    const payer = pg.wallet.keypair;

    const ANGRY_V06C_PROGRAM_ID = new web3.PublicKey(
      "9LeVEqRxnkaTGWkkQoNSdjb8PLcLbjnecQTkBcqsAS92"
    );

    const TOKEN_PROGRAM_ID = new web3.PublicKey(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    );

    const WSOL_MINT = new web3.PublicKey(
      "So11111111111111111111111111111111111111112"
    );

    const TOKEN_ACCOUNT_SIZE = 165;
    const WRAP_AMOUNT = 1_000_000; // 0.001 SOL

    assert.equal(
      pg.PROGRAM_ID.toString(),
      ANGRY_V06C_PROGRAM_ID.toString(),
      "Wrong Playground Program ID. Use 9LeVE...AS92."
    );

    const [configPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("angry-engine-config")],
      ANGRY_V06C_PROGRAM_ID
    );

    const [vaultPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("angry-engine-vault")],
      ANGRY_V06C_PROGRAM_ID
    );

    const [buybackSolPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("angry-engine-buyback-sol")],
      ANGRY_V06C_PROGRAM_ID
    );

    console.log(
      "ANGRY v0.6C Program:",
      ANGRY_V06C_PROGRAM_ID.toString()
    );
    console.log("Config PDA:", configPda.toString());
    console.log("Vault PDA:", vaultPda.toString());
    console.log("Buyback SOL PDA:", buybackSolPda.toString());
    console.log("Authority:", pg.wallet.publicKey.toString());

    // Initialize only if this temporary config does not already exist.
    const configInfo =
      await pg.connection.getAccountInfo(
        configPda,
        "confirmed"
      );

    if (configInfo === null) {
      console.log(
        "Initializing temporary ANGRY Engine v0.6C..."
      );

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
    } else {
      console.log(
        "Existing ANGRY Engine config found — initialization skipped"
      );
    }

    const config =
      await pg.program.account.engineConfig.fetch(
        configPda
      );

    assert(
      config.authority.equals(pg.wallet.publicKey),
      "Playground wallet is not Engine authority"
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

    console.log(
      "✅ v0.6C CONFIG VERIFIED: 40 / 40 / 20"
    );

    // Ensure there is enough staged SOL.
    let stagedSolBefore =
      await pg.connection.getBalance(
        buybackSolPda,
        "finalized"
      );

    console.log(
      "Staged Buyback SOL BEFORE preparation:",
      stagedSolBefore
    );

    if (stagedSolBefore < WRAP_AMOUNT) {
      console.log(
        "Not enough staged SOL — creating a small test creator fee..."
      );

      const TEST_CREATOR_FEE = 5_000_000;
      const EXPECTED_BUYBACK = 2_000_000;

      const transferTx =
        new web3.Transaction().add(
          web3.SystemProgram.transfer({
            fromPubkey: pg.wallet.publicKey,
            toPubkey: vaultPda,
            lamports: TEST_CREATOR_FEE,
          })
        );

      const creatorFeeSignature =
        await web3.sendAndConfirmTransaction(
          pg.connection,
          transferTx,
          [payer],
          {
            commitment: "confirmed",
          }
        );

      console.log(
        "Creator Fee TX:",
        creatorFeeSignature
      );

      const syncSignature =
        await pg.program.methods
          .syncFees()
          .accounts({
            config: configPda,
            vault: vaultPda,
          })
          .rpc();

      console.log(
        "Sync Fees TX:",
        syncSignature
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
        "finalized"
      );

      stagedSolBefore =
        await pg.connection.getBalance(
          buybackSolPda,
          "finalized"
        );
    }

    assert(
      stagedSolBefore >= WRAP_AMOUNT,
      "Buyback SOL PDA does not contain enough staged SOL"
    );

    console.log(
      "✅ STAGED BUYBACK SOL AVAILABLE:",
      stagedSolBefore
    );

    // Create a normal SPL Token account whose token authority is the
    // Buyback SOL PDA. This account will hold WSOL for the Engine.
    const buybackWsolKeypair =
      web3.Keypair.generate();

    const rent =
      await pg.connection.getMinimumBalanceForRentExemption(
        TOKEN_ACCOUNT_SIZE
      );

    // SPL Token InitializeAccount3 instruction:
    // discriminator 18 + 32-byte owner pubkey.
    const initializeAccount3Data =
      Buffer.concat([
        Buffer.from([18]),
        buybackSolPda.toBuffer(),
      ]);

    const initializeWsolAccountIx =
      new web3.TransactionInstruction({
        programId: TOKEN_PROGRAM_ID,
        keys: [
          {
            pubkey: buybackWsolKeypair.publicKey,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: WSOL_MINT,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: initializeAccount3Data,
      });

    const createWsolAccountTx =
      new web3.Transaction().add(
        web3.SystemProgram.createAccount({
          fromPubkey: pg.wallet.publicKey,
          newAccountPubkey:
            buybackWsolKeypair.publicKey,
          lamports: rent,
          space: TOKEN_ACCOUNT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        initializeWsolAccountIx
      );

    const createWsolSignature =
      await web3.sendAndConfirmTransaction(
        pg.connection,
        createWsolAccountTx,
        [payer, buybackWsolKeypair],
        {
          commitment: "confirmed",
        }
      );

    console.log(
      "Create Buyback WSOL Account TX:",
      createWsolSignature
    );
    console.log(
      "Buyback WSOL Account:",
      buybackWsolKeypair.publicKey.toString()
    );

    const readTokenAccount =
      async (pubkey) => {
        const info =
          await pg.connection.getAccountInfo(
            pubkey,
            "confirmed"
          );

        assert(
          info !== null,
          "WSOL token account does not exist"
        );

        assert.equal(
          info.owner.toString(),
          TOKEN_PROGRAM_ID.toString(),
          "WSOL account is not owned by SPL Token Program"
        );

        const mint =
          new web3.PublicKey(
            info.data.slice(0, 32)
          );

        const tokenAuthority =
          new web3.PublicKey(
            info.data.slice(32, 64)
          );

        const amount =
          info.data.readBigUInt64LE(64);

        return {
          mint,
          tokenAuthority,
          amount,
        };
      };

    const wsolBefore =
      await readTokenAccount(
        buybackWsolKeypair.publicKey
      );

    assert(
      wsolBefore.mint.equals(WSOL_MINT),
      "Wrong WSOL mint"
    );

    assert(
      wsolBefore.tokenAuthority.equals(
        buybackSolPda
      ),
      "WSOL token authority is not Buyback SOL PDA"
    );

    assert.equal(
      wsolBefore.amount.toString(),
      "0",
      "Fresh WSOL account should start at zero"
    );

    console.log(
      "WSOL balance BEFORE:",
      wsolBefore.amount.toString()
    );

    const prepareSignature =
      await pg.program.methods
        .prepareBuybackWsol(
          new BN(WRAP_AMOUNT)
        )
        .accounts({
          config: configPda,
          authority: pg.wallet.publicKey,
          vault: vaultPda,
          buybackSolVault: buybackSolPda,
          buybackWsolAccount:
            buybackWsolKeypair.publicKey,
          wsolMint: WSOL_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram:
            web3.SystemProgram.programId,
        })
        .rpc();

    console.log(
      "Prepare Buyback WSOL TX:",
      prepareSignature
    );

    await pg.connection.confirmTransaction(
      prepareSignature,
      "finalized"
    );

    let stagedSolAfter =
      await pg.connection.getBalance(
        buybackSolPda,
        "finalized"
      );

    for (let attempt = 1; attempt <= 8; attempt++) {
      if (
        stagedSolBefore - stagedSolAfter === WRAP_AMOUNT
      ) {
        break;
      }

      console.log(
        "Waiting for finalized Buyback SOL balance...",
        attempt
      );

      await new Promise((resolve) =>
        setTimeout(resolve, 1500)
      );

      stagedSolAfter =
        await pg.connection.getBalance(
          buybackSolPda,
          "finalized"
        );
    }

    const wsolAfter =
      await readTokenAccount(
        buybackWsolKeypair.publicKey
      );

    console.log(
      "Staged SOL AFTER:",
      stagedSolAfter
    );
    console.log(
      "WSOL balance AFTER:",
      wsolAfter.amount.toString()
    );

    assert.equal(
      stagedSolBefore - stagedSolAfter,
      WRAP_AMOUNT,
      "Staged SOL did not decrease by the wrapped amount"
    );

    assert.equal(
      (
        wsolAfter.amount -
        wsolBefore.amount
      ).toString(),
      WRAP_AMOUNT.toString(),
      "WSOL balance did not increase by the wrapped amount"
    );

    console.log(
      "✅ SOL → WSOL BALANCE MOVEMENT VERIFIED"
    );
    console.log(
      "✅ ANGRY ENGINE v0.6C WSOL BUYBACK PREPARATION PASSED"
    );
  });
});

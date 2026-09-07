import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

describe("ANGRY Engine v0.6A Burn Test", () => {
  it("Burns Engine tokens from the real ANGRY Engine program", async () => {
    const payer = pg.wallet.keypair;

    const ANGRY_PROGRAM_ID = new web3.PublicKey(
      "Asv68hEx77m6yaoKYnMUym1t7MfxidTkZyMh6Ynip4Zt"
    );

    const [configPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("angry-engine-config")],
      ANGRY_PROGRAM_ID
    );

    const [vaultPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("angry-engine-vault")],
      ANGRY_PROGRAM_ID
    );

    console.log("ANGRY Program:", ANGRY_PROGRAM_ID.toString());
    console.log("Config PDA:", configPda.toString());
    console.log("Vault PDA:", vaultPda.toString());
    console.log("Authority:", pg.wallet.publicKey.toString());

    // Verify that the real ANGRY Engine accounts exist on Devnet.
    const configInfo = await pg.connection.getAccountInfo(
      configPda,
      "confirmed"
    );

    const vaultInfo = await pg.connection.getAccountInfo(
      vaultPda,
      "confirmed"
    );

    assert(configInfo !== null, "ANGRY Engine config PDA does not exist");
    assert(vaultInfo !== null, "ANGRY Engine vault PDA does not exist");

    assert(
      configInfo.owner.equals(ANGRY_PROGRAM_ID),
      "Config PDA is not owned by ANGRY Engine"
    );

    assert(
      vaultInfo.owner.equals(ANGRY_PROGRAM_ID),
      "Vault PDA is not owned by ANGRY Engine"
    );

    console.log("✅ Real ANGRY Engine config/vault found");

    // Create temporary Devnet token for burn testing.
    const mint = await createMint(
      pg.connection,
      payer,
      payer.publicKey,
      null,
      0
    );

    console.log("Test Mint:", mint.toString());

    // Token account controlled by ANGRY Engine Vault PDA.
    const engineTokenAccount =
      await getOrCreateAssociatedTokenAccount(
        pg.connection,
        payer,
        mint,
        vaultPda,
        true
      );

    console.log(
      "Engine Token Account:",
      engineTokenAccount.address.toString()
    );

    // Mint 1000 temporary test tokens to Engine.
    await mintTo(
      pg.connection,
      payer,
      mint,
      engineTokenAccount.address,
      payer,
      1000
    );

    const accountBefore = await getAccount(
      pg.connection,
      engineTokenAccount.address
    );

    const mintBefore = await getMint(
      pg.connection,
      mint
    );

    console.log(
      "Engine balance BEFORE burn:",
      accountBefore.amount.toString()
    );

    console.log(
      "Total supply BEFORE burn:",
      mintBefore.supply.toString()
    );

    // Anchor discriminator:
    // sha256("global:burn_engine_tokens")[0..8]
    const discriminator = Buffer.from([
      181, 71, 171, 169, 111, 65, 106, 95
    ]);

    // Burn 400 raw token units.
    const amountData = new BN(400).toArrayLike(
      Buffer,
      "le",
      8
    );

    const instructionData = Buffer.concat([
      discriminator,
      amountData
    ]);

    const burnInstruction =
      new web3.TransactionInstruction({
        programId: ANGRY_PROGRAM_ID,
        keys: [
          {
            pubkey: configPda,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: pg.wallet.publicKey,
            isSigner: true,
            isWritable: false,
          },
          {
            pubkey: vaultPda,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: mint,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: engineTokenAccount.address,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: TOKEN_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: instructionData,
      });

    const transaction =
      new web3.Transaction().add(burnInstruction);

    const signature =
      await web3.sendAndConfirmTransaction(
        pg.connection,
        transaction,
        [payer],
        {
          commitment: "confirmed",
        }
      );

    console.log("Burn TX:", signature);

    // Verify the TokensBurned event from the confirmed transaction logs.
    const txDetails = await pg.connection.getTransaction(
      signature,
      {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }
    );

    assert(txDetails !== null, "Burn transaction could not be fetched");

    const logs = txDetails.meta?.logMessages ?? [];

    // Anchor event discriminator:
    // sha256("event:TokensBurned")[0..8]
    const eventDiscriminator = Buffer.from([
      230, 255, 34, 113, 226, 53, 227, 9
    ]);

    let tokensBurnedEvent: Buffer | null = null;

    for (const log of logs) {
      const prefix = "Program data: ";

      if (!log.startsWith(prefix)) {
        continue;
      }

      const data = Buffer.from(
        log.slice(prefix.length),
        "base64"
      );

      if (
        data.length >= 168 &&
        data.slice(0, 8).equals(eventDiscriminator)
      ) {
        tokensBurnedEvent = data;
        break;
      }
    }

    assert(
      tokensBurnedEvent !== null,
      "TokensBurned event was not found"
    );

    const eventAmount = new BN(
      tokensBurnedEvent!.slice(136, 144),
      "le"
    );

    const eventRemainingBalance = new BN(
      tokensBurnedEvent!.slice(144, 152),
      "le"
    );

    const eventRemainingSupply = new BN(
      tokensBurnedEvent!.slice(152, 160),
      "le"
    );

    console.log(
      "TokensBurned event amount:",
      eventAmount.toString()
    );

    console.log(
      "TokensBurned event remaining balance:",
      eventRemainingBalance.toString()
    );

    console.log(
      "TokensBurned event remaining supply:",
      eventRemainingSupply.toString()
    );

    assert.equal(eventAmount.toString(), "400");
    assert.equal(eventRemainingBalance.toString(), "600");
    assert.equal(eventRemainingSupply.toString(), "600");

    console.log(
      "✅ TokensBurned EVENT VERIFIED: 400 / 600 / 600"
    );

    const accountAfter = await getAccount(
      pg.connection,
      engineTokenAccount.address
    );

    const mintAfter = await getMint(
      pg.connection,
      mint
    );

    console.log(
      "Engine balance AFTER burn:",
      accountAfter.amount.toString()
    );

    console.log(
      "Total supply AFTER burn:",
      mintAfter.supply.toString()
    );

    assert.equal(
      accountBefore.amount.toString(),
      "1000"
    );

    assert.equal(
      accountAfter.amount.toString(),
      "600"
    );

    assert.equal(
      mintBefore.supply.toString(),
      "1000"
    );

    assert.equal(
      mintAfter.supply.toString(),
      "600"
    );

    console.log(
      "✅ ANGRY ENGINE v0.6A REAL DEVNET TOKEN BURN PASSED"
    );
  });
});

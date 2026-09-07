import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

describe("ANGRY Engine v0.6A Burn Test", () => {
  it("Burns Engine tokens from the Vault PDA", async () => {
    const payer = pg.wallet.keypair;

    const [configPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("angry-engine-config")],
      pg.PROGRAM_ID
    );

    const [vaultPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("angry-engine-vault")],
      pg.PROGRAM_ID
    );

    console.log("Program:", pg.PROGRAM_ID.toString());
    console.log("Config PDA:", configPda.toString());
    console.log("Vault PDA:", vaultPda.toString());
    console.log("Authority:", pg.wallet.publicKey.toString());

    const config =
      await pg.program.account.engineConfig.fetch(configPda);

    const vault =
      await pg.program.account.engineVault.fetch(vaultPda);

    console.log("Config authority:", config.authority.toString());
    console.log("Vault config:", vault.config.toString());

    assert(
      config.authority.equals(pg.wallet.publicKey),
      "Playground wallet is not ANGRY Engine authority"
    );

    const mint = await createMint(
      pg.connection,
      payer,
      payer.publicKey,
      null,
      0
    );

    console.log("Test Mint:", mint.toString());

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

    const tx = await pg.program.methods
      .burnEngineTokens(new BN(400))
      .accounts({
        config: configPda,
        authority: pg.wallet.publicKey,
        vault: vaultPda,
        mint: mint,
        engineTokenAccount: engineTokenAccount.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Burn TX:", tx);

    await pg.connection.confirmTransaction(
      tx,
      "confirmed"
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
      "✅ ANGRY ENGINE v0.6A TOKEN BURN PASSED"
    );
  });
});

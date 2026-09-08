// ANGRY Engine Clean — Core Devnet Verifier
// Runs from Solana Playground Client > Run.
// It intentionally does NOT use Mocha/Test runner.
// Contract Program ID is fixed to the already deployed Clean Devnet program.

console.log("==================================================");
console.log("ANGRY ENGINE CLEAN — CORE DEVNET VERIFIER");
console.log("==================================================");

const EXPECTED_PROGRAM_ID = "NmWNEKmU9N7YWKB2QeBMUAJC1NxuiYwSo1dX4NrKo6C";
const program = pg.program;
const authority = pg.wallet.publicKey;

if (program.programId.toBase58() !== EXPECTED_PROGRAM_ID) {
  throw new Error(
    `WRONG PROGRAM ID: ${program.programId.toBase58()} != ${EXPECTED_PROGRAM_ID}`
  );
}

const developmentWallet = web3.Keypair.generate();
const intruder = web3.Keypair.generate();
const newAuthority = web3.Keypair.generate();

const BUYBACK_BPS = 2500;
const LIQUIDITY_BPS = 1500;
const DEVELOPMENT_BPS = 6000;

const BUYBACK_THRESHOLD = new anchor.BN(1_000_000);
const LIQUIDITY_THRESHOLD = new anchor.BN(1_000_000);
const DEVELOPMENT_THRESHOLD = new anchor.BN(1_000_000);

let checks = 0;

function pass(label) {
  checks += 1;
  console.log(`✅ ${label}`);
}

function eq(actual, expected, label) {
  if (String(actual) !== String(expected)) {
    throw new Error(
      `ASSERT FAILED — ${label}: got ${String(actual)}, expected ${String(expected)}`
    );
  }
  pass(label);
}

function truth(value, label) {
  if (value !== true) {
    throw new Error(`ASSERT FAILED — ${label}: expected true`);
  }
  pass(label);
}

async function expectFailure(label, action) {
  let failed = false;
  try {
    await action();
  } catch (error) {
    failed = true;
  }

  if (!failed) {
    throw new Error(`EXPECTED FAILURE DID NOT FAIL — ${label}`);
  }

  pass(`expected failure: ${label}`);
}

function derive(project, seedAuthority = authority) {
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

async function send(tx, signers = [pg.wallet.keypair]) {
  const signature = await web3.sendAndConfirmTransaction(
    pg.connection,
    tx,
    signers,
    { commitment: "confirmed" }
  );
  return signature;
}

async function fund(pubkey, lamports) {
  const tx = new web3.Transaction().add(
    web3.SystemProgram.transfer({
      fromPubkey: authority,
      toPubkey: pubkey,
      lamports,
    })
  );
  return await send(tx);
}

async function fundTestActors() {
  // One transaction funds all generated SystemAccounts.
  const tx = new web3.Transaction()
    .add(
      web3.SystemProgram.transfer({
        fromPubkey: authority,
        toPubkey: developmentWallet.publicKey,
        lamports: 1_000_000,
      })
    )
    .add(
      web3.SystemProgram.transfer({
        fromPubkey: authority,
        toPubkey: intruder.publicKey,
        lamports: 1_000_000,
      })
    )
    .add(
      web3.SystemProgram.transfer({
        fromPubkey: authority,
        toPubkey: newAuthority.publicKey,
        lamports: 1_000_000,
      })
    );

  await send(tx);
  pass("test actor SystemAccounts funded in one transaction");
}

async function initialize(project, pda, thresholds = {}) {
  await program.methods
    .initializeEngine({
      project,
      buybackBps: BUYBACK_BPS,
      liquidityBps: LIQUIDITY_BPS,
      developmentBps: DEVELOPMENT_BPS,
      buybackThreshold: thresholds.buyback ?? BUYBACK_THRESHOLD,
      liquidityThreshold: thresholds.liquidity ?? LIQUIDITY_THRESHOLD,
      developmentThreshold: thresholds.development ?? DEVELOPMENT_THRESHOLD,
    })
    .accounts({
      authority,
      developmentWallet: developmentWallet.publicKey,
      config: pda.config,
      vault: pda.vault,
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc();
}

async function checkInvalidInputs() {
  console.log("\n--- CHECK 1: invalid input rejection ---");

  const invalidProjectA = web3.Keypair.generate().publicKey;
  const invalidA = derive(invalidProjectA);

  await expectFailure("allocation must total 10000 BPS", () =>
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
      .rpc()
  );

  const invalidProjectB = web3.Keypair.generate().publicKey;
  const invalidB = derive(invalidProjectB);

  await expectFailure("zero threshold rejected", () =>
    program.methods
      .initializeEngine({
        project: invalidProjectB,
        buybackBps: BUYBACK_BPS,
        liquidityBps: LIQUIDITY_BPS,
        developmentBps: DEVELOPMENT_BPS,
        buybackThreshold: new anchor.BN(0),
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
      .rpc()
  );
}

async function checkCumulativeAllocation() {
  console.log("\n--- CHECK 2: cumulative 25 / 15 / 60 accounting ---");

  const project = web3.Keypair.generate().publicKey;
  const pda = derive(project);

  await initialize(project, pda, {
    buyback: new anchor.BN(1),
    liquidity: new anchor.BN(1),
    development: new anchor.BN(1),
  });

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

  eq(config.buybackReserve.toString(), "1", "4 lamports => 1 buyback");
  eq(config.liquidityReserve.toString(), "0", "4 lamports => 0 liquidity");
  eq(config.developmentReserve.toString(), "3", "4 lamports => 3 development");
  eq(config.accountedBalance.toString(), "4", "all 4 lamports accounted");
  eq(config.totalReceived.toString(), "4", "total received = 4");
  eq(config.epochReceived.toString(), "4", "epoch received = 4");
  eq(config.epochBuybackAllocated.toString(), "1", "epoch buyback cumulative exact");
  eq(config.epochLiquidityAllocated.toString(), "0", "epoch liquidity cumulative exact");
  eq(config.epochDevelopmentAllocated.toString(), "3", "epoch development cumulative exact");
}

async function checkRollbackAndAuthorization() {
  console.log("\n--- CHECK 3: rollback + unauthorized protection ---");

  const project = web3.Keypair.generate().publicKey;
  const pda = derive(project);

  await initialize(project, pda);
  await fund(pda.vault, 100);

  await expectFailure("settlement below threshold rolls back", () =>
    program.methods
      .settleDevelopment()
      .accounts({
        config: pda.config,
        vault: pda.vault,
        developmentWallet: developmentWallet.publicKey,
      })
      .rpc()
  );

  let config = await program.account.engineConfig.fetch(pda.config);
  eq(config.totalReceived.toString(), "0", "failed lazy sync did not persist totalReceived");
  eq(config.accountedBalance.toString(), "0", "failed lazy sync did not persist accounting");
  eq(config.buybackReserve.toString(), "0", "failed lazy sync did not persist buyback");
  eq(config.liquidityReserve.toString(), "0", "failed lazy sync did not persist liquidity");
  eq(config.developmentReserve.toString(), "0", "failed lazy sync did not persist development");

  await expectFailure("intruder cannot sync", () =>
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

  await program.methods
    .syncFees()
    .accounts({
      config: pda.config,
      authority,
      vault: pda.vault,
    })
    .rpc();

  config = await program.account.engineConfig.fetch(pda.config);
  eq(config.totalReceived.toString(), "100", "legitimate authority syncs pending 100");
  eq(config.accountedBalance.toString(), "100", "pending 100 fully accounted");
}

async function checkMainCoreFlow() {
  console.log("\n--- CHECK 4: main Core flow ---");

  const project = web3.Keypair.generate().publicKey;
  const pda = derive(project);

  await initialize(project, pda);

  let config = await program.account.engineConfig.fetch(pda.config);

  eq(config.authority.toBase58(), authority.toBase58(), "authority stored");
  eq(config.seedAuthority.toBase58(), authority.toBase58(), "seed authority stored");
  eq(config.pendingAuthority.toBase58(), "11111111111111111111111111111111", "no pending authority");
  eq(config.project.toBase58(), project.toBase58(), "project stored");
  eq(
    config.developmentWallet.toBase58(),
    developmentWallet.publicKey.toBase58(),
    "development wallet stored"
  );
  eq(config.buybackBps, 2500, "buyback = 25%");
  eq(config.liquidityBps, 1500, "liquidity = 15%");
  eq(config.developmentBps, 6000, "development = 60%");
  eq(config.totalReceived.toString(), "0", "initial totalReceived = 0");
  truth(config.paused === false, "initial state unpaused");

  await expectFailure("intruder cannot pause", () =>
    program.methods
      .pauseEngine()
      .accounts({
        config: pda.config,
        authority: intruder.publicKey,
      })
      .signers([intruder])
      .rpc()
  );

  await expectFailure("settings cannot change while unpaused", () =>
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
      .rpc()
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

  eq(config.buybackReserve.toString(), "2500000", "10m => 2.5m buyback");
  eq(config.liquidityReserve.toString(), "1500000", "10m => 1.5m liquidity");
  eq(config.developmentReserve.toString(), "6000000", "10m => 6m development");
  eq(config.accountedBalance.toString(), "10000000", "10m fully accounted");

  await expectFailure("sync with no new fees fails", () =>
    program.methods
      .syncFees()
      .accounts({
        config: pda.config,
        authority,
        vault: pda.vault,
      })
      .rpc()
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

  eq(devAfter - devBefore, 6_000_000, "developer receives 6m in one batch");

  config = await program.account.engineConfig.fetch(pda.config);
  eq(config.buybackReserve.toString(), "2500000", "buyback reserve preserved after dev settlement");
  eq(config.liquidityReserve.toString(), "1500000", "liquidity reserve preserved after dev settlement");
  eq(config.developmentReserve.toString(), "0", "developer reserve settled to zero");
  eq(config.accountedBalance.toString(), "4000000", "remaining accounted balance = buyback + liquidity");
  eq(config.totalDevelopmentSettled.toString(), "6000000", "lifetime development settled = 6m");

  await program.methods
    .pauseEngine()
    .accounts({
      config: pda.config,
      authority,
    })
    .rpc();

  await expectFailure("development settlement blocked while paused", () =>
    program.methods
      .settleDevelopment()
      .accounts({
        config: pda.config,
        vault: pda.vault,
        developmentWallet: developmentWallet.publicKey,
      })
      .rpc()
  );

  // Fees arrive while paused. Updating settings must lazy-sync them under OLD 25/15/60.
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

  eq(config.buybackReserve.toString(), "3250000", "old BPS applied to pending 3m buyback");
  eq(config.liquidityReserve.toString(), "1950000", "old BPS applied to pending 3m liquidity");
  eq(config.developmentReserve.toString(), "1800000", "old BPS applied to pending 3m development");
  eq(config.accountedBalance.toString(), "7000000", "13m lifetime minus 6m settlement = 7m accounted");
  eq(config.totalReceived.toString(), "13000000", "lifetime received = 13m");
  eq(config.buybackBps, 2000, "new buyback BPS = 20%");
  eq(config.liquidityBps, 2000, "new liquidity BPS = 20%");
  eq(config.developmentBps, 6000, "development BPS remains 60%");
  eq(config.epochReceived.toString(), "0", "new settings reset allocation epoch");
  truth(config.paused === true, "settings update leaves engine paused");

  await program.methods
    .unpauseEngine()
    .accounts({
      config: pda.config,
      vault: pda.vault,
      authority,
    })
    .rpc();

  await expectFailure("wrong development wallet rejected", () =>
    program.methods
      .settleDevelopment()
      .accounts({
        config: pda.config,
        vault: pda.vault,
        developmentWallet: authority,
      })
      .rpc()
  );

  // No separate sync: settlement lazy-syncs 10m at NEW 20/20/60.
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

  eq(secondDevAfter - secondDevBefore, 7_800_000, "lazy sync + developer batch pays 7.8m");

  config = await program.account.engineConfig.fetch(pda.config);

  eq(config.buybackReserve.toString(), "5250000", "final buyback reserve = 5.25m");
  eq(config.liquidityReserve.toString(), "3950000", "final liquidity reserve = 3.95m");
  eq(config.developmentReserve.toString(), "0", "final developer reserve = 0");
  eq(config.accountedBalance.toString(), "9200000", "final accounted balance = 9.2m");
  eq(config.totalReceived.toString(), "23000000", "final lifetime received = 23m");
  eq(config.totalDevelopmentSettled.toString(), "13800000", "final dev settled = 13.8m");
  eq(config.totalBuybackProcessed.toString(), "0", "buyback processor untouched in Core");
  eq(config.totalLiquidityDeployed.toString(), "0", "liquidity processor untouched in Core");

  eq(
    Number(config.accountedBalance.toString()) +
      Number(config.totalDevelopmentSettled.toString()),
    Number(config.totalReceived.toString()),
    "lifetime creator-fee conservation"
  );
}

async function checkAuthorityRotation() {
  console.log("\n--- CHECK 5: two-step authority rotation ---");

  const project = web3.Keypair.generate().publicKey;
  const pda = derive(project);

  await initialize(project, pda);

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

  eq(
    config.pendingAuthority.toBase58(),
    newAuthority.publicKey.toBase58(),
    "pending authority recorded"
  );
  eq(
    config.seedAuthority.toBase58(),
    authority.toBase58(),
    "seed authority remains original"
  );

  await expectFailure("wrong pending authority cannot accept", () =>
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

  eq(
    config.authority.toBase58(),
    newAuthority.publicKey.toBase58(),
    "new authority accepted"
  );
  eq(
    config.seedAuthority.toBase58(),
    authority.toBase58(),
    "PDA seed authority unchanged after rotation"
  );
  eq(
    config.pendingAuthority.toBase58(),
    "11111111111111111111111111111111",
    "pending authority cleared"
  );

  await expectFailure("old authority loses control", () =>
    program.methods
      .unpauseEngine()
      .accounts({
        config: pda.config,
        vault: pda.vault,
        authority,
      })
      .rpc()
  );

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

  eq(
    config.pendingAuthority.toBase58(),
    "11111111111111111111111111111111",
    "authority transfer cancellation clears pending authority"
  );
  eq(
    config.authority.toBase58(),
    newAuthority.publicKey.toBase58(),
    "authority remains new authority after cancellation"
  );
}

try {
  const walletBalance = await pg.connection.getBalance(authority, "confirmed");
  console.log(`Program ID: ${program.programId.toBase58()}`);
  console.log(`Wallet: ${authority.toBase58()}`);
  console.log(`Wallet balance: ${walletBalance / web3.LAMPORTS_PER_SOL} SOL`);

  await fundTestActors();
  await checkInvalidInputs();
  await checkCumulativeAllocation();
  await checkRollbackAndAuthorization();
  await checkMainCoreFlow();
  await checkAuthorityRotation();

  console.log("\n==================================================");
  console.log(`✅ CORE ENGINE DEVNET VERIFIER PASSED — ${checks} checks`);
  console.log("✅ Program Rust was not upgraded by this verifier");
  console.log("==================================================");
} catch (error) {
  console.error("\n==================================================");
  console.error("❌ CORE ENGINE DEVNET VERIFIER FAILED");
  console.error(error);
  console.error("==================================================");
  throw error;
}

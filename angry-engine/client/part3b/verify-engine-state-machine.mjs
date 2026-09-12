import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

const RPC = "https://api.devnet.solana.com";

const MODE = process.argv[2] ?? "precheck";

if (!["precheck", "verify"].includes(MODE)) {
  console.error(
    "Usage: node verify-engine-state-machine.mjs precheck|verify"
  );
  process.exit(2);
}


const ANGRY_PROGRAM_ID =
  new PublicKey("NmWNEKmU9N7YWKB2QeBMUAJC1NxuiYwSo1dX4NrKo6C");

const EXPECTED_MAIN_WALLET =
  "GJScfY4ZwpsDyLTFzNEzNBA4iWKfUSduKNQwQzT7mGYT";

const ZERO_KEY = new PublicKey(new Uint8Array(32));

const OLD_BUYBACK_BPS = 2500;
const OLD_LIQUIDITY_BPS = 1500;
const OLD_DEVELOPMENT_BPS = 6000;

const NEW_BUYBACK_BPS = 3000;
const NEW_LIQUIDITY_BPS = 2000;
const NEW_DEVELOPMENT_BPS = 5000;

const BUYBACK_THRESHOLD = 100_000n;
const LIQUIDITY_THRESHOLD = 100_000n;
const DEVELOPMENT_THRESHOLD = 100_000n;

const INITIAL_DEPOSIT = 1_000_000n;
const PAUSED_PENDING_DEPOSIT = 10_000n;
const NEW_EPOCH_DEPOSIT = 1_000_001n;
const DIRECT_DONATION = 7n;

const TEMP_AUTHORITY_FUND = 20_000_000n;
const DEV_WALLET_SEED_FUND = 1_000_000n;
const NEW_AUTHORITY_FUND = 1_000_000n;

const connection = new Connection(RPC, "confirmed");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pass(msg) {
  console.log(`✅ ${msg}`);
}

function fail(msg) {
  throw new Error(msg);
}

function check(value, msg) {
  if (!value) fail(msg);
  pass(msg);
}

function sameKey(actual, expected, msg) {
  if (!actual.equals(expected)) {
    fail(
      `${msg}: ${actual.toBase58()} != ${expected.toBase58()}`
    );
  }
  pass(msg);
}

async function retry(label, fn, attempts = 6) {
  let last;

  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const text =
        String(e?.message ?? e).toLowerCase();

      const transient =
        text.includes("429") ||
        text.includes("rate limit") ||
        text.includes("fetch failed") ||
        text.includes("socket") ||
        text.includes("econnreset") ||
        text.includes("timed out") ||
        text.includes("blockhash") ||
        text.includes("node is behind");

      if (!transient || i === attempts) {
        throw e;
      }

      const wait = i * 2500;
      console.log(
        `⚠️ ${label}: RPC sementara bermasalah, ` +
        `retry ${i}/${attempts} setelah ${wait}ms`
      );
      await sleep(wait);
    }
  }

  throw last;
}

function loadMainWallet() {
  const dirs = [
    path.join(os.homedir(), "storage", "downloads"),
    path.join(os.homedir(), "storage", "download"),
  ];

  const found = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    for (const name of fs.readdirSync(dir)) {
      if (!name.toLowerCase().endsWith(".json")) continue;
      if (!name.toLowerCase().includes("keypair")) continue;

      const full = path.join(dir, name);

      try {
        const raw =
          JSON.parse(fs.readFileSync(full, "utf8"));

        if (
          !Array.isArray(raw) ||
          ![32, 64].includes(raw.length)
        ) {
          continue;
        }

        const bytes = Uint8Array.from(raw);
        const kp =
          raw.length === 64
            ? Keypair.fromSecretKey(bytes)
            : Keypair.fromSeed(bytes);

        found.push({
          name,
          pubkey: kp.publicKey.toBase58(),
          keypair: kp,
        });
      } catch {
        // Ignore unrelated JSON.
      }
    }
  }

  const match =
    found.find(
      (x) => x.pubkey === EXPECTED_MAIN_WALLET
    );

  if (!match) {
    fail(
      `Wallet expected tidak ditemukan: ${EXPECTED_MAIN_WALLET}`
    );
  }

  pass(`wallet cocok: ${match.name}`);
  pass(`wallet authority: ${match.pubkey}`);

  return match.keypair;
}

function ixDisc(name) {
  return crypto
    .createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

function accountDisc(name) {
  return crypto
    .createHash("sha256")
    .update(`account:${name}`)
    .digest()
    .subarray(0, 8);
}

function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}

function u64(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

function meta(pubkey, isSigner = false, isWritable = false) {
  return { pubkey, isSigner, isWritable };
}

function deriveEngine(authority, project) {
  const [config] =
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("angry-engine-config"),
        authority.toBuffer(),
        project.toBuffer(),
      ],
      ANGRY_PROGRAM_ID
    );

  const [vault] =
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("angry-engine-vault"),
        config.toBuffer(),
      ],
      ANGRY_PROGRAM_ID
    );

  const [buybackAuthority] =
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("angry-engine-buyback"),
        config.toBuffer(),
      ],
      ANGRY_PROGRAM_ID
    );

  const [liquidityAuthority] =
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("angry-engine-liquidity"),
        config.toBuffer(),
      ],
      ANGRY_PROGRAM_ID
    );

  return {
    config,
    vault,
    buybackAuthority,
    liquidityAuthority,
  };
}

function initializeData(project) {
  return Buffer.concat([
    ixDisc("initialize_engine"),
    project.toBuffer(),
    u16(OLD_BUYBACK_BPS),
    u16(OLD_LIQUIDITY_BPS),
    u16(OLD_DEVELOPMENT_BPS),
    u64(BUYBACK_THRESHOLD),
    u64(LIQUIDITY_THRESHOLD),
    u64(DEVELOPMENT_THRESHOLD),
  ]);
}

function updateSettingsData() {
  return Buffer.concat([
    ixDisc("update_engine_settings"),
    u16(NEW_BUYBACK_BPS),
    u16(NEW_LIQUIDITY_BPS),
    u16(NEW_DEVELOPMENT_BPS),
    u64(BUYBACK_THRESHOLD),
    u64(LIQUIDITY_THRESHOLD),
    u64(DEVELOPMENT_THRESHOLD),
  ]);
}

function proposeAuthorityData(newAuthority) {
  return Buffer.concat([
    ixDisc("propose_authority"),
    newAuthority.toBuffer(),
  ]);
}

function decodeEngineConfig(data) {
  const expected = accountDisc("EngineConfig");

  if (
    data.length < 8 ||
    !data.subarray(0, 8).equals(expected)
  ) {
    fail("EngineConfig discriminator mismatch.");
  }

  let o = 8;

  const pk = () => {
    const x =
      new PublicKey(data.subarray(o, o + 32));
    o += 32;
    return x;
  };

  const readU16 = () => {
    const x = data.readUInt16LE(o);
    o += 2;
    return x;
  };

  const readU64 = () => {
    const x = data.readBigUInt64LE(o);
    o += 8;
    return x;
  };

  const readU8 = () => data.readUInt8(o++);

  return {
    authority: pk(),
    seedAuthority: pk(),
    pendingAuthority: pk(),
    project: pk(),
    developmentWallet: pk(),

    buybackBps: readU16(),
    liquidityBps: readU16(),
    developmentBps: readU16(),

    buybackThreshold: readU64(),
    liquidityThreshold: readU64(),
    developmentThreshold: readU64(),

    buybackReserve: readU64(),
    liquidityReserve: readU64(),
    developmentReserve: readU64(),

    accountedBalance: readU64(),
    totalReceived: readU64(),

    totalDevelopmentSettled: readU64(),
    totalBuybackProcessed: readU64(),
    totalLiquidityDeployed: readU64(),

    epochReceived: readU64(),
    epochBuybackAllocated: readU64(),
    epochLiquidityAllocated: readU64(),
    epochDevelopmentAllocated: readU64(),

    paused: readU8() !== 0,
    version: readU8(),
    configBump: readU8(),
    vaultBump: readU8(),

    liquidityStaged: readU64(),
  };
}

async function fetchEngineConfig(config) {
  const info = await retry(
    "fetch EngineConfig",
    () =>
      connection.getAccountInfo(
        config,
        "confirmed"
      )
  );

  if (!info) {
    fail("EngineConfig tidak ditemukan.");
  }

  return decodeEngineConfig(info.data);
}

async function sendTx(
  mainWallet,
  instructions,
  extraSigners = [],
  label = "transaction"
) {
  /*
   * Avoid sendAndConfirmTransaction here.
   * Public Devnet RPC can heavily rate-limit websocket/internal
   * confirmation calls. Build/sign once, resend the SAME raw
   * transaction on transient RPC errors, then poll status over HTTP.
   */
  const latest = await retry(
    `${label}: blockhash`,
    () => connection.getLatestBlockhash("confirmed"),
    8
  );

  const tx =
    new Transaction({
      feePayer: mainWallet.publicKey,
      recentBlockhash: latest.blockhash,
    }).add(...instructions);

  tx.sign(
    mainWallet,
    ...extraSigners
  );

  const raw = tx.serialize();

  const signature = await retry(
    `${label}: send`,
    () =>
      connection.sendRawTransaction(
        raw,
        {
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 0,
        }
      ),
    8
  );

  for (let i = 1; i <= 90; i++) {
    const statuses = await retry(
      `${label}: signature status`,
      () =>
        connection.getSignatureStatuses(
          [signature]
        ),
      8
    );

    const status = statuses.value[0];

    if (status?.err) {
      const error = new Error(
        `${label} failed on-chain: ${JSON.stringify(status.err)}`
      );
      error.signature = signature;
      throw error;
    }

    if (
      status &&
      (
        status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized"
      )
    ) {
      pass(
        `${label} confirmed on-chain: ${signature}`
      );

      // Small pacing delay for public Devnet RPC.
      await sleep(750);

      return signature;
    }

    await sleep(1500);
  }

  throw new Error(
    `${label}: confirmation timeout for ${signature}`
  );
}

async function expectSimulationFailure(
  mainWallet,
  instructions,
  extraSigners,
  label,
  expectedLogText = null
) {
  const latest =
    await retry(
      `${label}: blockhash`,
      () =>
        connection.getLatestBlockhash("confirmed")
    );

  const messageV0 =
    new TransactionMessage({
      payerKey: mainWallet.publicKey,
      recentBlockhash: latest.blockhash,
      instructions,
    }).compileToV0Message();

  const tx =
    new VersionedTransaction(messageV0);

  tx.sign([
    mainWallet,
    ...extraSigners,
  ]);

  const result =
    await retry(
      `${label}: simulation`,
      () =>
        connection.simulateTransaction(tx, {
          sigVerify: true,
          commitment: "confirmed",
        })
    );

  const logs = result.value.logs ?? [];

  if (!result.value.err) {
    fail(
      `${label}: seharusnya gagal tetapi simulation sukses.`
    );
  }

  const joined =
    logs.join("\n");

  if (
    expectedLogText &&
    !joined.includes(expectedLogText)
  ) {
    console.log(
      `\n===== ${label} LOGS =====`
    );
    for (const line of logs) console.log(line);
    console.log(
      `===== END ${label} LOGS =====\n`
    );

    fail(
      `${label}: gagal, tetapi log tidak memuat "${expectedLogText}".`
    );
  }

  pass(
    `${label} rejected as expected` +
    (
      expectedLogText
        ? ` (${expectedLogText})`
        : ""
    )
  );

  return {
    err: result.value.err,
    logs,
  };
}

function makeInitializeIx(
  authority,
  developmentWallet,
  project,
  engine
) {
  return new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,
    keys: [
      meta(authority, true, true),
      meta(developmentWallet, false, false),
      meta(engine.config, false, true),
      meta(engine.vault, false, true),
      meta(
        engine.liquidityAuthority,
        false,
        true
      ),
      meta(
        SystemProgram.programId,
        false,
        false
      ),
    ],
    data: initializeData(project),
  });
}

function makeSyncIx(
  authority,
  engine
) {
  return new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,
    keys: [
      meta(engine.config, false, true),
      meta(authority, true, false),
      meta(engine.vault, false, false),
    ],
    data: ixDisc("sync_fees"),
  });
}

function makePauseIx(
  authority,
  engine
) {
  return new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,
    keys: [
      meta(engine.config, false, true),
      meta(authority, true, false),
    ],
    data: ixDisc("pause_engine"),
  });
}

function makeUnpauseIx(
  authority,
  engine
) {
  return new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,
    keys: [
      meta(engine.config, false, true),
      meta(engine.vault, false, false),
      meta(authority, true, false),
    ],
    data: ixDisc("unpause_engine"),
  });
}

function makeUpdateIx(
  authority,
  newDevelopmentWallet,
  engine
) {
  return new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,
    keys: [
      meta(engine.config, false, true),
      meta(engine.vault, false, false),
      meta(authority, true, false),
      meta(
        newDevelopmentWallet,
        false,
        false
      ),
    ],
    data: updateSettingsData(),
  });
}

function makeProposeIx(
  authority,
  newAuthority,
  engine
) {
  return new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,
    keys: [
      meta(engine.config, false, true),
      meta(authority, true, false),
    ],
    data: proposeAuthorityData(
      newAuthority
    ),
  });
}

function makeAcceptIx(
  pendingAuthority,
  engine
) {
  return new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,
    keys: [
      meta(engine.config, false, true),
      meta(
        pendingAuthority,
        true,
        false
      ),
    ],
    data: ixDisc("accept_authority"),
  });
}

function makeCancelIx(
  authority,
  engine
) {
  return new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,
    keys: [
      meta(engine.config, false, true),
      meta(authority, true, false),
    ],
    data:
      ixDisc("cancel_authority_transfer"),
  });
}

function makeStageIx(
  authority,
  engine
) {
  return new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,
    keys: [
      meta(engine.config, false, true),
      meta(engine.vault, false, true),
      meta(authority, true, false),
      meta(
        engine.liquidityAuthority,
        false,
        true
      ),
    ],
    data: ixDisc("stage_liquidity"),
  });
}

function makeSettleDevelopmentIx(
  developmentWallet,
  engine
) {
  return new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,
    keys: [
      meta(engine.config, false, true),
      meta(engine.vault, false, true),
      meta(
        developmentWallet,
        false,
        true
      ),
    ],
    data:
      ixDisc("settle_development"),
  });
}

function expectedEpoch(
  received,
  buybackBps,
  liquidityBps
) {
  const b =
    received *
    BigInt(buybackBps) /
    10_000n;

  const l =
    received *
    BigInt(liquidityBps) /
    10_000n;

  const d =
    received - b - l;

  return {
    buyback: b,
    liquidity: l,
    development: d,
  };
}

function assertInternalInvariant(
  c,
  label
) {
  const reserveTotal =
    c.buybackReserve +
    c.liquidityReserve +
    c.liquidityStaged +
    c.developmentReserve;

  check(
    reserveTotal === c.accountedBalance,
    `${label}: reserve total == accountedBalance`
  );

  const processed =
    c.totalDevelopmentSettled +
    c.totalBuybackProcessed +
    c.totalLiquidityDeployed;

  check(
    c.accountedBalance + processed
      === c.totalReceived,
    `${label}: lifetime accounting conserved`
  );

  const epoch =
    expectedEpoch(
      c.epochReceived,
      c.buybackBps,
      c.liquidityBps
    );

  check(
    c.epochBuybackAllocated
      === epoch.buyback,
    `${label}: epoch buyback exact`
  );

  check(
    c.epochLiquidityAllocated
      === epoch.liquidity,
    `${label}: epoch liquidity exact`
  );

  check(
    c.epochDevelopmentAllocated
      === epoch.development,
    `${label}: epoch development exact`
  );
}

async function assertBacking(
  engine,
  config,
  label
) {
  const vaultInfo =
    await retry(
      `${label}: vault`,
      () =>
        connection.getAccountInfo(
          engine.vault,
          "confirmed"
        )
    );

  if (!vaultInfo) {
    fail(`${label}: vault missing`);
  }

  const rentFloor =
    await retry(
      `${label}: vault rent`,
      () =>
        connection.getMinimumBalanceForRentExemption(
          vaultInfo.data.length,
          "confirmed"
        )
    );

  const spendable =
    BigInt(vaultInfo.lamports - rentFloor);

  const vaultAccounted =
    config.accountedBalance -
    config.liquidityStaged;

  check(
    spendable >= vaultAccounted,
    `${label}: EngineVault backs non-staged accounting`
  );

  const liquidityBalance =
    BigInt(
      await retry(
        `${label}: liquidity PDA balance`,
        () =>
          connection.getBalance(
            engine.liquidityAuthority,
            "confirmed"
          )
      )
    );

  const zeroDataRent =
    BigInt(
      await retry(
        `${label}: zero-data rent`,
        () =>
          connection.getMinimumBalanceForRentExemption(
            0,
            "confirmed"
          )
      )
    );

  check(
    liquidityBalance
      >= zeroDataRent + config.liquidityStaged,
    `${label}: liquidity PDA backs staged liquidity + rent`
  );
}

async function main() {
  console.log(
    "\n============================================================"
  );
  console.log(
    "ANGRY ENGINE — FINAL DEVNET STATE-MACHINE VERIFIER"
  );
  console.log(
    "============================================================\n"
  );

  const mainWallet =
    loadMainWallet();

  const mainBalance =
    await retry(
      "main wallet balance",
      () =>
        connection.getBalance(
          mainWallet.publicKey,
          "confirmed"
        )
    );

  console.log(
    `Main wallet balance: ${
      mainBalance / LAMPORTS_PER_SOL
    } SOL`
  );

  if (mainBalance < 50_000_000) {
    fail(
      "Butuh minimal 0.05 SOL Devnet untuk state-machine verifier."
    );
  }

  const originalAuthority =
    Keypair.generate();

  const newAuthority =
    Keypair.generate();

  const cancelledCandidate =
    Keypair.generate();

  const oldDevelopmentWallet =
    Keypair.generate();

  const newDevelopmentWallet =
    Keypair.generate();

  const project =
    Keypair.generate().publicKey;

  const engine =
    deriveEngine(
      originalAuthority.publicKey,
      project
    );

  console.log(
    `Original authority : ${originalAuthority.publicKey.toBase58()}`
  );
  console.log(
    `New authority      : ${newAuthority.publicKey.toBase58()}`
  );
  console.log(
    `Project            : ${project.toBase58()}`
  );
  console.log(
    `Config             : ${engine.config.toBase58()}`
  );
  console.log(
    `Vault              : ${engine.vault.toBase58()}`
  );
  console.log(
    `Liquidity PDA      : ${engine.liquidityAuthority.toBase58()}`
  );

  await sendTx(
    mainWallet,
    [
      SystemProgram.transfer({
        fromPubkey:
          mainWallet.publicKey,
        toPubkey:
          originalAuthority.publicKey,
        lamports:
          Number(TEMP_AUTHORITY_FUND),
      }),
      SystemProgram.transfer({
        fromPubkey:
          mainWallet.publicKey,
        toPubkey:
          newAuthority.publicKey,
        lamports:
          Number(NEW_AUTHORITY_FUND),
      }),
      SystemProgram.transfer({
        fromPubkey:
          mainWallet.publicKey,
        toPubkey:
          oldDevelopmentWallet.publicKey,
        lamports:
          Number(DEV_WALLET_SEED_FUND),
      }),
      SystemProgram.transfer({
        fromPubkey:
          mainWallet.publicKey,
        toPubkey:
          newDevelopmentWallet.publicKey,
        lamports:
          Number(DEV_WALLET_SEED_FUND),
      }),
    ],
    [],
    "fund state-machine test accounts"
  );

  pass(
    "temporary authority + development wallets funded"
  );

  await sendTx(
    mainWallet,
    [
      makeInitializeIx(
        originalAuthority.publicKey,
        oldDevelopmentWallet.publicKey,
        project,
        engine
      ),
    ],
    [originalAuthority],
    "initialize fresh Engine"
  );

  let c =
    await fetchEngineConfig(
      engine.config
    );

  sameKey(
    c.authority,
    originalAuthority.publicKey,
    "initial authority correct"
  );

  sameKey(
    c.seedAuthority,
    originalAuthority.publicKey,
    "seed authority immutable baseline correct"
  );

  sameKey(
    c.developmentWallet,
    oldDevelopmentWallet.publicKey,
    "initial development wallet correct"
  );

  check(
    !c.paused,
    "Engine initially unpaused"
  );

  assertInternalInvariant(
    c,
    "after initialize"
  );

  await assertBacking(
    engine,
    c,
    "after initialize"
  );

  await sendTx(
    mainWallet,
    [
      SystemProgram.transfer({
        fromPubkey:
          mainWallet.publicKey,
        toPubkey:
          engine.vault,
        lamports:
          Number(INITIAL_DEPOSIT),
      }),
    ],
    [],
    "deposit initial creator-fee SOL"
  );

  pass(
    "initial 0.001 SOL deposited directly to EngineVault"
  );

  /*
   * Stage is deliberately the first processing call.
   * This proves lazy sync under OLD 25/15/60 settings,
   * and gives us staged liquidity that must survive
   * settings + authority rotation.
   */
  await sendTx(
    mainWallet,
    [
      makeStageIx(
        originalAuthority.publicKey,
        engine
      ),
    ],
    [originalAuthority],
    "lazy-sync + stage old-BPS liquidity"
  );

  c =
    await fetchEngineConfig(
      engine.config
    );

  check(
    c.buybackReserve === 250_000n,
    "old BPS buyback reserve = 250000"
  );

  check(
    c.liquidityReserve === 0n,
    "old liquidity reserve moved fully to staged"
  );

  check(
    c.liquidityStaged === 150_000n,
    "old-BPS staged liquidity = 150000"
  );

  check(
    c.developmentReserve === 600_000n,
    "old BPS development reserve = 600000"
  );

  check(
    c.accountedBalance === INITIAL_DEPOSIT,
    "staging keeps accountedBalance unchanged"
  );

  assertInternalInvariant(
    c,
    "after old-BPS staging"
  );

  await assertBacking(
    engine,
    c,
    "after old-BPS staging"
  );

  await sendTx(
    mainWallet,
    [
      makePauseIx(
        originalAuthority.publicKey,
        engine
      ),
    ],
    [originalAuthority],
    "pause Engine"
  );

  c =
    await fetchEngineConfig(
      engine.config
    );

  check(
    c.paused,
    "Engine paused"
  );

  /*
   * Fee arriving while paused must remain pending until
   * update_engine_settings lazy-syncs it using OLD 25/15/60.
   */
  await sendTx(
    mainWallet,
    [
      SystemProgram.transfer({
        fromPubkey: mainWallet.publicKey,
        toPubkey: engine.vault,
        lamports: Number(PAUSED_PENDING_DEPOSIT),
      }),
    ],
    [],
    "deposit creator-fee SOL while paused"
  );

  pass(
    "paused pending fee deposited before settings update"
  );

  await expectSimulationFailure(
    mainWallet,
    [
      makeSettleDevelopmentIx(
        oldDevelopmentWallet.publicKey,
        engine
      ),
    ],
    [],
    "development settlement while paused",
    "EnginePaused"
  );

  /*
   * Update settings while paused.
   * Existing reserves/staged value MUST remain unchanged.
   * Allocation epoch MUST reset for future fees.
   */
  await sendTx(
    mainWallet,
    [
      makeUpdateIx(
        originalAuthority.publicKey,
        newDevelopmentWallet.publicKey,
        engine
      ),
    ],
    [originalAuthority],
    "update settings to 30/20/50"
  );

  c =
    await fetchEngineConfig(
      engine.config
    );

  check(
    c.buybackBps === NEW_BUYBACK_BPS &&
    c.liquidityBps === NEW_LIQUIDITY_BPS &&
    c.developmentBps === NEW_DEVELOPMENT_BPS,
    "new BPS = 30/20/50"
  );

  sameKey(
    c.developmentWallet,
    newDevelopmentWallet.publicKey,
    "development wallet updated"
  );

  check(
    c.buybackReserve === 252_500n &&
    c.liquidityReserve === 1_500n &&
    c.liquidityStaged === 150_000n &&
    c.developmentReserve === 606_000n,
    "paused pending fee allocated under OLD 25/15/60 before settings change"
  );

  check(
    c.accountedBalance
      === INITIAL_DEPOSIT + PAUSED_PENDING_DEPOSIT,
    "paused pending fee included in accountedBalance"
  );

  check(
    c.totalReceived
      === INITIAL_DEPOSIT + PAUSED_PENDING_DEPOSIT,
    "paused pending fee included in totalReceived"
  );

  check(
    c.epochReceived === 0n &&
    c.epochBuybackAllocated === 0n &&
    c.epochLiquidityAllocated === 0n &&
    c.epochDevelopmentAllocated === 0n,
    "allocation epoch reset after settings change"
  );

  assertInternalInvariant(
    c,
    "after settings update"
  );

  /*
   * Exercise propose -> cancel path first.
   */
  await sendTx(
    mainWallet,
    [
      makeProposeIx(
        originalAuthority.publicKey,
        cancelledCandidate.publicKey,
        engine
      ),
    ],
    [originalAuthority],
    "propose authority candidate for cancellation"
  );

  c =
    await fetchEngineConfig(
      engine.config
    );

  sameKey(
    c.pendingAuthority,
    cancelledCandidate.publicKey,
    "pending authority proposal stored"
  );

  await sendTx(
    mainWallet,
    [
      makeCancelIx(
        originalAuthority.publicKey,
        engine
      ),
    ],
    [originalAuthority],
    "cancel authority transfer"
  );

  c =
    await fetchEngineConfig(
      engine.config
    );

  sameKey(
    c.pendingAuthority,
    ZERO_KEY,
    "pending authority cleared after cancel"
  );

  /*
   * Real two-step authority rotation.
   */
  await sendTx(
    mainWallet,
    [
      makeProposeIx(
        originalAuthority.publicKey,
        newAuthority.publicKey,
        engine
      ),
    ],
    [originalAuthority],
    "propose real new authority"
  );

  await sendTx(
    mainWallet,
    [
      makeAcceptIx(
        newAuthority.publicKey,
        engine
      ),
    ],
    [newAuthority],
    "new authority accepts transfer"
  );

  c =
    await fetchEngineConfig(
      engine.config
    );

  sameKey(
    c.authority,
    newAuthority.publicKey,
    "authority rotated to new signer"
  );

  sameKey(
    c.seedAuthority,
    originalAuthority.publicKey,
    "seed authority unchanged after rotation"
  );

  sameKey(
    c.pendingAuthority,
    ZERO_KEY,
    "pending authority cleared after accept"
  );

  check(
    c.liquidityStaged === 150_000n,
    "staged liquidity survives authority rotation"
  );

  await expectSimulationFailure(
    mainWallet,
    [
      makeUnpauseIx(
        originalAuthority.publicKey,
        engine
      ),
    ],
    [originalAuthority],
    "old authority unpause after rotation",
    "ConstraintHasOne"
  );

  await sendTx(
    mainWallet,
    [
      makeUnpauseIx(
        newAuthority.publicKey,
        engine
      ),
    ],
    [newAuthority],
    "new authority unpauses Engine"
  );

  c =
    await fetchEngineConfig(
      engine.config
    );

  check(
    !c.paused,
    "new authority successfully unpaused"
  );

  /*
   * New epoch direct transfer.
   * 1,000,001 at 30/20/50 gives:
   * buyback 300000
   * liquidity 200000
   * development 500001
   */
  await sendTx(
    mainWallet,
    [
      SystemProgram.transfer({
        fromPubkey:
          mainWallet.publicKey,
        toPubkey:
          engine.vault,
        lamports:
          Number(NEW_EPOCH_DEPOSIT),
      }),
    ],
    [],
    "direct SOL deposit under new BPS"
  );

  await sendTx(
    mainWallet,
    [
      makeSyncIx(
        newAuthority.publicKey,
        engine
      ),
    ],
    [newAuthority],
    "sync new-BPS direct deposit"
  );

  c =
    await fetchEngineConfig(
      engine.config
    );

  check(
    c.buybackReserve === 552_500n,
    "buyback reserve old + new epoch exact"
  );

  check(
    c.liquidityReserve === 201_500n,
    "new epoch liquidity reserve exact"
  );

  check(
    c.liquidityStaged === 150_000n,
    "old staged liquidity remains separate"
  );

  check(
    c.developmentReserve === 1_106_001n,
    "development reserve old + new epoch exact"
  );

  check(
    c.totalReceived === 2_010_001n,
    "totalReceived includes both deposits"
  );

  check(
    c.epochReceived === NEW_EPOCH_DEPOSIT,
    "new allocation epoch counts only post-update fees"
  );

  assertInternalInvariant(
    c,
    "after first new-BPS sync"
  );

  /*
   * Tiny arbitrary direct donation.
   * This deliberately proves that external SOL sent to
   * EngineVault is accounted, and cumulative rounding remains
   * deterministic across multiple sync calls.
   */
  await sendTx(
    mainWallet,
    [
      SystemProgram.transfer({
        fromPubkey:
          mainWallet.publicKey,
        toPubkey:
          engine.vault,
        lamports:
          Number(DIRECT_DONATION),
      }),
    ],
    [],
    "send tiny direct SOL donation"
  );

  await sendTx(
    mainWallet,
    [
      makeSyncIx(
        newAuthority.publicKey,
        engine
      ),
    ],
    [newAuthority],
    "sync tiny direct donation"
  );

  c =
    await fetchEngineConfig(
      engine.config
    );

  const newEpochTotal =
    NEW_EPOCH_DEPOSIT +
    DIRECT_DONATION;

  const expected =
    expectedEpoch(
      newEpochTotal,
      NEW_BUYBACK_BPS,
      NEW_LIQUIDITY_BPS
    );

  check(
    c.epochReceived === newEpochTotal,
    "direct donation entered current fee epoch"
  );

  check(
    c.epochBuybackAllocated === expected.buyback &&
    c.epochLiquidityAllocated === expected.liquidity &&
    c.epochDevelopmentAllocated === expected.development,
    "cumulative rounding after tiny donation exact"
  );

  check(
    c.buybackReserve
      === 252_500n + expected.buyback,
    "buyback reserve after donation exact"
  );

  check(
    c.liquidityReserve
      === 1_500n + expected.liquidity,
    "liquidity reserve after donation exact"
  );

  check(
    c.developmentReserve
      === 606_000n + expected.development,
    "development reserve after donation exact"
  );

  assertInternalInvariant(
    c,
    "after direct donation sync"
  );

  await assertBacking(
    engine,
    c,
    "after direct donation sync"
  );

  /*
   * Permissionless development settlement.
   * Transaction has NO Engine authority signer.
   * Recipient is still fixed by config.
   */
  /*
   * The old development wallet must NOT be usable after
   * update_engine_settings changed the fixed recipient.
   */
  await expectSimulationFailure(
    mainWallet,
    [
      makeSettleDevelopmentIx(
        oldDevelopmentWallet.publicKey,
        engine
      ),
    ],
    [],
    "old development wallet after settings update",
    "InvalidDevelopmentWallet"
  );

  const developmentBefore =
    BigInt(
      await retry(
        "new development wallet before settlement",
        () =>
          connection.getBalance(
            newDevelopmentWallet.publicKey,
            "confirmed"
          )
      )
    );

  const developmentAmount =
    c.developmentReserve;

  await sendTx(
    mainWallet,
    [
      makeSettleDevelopmentIx(
        newDevelopmentWallet.publicKey,
        engine
      ),
    ],
    [],
    "permissionless fixed-recipient development settlement"
  );

  const developmentAfter =
    BigInt(
      await retry(
        "new development wallet after settlement",
        () =>
          connection.getBalance(
            newDevelopmentWallet.publicKey,
            "confirmed"
          )
      )
    );

  check(
    developmentAfter - developmentBefore
      === developmentAmount,
    "development wallet received exact reserve"
  );

  c =
    await fetchEngineConfig(
      engine.config
    );

  check(
    c.developmentReserve === 0n,
    "development reserve cleared after settlement"
  );

  check(
    c.totalDevelopmentSettled
      === developmentAmount,
    "lifetime development settled exact"
  );

  assertInternalInvariant(
    c,
    "after development settlement"
  );

  /*
   * Pause again while liquidity reserve is above threshold.
   * Stage MUST fail because paused, not because threshold is low.
   */
  await sendTx(
    mainWallet,
    [
      makePauseIx(
        newAuthority.publicKey,
        engine
      ),
    ],
    [newAuthority],
    "new authority pauses Engine"
  );

  await expectSimulationFailure(
    mainWallet,
    [
      makeStageIx(
        newAuthority.publicKey,
        engine
      ),
    ],
    [newAuthority],
    "stage liquidity while paused",
    "EnginePaused"
  );

  await sendTx(
    mainWallet,
    [
      makeUnpauseIx(
        newAuthority.publicKey,
        engine
      ),
    ],
    [newAuthority],
    "new authority unpauses for final stage"
  );

  /*
   * New authority stages the new liquidity reserve.
   * Existing 150000 staged under old authority must accumulate,
   * not disappear or double count.
   */
  const liquidityReserveBeforeFinalStage =
    c.liquidityReserve;

  await sendTx(
    mainWallet,
    [
      makeStageIx(
        newAuthority.publicKey,
        engine
      ),
    ],
    [newAuthority],
    "new authority stages post-rotation liquidity"
  );

  c =
    await fetchEngineConfig(
      engine.config
    );

  check(
    c.liquidityReserve === 0n,
    "final liquidity reserve moved to staged"
  );

  check(
    c.liquidityStaged
      === 150_000n +
         liquidityReserveBeforeFinalStage,
    "old + new staged liquidity accumulated exactly"
  );

  assertInternalInvariant(
    c,
    "FINAL"
  );

  await assertBacking(
    engine,
    c,
    "FINAL"
  );

  sameKey(
    c.authority,
    newAuthority.publicKey,
    "FINAL authority remains new signer"
  );

  sameKey(
    c.seedAuthority,
    originalAuthority.publicKey,
    "FINAL seed authority remains immutable"
  );

  sameKey(
    c.developmentWallet,
    newDevelopmentWallet.publicKey,
    "FINAL development wallet correct"
  );

  console.log(
    "\n============================================================"
  );
  console.log(
    "✅ ANGRY ENGINE DEVNET STATE-MACHINE VERIFIED"
  );
  console.log(
    "✅ PAUSE / SETTINGS / AUTHORITY / ACCOUNTING / DEVELOPMENT / STAGING PASSED"
  );
  console.log(
    "============================================================\n"
  );
}

if (MODE === "precheck") {
  console.log("✅ STATE-MACHINE VERIFIER PRECHECK ONLY");
  console.log(`RPC: ${RPC}`);
  console.log("ℹ️ No transaction sent.");
} else {
  main().catch((e) => {
    console.error("\n❌ STATE-MACHINE VERIFIER FAILED");
    console.error(e?.stack ?? e);
    process.exit(1);
  });
}

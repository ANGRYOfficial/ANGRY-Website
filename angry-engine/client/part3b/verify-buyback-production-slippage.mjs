import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";

import BN from "bn.js";
import {
  OnlinePumpAmmSdk,
  PumpAmmSdk,
  buyQuoteInput,
  depositLpToken,
  pumpPoolAuthorityPda,
} from "@pump-fun/pump-swap-sdk";

const MODE = process.argv[2] ?? "precheck";
if (!["precheck", "verify", "stage-only", "deploy-only"].includes(MODE)) {
  console.error("Usage: node verify-part3.mjs precheck|verify|stage-only|deploy-only");
  process.exit(2);
}

const RPC = "https://api.devnet.solana.com";

const ANGRY_PROGRAM_ID =
  new PublicKey("NmWNEKmU9N7YWKB2QeBMUAJC1NxuiYwSo1dX4NrKo6C");

const EXPECTED_MAIN_WALLET =
  "GJScfY4ZwpsDyLTFzNEzNBA4iWKfUSduKNQwQzT7mGYT";

const PUMPSWAP_PROGRAM_ID =
  new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

const PUMP_FEE_PROGRAM_ID =
  new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");

const PUMPSWAP_POOL_DISCRIMINATOR =
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);

const BREAKING_FEE_RECIPIENTS = [
  "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
  "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
  "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
  "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
  "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6",
  "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
  "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
  "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
].map((x) => new PublicKey(x));

const OFFICIAL_DEVNET_AMM_EXAMPLES = [
  "235fuAQcDZXL8CMRuGf7iqMYpkHX95cAXW8Kqh5yVDEPs7zN7K8yRkuji1j6vkAg4ybBQbvQ4HKGaLexR3p9xWm7",
  "jqZAviLnwV7cyBtNzz7DTPB3xSyj2ZTkSAWtUKWKrjXeAkTKM16zsH3J2FbZQtXY4mCsVntVe1C6qnnNVYNDAfP",
  "2MJZMr86BdoNKDRpzAZSyQ8k782ZcNo1gaqse5raFzeWKERkdnr7B9iknSKJRSWGiUzXnsRT5m9CZpouvjbZnhrA",
  "2FDkzZ4WzKN3FMLuffz61JLMGpJ1Q9oGydyJp14xttgYaMZM5rZQiXnBkaSGTadCaP7EhjQw2peLGWskk8YaRS5s",
];

const ENGINE_DEPOSIT = 4_000_000n;       // 0.004 Devnet SOL
const BUYBACK_AMOUNT = 1_000_000n;       // 0.001 Devnet SOL
const LIQUIDITY_AMOUNT = 600_000n;      // 15% of 0.004 Devnet SOL
const BUYBACK_THRESHOLD = 1_000_000n;
const LIQUIDITY_THRESHOLD = LIQUIDITY_AMOUNT;
const DEVELOPMENT_THRESHOLD = 1_000_000n;
const OPERATIONAL_BUFFER = 20_000_000n;  // 0.02 Devnet SOL; outside creator-fee accounting
const TEMP_AUTHORITY_FUND = 50_000_000n; // config/vault rent + safety buffer

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

function sameKey(actual, expected, label) {
  const a = actual.toBase58();
  const e = expected.toBase58();
  if (a !== e) fail(`${label}: ${a} != ${e}`);
  pass(label);
}

function check(value, label) {
  if (!value) fail(label);
  pass(label);
}

function printProgramLogs(label, logs) {
  console.log(`\n===== ${label} PROGRAM LOGS =====`);
  if (!logs || logs.length === 0) {
    console.log("(no program logs returned)");
  } else {
    for (const line of logs) console.log(line);
  }
  console.log(`===== END ${label} PROGRAM LOGS =====\n`);
}

function stageFromLogs(logs) {
  return {
    angry: logs.some((line) =>
      line.includes(`Program ${ANGRY_PROGRAM_ID.toBase58()} invoke`)
    ),
    system: logs.some((line) =>
      line.includes(`Program ${SystemProgram.programId.toBase58()} invoke`)
    ),
    token: logs.some(
      (line) =>
        line.includes(`Program ${TOKEN_PROGRAM_ID.toBase58()} invoke`) ||
        line.includes(`Program ${TOKEN_2022_PROGRAM_ID.toBase58()} invoke`)
    ),
    pump: logs.some((line) =>
      line.includes(`Program ${PUMPSWAP_PROGRAM_ID.toBase58()} invoke`)
    ),
  };
}

async function retry(label, fn, attempts = 6) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const text = String(e?.message ?? e).toLowerCase();
      const transient =
        text.includes("429") ||
        text.includes("rate limit") ||
        text.includes("fetch failed") ||
        text.includes("socket") ||
        text.includes("econnreset") ||
        text.includes("timed out") ||
        text.includes("blockhash") ||
        text.includes("node is behind");

      if (!transient || i === attempts) throw e;
      const wait = i * 2500;
      console.log(`⚠️ ${label}: RPC sementara bermasalah, retry ${i}/${attempts} setelah ${wait}ms`);
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
        const raw = JSON.parse(fs.readFileSync(full, "utf8"));
        if (!Array.isArray(raw) || ![32, 64].includes(raw.length)) continue;

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
        // Ignore unrelated JSON files.
      }
    }
  }

  const match = found.find((x) => x.pubkey === EXPECTED_MAIN_WALLET);

  if (!match) {
    console.error("❌ Wallet Playground yang benar tidak ditemukan di folder Download.");
    console.error(`Expected: ${EXPECTED_MAIN_WALLET}`);
    if (found.length) {
      console.error("Keypair JSON yang ditemukan (public key saja):");
      for (const x of found) {
        console.error(`  ${x.name} -> ${x.pubkey}`);
      }
    }
    process.exit(2);
  }

  pass(`wallet cocok: ${match.name}`);
  pass(`wallet authority: ${match.pubkey}`);
  return match.keypair;
}

function pubkeyAt(data, offset) {
  return new PublicKey(data.subarray(offset, offset + 32));
}

function decodePool(data) {
  if (data.length < 245) return null;
  if (!data.subarray(0, 8).equals(PUMPSWAP_POOL_DISCRIMINATOR)) return null;

  return {
    creator: pubkeyAt(data, 11),
    baseMint: pubkeyAt(data, 43),
    quoteMint: pubkeyAt(data, 75),
    lpMint: pubkeyAt(data, 107),
    poolBaseTokenAccount: pubkeyAt(data, 139),
    poolQuoteTokenAccount: pubkeyAt(data, 171),
    coinCreator: pubkeyAt(data, 211),
    isMayhemMode: data[243] !== 0,
    isCashbackCoin: data[244] !== 0,
  };
}

function decodeGlobalProtocolRecipients(data) {
  // Anchor discriminator 8
  // admin 32, lp_fee u64, protocol_fee u64, disable_flags u8
  const start = 8 + 32 + 8 + 8 + 1;
  if (data.length < start + 8 * 32) {
    fail("PumpSwap GlobalConfig terlalu pendek.");
  }

  const out = [];
  for (let i = 0; i < 8; i++) {
    out.push(pubkeyAt(data, start + i * 32));
  }
  return out;
}

async function assertExecutable(programId, label) {
  const info = await retry(label, () =>
    connection.getAccountInfo(programId, "confirmed")
  );
  if (!info || !info.executable) {
    fail(`${label} tidak executable di Devnet: ${programId.toBase58()}`);
  }
  pass(`${label} executable di Devnet`);
}

async function getTokenAmount(account) {
  const x = await retry("getTokenAccountBalance", () =>
    connection.getTokenAccountBalance(account, "confirmed")
  );
  return BigInt(x.value.amount);
}

async function discoverPoolFromOfficialExamples() {
  const candidates = [];

  for (const sig of OFFICIAL_DEVNET_AMM_EXAMPLES) {
    try {
      const tx = await retry("getParsedTransaction", () =>
        connection.getParsedTransaction(sig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        })
      );

      if (!tx) continue;

      for (const ix of tx.transaction.message.instructions) {
        if (!("programId" in ix)) continue;
        if (!ix.programId.equals(PUMPSWAP_PROGRAM_ID)) continue;
        if (!("accounts" in ix) || ix.accounts.length < 1) continue;

        const poolKey = ix.accounts[0];
        const poolInfo = await retry("pool account", () =>
          connection.getAccountInfo(poolKey, "confirmed")
        );
        if (!poolInfo || !poolInfo.owner.equals(PUMPSWAP_PROGRAM_ID)) continue;

        const pool = decodePool(poolInfo.data);
        if (!pool) continue;
        if (!pool.quoteMint.equals(NATIVE_MINT)) continue;
        if (pool.isCashbackCoin) continue;
        if (pool.isMayhemMode) continue;

        const mintInfo = await retry("base mint", () =>
          connection.getAccountInfo(pool.baseMint, "confirmed")
        );
        if (!mintInfo) continue;

        const baseProgram = mintInfo.owner;
        if (
          !baseProgram.equals(TOKEN_PROGRAM_ID) &&
          !baseProgram.equals(TOKEN_2022_PROGRAM_ID)
        ) {
          continue;
        }

        // Part 3B supports both legacy SPL Token and Token-2022 base mints.

        const quoteReserve = await getTokenAmount(pool.poolQuoteTokenAccount);
        const baseReserve = await getTokenAmount(pool.poolBaseTokenAccount);

        if (quoteReserve < 10_000_000n || baseReserve < 1_000n) continue;

        candidates.push({
          poolKey,
          pool,
          baseProgram,
          quoteReserve,
          baseReserve,
          sourceTx: sig,
        });
      }
    } catch (e) {
      console.log(`⚠️ contoh tx ${sig.slice(0, 8)}... dilewati: ${String(e?.message ?? e)}`);
    }
  }

  // De-duplicate pools.
  const unique = new Map();
  for (const c of candidates) {
    unique.set(c.poolKey.toBase58(), c);
  }

  const values = [...unique.values()].sort((a, b) =>
    a.quoteReserve > b.quoteReserve ? -1 : a.quoteReserve < b.quoteReserve ? 1 : 0
  );

  if (!values.length) {
    fail(
      "Tidak menemukan pool PumpSwap Devnet non-cashback/non-mayhem yang masih cukup likuid dari contoh resmi."
    );
  }

  return values[0];
}

async function buildPlan() {
  await assertExecutable(ANGRY_PROGRAM_ID, "ANGRY Engine");
  await assertExecutable(PUMPSWAP_PROGRAM_ID, "PumpSwap");
  await assertExecutable(PUMP_FEE_PROGRAM_ID, "Pump Fee");

  const [globalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_config")],
    PUMPSWAP_PROGRAM_ID
  );

  const globalInfo = await retry("PumpSwap GlobalConfig", () =>
    connection.getAccountInfo(globalConfig, "confirmed")
  );
  if (!globalInfo || !globalInfo.owner.equals(PUMPSWAP_PROGRAM_ID)) {
    fail("PumpSwap GlobalConfig tidak valid.");
  }

  const protocolRecipients = decodeGlobalProtocolRecipients(globalInfo.data);
  const protocolFeeRecipient = protocolRecipients[0];

  const chosen = await discoverPoolFromOfficialExamples();

  const [pumpEventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    PUMPSWAP_PROGRAM_ID
  );

  const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_volume_accumulator")],
    PUMPSWAP_PROGRAM_ID
  );

  const [feeConfig] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("fee_config"),
      PUMPSWAP_PROGRAM_ID.toBuffer(),
    ],
    PUMP_FEE_PROGRAM_ID
  );

  const [poolV2] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool-v2"),
      chosen.pool.baseMint.toBuffer(),
    ],
    PUMPSWAP_PROGRAM_ID
  );

  const [coinCreatorVaultAuthority] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("creator_vault"),
      chosen.pool.coinCreator.toBuffer(),
    ],
    PUMPSWAP_PROGRAM_ID
  );

  const breakingFeeRecipient = BREAKING_FEE_RECIPIENTS[0];

  const plan = {
    rpc: RPC,
    angryProgramId: ANGRY_PROGRAM_ID.toBase58(),
    pumpSwapProgramId: PUMPSWAP_PROGRAM_ID.toBase58(),
    pumpFeeProgramId: PUMP_FEE_PROGRAM_ID.toBase58(),
    sourceOfficialDevnetTx: chosen.sourceTx,
    pool: chosen.poolKey.toBase58(),
    baseMint: chosen.pool.baseMint.toBase58(),
    quoteMint: chosen.pool.quoteMint.toBase58(),
    lpMint: chosen.pool.lpMint.toBase58(),
    baseTokenProgram: chosen.baseProgram.toBase58(),
    poolBaseTokenAccount: chosen.pool.poolBaseTokenAccount.toBase58(),
    poolQuoteTokenAccount: chosen.pool.poolQuoteTokenAccount.toBase58(),
    coinCreator: chosen.pool.coinCreator.toBase58(),
    poolQuoteReserve: chosen.quoteReserve.toString(),
    poolBaseReserve: chosen.baseReserve.toString(),
    globalConfig: globalConfig.toBase58(),
    protocolFeeRecipient: protocolFeeRecipient.toBase58(),
    pumpEventAuthority: pumpEventAuthority.toBase58(),
    globalVolumeAccumulator: globalVolumeAccumulator.toBase58(),
    feeConfig: feeConfig.toBase58(),
    poolV2: poolV2.toBase58(),
    coinCreatorVaultAuthority: coinCreatorVaultAuthority.toBase58(),
    breakingFeeRecipient: breakingFeeRecipient.toBase58(),
  };

  fs.writeFileSync(
    path.join(process.cwd(), "part2-plan.json"),
    JSON.stringify(plan, null, 2) + "\n"
  );

  return plan;
}

function printPlan(plan) {
  console.log("\n===== DEVNET PUMPSWAP PLAN =====");
  console.log(`Pool              : ${plan.pool}`);
  console.log(`Base mint         : ${plan.baseMint}`);
  console.log(`LP mint           : ${plan.lpMint ?? "(not requested in this mode)"}`);
  console.log(`Base token program: ${plan.baseTokenProgram}`);
  console.log(`Quote mint        : ${plan.quoteMint}`);
  console.log(`Quote reserve     : ${plan.poolQuoteReserve} lamports`);
  console.log(`Source official tx: ${plan.sourceOfficialDevnetTx}`);
  console.log("================================\n");
}

function ixDisc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function accountDisc(name) {
  return crypto.createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
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

function initializeData(project) {
  return Buffer.concat([
    ixDisc("initialize_engine"),
    project.toBuffer(),
    u16(2500),
    u16(1500),
    u16(6000),
    u64(BUYBACK_THRESHOLD),
    u64(LIQUIDITY_THRESHOLD),
    u64(DEVELOPMENT_THRESHOLD),
  ]);
}

function executeData(quoteAmount, minBaseOut) {
  return Buffer.concat([
    ixDisc("execute_buyback_burn"),
    u64(quoteAmount),
    u64(minBaseOut),
  ]);
}

function stageLiquidityData() {
  return ixDisc("stage_liquidity");
}

function deployLiquidityData(
  quoteAmountToBuy,
  expectedBaseAmountOut,
  quoteAmountToDeposit,
  lpTokenAmountOut
) {
  return Buffer.concat([
    ixDisc("deploy_liquidity"),
    u64(quoteAmountToBuy),
    u64(expectedBaseAmountOut),
    u64(quoteAmountToDeposit),
    u64(lpTokenAmountOut),
  ]);
}

function meta(pubkey, isSigner = false, isWritable = false) {
  return { pubkey, isSigner, isWritable };
}

function deriveEngine(authority, project) {
  const [config] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("angry-engine-config"),
      authority.toBuffer(),
      project.toBuffer(),
    ],
    ANGRY_PROGRAM_ID
  );

  const [vault] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("angry-engine-vault"),
      config.toBuffer(),
    ],
    ANGRY_PROGRAM_ID
  );

  const [buybackAuthority] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("angry-engine-buyback"),
      config.toBuffer(),
    ],
    ANGRY_PROGRAM_ID
  );

  const [liquidityAuthority] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("angry-engine-liquidity"),
      config.toBuffer(),
    ],
    ANGRY_PROGRAM_ID
  );

  return { config, vault, buybackAuthority, liquidityAuthority };
}

async function sendTx(mainWallet, instructions, extraSigners = [], label = "transaction") {
  return await retry(label, async () => {
    const tx = new Transaction().add(...instructions);
    tx.feePayer = mainWallet.publicKey;
    return await sendAndConfirmTransaction(
      connection,
      tx,
      [mainWallet, ...extraSigners],
      {
        commitment: "confirmed",
        preflightCommitment: "confirmed",
        maxRetries: 5,
      }
    );
  });
}

function uniquePubkeys(addresses) {
  const seen = new Set();
  const out = [];
  for (const address of addresses) {
    const key = address.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

async function createExecuteLookupTable(mainWallet, addresses) {
  console.log("\n--- PREPARE ADDRESS LOOKUP TABLE (v0) ---");

  const recentSlot = await retry("get finalized slot", () =>
    connection.getSlot("finalized")
  );

  const [createIx, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: mainWallet.publicKey,
      payer: mainWallet.publicKey,
      recentSlot,
    });

  await sendTx(
    mainWallet,
    [createIx],
    [],
    "create Address Lookup Table"
  );

  const unique = uniquePubkeys(addresses).filter(
    (address) => !address.equals(mainWallet.publicKey)
  );

  // Keep extend transactions comfortably below the legacy packet limit.
  const CHUNK = 15;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: mainWallet.publicKey,
      authority: mainWallet.publicKey,
      lookupTable: lookupTableAddress,
      addresses: chunk,
    });

    await sendTx(
      mainWallet,
      [extendIx],
      [],
      `extend Address Lookup Table ${i / CHUNK + 1}`
    );
  }

  // New lookup addresses are usable only after the extension slot has passed.
  for (let attempt = 1; attempt <= 20; attempt++) {
    const result = await retry("fetch Address Lookup Table", () =>
      connection.getAddressLookupTable(lookupTableAddress, {
        commitment: "confirmed",
      })
    );

    if (!result.value) {
      await sleep(700);
      continue;
    }

    const currentSlot = await retry("get current slot", () =>
      connection.getSlot("confirmed")
    );

    if (currentSlot > result.value.state.lastExtendedSlot) {
      pass(
        `Address Lookup Table active: ${lookupTableAddress.toBase58()} (${result.value.state.addresses.length} addresses)`
      );
      return result.value;
    }

    await sleep(700);
  }

  fail("Address Lookup Table belum aktif setelah menunggu beberapa slot.");
}

async function buildV0Transaction(
  mainWallet,
  instructions,
  extraSigners,
  lookupTable,
  label
) {
  const latest = await retry(`${label}: latest blockhash`, () =>
    connection.getLatestBlockhash("confirmed")
  );

  const messageV0 = new TransactionMessage({
    payerKey: mainWallet.publicKey,
    recentBlockhash: latest.blockhash,
    instructions,
  }).compileToV0Message([lookupTable]);

  const tx = new VersionedTransaction(messageV0);
  tx.sign([mainWallet, ...extraSigners]);

  // This is a client-side size check only. Never treat it as an expected
  // on-chain rollback.
  const serialized = tx.serialize();
  if (serialized.length > 1232) {
    fail(
      `${label}: v0 transaction masih terlalu besar: ${serialized.length} > 1232`
    );
  }

  console.log(`ℹ️ ${label}: v0 serialized size = ${serialized.length} bytes`);
  return { tx, latest };
}

async function simulateV0(
  mainWallet,
  instructions,
  extraSigners,
  lookupTable,
  label
) {
  const { tx } = await buildV0Transaction(
    mainWallet,
    instructions,
    extraSigners,
    lookupTable,
    `${label} simulation`
  );

  const result = await retry(`${label}: simulate`, () =>
    connection.simulateTransaction(tx, {
      commitment: "confirmed",
      sigVerify: true,
    })
  );

  const logs = result.value.logs ?? [];
  const stage = stageFromLogs(logs);

  console.log(
    `ℹ️ ${label}: simulation err=${JSON.stringify(result.value.err)} ` +
      `ANGRY=${stage.angry} SYSTEM=${stage.system} TOKEN=${stage.token} PUMPSWAP=${stage.pump}`
  );

  if (result.value.err) {
    printProgramLogs(`${label} SIMULATION`, logs);
  }

  return { err: result.value.err, logs, ...stage };
}

async function sendV0Success(
  mainWallet,
  instructions,
  extraSigners,
  lookupTable,
  label
) {
  const { tx, latest } = await buildV0Transaction(
    mainWallet,
    instructions,
    extraSigners,
    lookupTable,
    label
  );

  const signature = await retry(`${label}: send`, () =>
    connection.sendTransaction(tx, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 5,
    })
  );

  const confirmation = await retry(`${label}: confirm`, () =>
    connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      "confirmed"
    )
  );

  if (confirmation.value.err) {
    const txInfo = await retry(`${label}: fetch failed tx`, () =>
      connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
    );

    const error = new Error(
      `${label} failed on-chain: ${JSON.stringify(confirmation.value.err)}`
    );
    error.logs = txInfo?.meta?.logMessages ?? [];
    throw error;
  }

  pass(`${label} confirmed on-chain: ${signature}`);
  return signature;
}

async function sendV0ExpectedFailure(
  mainWallet,
  instructions,
  extraSigners,
  lookupTable,
  label
) {
  const { tx, latest } = await buildV0Transaction(
    mainWallet,
    instructions,
    extraSigners,
    lookupTable,
    label
  );

  // skipPreflight=true is deliberate here: we want a real failed transaction
  // recorded by the runtime so atomic rollback can be checked afterward.
  const signature = await retry(`${label}: send expected failure`, () =>
    connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: 5,
    })
  );

  const confirmation = await retry(`${label}: confirm expected failure`, () =>
    connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      "confirmed"
    )
  );

  if (!confirmation.value.err) {
    fail(`${label}: transaksi seharusnya gagal tetapi sukses.`);
  }

  const txInfo = await retry(`${label}: fetch failure logs`, () =>
    connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    })
  );

  const logs = txInfo?.meta?.logMessages ?? [];
  const stage = stageFromLogs(logs);

  console.log(`ℹ️ expected-failure signature: ${signature}`);
  console.log(
    `ℹ️ on-chain stage: ANGRY=${stage.angry} SYSTEM=${stage.system} ` +
      `TOKEN=${stage.token} PUMPSWAP=${stage.pump}`
  );

  if (!stage.angry || !stage.pump) {
    printProgramLogs("EXPECTED FAILURE", logs);
    const error = new Error(
      !stage.angry
        ? `${label}: failed transaction tidak mencapai ANGRY program.`
        : `${label}: failed transaction berhenti di ANGRY sebelum PumpSwap CPI.`
    );
    error.logs = logs;
    throw error;
  }

  pass(`expected failure benar-benar tercatat on-chain: ${signature}`);
  pass("rollback path reached ANGRY → PumpSwap before failing");
  return { signature, logs };
}

async function createAtaIfNeeded(mainWallet, mint, owner, tokenProgram) {
  const ata = getAssociatedTokenAddressSync(
    mint,
    owner,
    true,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const ix = createAssociatedTokenAccountIdempotentInstruction(
    mainWallet.publicKey,
    ata,
    owner,
    mint,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  return { ata, ix };
}

function decodeEngineConfig(data) {
  const expected = accountDisc("EngineConfig");
  if (data.length < 8 || !data.subarray(0, 8).equals(expected)) {
    fail("EngineConfig discriminator mismatch.");
  }

  let o = 8;
  const pk = () => {
    const x = new PublicKey(data.subarray(o, o + 32));
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
  const info = await retry("fetch EngineConfig", () =>
    connection.getAccountInfo(config, "confirmed")
  );
  if (!info) fail("EngineConfig tidak ditemukan.");
  return decodeEngineConfig(info.data);
}

async function tokenAmountOrZero(account) {
  try {
    return await getTokenAmount(account);
  } catch {
    return 0n;
  }
}

async function runVerify(mainWallet, plan) {
  console.log("\n============================================================");
  console.log("ANGRY PART 3 R1 — DEVNET LIQUIDITY STAGING VERIFIER");
  console.log("============================================================");

  const balance = await retry("wallet balance", () =>
    connection.getBalance(mainWallet.publicKey, "confirmed")
  );

  console.log(`Main wallet balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  if (balance < 150_000_000) {
    fail("Butuh minimal 0.15 SOL Devnet agar verifier punya buffer aman.");
  }

  const pool = new PublicKey(plan.pool);
  const baseMint = new PublicKey(plan.baseMint);
  const quoteMint = new PublicKey(plan.quoteMint);
  const baseTokenProgram = new PublicKey(plan.baseTokenProgram);
  const poolBaseTokenAccount = new PublicKey(plan.poolBaseTokenAccount);
  const poolQuoteTokenAccount = new PublicKey(plan.poolQuoteTokenAccount);
  const globalConfig = new PublicKey(plan.globalConfig);
  const protocolFeeRecipient = new PublicKey(plan.protocolFeeRecipient);
  const pumpEventAuthority = new PublicKey(plan.pumpEventAuthority);
  const globalVolumeAccumulator = new PublicKey(plan.globalVolumeAccumulator);
  const feeConfig = new PublicKey(plan.feeConfig);
  const poolV2 = new PublicKey(plan.poolV2);
  const coinCreatorVaultAuthority =
    new PublicKey(plan.coinCreatorVaultAuthority);
  const breakingFeeRecipient = new PublicKey(plan.breakingFeeRecipient);

  const tempAuthority = Keypair.generate();
  const developmentWallet = Keypair.generate();
  const engine = deriveEngine(tempAuthority.publicKey, baseMint);

  console.log(`Temporary Engine authority: ${tempAuthority.publicKey.toBase58()}`);
  console.log(`Engine config             : ${engine.config.toBase58()}`);
  console.log(`Engine vault              : ${engine.vault.toBase58()}`);
  console.log(`Buyback authority PDA     : ${engine.buybackAuthority.toBase58()}`);
  console.log(`Liquidity authority PDA   : ${engine.liquidityAuthority.toBase58()}`);

  const [
    buybackBase,
    buybackWsol,
    protocolFeeAta,
    creatorVaultAta,
    breakingFeeAta,
  ] = await Promise.all([
    createAtaIfNeeded(
      mainWallet,
      baseMint,
      engine.buybackAuthority,
      baseTokenProgram
    ),
    createAtaIfNeeded(
      mainWallet,
      quoteMint,
      engine.buybackAuthority,
      TOKEN_PROGRAM_ID
    ),
    createAtaIfNeeded(
      mainWallet,
      quoteMint,
      protocolFeeRecipient,
      TOKEN_PROGRAM_ID
    ),
    createAtaIfNeeded(
      mainWallet,
      quoteMint,
      coinCreatorVaultAuthority,
      TOKEN_PROGRAM_ID
    ),
    createAtaIfNeeded(
      mainWallet,
      quoteMint,
      breakingFeeRecipient,
      TOKEN_PROGRAM_ID
    ),
  ]);

  const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("user_volume_accumulator"),
      engine.buybackAuthority.toBuffer(),
    ],
    PUMPSWAP_PROGRAM_ID
  );

  // Setup is deliberately separate from the creator-fee transaction.
  await sendTx(
    mainWallet,
    [
      SystemProgram.transfer({
        fromPubkey: mainWallet.publicKey,
        toPubkey: tempAuthority.publicKey,
        lamports: Number(TEMP_AUTHORITY_FUND),
      }),
      SystemProgram.transfer({
        fromPubkey: mainWallet.publicKey,
        toPubkey: engine.buybackAuthority,
        lamports: Number(OPERATIONAL_BUFFER),
      }),
    ],
    [],
    "fund temporary verifier accounts"
  );
  pass("temporary authority + buyback operational buffer funded");

  await sendTx(
    mainWallet,
    [
      buybackBase.ix,
      buybackWsol.ix,
      protocolFeeAta.ix,
      creatorVaultAta.ix,
      breakingFeeAta.ix,
    ],
    [],
    "create idempotent ATAs"
  );
  pass("all required ATAs prepared before creator-fee execution");

  const initIx = new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,
    keys: [
      meta(tempAuthority.publicKey, true, true),
      meta(developmentWallet.publicKey, false, false),
      meta(engine.config, false, true),
      meta(engine.vault, false, true),
      meta(engine.liquidityAuthority, false, true),
      meta(SystemProgram.programId, false, false),
    ],
    data: initializeData(baseMint),
  });

  await sendTx(mainWallet, [initIx], [tempAuthority], "initialize Engine config");
  pass("fresh 25/15/60 Engine config initialized");

  await sendTx(
    mainWallet,
    [
      SystemProgram.transfer({
        fromPubkey: mainWallet.publicKey,
        toPubkey: engine.vault,
        lamports: Number(ENGINE_DEPOSIT),
      }),
    ],
    [],
    "deposit creator-fee test SOL"
  );
  pass("0.004 SOL creator-fee test deposit sent to EngineVault");

  const makeExecuteIx = (minBaseOut) =>
    new TransactionInstruction({
      programId: ANGRY_PROGRAM_ID,
      keys: [
        meta(engine.config, false, true),
        meta(engine.vault, false, true),
        meta(tempAuthority.publicKey, true, false),
        meta(engine.buybackAuthority, false, true),

        meta(pool, false, true),
        meta(globalConfig, false, false),
        meta(baseMint, false, true),
        meta(quoteMint, false, false),

        meta(buybackBase.ata, false, true),
        meta(buybackWsol.ata, false, true),

        meta(poolBaseTokenAccount, false, true),
        meta(poolQuoteTokenAccount, false, true),

        meta(protocolFeeRecipient, false, false),
        meta(protocolFeeAta.ata, false, true),

        meta(baseTokenProgram, false, false),
        meta(TOKEN_PROGRAM_ID, false, false),
        meta(SystemProgram.programId, false, false),
        meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),

        meta(pumpEventAuthority, false, false),
        meta(PUMPSWAP_PROGRAM_ID, false, false),

        meta(creatorVaultAta.ata, false, true),
        meta(coinCreatorVaultAuthority, false, false),

        meta(globalVolumeAccumulator, false, false),
        meta(userVolumeAccumulator, false, true),

        meta(feeConfig, false, false),
        meta(PUMP_FEE_PROGRAM_ID, false, false),

        meta(poolV2, false, false),
        meta(breakingFeeRecipient, false, false),
        meta(breakingFeeAta.ata, false, true),
      ],
      data: executeData(BUYBACK_AMOUNT, minBaseOut),
    });

  console.log("\n--- FULL PRE-CPI ACCOUNT / STATE AUDIT ---");

  const configAudit = await fetchEngineConfig(engine.config);
  sameKey(configAudit.authority, tempAuthority.publicKey, "Engine authority matches temporary signer");
  sameKey(configAudit.project, baseMint, "Engine project equals PumpSwap base mint");
  check(configAudit.paused === false, "Engine is unpaused");
  check(configAudit.buybackBps === 2500, "Engine buyback BPS = 25%");
  check(configAudit.liquidityBps === 1500, "Engine liquidity BPS = 15%");
  check(configAudit.developmentBps === 6000, "Engine development BPS = 60%");

  const vaultInfoAudit = await retry("fetch EngineVault", () =>
    connection.getAccountInfo(engine.vault, "confirmed")
  );
  if (!vaultInfoAudit) fail("EngineVault missing.");
  sameKey(vaultInfoAudit.owner, ANGRY_PROGRAM_ID, "EngineVault owned by ANGRY program");

  const vaultRent = await retry("vault rent floor", () =>
    connection.getMinimumBalanceForRentExemption(vaultInfoAudit.data.length, "confirmed")
  );
  const vaultSpendable = BigInt(vaultInfoAudit.lamports - vaultRent);
  check(
    vaultSpendable === ENGINE_DEPOSIT,
    `EngineVault pending creator-fee spendable balance = ${ENGINE_DEPOSIT.toString()} lamports`
  );

  const buybackAuthorityInfo = await retry("buyback authority account", () =>
    connection.getAccountInfo(engine.buybackAuthority, "confirmed")
  );
  if (!buybackAuthorityInfo) fail("Buyback authority PDA account missing.");
  sameKey(
    buybackAuthorityInfo.owner,
    SystemProgram.programId,
    "Buyback authority PDA remains System-owned"
  );
  check(buybackAuthorityInfo.data.length === 0, "Buyback authority PDA has zero data");
  check(
    BigInt(buybackAuthorityInfo.lamports) >= OPERATIONAL_BUFFER,
    "Buyback authority has operational SOL buffer"
  );

  const mintAudit = await getMint(connection, baseMint, "confirmed", baseTokenProgram);
  sameKey(mintAudit.address, baseMint, "Base mint decodes under selected token program");

  const buybackBaseAudit = await getAccount(
    connection,
    buybackBase.ata,
    "confirmed",
    baseTokenProgram
  );
  sameKey(buybackBaseAudit.owner, engine.buybackAuthority, "Buyback base ATA owner = buyback PDA");
  sameKey(buybackBaseAudit.mint, baseMint, "Buyback base ATA mint = project mint");

  const buybackWsolAudit = await getAccount(
    connection,
    buybackWsol.ata,
    "confirmed",
    TOKEN_PROGRAM_ID
  );
  sameKey(buybackWsolAudit.owner, engine.buybackAuthority, "Buyback WSOL ATA owner = buyback PDA");
  sameKey(buybackWsolAudit.mint, quoteMint, "Buyback WSOL ATA mint = WSOL");

  const poolInfoAudit = await retry("PumpSwap pool audit", () =>
    connection.getAccountInfo(pool, "confirmed")
  );
  if (!poolInfoAudit) fail("PumpSwap pool missing during audit.");
  sameKey(poolInfoAudit.owner, PUMPSWAP_PROGRAM_ID, "Pool owned by PumpSwap");

  const decodedPoolAudit = decodePool(poolInfoAudit.data);
  if (!decodedPoolAudit) fail("PumpSwap Pool discriminator/layout failed during audit.");
  sameKey(decodedPoolAudit.baseMint, baseMint, "Pool base mint matches project");
  sameKey(decodedPoolAudit.quoteMint, quoteMint, "Pool quote mint is WSOL");
  sameKey(decodedPoolAudit.poolBaseTokenAccount, poolBaseTokenAccount, "Pool base vault matches Pool state");
  sameKey(decodedPoolAudit.poolQuoteTokenAccount, poolQuoteTokenAccount, "Pool quote vault matches Pool state");
  check(decodedPoolAudit.isCashbackCoin === false, "Pool is non-cashback");
  check(decodedPoolAudit.isMayhemMode === false, "Pool is non-mayhem");

  const expectedProtocolAta = getAssociatedTokenAddressSync(
    quoteMint,
    protocolFeeRecipient,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  sameKey(protocolFeeAta.ata, expectedProtocolAta, "Protocol fee WSOL ATA is canonical");

  const expectedCreatorAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), decodedPoolAudit.coinCreator.toBuffer()],
    PUMPSWAP_PROGRAM_ID
  )[0];
  sameKey(
    coinCreatorVaultAuthority,
    expectedCreatorAuthority,
    "Coin creator vault authority PDA matches Pool state"
  );

  const expectedCreatorAta = getAssociatedTokenAddressSync(
    quoteMint,
    coinCreatorVaultAuthority,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  sameKey(creatorVaultAta.ata, expectedCreatorAta, "Coin creator WSOL ATA is canonical");

  sameKey(
    globalConfig,
    PublicKey.findProgramAddressSync([Buffer.from("global_config")], PUMPSWAP_PROGRAM_ID)[0],
    "PumpSwap global_config PDA correct"
  );

  sameKey(
    pumpEventAuthority,
    PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMPSWAP_PROGRAM_ID)[0],
    "PumpSwap event authority PDA correct"
  );

  sameKey(
    globalVolumeAccumulator,
    PublicKey.findProgramAddressSync(
      [Buffer.from("global_volume_accumulator")],
      PUMPSWAP_PROGRAM_ID
    )[0],
    "PumpSwap global volume accumulator PDA correct"
  );

  sameKey(
    userVolumeAccumulator,
    PublicKey.findProgramAddressSync(
      [Buffer.from("user_volume_accumulator"), engine.buybackAuthority.toBuffer()],
      PUMPSWAP_PROGRAM_ID
    )[0],
    "PumpSwap user volume accumulator PDA correct"
  );

  sameKey(
    feeConfig,
    PublicKey.findProgramAddressSync(
      [Buffer.from("fee_config"), PUMPSWAP_PROGRAM_ID.toBuffer()],
      PUMP_FEE_PROGRAM_ID
    )[0],
    "Pump Fee config PDA correct"
  );

  sameKey(
    poolV2,
    PublicKey.findProgramAddressSync(
      [Buffer.from("pool-v2"), baseMint.toBuffer()],
      PUMPSWAP_PROGRAM_ID
    )[0],
    "PumpSwap pool-v2 PDA correct"
  );

  check(
    BREAKING_FEE_RECIPIENTS.some((x) => x.equals(breakingFeeRecipient)),
    "Breaking fee recipient is in official allowlist"
  );

  const expectedBreakingAta = getAssociatedTokenAddressSync(
    quoteMint,
    breakingFeeRecipient,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  sameKey(
    breakingFeeAta.ata,
    expectedBreakingAta,
    "Breaking fee recipient WSOL ATA is canonical"
  );

  check(
    !!(await retry("protocol fee ATA info", () =>
      connection.getAccountInfo(protocolFeeAta.ata, "confirmed")
    )),
    "Protocol fee ATA exists before execute"
  );
  check(
    !!(await retry("creator ATA info", () =>
      connection.getAccountInfo(creatorVaultAta.ata, "confirmed")
    )),
    "Coin creator ATA exists before execute"
  );
  check(
    !!(await retry("breaking ATA info", () =>
      connection.getAccountInfo(breakingFeeAta.ata, "confirmed")
    )),
    "Breaking fee ATA exists before execute"
  );

  const poolV2Info = await retry("pool-v2 account info", () =>
    connection.getAccountInfo(poolV2, "confirmed")
  );
  console.log(`ℹ️ pool-v2 existence: ${poolV2Info ? "exists" : "not currently allocated"}`);

  const userVolumeInfo = await retry("user volume account info", () =>
    connection.getAccountInfo(userVolumeAccumulator, "confirmed")
  );
  console.log(
    `ℹ️ user_volume_accumulator existence before PumpSwap: ` +
      `${userVolumeInfo ? "exists" : "not allocated yet (PumpSwap may initialize it)"}`
  );

  pass("FULL PRE-CPI AUDIT PASSED");

  const executeLookupAddresses = [
    ANGRY_PROGRAM_ID,
    engine.config,
    engine.vault,
    engine.buybackAuthority,
    pool,
    globalConfig,
    baseMint,
    quoteMint,
    buybackBase.ata,
    buybackWsol.ata,
    poolBaseTokenAccount,
    poolQuoteTokenAccount,
    protocolFeeRecipient,
    protocolFeeAta.ata,
    baseTokenProgram,
    TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    pumpEventAuthority,
    PUMPSWAP_PROGRAM_ID,
    creatorVaultAta.ata,
    coinCreatorVaultAuthority,
    globalVolumeAccumulator,
    userVolumeAccumulator,
    feeConfig,
    PUMP_FEE_PROGRAM_ID,
    poolV2,
    breakingFeeRecipient,
    breakingFeeAta.ata,
  ];

  const executeLookupTable = await createExecuteLookupTable(
    mainWallet,
    executeLookupAddresses
  );

  const PRODUCTION_SLIPPAGE_BPS = 200n; // 2%
  const PRODUCTION_MAX_SLIPPAGE_BPS = 500n; // 5%
  const BPS_DENOMINATOR = 10_000n;

  async function getProductionBuybackQuote(label) {
    if (
      PRODUCTION_SLIPPAGE_BPS <= 0n ||
      PRODUCTION_SLIPPAGE_BPS > PRODUCTION_MAX_SLIPPAGE_BPS
    ) {
      fail("Invalid ANGRY production slippage policy.");
    }

    const slotBefore = await retry(
      `${label} slot before`,
      () => connection.getSlot("confirmed")
    );

    const onlineBuybackSdk =
      new OnlinePumpAmmSdk(connection);

    const liveSwapState =
      await onlineBuybackSdk.swapSolanaState(
        pool,
        engine.buybackAuthority
      );

    sameKey(
      liveSwapState.pool.baseMint,
      baseMint,
      `${label}: live base mint`
    );

    sameKey(
      liveSwapState.pool.quoteMint,
      quoteMint,
      `${label}: live quote mint`
    );

    const q = buyQuoteInput({
      quote: new BN(BUYBACK_AMOUNT.toString()),
      slippage: 0,
      baseReserve: liveSwapState.poolBaseAmount,
      quoteReserve: liveSwapState.poolQuoteAmount,
      virtualQuoteReserves:
        liveSwapState.pool.virtualQuoteReserves ?? new BN(0),
      globalConfig: liveSwapState.globalConfig,
      baseMintAccount: liveSwapState.baseMintAccount,
      baseMint: liveSwapState.pool.baseMint,
      coinCreator: liveSwapState.pool.coinCreator,
      creator: liveSwapState.pool.creator,
      feeConfig: liveSwapState.feeConfig,
    });

    const expectedBase =
      BigInt(q.base.toString());

    if (expectedBase <= 0n) {
      fail(`${label}: expectedBase must be > 0`);
    }

    const minBaseOut =
      expectedBase *
      (BPS_DENOMINATOR - PRODUCTION_SLIPPAGE_BPS) /
      BPS_DENOMINATOR;

    if (minBaseOut <= 0n) {
      fail(`${label}: minBaseOut must be > 0`);
    }

    const slotAfter = await retry(
      `${label} slot after`,
      () => connection.getSlot("confirmed")
    );

    console.log(`\n--- ${label.toUpperCase()} ---`);
    console.log(`Expected base         : ${expectedBase}`);
    console.log(`Slippage policy       : 200 bps (2%)`);
    console.log(`Production minBaseOut : ${minBaseOut}`);
    console.log(`Quote slot range      : ${slotBefore} -> ${slotAfter}`);

    return { expectedBase, minBaseOut };
  }

  const initialProductionQuote =
    await getProductionBuybackQuote(
      "initial production buyback quote"
    );

  console.log("\n--- V0 SIMULATION GATE — PRODUCTION 2% ---");

  const successSimulation = await simulateV0(
    mainWallet,
    [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
      makeExecuteIx(
        initialProductionQuote.minBaseOut
      ),
    ],
    [tempAuthority],
    executeLookupTable,
    "success candidate production min_base_out=98% live quote"
  );

  if (successSimulation.err) {
    if (!successSimulation.pump) {
      fail(
        "Success simulation berhenti di ANGRY sebelum PumpSwap. " +
        "Full program logs sudah dicetak di atas."
      );
    }
    fail(
      "Success simulation sudah mencapai PumpSwap tetapi masih gagal. " +
      "Full program logs sudah dicetak di atas."
    );
  }

  check(successSimulation.angry, "Success simulation reached ANGRY");
  check(successSimulation.pump, "Success simulation reached PumpSwap");
  pass("Success candidate simulation completed without on-chain error");

  const rollbackSimulation = await simulateV0(
    mainWallet,
    [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
      makeExecuteIx(18_446_744_073_709_551_615n),
    ],
    [tempAuthority],
    executeLookupTable,
    "rollback candidate impossible min_base_out"
  );

  if (!rollbackSimulation.err) {
    fail("Impossible min_base_out simulation unexpectedly succeeded.");
  }

  check(rollbackSimulation.angry, "Rollback simulation reached ANGRY");
  check(rollbackSimulation.pump, "Rollback simulation reached PumpSwap");
  pass("Rollback simulation failed only after reaching PumpSwap path");

  const configBeforeRollback = await fetchEngineConfig(engine.config);
  const vaultBeforeRollback = await retry("vault before rollback", () =>
    connection.getBalance(engine.vault, "confirmed")
  );
  const supplyBeforeRollback = BigInt(
    (await retry("mint supply before rollback", () =>
      connection.getTokenSupply(baseMint, "confirmed")
    )).value.amount
  );
  const baseAtaBeforeRollback = await tokenAmountOrZero(buybackBase.ata);
  const wsolBeforeRollback = await tokenAmountOrZero(buybackWsol.ata);

  await sendV0ExpectedFailure(
    mainWallet,
    [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
      makeExecuteIx(18_446_744_073_709_551_615n),
    ],
    [tempAuthority],
    executeLookupTable,
    "impossible min_base_out rollback transaction"
  );

  const configAfterRollback = await fetchEngineConfig(engine.config);
  const vaultAfterRollback = await retry("vault after rollback", () =>
    connection.getBalance(engine.vault, "confirmed")
  );
  const supplyAfterRollback = BigInt(
    (await retry("mint supply after rollback", () =>
      connection.getTokenSupply(baseMint, "confirmed")
    )).value.amount
  );
  const baseAtaAfterRollback = await tokenAmountOrZero(buybackBase.ata);
  const wsolAfterRollback = await tokenAmountOrZero(buybackWsol.ata);

  if (configAfterRollback.totalReceived !== configBeforeRollback.totalReceived)
    fail("Rollback gagal: totalReceived berubah.");
  if (configAfterRollback.accountedBalance !== configBeforeRollback.accountedBalance)
    fail("Rollback gagal: accountedBalance berubah.");
  if (vaultAfterRollback !== vaultBeforeRollback)
    fail("Rollback gagal: EngineVault lamports berubah.");
  if (supplyAfterRollback !== supplyBeforeRollback)
    fail("Rollback gagal: mint supply berubah.");
  if (baseAtaAfterRollback !== baseAtaBeforeRollback)
    fail("Rollback gagal: base ATA berubah.");
  if (wsolAfterRollback !== wsolBeforeRollback)
    fail("Rollback gagal: WSOL ATA berubah.");

  pass("atomic rollback verified across accounting + SOL + token + mint supply");

  /*
   * Rollback testing can take time. Fetch a NEW quote
   * immediately before the real transaction.
   */
  const finalProductionQuote =
    await getProductionBuybackQuote(
      "final pre-send production buyback quote"
    );

  const finalProductionSimulation =
    await simulateV0(
      mainWallet,
      [
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 1_000_000,
        }),
        makeExecuteIx(
          finalProductionQuote.minBaseOut
        ),
      ],
      [tempAuthority],
      executeLookupTable,
      "final production 2% pre-send simulation"
    );

  if (finalProductionSimulation.err) {
    fail(
      "Final production 2% simulation failed. " +
      "Do not widen slippage; fetch a new quote."
    );
  }

  check(
    finalProductionSimulation.angry,
    "Final production 2% simulation reached ANGRY"
  );

  check(
    finalProductionSimulation.pump,
    "Final production 2% simulation reached PumpSwap"
  );

  pass(
    "Final production 2% simulation passed before real send"
  );

  const supplyBefore = supplyAfterRollback;
  const poolBaseBefore = await getTokenAmount(poolBaseTokenAccount);
  const poolQuoteBefore = await getTokenAmount(poolQuoteTokenAccount);

  await sendV0Success(
    mainWallet,
    [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
      makeExecuteIx(
        finalProductionQuote.minBaseOut
      ),
    ],
    [tempAuthority],
    executeLookupTable,
    "real PumpSwap buyback+burn — production 2% minBaseOut"
  );

  const configAfter = await fetchEngineConfig(engine.config);
  const supplyAfter = BigInt(
    (await retry("mint supply after success", () =>
      connection.getTokenSupply(baseMint, "confirmed")
    )).value.amount
  );
  const finalBaseAta = await tokenAmountOrZero(buybackBase.ata);
  const finalWsolAta = await tokenAmountOrZero(buybackWsol.ata);
  const poolBaseAfter = await getTokenAmount(poolBaseTokenAccount);
  const poolQuoteAfter = await getTokenAmount(poolQuoteTokenAccount);

  if (!(supplyAfter < supplyBefore))
    fail("Mint supply tidak turun setelah buyback+burn.");

  const burned = supplyBefore - supplyAfter;
  if (burned <= 0n)
    fail("Burn amount harus > 0.");

  if (finalBaseAta !== baseAtaBeforeRollback)
    fail("Token buyback tidak habis diburn; base ATA tidak kembali ke saldo awal.");

  if (finalWsolAta !== wsolBeforeRollback)
    fail("WSOL creator-fee batch tidak habis dipakai; WSOL ATA tidak kembali ke saldo awal.");

  if (configAfter.totalReceived !== ENGINE_DEPOSIT)
    fail(`totalReceived salah: ${configAfter.totalReceived}`);

  if (configAfter.totalBuybackProcessed !== BUYBACK_AMOUNT)
    fail(`totalBuybackProcessed salah: ${configAfter.totalBuybackProcessed}`);

  if (configAfter.buybackReserve !== 0n)
    fail(`buybackReserve seharusnya 0, got ${configAfter.buybackReserve}`);

  if (configAfter.liquidityReserve !== 600_000n)
    fail(`liquidityReserve seharusnya 600000, got ${configAfter.liquidityReserve}`);

  if (configAfter.developmentReserve !== 2_400_000n)
    fail(`developmentReserve seharusnya 2400000, got ${configAfter.developmentReserve}`);

  if (configAfter.accountedBalance !== 3_000_000n)
    fail(`accountedBalance seharusnya 3000000, got ${configAfter.accountedBalance}`);

  if (
    configAfter.accountedBalance +
      configAfter.totalDevelopmentSettled +
      configAfter.totalBuybackProcessed +
      configAfter.totalLiquidityDeployed !==
    configAfter.totalReceived
  ) {
    fail("Lifetime accounting conservation rusak setelah buyback.");
  }

  if (!(poolBaseAfter < poolBaseBefore))
    fail("PumpSwap pool base reserve tidak turun seperti buy.");

  if (!(poolQuoteAfter > poolQuoteBefore))
    fail("PumpSwap pool quote reserve tidak naik seperti buy.");

  console.log("\n--- PART 3 R1 LIQUIDITY STAGING TEST ---");

  const configBeforeStage = await fetchEngineConfig(engine.config);

  if (configBeforeStage.liquidityReserve !== LIQUIDITY_AMOUNT)
    fail(
      `Pre-stage liquidityReserve harus ${LIQUIDITY_AMOUNT}, got ${configBeforeStage.liquidityReserve}`
    );

  if (configBeforeStage.liquidityStaged !== 0n)
    fail(
      `Pre-stage liquidityStaged harus 0, got ${configBeforeStage.liquidityStaged}`
    );

  if (
    configBeforeStage.buybackReserve +
      configBeforeStage.liquidityReserve +
      configBeforeStage.liquidityStaged +
      configBeforeStage.developmentReserve !==
    configBeforeStage.accountedBalance
  ) {
    fail("Pre-stage reserve accounting invariant rusak.");
  }

  const vaultBeforeStage = BigInt(
    await retry("EngineVault balance before liquidity stage", () =>
      connection.getBalance(engine.vault, "confirmed")
    )
  );

  const liquidityAuthorityBeforeStage = BigInt(
    await retry("Liquidity PDA balance before stage", () =>
      connection.getBalance(engine.liquidityAuthority, "confirmed")
    )
  );

  const stageLiquidityIx = new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,
    keys: [
      meta(engine.config, false, true),
      meta(engine.vault, false, true),
      meta(tempAuthority.publicKey, true, false),
      meta(engine.liquidityAuthority, false, true),
    ],
    data: stageLiquidityData(),
  });

  await sendTx(
    mainWallet,
    [stageLiquidityIx],
    [tempAuthority],
    "stage Part 3 liquidity reserve"
  );

  const configAfterStage = await fetchEngineConfig(engine.config);

  const vaultAfterStage = BigInt(
    await retry("EngineVault balance after liquidity stage", () =>
      connection.getBalance(engine.vault, "confirmed")
    )
  );

  const liquidityAuthorityAfterStage = BigInt(
    await retry("Liquidity PDA balance after stage", () =>
      connection.getBalance(engine.liquidityAuthority, "confirmed")
    )
  );

  const liquidityAuthorityInfo = await retry(
    "Liquidity Authority account after stage",
    () => connection.getAccountInfo(engine.liquidityAuthority, "confirmed")
  );

  if (!liquidityAuthorityInfo)
    fail("Liquidity Authority PDA tidak ditemukan setelah staging.");

  sameKey(
    liquidityAuthorityInfo.owner,
    SystemProgram.programId,
    "Liquidity Authority remains System-owned"
  );

  if (liquidityAuthorityInfo.data.length !== 0)
    fail("Liquidity Authority PDA harus tetap data-empty.");

  if (configAfterStage.liquidityReserve !== 0n)
    fail(
      `Post-stage liquidityReserve harus 0, got ${configAfterStage.liquidityReserve}`
    );

  if (configAfterStage.liquidityStaged !== LIQUIDITY_AMOUNT)
    fail(
      `Post-stage liquidityStaged harus ${LIQUIDITY_AMOUNT}, got ${configAfterStage.liquidityStaged}`
    );

  if (configAfterStage.buybackReserve !== 0n)
    fail(
      `Post-stage buybackReserve harus 0, got ${configAfterStage.buybackReserve}`
    );

  if (configAfterStage.developmentReserve !== 2_400_000n)
    fail(
      `Post-stage developmentReserve harus 2400000, got ${configAfterStage.developmentReserve}`
    );

  if (configAfterStage.accountedBalance !== 3_000_000n)
    fail(
      `Post-stage accountedBalance harus tetap 3000000, got ${configAfterStage.accountedBalance}`
    );

  if (configAfterStage.totalLiquidityDeployed !== 0n)
    fail(
      `totalLiquidityDeployed belum boleh berubah saat staging, got ${configAfterStage.totalLiquidityDeployed}`
    );

  if (vaultBeforeStage - vaultAfterStage !== LIQUIDITY_AMOUNT)
    fail(
      `EngineVault tidak berkurang tepat ${LIQUIDITY_AMOUNT} lamports. Before=${vaultBeforeStage}, after=${vaultAfterStage}`
    );

  if (
    liquidityAuthorityAfterStage - liquidityAuthorityBeforeStage !==
    LIQUIDITY_AMOUNT
  ) {
    fail(
      `Liquidity PDA tidak bertambah tepat ${LIQUIDITY_AMOUNT} lamports. Before=${liquidityAuthorityBeforeStage}, after=${liquidityAuthorityAfterStage}`
    );
  }

  if (
    vaultBeforeStage + liquidityAuthorityBeforeStage !==
    vaultAfterStage + liquidityAuthorityAfterStage
  ) {
    fail("SOL custody conservation rusak saat liquidity staging.");
  }

  if (
    configAfterStage.buybackReserve +
      configAfterStage.liquidityReserve +
      configAfterStage.liquidityStaged +
      configAfterStage.developmentReserve !==
    configAfterStage.accountedBalance
  ) {
    fail("Post-stage reserve accounting invariant rusak.");
  }

  if (
    configAfterStage.accountedBalance +
      configAfterStage.totalDevelopmentSettled +
      configAfterStage.totalBuybackProcessed +
      configAfterStage.totalLiquidityDeployed !==
    configAfterStage.totalReceived
  ) {
    fail("Lifetime accounting conservation rusak setelah liquidity staging.");
  }

  pass("Part 3 liquidity reserve moved from EngineVault to Liquidity PDA");
  pass("liquidityReserve became 0 and liquidityStaged became exactly 600000");
  pass("accountedBalance stayed conserved at 3000000");
  pass("Liquidity Authority remained System-owned and data-empty");
  pass("EngineVault/PDA SOL custody movement conserved exactly");

  console.log("\n============================================================");
  pass(`REAL PumpSwap buy happened and ${burned.toString()} raw base units were burned`);
  pass("mint supply decreased on-chain");
  pass("buyback token ATA returned to its original balance");
  pass("WSOL ATA returned to its original balance");
  pass("buyback reserve reduced only after successful swap+burn");
  pass("25/15/60 accounting remained conserved");
  pass("PumpSwap pool reserves moved in buy direction");
  pass("Part 3 liquidity staging accounting remained conserved");
  console.log("============================================================");
  console.log("✅ ANGRY PART 3 R1 DEVNET VERIFIED — LIQUIDITY STAGING PASSED");
  console.log("✅ ANGRY PART 2 DEVNET VERIFIED — PUMPSWAP → BUYBACK → BURN PASSED");
  console.log("============================================================");
}


async function runStageOnly(mainWallet) {
  console.log("\n============================================================");
  console.log("ANGRY PART 3 R1 — LIGHTWEIGHT LIQUIDITY STAGING VERIFIER");
  console.log("============================================================");

  const project = Keypair.generate().publicKey;
  const tempAuthority = Keypair.generate();
  const developmentWallet = Keypair.generate();
  const engine = deriveEngine(tempAuthority.publicKey, project);

  console.log(`Temporary authority       : ${tempAuthority.publicKey.toBase58()}`);
  console.log(`Test project              : ${project.toBase58()}`);
  console.log(`Engine config             : ${engine.config.toBase58()}`);
  console.log(`Engine vault              : ${engine.vault.toBase58()}`);
  console.log(`Liquidity authority PDA   : ${engine.liquidityAuthority.toBase58()}`);

  await sendTx(
    mainWallet,
    [
      SystemProgram.transfer({
        fromPubkey: mainWallet.publicKey,
        toPubkey: tempAuthority.publicKey,
        lamports: Number(TEMP_AUTHORITY_FUND),
      }),
    ],
    [],
    "fund stage-only temporary authority"
  );

  const initIx = new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,
    keys: [
      meta(tempAuthority.publicKey, true, true),
      meta(developmentWallet.publicKey, false, false),
      meta(engine.config, false, true),
      meta(engine.vault, false, true),
      meta(engine.liquidityAuthority, false, true),
      meta(SystemProgram.programId, false, false),
    ],
    data: initializeData(project),
  });

  await sendTx(
    mainWallet,
    [initIx],
    [tempAuthority],
    "initialize stage-only Engine"
  );
  pass("fresh 25/15/60 Engine initialized");

  const zeroDataRent = BigInt(
    await retry("zero-data rent minimum", () =>
      connection.getMinimumBalanceForRentExemption(0, "confirmed")
    )
  );

  const liquidityRentBalance = BigInt(
    await retry("Liquidity PDA balance after initialize", () =>
      connection.getBalance(engine.liquidityAuthority, "confirmed")
    )
  );

  const liquidityRentInfo = await retry(
    "Liquidity PDA info after initialize",
    () => connection.getAccountInfo(engine.liquidityAuthority, "confirmed")
  );

  if (!liquidityRentInfo) {
    fail("Liquidity Authority PDA tidak ditemukan setelah initialize.");
  }

  sameKey(
    liquidityRentInfo.owner,
    SystemProgram.programId,
    "Liquidity Authority is System-owned after initialize"
  );

  if (liquidityRentInfo.data.length !== 0) {
    fail("Liquidity Authority harus data-empty setelah initialize.");
  }

  if (liquidityRentBalance < zeroDataRent) {
    fail(
      `Liquidity rent buffer kurang: balance=${liquidityRentBalance}, minimum=${zeroDataRent}`
    );
  }

  const configImmediatelyAfterInit =
    await fetchEngineConfig(engine.config);

  if (configImmediatelyAfterInit.accountedBalance !== 0n) {
    fail("Rent buffer tidak boleh masuk accountedBalance.");
  }

  if (configImmediatelyAfterInit.totalReceived !== 0n) {
    fail("Rent buffer tidak boleh masuk totalReceived.");
  }

  if (configImmediatelyAfterInit.liquidityStaged !== 0n) {
    fail("Rent buffer tidak boleh masuk liquidityStaged.");
  }

  pass(`Liquidity PDA rent buffer funded: ${liquidityRentBalance} lamports`);
  pass("rent buffer remains outside creator-fee accounting");

  await sendTx(
    mainWallet,
    [
      SystemProgram.transfer({
        fromPubkey: mainWallet.publicKey,
        toPubkey: engine.vault,
        lamports: Number(ENGINE_DEPOSIT),
      }),
    ],
    [],
    "deposit stage-only creator fee"
  );
  pass("0.004 SOL creator fee deposited");

  const configBefore = await fetchEngineConfig(engine.config);

  if (configBefore.totalReceived !== 0n)
    fail(`Before lazy sync totalReceived harus 0, got ${configBefore.totalReceived}`);

  if (configBefore.accountedBalance !== 0n)
    fail(`Before lazy sync accountedBalance harus 0, got ${configBefore.accountedBalance}`);

  if (configBefore.liquidityReserve !== 0n)
    fail(`Before lazy sync liquidityReserve harus 0, got ${configBefore.liquidityReserve}`);

  if (configBefore.liquidityStaged !== 0n)
    fail(`Before stage liquidityStaged harus 0, got ${configBefore.liquidityStaged}`);

  const vaultBefore = BigInt(
    await retry("stage-only vault balance before", () =>
      connection.getBalance(engine.vault, "confirmed")
    )
  );

  const liquidityBefore = BigInt(
    await retry("stage-only liquidity PDA balance before", () =>
      connection.getBalance(engine.liquidityAuthority, "confirmed")
    )
  );

  const stageIx = new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,
    keys: [
      meta(engine.config, false, true),
      meta(engine.vault, false, true),
      meta(tempAuthority.publicKey, true, false),
      meta(engine.liquidityAuthority, false, true),
    ],
    data: stageLiquidityData(),
  });

  await sendTx(
    mainWallet,
    [stageIx],
    [tempAuthority],
    "execute stage_liquidity"
  );
  pass("stage_liquidity confirmed on-chain");

  const configAfter = await fetchEngineConfig(engine.config);

  const vaultAfter = BigInt(
    await retry("stage-only vault balance after", () =>
      connection.getBalance(engine.vault, "confirmed")
    )
  );

  const liquidityAfter = BigInt(
    await retry("stage-only liquidity PDA balance after", () =>
      connection.getBalance(engine.liquidityAuthority, "confirmed")
    )
  );

  const liquidityInfo = await retry(
    "stage-only liquidity PDA info",
    () => connection.getAccountInfo(engine.liquidityAuthority, "confirmed")
  );

  if (!liquidityInfo)
    fail("Liquidity Authority PDA tidak ditemukan.");

  sameKey(
    liquidityInfo.owner,
    SystemProgram.programId,
    "Liquidity Authority remains System-owned"
  );

  if (liquidityInfo.data.length !== 0)
    fail("Liquidity Authority harus tetap data-empty.");

  if (configAfter.buybackReserve !== 1_000_000n)
    fail(`buybackReserve harus 1000000, got ${configAfter.buybackReserve}`);

  if (configAfter.liquidityReserve !== 0n)
    fail(`liquidityReserve harus 0, got ${configAfter.liquidityReserve}`);

  if (configAfter.liquidityStaged !== LIQUIDITY_AMOUNT)
    fail(`liquidityStaged harus ${LIQUIDITY_AMOUNT}, got ${configAfter.liquidityStaged}`);

  if (configAfter.developmentReserve !== 2_400_000n)
    fail(`developmentReserve harus 2400000, got ${configAfter.developmentReserve}`);

  if (configAfter.accountedBalance !== ENGINE_DEPOSIT)
    fail(`accountedBalance harus ${ENGINE_DEPOSIT}, got ${configAfter.accountedBalance}`);

  if (configAfter.totalReceived !== ENGINE_DEPOSIT)
    fail(`totalReceived harus ${ENGINE_DEPOSIT}, got ${configAfter.totalReceived}`);

  if (configAfter.totalLiquidityDeployed !== 0n)
    fail(`totalLiquidityDeployed harus tetap 0, got ${configAfter.totalLiquidityDeployed}`);

  if (
    configAfter.buybackReserve +
      configAfter.liquidityReserve +
      configAfter.liquidityStaged +
      configAfter.developmentReserve !==
    configAfter.accountedBalance
  ) {
    fail("Reserve accounting conservation rusak.");
  }

  if (
    configAfter.accountedBalance +
      configAfter.totalDevelopmentSettled +
      configAfter.totalBuybackProcessed +
      configAfter.totalLiquidityDeployed !==
    configAfter.totalReceived
  ) {
    fail("Lifetime accounting conservation rusak.");
  }

  if (vaultBefore - vaultAfter !== LIQUIDITY_AMOUNT)
    fail(
      `EngineVault harus turun ${LIQUIDITY_AMOUNT}; before=${vaultBefore}, after=${vaultAfter}`
    );

  if (liquidityAfter - liquidityBefore !== LIQUIDITY_AMOUNT)
    fail(
      `Liquidity PDA harus naik ${LIQUIDITY_AMOUNT}; before=${liquidityBefore}, after=${liquidityAfter}`
    );

  if (vaultBefore + liquidityBefore !== vaultAfter + liquidityAfter)
    fail("SOL custody conservation rusak.");

  pass("lazy sync produced exact 25/15/60 allocation");
  pass("600000 lamports moved from EngineVault to Liquidity PDA");
  pass("liquidityReserve became 0");
  pass("liquidityStaged became exactly 600000");
  pass("accountedBalance remained exactly 4000000");
  pass("totalLiquidityDeployed remained 0");
  pass("Liquidity Authority remained System-owned and data-empty");
  pass("SOL custody conservation passed");

  console.log("============================================================");
  console.log("✅ ANGRY PART 3 R1 DEVNET VERIFIED — LIGHTWEIGHT LIQUIDITY STAGING PASSED");
  console.log("============================================================");
}


function ceilDivBigInt(a, b) {
  if (b === 0n) fail("ceilDiv division by zero");
  return (a + b - 1n) / b;
}

function feeBigInt(amount, bps) {
  return ceilDivBigInt(amount * bps, 10_000n);
}

function chooseFeeTier(feeTiers, marketCap) {
  if (!feeTiers?.length) fail("PumpSwap feeTiers empty.");

  const first = feeTiers[0];
  if (marketCap < BigInt(first.marketCapLamportsThreshold.toString())) {
    return first.fees;
  }

  for (const tier of [...feeTiers].reverse()) {
    if (marketCap >= BigInt(tier.marketCapLamportsThreshold.toString())) {
      return tier.fees;
    }
  }

  return first.fees;
}

function currentFeeBpsForSwapState(swapState) {
  const baseReserve = BigInt(swapState.poolBaseAmount.toString());
  const rawQuoteReserve = BigInt(swapState.poolQuoteAmount.toString());
  const virtualQuoteReserve = BigInt(
    swapState.pool.virtualQuoteReserves?.toString?.() ?? "0"
  );
  const effectiveQuoteReserve = rawQuoteReserve + virtualQuoteReserve;
  const mintSupply = BigInt(swapState.baseMintAccount.supply.toString());

  if (swapState.feeConfig != null) {
    if (baseReserve === 0n) fail("PumpSwap base reserve is zero.");

    const marketCap = effectiveQuoteReserve * mintSupply / baseReserve;
    const canonical = pumpPoolAuthorityPda(swapState.pool.baseMint).equals(
      swapState.pool.creator
    );
    const f = canonical
      ? chooseFeeTier(swapState.feeConfig.feeTiers, marketCap)
      : swapState.feeConfig.flatFees;

    return {
      canonical,
      marketCap,
      lp: BigInt(f.lpFeeBps.toString()),
      protocol: BigInt(f.protocolFeeBps.toString()),
      creator: BigInt(f.creatorFeeBps.toString()),
    };
  }

  return {
    canonical: null,
    marketCap: null,
    lp: BigInt(swapState.globalConfig.lpFeeBasisPoints.toString()),
    protocol: BigInt(swapState.globalConfig.protocolFeeBasisPoints.toString()),
    creator: BigInt(swapState.globalConfig.coinCreatorFeeBasisPoints.toString()),
  };
}

function exactLpInterval(reserve, wanted, supply) {
  if (reserve <= 0n || wanted <= 0n || supply <= 0n) return null;

  // depositLpToken at 0% slippage computes ceil(reserve * lp / supply).
  const min = ((wanted - 1n) * supply) / reserve + 1n;
  const max = (wanted * supply) / reserve;
  if (min > max) return null;
  return { min, max };
}

function buildPart3bCandidates(swapState, liquidityState, totalStaged) {
  const baseReserve = BigInt(swapState.poolBaseAmount.toString());
  const quoteReserve = BigInt(swapState.poolQuoteAmount.toString());
  const virtualQuoteReserve = BigInt(
    swapState.pool.virtualQuoteReserves?.toString?.() ?? "0"
  );
  const lpSupply = BigInt(liquidityState.pool.lpSupply.toString());
  const fees = currentFeeBpsForSwapState(swapState);
  const creatorFeeActive =
    swapState.pool.coinCreator.toBase58() !==
    "11111111111111111111111111111111";

  const creatorBps = creatorFeeActive ? fees.creator : 0n;
  const totalFeeBps = fees.lp + fees.protocol + creatorBps;

  const reproduceInternalQuote = (buy) => {
    let effective = buy * 10_000n / (10_000n + totalFeeBps);
    const totalWithFees =
      effective +
      feeBigInt(effective, fees.lp) +
      feeBigInt(effective, fees.protocol) +
      (creatorFeeActive ? feeBigInt(effective, fees.creator) : 0n);

    if (totalWithFees > buy) effective -= totalWithFees - buy;
    return effective;
  };

  const low = totalStaged * 35n / 100n;
  const high = totalStaged * 60n / 100n;
  const candidates = [];
  const seen = new Set();

  for (let buy = low; buy <= high; buy++) {
    const q = buyQuoteInput({
      quote: new BN(buy.toString()),
      slippage: 0,
      baseReserve: new BN(baseReserve.toString()),
      quoteReserve: new BN(quoteReserve.toString()),
      virtualQuoteReserves: new BN(virtualQuoteReserve.toString()),
      globalConfig: swapState.globalConfig,
      baseMintAccount: swapState.baseMintAccount,
      baseMint: swapState.pool.baseMint,
      coinCreator: swapState.pool.coinCreator,
      creator: swapState.pool.creator,
      feeConfig: swapState.feeConfig,
    });

    const baseOut = BigInt(q.base.toString());
    const internalQuote = BigInt(q.internalQuoteWithoutFees.toString());
    if (baseOut <= 0n || internalQuote <= 0n) continue;

    // Safety: copied fee rounding must reproduce SDK 1.19.0 exactly.
    if (reproduceInternalQuote(buy) !== internalQuote) continue;

    const lpFee = feeBigInt(internalQuote, fees.lp);
    const basePost = baseReserve - baseOut;
    const baseRange = exactLpInterval(basePost, baseOut, lpSupply);
    if (!baseRange) continue;

    const lpChoices =
      baseRange.min === baseRange.max
        ? [baseRange.min]
        : [baseRange.min, baseRange.max];

    // The known SDK/on-chain boundary can differ by one raw quote unit around
    // internalQuote-1. We generate both hypotheses, then require full v0
    // simulation against the real upgraded program before any deploy send.
    for (const mode of ["internal-plus-lp", "input-plus-lp"]) {
      const quoteIncrease =
        mode === "internal-plus-lp"
          ? internalQuote + lpFee
          : (internalQuote - 1n) + lpFee;
      const quotePost = quoteReserve + quoteIncrease;

      for (const lpOut of lpChoices) {
        const dep = depositLpToken(
          new BN(lpOut.toString()),
          0,
          new BN(basePost.toString()),
          new BN(quotePost.toString()),
          new BN(lpSupply.toString())
        );

        const exactBase = BigInt(dep.maxBase.toString());
        const quoteDeposit = BigInt(dep.maxQuote.toString());
        if (exactBase !== baseOut || quoteDeposit <= 0n) continue;

        const totalQuote = buy + quoteDeposit;
        if (totalQuote > totalStaged) continue;

        const key = [buy, baseOut, quoteDeposit, lpOut].join(":");
        if (seen.has(key)) continue;
        seen.add(key);

        candidates.push({
          mode,
          quoteAmountToBuy: buy,
          expectedBaseAmountOut: baseOut,
          quoteAmountToDeposit: quoteDeposit,
          lpTokenAmountOut: lpOut,
          totalQuote,
          remainingStaged: totalStaged - totalQuote,
          internalQuote,
          lpFee,
          baseReserve,
          quoteReserve,
          lpSupply,
        });

        // A handful is enough; each is gated by real simulation.
        if (candidates.length >= 8) {
          return { candidates, fees, virtualQuoteReserve };
        }
      }
    }
  }

  return { candidates, fees, virtualQuoteReserve };
}

async function runDeployOnly(mainWallet, plan) {
  console.log("\n============================================================");
  console.log("ANGRY PART 3B — DEVNET PUMPSWAP LIQUIDITY DEPLOY VERIFIER");
  console.log("============================================================");

  const balance = await retry("wallet balance", () =>
    connection.getBalance(mainWallet.publicKey, "confirmed")
  );
  console.log(`Main wallet balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  if (balance < 150_000_000) {
    fail("Butuh minimal 0.15 SOL Devnet agar deploy-only punya buffer aman.");
  }

  const pool = new PublicKey(plan.pool);
  const baseMint = new PublicKey(plan.baseMint);
  const quoteMint = new PublicKey(plan.quoteMint);
  const lpMint = new PublicKey(plan.lpMint);
  const baseTokenProgram = new PublicKey(plan.baseTokenProgram);
  const poolBaseTokenAccount = new PublicKey(plan.poolBaseTokenAccount);
  const poolQuoteTokenAccount = new PublicKey(plan.poolQuoteTokenAccount);
  const globalConfig = new PublicKey(plan.globalConfig);
  const protocolFeeRecipient = new PublicKey(plan.protocolFeeRecipient);
  const pumpEventAuthority = new PublicKey(plan.pumpEventAuthority);
  const globalVolumeAccumulator = new PublicKey(plan.globalVolumeAccumulator);
  const feeConfig = new PublicKey(plan.feeConfig);
  const poolV2 = new PublicKey(plan.poolV2);
  const coinCreatorVaultAuthority = new PublicKey(plan.coinCreatorVaultAuthority);
  const breakingFeeRecipient = new PublicKey(plan.breakingFeeRecipient);

  sameKey(quoteMint, NATIVE_MINT, "Deploy-only quote mint is WSOL");
  check(
    baseTokenProgram.equals(TOKEN_PROGRAM_ID) ||
      baseTokenProgram.equals(TOKEN_2022_PROGRAM_ID),
    "Deploy-only base mint uses supported SPL Token program"
  );

  const poolInfo = await retry("deploy-only pool account", () =>
    connection.getAccountInfo(pool, "confirmed")
  );
  if (!poolInfo) fail("PumpSwap pool missing.");
  const decodedPool = decodePool(poolInfo.data);
  if (!decodedPool) fail("PumpSwap pool discriminator/layout invalid.");
  sameKey(decodedPool.baseMint, baseMint, "Pool base mint matches plan");
  sameKey(decodedPool.quoteMint, quoteMint, "Pool quote mint matches plan");
  sameKey(decodedPool.lpMint, lpMint, "Pool LP mint matches plan");
  sameKey(decodedPool.poolBaseTokenAccount, poolBaseTokenAccount, "Pool base vault matches plan");
  sameKey(decodedPool.poolQuoteTokenAccount, poolQuoteTokenAccount, "Pool quote vault matches plan");

  const lpMintInfo = await retry("LP mint account", () =>
    connection.getAccountInfo(lpMint, "confirmed")
  );
  if (!lpMintInfo) fail("PumpSwap LP mint missing.");
  sameKey(lpMintInfo.owner, TOKEN_2022_PROGRAM_ID, "PumpSwap LP mint owned by Token-2022");

  const tempAuthority = Keypair.generate();
  const developmentWallet = Keypair.generate();
  const engine = deriveEngine(tempAuthority.publicKey, baseMint);

  console.log(`Temporary Engine authority: ${tempAuthority.publicKey.toBase58()}`);
  console.log(`Engine config             : ${engine.config.toBase58()}`);
  console.log(`Engine vault              : ${engine.vault.toBase58()}`);
  console.log(`Liquidity authority PDA   : ${engine.liquidityAuthority.toBase58()}`);

  const [
    liquidityBase,
    liquidityWsol,
    liquidityLp,
    protocolFeeAta,
    creatorVaultAta,
    breakingFeeAta,
  ] = await Promise.all([
    createAtaIfNeeded(mainWallet, baseMint, engine.liquidityAuthority, baseTokenProgram),
    createAtaIfNeeded(mainWallet, quoteMint, engine.liquidityAuthority, TOKEN_PROGRAM_ID),
    createAtaIfNeeded(mainWallet, lpMint, engine.liquidityAuthority, TOKEN_2022_PROGRAM_ID),
    createAtaIfNeeded(mainWallet, quoteMint, protocolFeeRecipient, TOKEN_PROGRAM_ID),
    createAtaIfNeeded(mainWallet, quoteMint, coinCreatorVaultAuthority, TOKEN_PROGRAM_ID),
    createAtaIfNeeded(mainWallet, quoteMint, breakingFeeRecipient, TOKEN_PROGRAM_ID),
  ]);

  const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), engine.liquidityAuthority.toBuffer()],
    PUMPSWAP_PROGRAM_ID
  );

  console.log("\n--- PART 3B SETUP ---");
  await sendTx(
    mainWallet,
    [
      SystemProgram.transfer({
        fromPubkey: mainWallet.publicKey,
        toPubkey: tempAuthority.publicKey,
        lamports: Number(TEMP_AUTHORITY_FUND),
      }),
    ],
    [],
    "fund Part 3B temporary authority"
  );

  await sendTx(
    mainWallet,
    [
      liquidityBase.ix,
      liquidityWsol.ix,
      liquidityLp.ix,
      protocolFeeAta.ix,
      creatorVaultAta.ix,
      breakingFeeAta.ix,
    ],
    [],
    "create Part 3B idempotent ATAs"
  );
  pass("liquidity base/WSOL/LP + PumpSwap fee ATAs prepared");

  const initIx = new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,
    keys: [
      meta(tempAuthority.publicKey, true, true),
      meta(developmentWallet.publicKey, false, false),
      meta(engine.config, false, true),
      meta(engine.vault, false, true),
      meta(engine.liquidityAuthority, false, true),
      meta(SystemProgram.programId, false, false),
    ],
    data: initializeData(baseMint),
  });

  await sendTx(mainWallet, [initIx], [tempAuthority], "initialize Part 3B Engine");
  pass("fresh 25/15/60 Engine initialized for Part 3B");

  await sendTx(
    mainWallet,
    [
      SystemProgram.transfer({
        fromPubkey: mainWallet.publicKey,
        toPubkey: engine.vault,
        lamports: Number(ENGINE_DEPOSIT),
      }),
    ],
    [],
    "deposit Part 3B creator fee"
  );

  const stageIx = new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,
    keys: [
      meta(engine.config, false, true),
      meta(engine.vault, false, true),
      meta(tempAuthority.publicKey, true, false),
      meta(engine.liquidityAuthority, false, true),
    ],
    data: stageLiquidityData(),
  });

  await sendTx(mainWallet, [stageIx], [tempAuthority], "stage Part 3B liquidity");
  const stagedConfig = await fetchEngineConfig(engine.config);

  if (stagedConfig.totalReceived !== ENGINE_DEPOSIT)
    fail(`Part3B totalReceived expected ${ENGINE_DEPOSIT}, got ${stagedConfig.totalReceived}`);
  if (stagedConfig.buybackReserve !== 1_000_000n)
    fail(`Part3B buybackReserve expected 1000000, got ${stagedConfig.buybackReserve}`);
  if (stagedConfig.liquidityReserve !== 0n)
    fail(`Part3B liquidityReserve expected 0, got ${stagedConfig.liquidityReserve}`);
  if (stagedConfig.liquidityStaged !== LIQUIDITY_AMOUNT)
    fail(`Part3B liquidityStaged expected ${LIQUIDITY_AMOUNT}, got ${stagedConfig.liquidityStaged}`);
  if (stagedConfig.developmentReserve !== 2_400_000n)
    fail(`Part3B developmentReserve expected 2400000, got ${stagedConfig.developmentReserve}`);
  if (stagedConfig.accountedBalance !== ENGINE_DEPOSIT)
    fail(`Part3B accountedBalance expected ${ENGINE_DEPOSIT}, got ${stagedConfig.accountedBalance}`);
  if (stagedConfig.totalLiquidityDeployed !== 0n)
    fail("Part3B totalLiquidityDeployed must start at 0.");
  pass("0.004 SOL lazy-sync staged exact 25/15/60 accounting; liquidityStaged=600000");

  const liquidityAuthorityInfo = await retry("Part3B liquidity authority", () =>
    connection.getAccountInfo(engine.liquidityAuthority, "confirmed")
  );
  if (!liquidityAuthorityInfo) fail("Part3B liquidity authority missing.");
  sameKey(liquidityAuthorityInfo.owner, SystemProgram.programId, "Liquidity PDA remains System-owned");
  check(liquidityAuthorityInfo.data.length === 0, "Liquidity PDA remains data-empty");

  const baseAtaAudit = await getAccount(
    connection, liquidityBase.ata, "confirmed", baseTokenProgram
  );
  sameKey(baseAtaAudit.owner, engine.liquidityAuthority, "Liquidity base ATA owner = liquidity PDA");
  sameKey(baseAtaAudit.mint, baseMint, "Liquidity base ATA mint = project");

  const wsolAtaAudit = await getAccount(
    connection, liquidityWsol.ata, "confirmed", TOKEN_PROGRAM_ID
  );
  sameKey(wsolAtaAudit.owner, engine.liquidityAuthority, "Liquidity WSOL ATA owner = liquidity PDA");
  sameKey(wsolAtaAudit.mint, quoteMint, "Liquidity WSOL ATA mint = WSOL");

  const lpAtaAudit = await getAccount(
    connection, liquidityLp.ata, "confirmed", TOKEN_2022_PROGRAM_ID
  );
  sameKey(lpAtaAudit.owner, engine.liquidityAuthority, "Liquidity LP ATA owner = liquidity PDA");
  sameKey(lpAtaAudit.mint, lpMint, "Liquidity LP ATA mint = PumpSwap LP mint");

  const deployLookupAddresses = [
    ANGRY_PROGRAM_ID,
    engine.config,
    engine.vault,
    engine.liquidityAuthority,
    pool,
    globalConfig,
    baseMint,
    quoteMint,
    lpMint,
    liquidityBase.ata,
    liquidityWsol.ata,
    liquidityLp.ata,
    poolBaseTokenAccount,
    poolQuoteTokenAccount,
    protocolFeeRecipient,
    protocolFeeAta.ata,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    SystemProgram.programId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    pumpEventAuthority,
    PUMPSWAP_PROGRAM_ID,
    creatorVaultAta.ata,
    coinCreatorVaultAuthority,
    globalVolumeAccumulator,
    userVolumeAccumulator,
    feeConfig,
    PUMP_FEE_PROGRAM_ID,
    poolV2,
    breakingFeeRecipient,
    breakingFeeAta.ata,
  ];

  const deployLookupTable = await createExecuteLookupTable(
    mainWallet,
    deployLookupAddresses
  );

  console.log("\n--- PUMPSWAP USER VOLUME ACCUMULATOR ---");

  const userVolumeAccountInfo = await retry(
    "PumpSwap user volume accumulator account",
    () => connection.getAccountInfo(userVolumeAccumulator, "confirmed")
  );

  if (!userVolumeAccountInfo) {
    const pumpAmmSdk = new PumpAmmSdk();

    const initUserVolumeIx =
      await pumpAmmSdk.initUserVolumeAccumulator({
        payer: mainWallet.publicKey,
        user: engine.liquidityAuthority,
      });

    await sendTx(
      mainWallet,
      [initUserVolumeIx],
      [],
      "initialize PumpSwap user volume accumulator"
    );

    const userVolumeAccountAfterInit = await retry(
      "PumpSwap user volume accumulator after init",
      () => connection.getAccountInfo(userVolumeAccumulator, "confirmed")
    );

    check(
      userVolumeAccountAfterInit !== null,
      "PumpSwap user volume accumulator initialized"
    );
  } else {
    pass("PumpSwap user volume accumulator already exists");
  }

  // Fetch the live pool only after all setup/ALT transactions to minimize drift.
  console.log("\n--- LIVE PART 3B QUOTE / LP CANDIDATES ---");
  const onlineSdk = new OnlinePumpAmmSdk(connection);
  const swapState = await onlineSdk.swapSolanaState(pool, engine.liquidityAuthority);
  const liquidityState = await onlineSdk.liquiditySolanaState(
    pool,
    engine.liquidityAuthority
  );

  sameKey(swapState.pool.baseMint, baseMint, "SDK base mint matches deploy pool");
  sameKey(swapState.pool.quoteMint, quoteMint, "SDK quote mint matches deploy pool");
  sameKey(swapState.pool.lpMint, lpMint, "SDK LP mint matches deploy pool");

  const built = buildPart3bCandidates(
    swapState,
    liquidityState,
    stagedConfig.liquidityStaged
  );

  console.log(`Canonical pool             : ${built.fees.canonical}`);
  console.log(`LP fee bps                 : ${built.fees.lp}`);
  console.log(`Protocol fee bps           : ${built.fees.protocol}`);
  console.log(`Creator fee bps            : ${built.fees.creator}`);
  console.log(`Virtual quote reserve      : ${built.virtualQuoteReserve}`);
  console.log(`Candidate count            : ${built.candidates.length}`);

  if (!built.candidates.length) {
    fail("No Part 3B exact-base/no-dust candidate found from live PumpSwap state. DO NOT SEND DEPLOY.");
  }

  const makeDeployIx = (c) =>
    new TransactionInstruction({
      programId: ANGRY_PROGRAM_ID,
      keys: [
        meta(engine.config, false, true),
        meta(engine.vault, false, false),
        meta(tempAuthority.publicKey, true, false),
        meta(engine.liquidityAuthority, false, true),
        meta(pool, false, true),
        meta(globalConfig, false, false),
        meta(baseMint, false, false),
        meta(quoteMint, false, false),
        meta(lpMint, false, true),
        meta(liquidityBase.ata, false, true),
        meta(liquidityWsol.ata, false, true),
        meta(liquidityLp.ata, false, true),
        meta(poolBaseTokenAccount, false, true),
        meta(poolQuoteTokenAccount, false, true),
        meta(protocolFeeRecipient, false, false),
        meta(protocolFeeAta.ata, false, true),
        meta(baseTokenProgram, false, false),
        meta(TOKEN_PROGRAM_ID, false, false),
        meta(TOKEN_2022_PROGRAM_ID, false, false),
        meta(SystemProgram.programId, false, false),
        meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
        meta(pumpEventAuthority, false, false),
        meta(PUMPSWAP_PROGRAM_ID, false, false),
        meta(creatorVaultAta.ata, false, true),
        meta(coinCreatorVaultAuthority, false, false),
        meta(globalVolumeAccumulator, false, false),
        meta(userVolumeAccumulator, false, true),
        meta(feeConfig, false, false),
        meta(PUMP_FEE_PROGRAM_ID, false, false),
        meta(poolV2, false, false),
        meta(breakingFeeRecipient, false, false),
        meta(breakingFeeAta.ata, false, true),
      ],
      data: deployLiquidityData(
        c.quoteAmountToBuy,
        c.expectedBaseAmountOut,
        c.quoteAmountToDeposit,
        c.lpTokenAmountOut
      ),
    });

  console.log("\n--- PART 3B V0 SIMULATION GATE ---");
  let selected = null;
  for (let i = 0; i < built.candidates.length; i++) {
    const c = built.candidates[i];
    console.log(
      `Candidate ${i + 1}: mode=${c.mode} buy=${c.quoteAmountToBuy} ` +
      `base=${c.expectedBaseAmountOut} deposit=${c.quoteAmountToDeposit} ` +
      `lp=${c.lpTokenAmountOut} total=${c.totalQuote} remaining=${c.remainingStaged}`
    );

    const sim = await simulateV0(
      mainWallet,
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_300_000 }),
        makeDeployIx(c),
      ],
      [tempAuthority],
      deployLookupTable,
      `Part3B candidate ${i + 1}`
    );

    if (!sim.err) {
      check(sim.angry, `Candidate ${i + 1} simulation reached ANGRY`);
      check(sim.pump, `Candidate ${i + 1} simulation reached PumpSwap`);
      selected = c;
      pass(`Candidate ${i + 1} FULL SIMULATION PASSED`);
      break;
    }

    if (!sim.angry) {
      fail(
        "deploy_liquidity simulation did not reach ANGRY. " +
        "Likely source/build/deployment mismatch (for example old Part 3A still on-chain)."
      );
    }

    console.log(
      sim.pump
        ? `⚠️ Candidate ${i + 1} reached PumpSwap but failed; trying next mathematically valid candidate.`
        : `⚠️ Candidate ${i + 1} stopped inside ANGRY before PumpSwap.`
    );
  }

  if (!selected) {
    fail(
      "All Part 3B candidates failed simulation. NO deploy transaction was sent. " +
      "Classify from the printed program logs before changing code."
    );
  }

  const configBefore = await fetchEngineConfig(engine.config);
  const liquidityLamportsBefore = BigInt(
    await retry("liquidity PDA balance before deploy", () =>
      connection.getBalance(engine.liquidityAuthority, "confirmed")
    )
  );
  const baseBefore = await getTokenAmount(liquidityBase.ata);
  const wsolBefore = await getTokenAmount(liquidityWsol.ata);
  const lpBefore = await getTokenAmount(liquidityLp.ata);
  const poolBaseBefore = await getTokenAmount(poolBaseTokenAccount);
  const poolQuoteBefore = await getTokenAmount(poolQuoteTokenAccount);
  const lpSupplyBefore = BigInt(
    (await getMint(connection, lpMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply.toString()
  );

  console.log("\n--- SEND REAL PART 3B DEPLOY (ONLY AFTER SIMULATION PASS) ---");
  const deploySignature = await sendV0Success(
    mainWallet,
    [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_300_000 }),
      makeDeployIx(selected),
    ],
    [tempAuthority],
    deployLookupTable,
    "real Part 3B PumpSwap liquidity deploy"
  );

  const configAfter = await fetchEngineConfig(engine.config);
  const liquidityLamportsAfter = BigInt(
    await retry("liquidity PDA balance after deploy", () =>
      connection.getBalance(engine.liquidityAuthority, "confirmed")
    )
  );
  const baseAfter = await getTokenAmount(liquidityBase.ata);
  const wsolAfter = await getTokenAmount(liquidityWsol.ata);
  const lpAfter = await getTokenAmount(liquidityLp.ata);
  const poolBaseAfter = await getTokenAmount(poolBaseTokenAccount);
  const poolQuoteAfter = await getTokenAmount(poolQuoteTokenAccount);
  const lpSupplyAfter = BigInt(
    (await getMint(connection, lpMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply.toString()
  );

  if (configAfter.liquidityStaged !== configBefore.liquidityStaged - selected.totalQuote)
    fail(`liquidityStaged accounting mismatch: before=${configBefore.liquidityStaged} after=${configAfter.liquidityStaged}`);
  if (configAfter.accountedBalance !== configBefore.accountedBalance - selected.totalQuote)
    fail(`accountedBalance mismatch: before=${configBefore.accountedBalance} after=${configAfter.accountedBalance}`);
  if (configAfter.totalLiquidityDeployed !== configBefore.totalLiquidityDeployed + selected.totalQuote)
    fail(`totalLiquidityDeployed mismatch: before=${configBefore.totalLiquidityDeployed} after=${configAfter.totalLiquidityDeployed}`);
  if (configAfter.buybackReserve !== configBefore.buybackReserve)
    fail("buybackReserve changed during liquidity deploy.");
  if (configAfter.developmentReserve !== configBefore.developmentReserve)
    fail("developmentReserve changed during liquidity deploy.");
  if (configAfter.liquidityReserve !== 0n)
    fail("liquidityReserve should remain 0 after staged deploy.");

  if (
    configAfter.buybackReserve +
      configAfter.liquidityReserve +
      configAfter.liquidityStaged +
      configAfter.developmentReserve !==
    configAfter.accountedBalance
  ) {
    fail("Part3B reserve accounting invariant broken after deploy.");
  }

  if (
    configAfter.accountedBalance +
      configAfter.totalDevelopmentSettled +
      configAfter.totalBuybackProcessed +
      configAfter.totalLiquidityDeployed !==
    configAfter.totalReceived
  ) {
    fail("Part3B lifetime accounting conservation broken after deploy.");
  }

  if (liquidityLamportsBefore - liquidityLamportsAfter !== selected.totalQuote)
    fail(`Liquidity PDA lamports did not fall by exact processed quote amount ${selected.totalQuote}.`);
  if (baseAfter !== baseBefore)
    fail("Project-token ATA did not return to its pre-deploy balance; base dust remained.");
  if (wsolAfter !== wsolBefore)
    fail("WSOL ATA did not return to its pre-deploy token balance; creator-fee WSOL dust remained.");
  if (lpAfter - lpBefore !== selected.lpTokenAmountOut)
    fail(`LP ATA received wrong amount: expected ${selected.lpTokenAmountOut}, got ${lpAfter - lpBefore}`);
  if (lpSupplyAfter - lpSupplyBefore !== selected.lpTokenAmountOut)
    fail(`LP mint supply increase mismatch: expected ${selected.lpTokenAmountOut}, got ${lpSupplyAfter - lpSupplyBefore}`);

  // Buy removes base, deposit adds exactly all base bought. Net pool base should return exactly.
  if (poolBaseAfter !== poolBaseBefore)
    fail(`Pool base reserve net mismatch: before=${poolBaseBefore}, after=${poolBaseAfter}`);
  if (!(poolQuoteAfter > poolQuoteBefore))
    fail("Pool quote reserve did not increase after atomic buy + liquidity deposit.");

  pass(`real deploy transaction: ${deploySignature}`);
  pass(`quote used for buy: ${selected.quoteAmountToBuy} lamports`);
  pass(`project token bought and fully deposited: ${selected.expectedBaseAmountOut} raw units`);
  pass(`quote deposited to LP: ${selected.quoteAmountToDeposit} lamports`);
  pass(`Token-2022 LP received: ${selected.lpTokenAmountOut} raw LP units`);
  pass(`processed creator-fee liquidity: ${selected.totalQuote} lamports`);
  pass(`remaining liquidityStaged: ${configAfter.liquidityStaged} lamports`);
  pass("liquidity base ATA returned exactly to pre-deploy balance");
  pass("liquidity WSOL ATA returned exactly to pre-deploy balance");
  pass("buyback/development reserves were untouched");
  pass("reserve + lifetime accounting conservation passed");
  pass("PumpSwap LP mint supply increased exactly by LP received");

  console.log("============================================================");
  console.log("✅ ANGRY PART 3B DEVNET VERIFIED — BUY → PUMPSWAP LP DEPLOY PASSED");
  console.log("============================================================");
}

async function main() {
  console.log("============================================================");
  console.log("ANGRY ENGINE PART 2 — DEVNET VERIFIER R3");
  console.log(`Mode: ${MODE}`);
  console.log("============================================================");

  const mainWallet = loadMainWallet();

  const walletBalance = await retry("wallet balance", () =>
    connection.getBalance(mainWallet.publicKey, "confirmed")
  );
  console.log(`Wallet balance: ${walletBalance / LAMPORTS_PER_SOL} SOL`);

  if (MODE === "stage-only") {
    await assertExecutable(ANGRY_PROGRAM_ID, "ANGRY Engine");
    await runStageOnly(mainWallet);
    return;
  }

  if (MODE === "deploy-only") {
    const plan = await buildPlan();
    printPlan(plan);
    await runDeployOnly(mainWallet, plan);
    return;
  }

  const plan = await buildPlan();
  printPlan(plan);

  pass("PumpSwap Devnet precheck complete");
  pass("selected pool is WSOL-quoted, non-cashback, non-mayhem");
  pass("base mint uses supported SPL Token or Token-2022 program");
  pass("protocol fee recipient read from current Devnet GlobalConfig");
  pass("official April-2026 breaking fee recipient configured");

  if (MODE === "precheck") {
    console.log("============================================================");
    console.log("✅ PRECHECK PASSED");
    console.log("✅ NO ANGRY UPGRADE OR BUYBACK TRANSACTION WAS PERFORMED");
    console.log("Part 2 R3 must already be upgraded once before real verification.");
    console.log("============================================================");
    return;
  }

  await runVerify(mainWallet, plan);
}

main().catch((error) => {
  console.error("\n============================================================");
  console.error("❌ ANGRY VERIFIER FAILED");
  console.error(error?.message ?? error);
  if (error?.logs) {
    console.error("\nProgram logs:");
    for (const line of error.logs) console.error(line);
  }
  console.error("============================================================");
  process.exit(1);
});

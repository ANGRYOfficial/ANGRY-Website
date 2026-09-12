import fs from "node:fs";
import crypto from "node:crypto";

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const RPC = "https://api.devnet.solana.com";
const connection = new Connection(RPC, "confirmed");

const ANGRY_PROGRAM_ID =
  new PublicKey("NmWNEKmU9N7YWKB2QeBMUAJC1NxuiYwSo1dX4NrKo6C");

const PUMPSWAP_PROGRAM_ID =
  new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

const PUMP_FEE_PROGRAM_ID =
  new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");

const MAIN_WALLET =
  new PublicKey("GJScfY4ZwpsDyLTFzNEzNBA4iWKfUSduKNQwQzT7mGYT");

/*
 * Fresh Engine from the post-hardening successful
 * Buyback -> Burn regression run.
 */
const AUTHORITY =
  new PublicKey("C7WXhz9w29vhjBewfvnwHTcWdLgfZSszwfMjrpahWSDs");

const CONFIG =
  new PublicKey("C7LFbbM63QSRm4YuEoTeFnp3KqsUz8ohcp2iJg1b3mnm");

const VAULT =
  new PublicKey("3FrReh9RdsVfHvEwPdtye1r1kcUt5mK5qi2YMZquq8jU");

const BUYBACK_AUTHORITY =
  new PublicKey("AMsdDuMGzofovajjdbScsxs4A7JbNNdeAmdRDw7MBJfV");

const ALT_ADDRESS =
  new PublicKey("7i8VtpYQfz5TJw9Jm1JaWKuJ7L7VUGymEkrF7dURjDre");

/*
 * Real PumpSwap Devnet WSOL pools discovered from
 * live PumpSwap-owned Pool accounts.
 */
const MAYHEM_POOL =
  new PublicKey("91KCx8VWb8fVTGTjgExFWuXaP9BoJjgAGfx37b9aRJn");

const CASHBACK_POOL =
  new PublicKey("12BKwF4BCneqB2ZicinDXCq9jcFLQop4ByDnb9jABimD");

const POOL_DISCRIMINATOR =
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);

const plan =
  JSON.parse(fs.readFileSync("part2-plan.json", "utf8"));

function key(name) {
  if (!plan[name])
    throw new Error(`Missing part2-plan key: ${name}`);

  return new PublicKey(plan[name]);
}

const normalPool = key("pool");
const baseMint = key("baseMint");
const quoteMint = key("quoteMint");
const baseTokenProgram = key("baseTokenProgram");

const poolBaseTokenAccount = key("poolBaseTokenAccount");
const poolQuoteTokenAccount = key("poolQuoteTokenAccount");

const protocolFeeRecipient = key("protocolFeeRecipient");
const globalConfig = key("globalConfig");
const pumpEventAuthority = key("pumpEventAuthority");
const globalVolumeAccumulator = key("globalVolumeAccumulator");
const feeConfig = key("feeConfig");
const poolV2 = key("poolV2");

const coinCreatorVaultAuthority =
  key("coinCreatorVaultAuthority");

const breakingFeeRecipient =
  key("breakingFeeRecipient");

const buybackBaseAta =
  getAssociatedTokenAddressSync(
    baseMint,
    BUYBACK_AUTHORITY,
    true,
    baseTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

const buybackWsolAta =
  getAssociatedTokenAddressSync(
    quoteMint,
    BUYBACK_AUTHORITY,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

const protocolFeeAta =
  getAssociatedTokenAddressSync(
    quoteMint,
    protocolFeeRecipient,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

const creatorVaultAta =
  getAssociatedTokenAddressSync(
    quoteMint,
    coinCreatorVaultAuthority,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

const breakingFeeAta =
  getAssociatedTokenAddressSync(
    quoteMint,
    breakingFeeRecipient,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

const [userVolumeAccumulator] =
  PublicKey.findProgramAddressSync(
    [
      Buffer.from("user_volume_accumulator"),
      BUYBACK_AUTHORITY.toBuffer(),
    ],
    PUMPSWAP_PROGRAM_ID
  );

function ixDisc(name) {
  return crypto
    .createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

function u64(x) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(x));
  return b;
}

function executeData() {
  /*
   * Tiny non-zero values.
   *
   * Unsupported-pool validation executes before
   * buyback threshold/reserve checks.
   */
  return Buffer.concat([
    ixDisc("execute_buyback_burn"),
    u64(1n),
    u64(1n),
  ]);
}

function meta(pubkey, isSigner = false, isWritable = false) {
  return { pubkey, isSigner, isWritable };
}

function makeIx(poolOverride) {
  return new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,

    keys: [
      meta(CONFIG, false, true),
      meta(VAULT, false, true),
      meta(AUTHORITY, true, false),
      meta(BUYBACK_AUTHORITY, false, true),

      meta(poolOverride, false, true),
      meta(globalConfig),
      meta(baseMint, false, true),
      meta(quoteMint),

      meta(buybackBaseAta, false, true),
      meta(buybackWsolAta, false, true),

      meta(poolBaseTokenAccount, false, true),
      meta(poolQuoteTokenAccount, false, true),

      meta(protocolFeeRecipient),
      meta(protocolFeeAta, false, true),

      meta(baseTokenProgram),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),

      meta(pumpEventAuthority),
      meta(PUMPSWAP_PROGRAM_ID),

      meta(creatorVaultAta, false, true),
      meta(coinCreatorVaultAuthority),

      meta(globalVolumeAccumulator),
      meta(userVolumeAccumulator, false, true),

      meta(feeConfig),
      meta(PUMP_FEE_PROGRAM_ID),

      meta(poolV2),
      meta(breakingFeeRecipient),
      meta(breakingFeeAta, false, true),
    ],

    data: executeData(),
  });
}

async function verifyTarget(
  target,
  expectedMayhem,
  expectedCashback,
  label
) {
  const info =
    await connection.getAccountInfo(target, "confirmed");

  if (!info)
    throw new Error(`${label}: account missing`);

  if (!info.owner.equals(PUMPSWAP_PROGRAM_ID))
    throw new Error(`${label}: owner is not PumpSwap`);

  if (info.data.length <= 244)
    throw new Error(`${label}: Pool data too short`);

  if (!info.data.subarray(0, 8).equals(POOL_DISCRIMINATOR))
    throw new Error(`${label}: invalid Pool discriminator`);

  const targetQuoteMint =
    new PublicKey(info.data.subarray(75, 107));

  if (!targetQuoteMint.equals(quoteMint))
    throw new Error(`${label}: Pool is not WSOL quoted`);

  const mayhem = info.data[243] !== 0;
  const cashback = info.data[244] !== 0;

  console.log(
    `✅ ${label}: Mayhem=${mayhem} Cashback=${cashback}`
  );

  if (
    mayhem !== expectedMayhem ||
    cashback !== expectedCashback
  ) {
    throw new Error(`${label}: live Pool flags changed`);
  }
}

function classify(logs) {
  return {
    angry: logs.some(line =>
      line.includes(
        `Program ${ANGRY_PROGRAM_ID.toBase58()} invoke`
      )
    ),

    pump: logs.some(line =>
      line.includes(
        `Program ${PUMPSWAP_PROGRAM_ID.toBase58()} invoke`
      )
    ),
  };
}

async function simulate(label, poolOverride, alt) {
  const latest =
    await connection.getLatestBlockhash("confirmed");

  const message =
    new TransactionMessage({
      payerKey: MAIN_WALLET,
      recentBlockhash: latest.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 1_000_000,
        }),
        makeIx(poolOverride),
      ],
    }).compileToV0Message([alt]);

  const tx =
    new VersionedTransaction(message);

  console.log(
    "\n================================================"
  );
  console.log(label);
  console.log(
    `serialized size: ${tx.serialize().length} bytes`
  );

  const result =
    await connection.simulateTransaction(tx, {
      commitment: "confirmed",
      sigVerify: false,
    });

  const logs = result.value.logs ?? [];
  const stage = classify(logs);

  console.log(
    "error:",
    JSON.stringify(result.value.err)
  );

  console.log(
    `ANGRY=${stage.angry} PUMPSWAP=${stage.pump}`
  );

  for (const line of logs) {
    if (
      /UnsupportedPumpSwapPoolMode|Error Code|AnchorError|failed/i.test(
        line
      )
    ) {
      console.log(line);
    }
  }

  return {
    err: result.value.err,
    logs,
    ...stage,
  };
}

/*
 * Sanity checks for the canonical normal Pool.
 */
const normalInfo =
  await connection.getAccountInfo(normalPool, "confirmed");

if (!normalInfo)
  throw new Error("Canonical normal Pool missing");

if (
  normalInfo.data.length <= 244 ||
  normalInfo.data[243] !== 0 ||
  normalInfo.data[244] !== 0
) {
  throw new Error(
    "Canonical Pool is no longer normal non-Mayhem/non-Cashback"
  );
}

console.log("✅ canonical normal Pool flags remain false/false");

/*
 * Prove the targets are real PumpSwap mode-flagged pools.
 */
await verifyTarget(
  MAYHEM_POOL,
  true,
  false,
  "REAL DEVNET MAYHEM POOL"
);

await verifyTarget(
  CASHBACK_POOL,
  false,
  true,
  "REAL DEVNET CASHBACK POOL"
);

const altResult =
  await connection.getAddressLookupTable(
    ALT_ADDRESS,
    { commitment: "confirmed" }
  );

if (!altResult.value)
  throw new Error("Fresh Buyback ALT no longer exists");

const alt = altResult.value;

console.log(
  `✅ Buyback ALT loaded: ${ALT_ADDRESS.toBase58()}`
);
console.log(
  `✅ ALT contains ${alt.state.addresses.length} addresses`
);

const tests = [
  {
    label:
      "BUYBACK MODE ATTACK 1 — REAL MAYHEM POOL",
    pool: MAYHEM_POOL,
  },
  {
    label:
      "BUYBACK MODE ATTACK 2 — REAL CASHBACK POOL",
    pool: CASHBACK_POOL,
  },
];

let passed = 0;

for (const test of tests) {
  const r =
    await simulate(
      test.label,
      test.pool,
      alt
    );

  const rendered = r.logs.join("\n");

  const rejectedByAngry =
    r.err !== null &&
    r.angry &&
    !r.pump;

  const expectedError =
    /UnsupportedPumpSwapPoolMode/i.test(rendered);

  if (rejectedByAngry && expectedError) {
    console.log(
      `✅ ${test.label}: REJECTED BY ANGRY BEFORE PUMPSWAP`
    );
    passed++;
  } else {
    console.log(
      `❌ ${test.label}: UNEXPECTED RESULT`
    );
  }
}

console.log(
  "\n================================================"
);
console.log("BUYBACK POOL-MODE NEGATIVE TEST SUMMARY");
console.log(
  "================================================"
);
console.log(`Passed: ${passed}/${tests.length}`);
console.log("No transaction was sent.");

if (passed !== tests.length) {
  throw new Error(
    "One or more Buyback pool-mode simulations failed"
  );
}

console.log(
  "\n✅ ALL BUYBACK UNSUPPORTED POOL-MODE TESTS REJECTED"
);
console.log(
  "✅ ANGRY STOPPED THEM BEFORE PUMPSWAP CPI"
);
console.log(
  "✅ SIMULATION ONLY — NO TRANSACTION SENT"
);

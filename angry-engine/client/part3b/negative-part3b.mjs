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
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const RPC = "https://api.devnet.solana.com";

const connection =
  new Connection(RPC, "confirmed");

const ANGRY_PROGRAM_ID =
  new PublicKey(
    "NmWNEKmU9N7YWKB2QeBMUAJC1NxuiYwSo1dX4NrKo6C"
  );

const PUMPSWAP_PROGRAM_ID =
  new PublicKey(
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
  );

const PUMP_FEE_PROGRAM_ID =
  new PublicKey(
    "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"
  );

const MAIN_WALLET =
  new PublicKey(
    "GJScfY4ZwpsDyLTFzNEzNBA4iWKfUSduKNQwQzT7mGYT"
  );

/*
 * Historical Part 3B VERIFIED state.
 * No private key is required.
 */
const OLD_AUTHORITY =
  new PublicKey(
    "AUCFPvBaYLNd6nrgWz23eFo9rSJkeHj2yLEXcxDMWuBH"
  );

const OLD_CONFIG =
  new PublicKey(
    "9VuVjNiyDdRwzfUoJHSY3SY4eyDmX4D7JK2gFzteqmLP"
  );

const OLD_VAULT =
  new PublicKey(
    "3ZCxKpRa5S8ECP3DZojfhXVerWSoVgNkVMaNGERYkccS"
  );

const OLD_LIQUIDITY_AUTHORITY =
  new PublicKey(
    "42SEYwss2rHnofRNyCxGpqihLot2uuqiKUfiGda1DBTC"
  );

const OLD_ALT =
  new PublicKey(
    "AEDLztpnHfBQz5rHiR3HQh8QddZJxLJk2LXKC6bSbre1"
  );

const plan =
  JSON.parse(
    fs.readFileSync("part2-plan.json", "utf8")
  );

function key(name) {
  if (!plan[name]) {
    throw new Error(`Missing plan key: ${name}`);
  }

  return new PublicKey(plan[name]);
}

const pool = key("pool");
const baseMint = key("baseMint");
const quoteMint = key("quoteMint");
const lpMint = key("lpMint");
const baseTokenProgram = key("baseTokenProgram");

const poolBaseTokenAccount =
  key("poolBaseTokenAccount");

const poolQuoteTokenAccount =
  key("poolQuoteTokenAccount");

const protocolFeeRecipient =
  key("protocolFeeRecipient");

const globalConfig =
  key("globalConfig");

const pumpEventAuthority =
  key("pumpEventAuthority");

const globalVolumeAccumulator =
  key("globalVolumeAccumulator");

const feeConfig =
  key("feeConfig");

const poolV2 =
  key("poolV2");

const coinCreatorVaultAuthority =
  key("coinCreatorVaultAuthority");

const breakingFeeRecipient =
  key("breakingFeeRecipient");

function same(actual, expected, label) {
  if (!actual.equals(expected)) {
    throw new Error(
      `${label}: ${actual.toBase58()} != ${expected.toBase58()}`
    );
  }

  console.log(`✅ ${label}`);
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
    liquidityAuthority,
  };
}

/*
 * Critical historical identity check.
 * Abort rather than accidentally testing a different project.
 */
const derived =
  deriveEngine(
    OLD_AUTHORITY,
    baseMint
  );

same(
  derived.config,
  OLD_CONFIG,
  "historical config matches current base mint"
);

same(
  derived.vault,
  OLD_VAULT,
  "historical vault derivation matches"
);

same(
  derived.liquidityAuthority,
  OLD_LIQUIDITY_AUTHORITY,
  "historical liquidityAuthority derivation matches"
);

const liquidityBaseAta =
  getAssociatedTokenAddressSync(
    baseMint,
    OLD_LIQUIDITY_AUTHORITY,
    true,
    baseTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

const liquidityWsolAta =
  getAssociatedTokenAddressSync(
    quoteMint,
    OLD_LIQUIDITY_AUTHORITY,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

const liquidityLpAta =
  getAssociatedTokenAddressSync(
    lpMint,
    OLD_LIQUIDITY_AUTHORITY,
    true,
    TOKEN_2022_PROGRAM_ID,
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
      Buffer.from(
        "user_volume_accumulator"
      ),
      OLD_LIQUIDITY_AUTHORITY.toBuffer(),
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

function u64(value) {
  const b = Buffer.alloc(8);

  b.writeBigUInt64LE(
    BigInt(value)
  );

  return b;
}

function deployData() {
  /*
   * Deliberately tiny non-zero values.
   *
   * Account validation happens before quote execution.
   * We only need a valid-shaped instruction for negative
   * account-substitution simulations.
   */
  return Buffer.concat([
    ixDisc("deploy_liquidity"),
    u64(1n), // quote_amount_to_buy
    u64(1n), // expected_base_amount_out
    u64(1n), // quote_amount_to_deposit
    u64(1n), // lp_token_amount_out
  ]);
}

function meta(
  pubkey,
  isSigner = false,
  isWritable = false
) {
  return {
    pubkey,
    isSigner,
    isWritable,
  };
}

function canonicalAccounts() {
  return {
    config: OLD_CONFIG,
    vault: OLD_VAULT,
    authority: OLD_AUTHORITY,
    liquidityAuthority:
      OLD_LIQUIDITY_AUTHORITY,

    pool,
    globalConfig,
    baseMint,
    quoteMint,
    lpMint,

    liquidityBaseAta,
    liquidityWsolAta,
    liquidityLpAta,

    poolBaseTokenAccount,
    poolQuoteTokenAccount,

    protocolFeeRecipient,
    protocolFeeAta,

    baseTokenProgram,
    tokenProgram:
      TOKEN_PROGRAM_ID,
    token2022Program:
      TOKEN_2022_PROGRAM_ID,
    systemProgram:
      SystemProgram.programId,
    associatedTokenProgram:
      ASSOCIATED_TOKEN_PROGRAM_ID,

    pumpEventAuthority,
    pumpSwapProgram:
      PUMPSWAP_PROGRAM_ID,

    creatorVaultAta,
    coinCreatorVaultAuthority,

    globalVolumeAccumulator,
    userVolumeAccumulator,

    feeConfig,
    feeProgram:
      PUMP_FEE_PROGRAM_ID,

    poolV2,

    breakingFeeRecipient,
    breakingFeeAta,
  };
}

function makeDeployIx(overrides = {}) {
  const a = {
    ...canonicalAccounts(),
    ...overrides,
  };

  return new TransactionInstruction({
    programId: ANGRY_PROGRAM_ID,

    /*
     * Exact 32-account order from verified Part 3B.
     */
    keys: [
      meta(a.config, false, true),
      meta(a.vault, false, false),
      meta(a.authority, true, false),
      meta(
        a.liquidityAuthority,
        false,
        true
      ),

      meta(a.pool, false, true),
      meta(a.globalConfig),
      meta(a.baseMint),
      meta(a.quoteMint),
      meta(a.lpMint, false, true),

      meta(
        a.liquidityBaseAta,
        false,
        true
      ),

      meta(
        a.liquidityWsolAta,
        false,
        true
      ),

      meta(
        a.liquidityLpAta,
        false,
        true
      ),

      meta(
        a.poolBaseTokenAccount,
        false,
        true
      ),

      meta(
        a.poolQuoteTokenAccount,
        false,
        true
      ),

      meta(a.protocolFeeRecipient),

      meta(
        a.protocolFeeAta,
        false,
        true
      ),

      meta(a.baseTokenProgram),
      meta(a.tokenProgram),
      meta(a.token2022Program),
      meta(a.systemProgram),
      meta(a.associatedTokenProgram),

      meta(a.pumpEventAuthority),
      meta(a.pumpSwapProgram),

      meta(
        a.creatorVaultAta,
        false,
        true
      ),

      meta(a.coinCreatorVaultAuthority),

      meta(a.globalVolumeAccumulator),

      meta(
        a.userVolumeAccumulator,
        false,
        true
      ),

      meta(a.feeConfig),
      meta(a.feeProgram),
      meta(a.poolV2),

      meta(a.breakingFeeRecipient),

      meta(
        a.breakingFeeAta,
        false,
        true
      ),
    ],

    data: deployData(),
  });
}

function classify(logs) {
  return {
    angry: logs.some(
      line =>
        line.includes(
          `Program ${ANGRY_PROGRAM_ID.toBase58()} invoke`
        )
    ),

    pump: logs.some(
      line =>
        line.includes(
          `Program ${PUMPSWAP_PROGRAM_ID.toBase58()} invoke`
        )
    ),
  };
}

function printRelevantLogs(logs) {
  for (const line of logs) {
    if (
      /AnchorError|Error Code|failed|ConstraintSeeds|InvalidPump|ANGRY_DIAG/i.test(
        line
      )
    ) {
      console.log(line);
    }
  }
}

const altResult =
  await connection.getAddressLookupTable(
    OLD_ALT,
    {
      commitment: "confirmed",
    }
  );

if (!altResult.value) {
  throw new Error(
    "Historical ALT no longer exists"
  );
}

const alt =
  altResult.value;

console.log(
  `✅ historical ALT loaded: ${OLD_ALT.toBase58()}`
);

console.log(
  `✅ ALT contains ${alt.state.addresses.length} addresses`
);

async function simulate(
  label,
  overrides = {}
) {
  const latest =
    await connection.getLatestBlockhash(
      "confirmed"
    );

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_300_000,
    }),

    makeDeployIx(overrides),
  ];

  const message =
    new TransactionMessage({
      payerKey: MAIN_WALLET,
      recentBlockhash:
        latest.blockhash,
      instructions,
    }).compileToV0Message([alt]);

  /*
   * Signatures remain zero-filled deliberately.
   *
   * sigVerify:false means simulation does not require
   * the historical ephemeral authority private key.
   * Signer privileges are still encoded in the message.
   */
  const tx =
    new VersionedTransaction(
      message
    );

  const size =
    tx.serialize().length;

  console.log(
    `\n================================================`
  );

  console.log(label);

  console.log(
    `serialized size: ${size} bytes`
  );

  if (size > 1232) {
    throw new Error(
      `${label}: transaction too large`
    );
  }

  const result =
    await connection.simulateTransaction(
      tx,
      {
        commitment: "confirmed",
        sigVerify: false,
      }
    );

  const logs =
    result.value.logs ?? [];

  const stage =
    classify(logs);

  console.log(
    "error:",
    JSON.stringify(
      result.value.err
    )
  );

  console.log(
    `ANGRY=${stage.angry} PUMPSWAP=${stage.pump}`
  );

  printRelevantLogs(logs);

  return {
    err: result.value.err,
    logs,
    ...stage,
  };
}

/*
 * CONTROL:
 * Valid account set should get through ANGRY account
 * validation far enough to invoke PumpSwap.
 *
 * Tiny quote values may subsequently make PumpSwap reject
 * the economic operation. That is fine for this control.
 */
const control =
  await simulate(
    "CONTROL — CANONICAL ACCOUNTS"
  );

if (!control.angry) {
  throw new Error(
    "CONTROL did not reach ANGRY"
  );
}

if (!control.pump) {
  throw new Error(
    "CONTROL did not reach PumpSwap; negative tests would be inconclusive"
  );
}

console.log(
  "\n✅ CONTROL reached PumpSwap"
);

/*
 * Use existing on-chain accounts as deliberately wrong
 * substitutes, avoiding AccountNotFound false positives.
 */
const tests = [
  {
    label:
      "ATTACK 1 — FAKE LIQUIDITY AUTHORITY",

    overrides: {
      liquidityAuthority:
        MAIN_WALLET,
    },

    expected:
      /ConstraintSeeds/i,
  },

  {
    label:
      "ATTACK 2 — FAKE POOL_V2",

    overrides: {
      poolV2:
        globalConfig,
    },

    expected:
      /InvalidPumpSwapPoolV2/i,
  },

  {
    label:
      "ATTACK 3 — FAKE USER VOLUME ACCUMULATOR",

    overrides: {
      userVolumeAccumulator:
        globalConfig,
    },

    expected:
      /InvalidPumpUserVolumeAccumulator/i,
  },

  {
    label:
      "ATTACK 4 — FAKE POOL BASE TOKEN ACCOUNT",

    overrides: {
      poolBaseTokenAccount:
        poolQuoteTokenAccount,
    },

    expected:
      /InvalidPumpSwapPoolVault/i,
  },
];

let passed = 0;

for (const test of tests) {
  const result =
    await simulate(
      test.label,
      test.overrides
    );

  const rendered =
    result.logs.join("\n");

  const rejectedByAngry =
    result.err !== null &&
    result.angry &&
    !result.pump;

  const expectedError =
    test.expected.test(
      rendered
    );

  if (
    rejectedByAngry &&
    expectedError
  ) {
    console.log(
      `✅ ${test.label}: REJECTED BY ANGRY BEFORE PUMPSWAP`
    );

    passed += 1;
  } else {
    console.log(
      `❌ ${test.label}: UNEXPECTED RESULT`
    );

    console.log(
      "Expected ANGRY=true, PUMPSWAP=false and",
      test.expected
    );
  }
}

console.log(
  "\n================================================"
);

console.log(
  "NEGATIVE PART 3B SUMMARY"
);

console.log(
  "================================================"
);

console.log(
  `Passed: ${passed}/${tests.length}`
);

console.log(
  "No transaction was sent."
);

if (passed !== tests.length) {
  throw new Error(
    "One or more adversarial simulations did not behave as expected"
  );
}

console.log(
  "\n✅ ALL ACCOUNT-SUBSTITUTION TESTS REJECTED"
);

console.log(
  "✅ ANGRY STOPPED THEM BEFORE PUMPSWAP CPI"
);

console.log(
  "✅ SIMULATION ONLY — NO TRANSACTION SENT"
);

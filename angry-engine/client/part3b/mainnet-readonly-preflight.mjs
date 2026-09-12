import fs from "node:fs";

import {
  Connection,
  PublicKey,
} from "@solana/web3.js";

import {
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

/*
 * ANGRY ENGINE — MAINNET READ-ONLY PREFLIGHT
 *
 * Mainnet addresses/config are loaded from:
 *   ./mainnet-config.json
 *
 * SAFETY:
 * - no Keypair
 * - no Transaction
 * - no TransactionInstruction
 * - no signing
 * - no sendTransaction
 * - no sendRawTransaction
 * - no confirmTransaction
 */

const CONFIG_FILE = "./mainnet-config.json";

function pass(message) {
  console.log(`✅ ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function pubkey(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} missing from Mainnet config`);
  }

  try {
    return new PublicKey(value);
  } catch {
    fail(`${label} is not a valid Solana public key`);
  }
}

if (!fs.existsSync(CONFIG_FILE)) {
  fail(`${CONFIG_FILE} not found`);
}

const config =
  JSON.parse(
    fs.readFileSync(CONFIG_FILE, "utf8")
  );

if (config.network !== "mainnet-beta") {
  fail(
    `Refusing network: ${String(config.network)}`
  );
}

if (
  config.safety?.transactionsEnabled !== false
) {
  fail(
    "Mainnet planning safety lock is not OFF"
  );
}

if (
  config.safety?.productionSenderCreated !== false
) {
  fail(
    "productionSenderCreated must remain false during read-only planning"
  );
}

pass("Mainnet planning safety locks are OFF");

const RPC =
  process.env[
    config.rpc?.environmentVariable ??
    "ANGRY_MAINNET_RPC"
  ] ||
  config.rpc?.publicFallback;

if (
  typeof RPC !== "string" ||
  RPC.length === 0
) {
  fail("No Mainnet RPC configured");
}

if (/devnet|testnet/i.test(RPC)) {
  fail(
    `Refusing non-mainnet RPC: ${RPC}`
  );
}

const ANGRY_PROGRAM_ID =
  pubkey(
    config.programs?.angryEngine,
    "ANGRY Program ID"
  );

const PUMPSWAP_PROGRAM_ID =
  pubkey(
    config.programs?.pumpSwap,
    "PumpSwap Program ID"
  );

const PUMP_FEE_PROGRAM_ID =
  pubkey(
    config.programs?.pumpFee,
    "Pump Fee Program ID"
  );

const WSOL_MINT =
  pubkey(
    config.tokens?.wsol,
    "WSOL mint"
  );

const connection =
  new Connection(RPC, "confirmed");

console.log(
  "=============================================="
);
console.log(
  "ANGRY ENGINE — MAINNET READ-ONLY PREFLIGHT"
);
console.log(
  "=============================================="
);

console.log(
  "Config:",
  CONFIG_FILE
);

console.log(
  "Network:",
  config.network
);

console.log(
  "RPC:",
  RPC
);

console.log("");

const genesisHash =
  await connection.getGenesisHash();

console.log(
  "Genesis hash:",
  genesisHash
);

if (
  genesisHash !== config.genesisHash
) {
  fail(
    `RPC genesis mismatch: ${genesisHash} != ${config.genesisHash}`
  );
}

pass(
  "RPC genesis hash matches Mainnet config"
);

const slot =
  await connection.getSlot("confirmed");

console.log(
  "Current confirmed slot:",
  slot
);

if (
  !Number.isSafeInteger(slot) ||
  slot <= 0
) {
  fail("Invalid Mainnet slot");
}

pass("Mainnet RPC returned live slot");

async function assertExecutable(
  key,
  label
) {
  const info =
    await connection.getAccountInfo(
      key,
      "confirmed"
    );

  if (!info) {
    fail(
      `${label} account does not exist`
    );
  }

  if (!info.executable) {
    fail(
      `${label} is not executable`
    );
  }

  pass(
    `${label} executable: ${key.toBase58()}`
  );

  return info;
}

await assertExecutable(
  PUMPSWAP_PROGRAM_ID,
  "PumpSwap"
);

await assertExecutable(
  PUMP_FEE_PROGRAM_ID,
  "Pump Fee"
);

const wsolInfo =
  await connection.getAccountInfo(
    WSOL_MINT,
    "confirmed"
  );

if (!wsolInfo) {
  fail("WSOL mint missing");
}

if (
  !wsolInfo.owner.equals(
    TOKEN_PROGRAM_ID
  )
) {
  fail(
    `WSOL mint owner mismatch: ${wsolInfo.owner.toBase58()}`
  );
}

pass(
  `WSOL mint verified: ${WSOL_MINT.toBase58()}`
);

const angryMainnetInfo =
  await connection.getAccountInfo(
    ANGRY_PROGRAM_ID,
    "confirmed"
  );

console.log("");

if (!angryMainnetInfo) {
  console.log(
    "ℹ️ ANGRY Program ID is NOT currently deployed on Mainnet:"
  );

  console.log(
    `   ${ANGRY_PROGRAM_ID.toBase58()}`
  );

  console.log(
    "   This is expected before the planned Mainnet deployment."
  );
} else {
  console.log(
    "⚠️ ANGRY Program ID ALREADY EXISTS on Mainnet:"
  );

  console.log(
    `   ${ANGRY_PROGRAM_ID.toBase58()}`
  );

  console.log(
    `   executable=${angryMainnetInfo.executable}`
  );

  console.log(
    `   owner=${angryMainnetInfo.owner.toBase58()}`
  );

  console.log(
    "   Stop and investigate before any deployment."
  );
}

console.log("");
console.log(
  "=== PRODUCTION CONFIG READINESS ==="
);

const productionFields = [
  [
    "projectMint",
    config.tokens?.projectMint,
  ],
  [
    "lpMint",
    config.tokens?.lpMint,
  ],
  [
    "pool",
    config.pumpSwap?.pool,
  ],
  [
    "configPda",
    config.engine?.configPda,
  ],
  [
    "vaultPda",
    config.engine?.vaultPda,
  ],
];

const missing =
  productionFields
    .filter(([, value]) => value === null)
    .map(([name]) => name);

if (missing.length > 0) {
  console.log(
    "🔒 Production execution remains intentionally unavailable."
  );

  console.log(
    `Missing ${missing.length} core production value(s):`
  );

  for (const name of missing) {
    console.log(
      `  - ${name}`
    );
  }
} else {
  console.log(
    "⚠️ Core production addresses are populated."
  );

  console.log(
    "Transactions are STILL disabled by Mainnet safety policy."
  );
}

console.log("");
console.log(
  "=============================================="
);
console.log(
  "✅ MAINNET READ-ONLY PREFLIGHT COMPLETED"
);
console.log(
  "✅ CONFIG SOURCE: mainnet-config.json"
);
console.log(
  "✅ NO TRANSACTION WAS CREATED OR SENT"
);
console.log(
  "=============================================="
);

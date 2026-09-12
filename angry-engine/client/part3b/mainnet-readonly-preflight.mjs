import {
  Connection,
  PublicKey,
} from "@solana/web3.js";

import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";

/*
 * ANGRY MAINNET READ-ONLY PREFLIGHT
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

const DEFAULT_PUBLIC_RPC =
  "https://api.mainnet.solana.com";

const RPC =
  process.env.ANGRY_MAINNET_RPC ||
  DEFAULT_PUBLIC_RPC;

const MAINNET_GENESIS_HASH =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

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

function pass(text) {
  console.log(`✅ ${text}`);
}

function fail(text) {
  throw new Error(text);
}

if (/devnet|testnet/i.test(RPC)) {
  fail(
    `Refusing non-mainnet RPC: ${RPC}`
  );
}

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
console.log("RPC:", RPC);
console.log("");

const genesisHash =
  await connection.getGenesisHash();

console.log(
  "Genesis hash:",
  genesisHash
);

if (
  genesisHash !== MAINNET_GENESIS_HASH
) {
  fail(
    "RPC is not Solana Mainnet. Genesis hash mismatch."
  );
}

pass("RPC genesis hash = Solana Mainnet");

const slot =
  await connection.getSlot("confirmed");

console.log(
  "Current confirmed slot:",
  slot
);

if (!Number.isSafeInteger(slot) || slot <= 0) {
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
    NATIVE_MINT,
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
  `WSOL mint verified: ${NATIVE_MINT.toBase58()}`
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
    "   Do not deploy until ownership/upgrade authority is investigated."
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
  "✅ NO TRANSACTION WAS CREATED OR SENT"
);
console.log(
  "=============================================="
);

import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";

const CONFIG_FILE = "./mainnet-config.json";

const EXPECTED = Object.freeze({
  network: "mainnet-beta",
  genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  angryEngine: "NmWNEKmU9N7YWKB2QeBMUAJC1NxuiYwSo1dX4NrKo6C",
  pumpSwap: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  pumpFee: "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
  wsol: "So11111111111111111111111111111111111111112",
});

const FORBIDDEN_DEVNET_FINGERPRINTS = [
  "https://api.devnet.solana.com",
  "9sNparjr1Up6K9vSX6Ab7WEs6kXPPAfPeYnEFpuMqjmf",
  "GaSKTF4rCdWC8CNFpddrcdD5AFcDXAJXvCFKeAQNpump",
  "DE1D7ZYJBq2mhw8nUCRZ1rreYgEPjYZq4MPdzn5kZAc5",
];

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`✅ ${message}`);
}

function same(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label}: ${String(actual)} != ${expected}`);
  }
  pass(label);
}

function validatePubkey(value, label, allowNull = false) {
  if (value === null && allowNull) return;

  if (typeof value !== "string" || value.length === 0) {
    fail(`${label}: expected non-empty public key string`);
  }

  try {
    new PublicKey(value);
  } catch {
    fail(`${label}: invalid Solana public key`);
  }
}

if (!fs.existsSync(CONFIG_FILE)) {
  fail(`${CONFIG_FILE} not found`);
}

const raw = fs.readFileSync(CONFIG_FILE, "utf8");

for (const bad of FORBIDDEN_DEVNET_FINGERPRINTS) {
  if (raw.includes(bad)) {
    fail(`Devnet fingerprint found in Mainnet config: ${bad}`);
  }
}

pass("No known Devnet fingerprints");

let config;

try {
  config = JSON.parse(raw);
} catch (error) {
  fail(`Invalid JSON: ${error.message}`);
}

same(
  config.network,
  EXPECTED.network,
  "network = mainnet-beta"
);

same(
  config.genesisHash,
  EXPECTED.genesisHash,
  "Mainnet genesis hash"
);

same(
  config.programs?.angryEngine,
  EXPECTED.angryEngine,
  "ANGRY Program ID"
);

same(
  config.programs?.pumpSwap,
  EXPECTED.pumpSwap,
  "PumpSwap Program ID"
);

same(
  config.programs?.pumpFee,
  EXPECTED.pumpFee,
  "Pump Fee Program ID"
);

same(
  config.tokens?.wsol,
  EXPECTED.wsol,
  "WSOL mint"
);

validatePubkey(
  config.programs.angryEngine,
  "ANGRY Program ID"
);

validatePubkey(
  config.programs.pumpSwap,
  "PumpSwap Program ID"
);

validatePubkey(
  config.programs.pumpFee,
  "Pump Fee Program ID"
);

validatePubkey(
  config.tokens.wsol,
  "WSOL mint"
);

const optionalPubkeys = [
  ["tokens.projectMint", config.tokens?.projectMint],
  ["tokens.lpMint", config.tokens?.lpMint],
  ["pumpSwap.pool", config.pumpSwap?.pool],
  [
    "pumpSwap.poolBaseTokenAccount",
    config.pumpSwap?.poolBaseTokenAccount,
  ],
  [
    "pumpSwap.poolQuoteTokenAccount",
    config.pumpSwap?.poolQuoteTokenAccount,
  ],
  ["pumpSwap.globalConfig", config.pumpSwap?.globalConfig],
  [
    "pumpSwap.protocolFeeRecipient",
    config.pumpSwap?.protocolFeeRecipient,
  ],
  ["pumpSwap.feeConfig", config.pumpSwap?.feeConfig],
  ["pumpSwap.coinCreator", config.pumpSwap?.coinCreator],
  [
    "pumpSwap.coinCreatorVaultAuthority",
    config.pumpSwap?.coinCreatorVaultAuthority,
  ],
  ["engine.configPda", config.engine?.configPda],
  ["engine.vaultPda", config.engine?.vaultPda],
  [
    "engine.buybackAuthorityPda",
    config.engine?.buybackAuthorityPda,
  ],
  [
    "engine.liquidityAuthorityPda",
    config.engine?.liquidityAuthorityPda,
  ],
];

for (const [label, value] of optionalPubkeys) {
  validatePubkey(value, label, true);
}

if (
  config.safety?.transactionsEnabled !== false
) {
  fail(
    "transactionsEnabled must remain false during Mainnet planning"
  );
}

if (
  config.safety?.productionSenderCreated !== false
) {
  fail(
    "productionSenderCreated must remain false during Mainnet planning"
  );
}

if (
  config.safety?.mainnetDeploymentConfirmed !== false
) {
  fail(
    "mainnetDeploymentConfirmed must remain false before deployment"
  );
}

pass("Mainnet transaction safety locks remain OFF");

const requiredForExecution = [
  ["projectMint", config.tokens?.projectMint],
  ["lpMint", config.tokens?.lpMint],
  ["pool", config.pumpSwap?.pool],
  [
    "poolBaseTokenAccount",
    config.pumpSwap?.poolBaseTokenAccount,
  ],
  [
    "poolQuoteTokenAccount",
    config.pumpSwap?.poolQuoteTokenAccount,
  ],
  ["globalConfig", config.pumpSwap?.globalConfig],
  [
    "protocolFeeRecipient",
    config.pumpSwap?.protocolFeeRecipient,
  ],
  ["feeConfig", config.pumpSwap?.feeConfig],
  ["coinCreator", config.pumpSwap?.coinCreator],
  [
    "coinCreatorVaultAuthority",
    config.pumpSwap?.coinCreatorVaultAuthority,
  ],
  ["configPda", config.engine?.configPda],
  ["vaultPda", config.engine?.vaultPda],
  [
    "buybackAuthorityPda",
    config.engine?.buybackAuthorityPda,
  ],
  [
    "liquidityAuthorityPda",
    config.engine?.liquidityAuthorityPda,
  ],
];

const missing =
  requiredForExecution
    .filter(([, value]) => value === null)
    .map(([name]) => name);

console.log("");
console.log("=== EXECUTION READINESS ===");

if (missing.length > 0) {
  console.log(
    "🔒 NOT READY FOR MAINNET TRANSACTIONS — expected during planning."
  );
  console.log("Missing production values:");
  for (const name of missing) {
    console.log(`  - ${name}`);
  }
} else {
  console.log(
    "⚠️ All address fields are populated, but transactions are STILL locked."
  );
}

console.log("");
console.log(
  "✅ MAINNET PLANNING CONFIG VALID"
);
console.log(
  "✅ FAIL-CLOSED SAFETY STATE VERIFIED"
);

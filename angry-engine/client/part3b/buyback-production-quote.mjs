import fs from "node:fs";
import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  OnlinePumpAmmSdk,
  buyQuoteInput,
} from "@pump-fun/pump-swap-sdk";

const RPC = "https://api.devnet.solana.com";

const DEFAULT_SLIPPAGE_BPS = 200n; // 2%
const MAX_SLIPPAGE_BPS = 500n;     // 5%
const BPS_DENOMINATOR = 10_000n;

const BUYBACK_BUDGET = 1_000_000n; // 0.001 SOL test budget

const plan = JSON.parse(
  fs.readFileSync("part2-plan.json", "utf8")
);

const pool = new PublicKey(plan.pool);

/*
 * The quote calculation does not spend funds.
 * User is supplied only so OnlinePumpAmmSdk can construct
 * the correct PumpSwap state.
 */
const buybackAuthority =
  new PublicKey(
    "AMsdDuMGzofovajjdbScsxs4A7JbNNdeAmdRDw7MBJfV"
  );

function minimumOut(expectedBase, slippageBps) {
  if (slippageBps < 0n) {
    throw new Error("Slippage cannot be negative");
  }

  if (slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(
      `Slippage ${slippageBps} bps exceeds ANGRY maximum ${MAX_SLIPPAGE_BPS} bps`
    );
  }

  if (expectedBase <= 0n) {
    throw new Error("Expected base output must be > 0");
  }

  const keepBps =
    BPS_DENOMINATOR - slippageBps;

  const result =
    expectedBase * keepBps / BPS_DENOMINATOR;

  if (result <= 0n) {
    throw new Error("Calculated minBaseOut must be > 0");
  }

  return result;
}

const connection =
  new Connection(RPC, "confirmed");

const slotBefore =
  await connection.getSlot("confirmed");

const sdk =
  new OnlinePumpAmmSdk(connection);

const state =
  await sdk.swapSolanaState(
    pool,
    buybackAuthority
  );

/*
 * ANGRY production policy only supports normal pools.
 * These offsets are the same PumpSwap Pool layout already
 * verified in our on-chain hardening tests.
 */
const poolInfo =
  await connection.getAccountInfo(pool, "confirmed");

if (!poolInfo) {
  throw new Error("PumpSwap Pool account missing");
}

if (poolInfo.data.length <= 244) {
  throw new Error("PumpSwap Pool data too short");
}

const isMayhemMode =
  poolInfo.data[243] !== 0;

const isCashbackCoin =
  poolInfo.data[244] !== 0;

if (isMayhemMode || isCashbackCoin) {
  throw new Error(
    "Production quote rejected: unsupported Mayhem/Cashback Pool"
  );
}

const quote =
  buyQuoteInput({
    quote:
      new BN(BUYBACK_BUDGET.toString()),

    /*
     * Use the current Pool state as the expected output.
     * ANGRY applies its own output floor below.
     */
    slippage: 0,

    baseReserve:
      state.poolBaseAmount,

    quoteReserve:
      state.poolQuoteAmount,

    virtualQuoteReserves:
      state.pool.virtualQuoteReserves ?? new BN(0),

    globalConfig:
      state.globalConfig,

    baseMintAccount:
      state.baseMintAccount,

    baseMint:
      state.pool.baseMint,

    coinCreator:
      state.pool.coinCreator,

    creator:
      state.pool.creator,

    feeConfig:
      state.feeConfig,
  });

const expectedBase =
  BigInt(quote.base.toString());

const minBaseOut =
  minimumOut(
    expectedBase,
    DEFAULT_SLIPPAGE_BPS
  );

const slotAfter =
  await connection.getSlot("confirmed");

console.log(
  "\n=== ANGRY PRODUCTION BUYBACK QUOTE ==="
);

console.log(
  "Pool                 :",
  pool.toBase58()
);

console.log(
  "Pool mode            : normal"
);

console.log(
  "Buyback budget       :",
  BUYBACK_BUDGET.toString(),
  "lamports"
);

console.log(
  "Expected base        :",
  expectedBase.toString()
);

console.log(
  "Default slippage     :",
  `${DEFAULT_SLIPPAGE_BPS} bps (2%)`
);

console.log(
  "Maximum policy       :",
  `${MAX_SLIPPAGE_BPS} bps (5%)`
);

console.log(
  "Production minBaseOut:",
  minBaseOut.toString()
);

console.log(
  "Quote slot range     :",
  `${slotBefore} -> ${slotAfter}`
);

console.log(
  "\nPOLICY:"
);

console.log(
  "• simulate with this minBaseOut before sending"
);

console.log(
  "• if simulation fails, fetch a NEW quote"
);

console.log(
  "• never automatically increase slippage"
);

console.log(
  "• minBaseOut=1 is TEST-ONLY"
);

console.log(
  "\nREAD ONLY — NO TRANSACTION SENT"
);

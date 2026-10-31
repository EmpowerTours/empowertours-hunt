// ---------------------------------------------------------------------------
// MON -> AUSD through Uniswap v4's MON/AUSD pool, called directly.
//
// Why this exists: AUSD for Perpl came from Kuru's aggregator until Kuru's
// relaunch removed it (no AUSD market on the new exchange, 2026-10-31). The
// desk we deployed fills the gap but pays only from the AUSD we seed it with
// and refuses one wallet more than its per-address cap — it reverted
// "address cap" on an 843 MON swap. This pool needs neither.
//
// Every address here is from Uniswap's own deployment list for Monad 143
// (Uniswap/docs content/protocols/v4/deployments.mdx), and the PoolManager in
// it matches the one a real swap's logs named in September.
//
// THE ENCODING, and how it was proven rather than assumed. Universal Router
// `execute(commands, inputs, deadline)` with one command, V4_SWAP (0x10), whose
// input is abi.encode(actions, params) with three actions:
//
//   SWAP_EXACT_IN_SINGLE (0x06)  the trade, with its amountOutMinimum floor
//   SETTLE_ALL           (0x0c)  pay native MON from msg.value, capped at amountIn
//   TAKE_ALL             (0x0f)  send the AUSD to the caller, at least the floor
//
// Constants from Uniswap/universal-router Commands.sol and v4-periphery
// Actions.sol. Uniswap's `main` adds a `minHopPriceX36` field to
// ExactInputSingleParams that the routers deployed on Monad predate; the
// layout below is the one they take. Simulated on mainnet state with
// eth_simulateV1, 2026-10-31, against router 2.1.1:
//
//   amountOutMinimum = output       -> succeeds, AUSD arrives
//   amountOutMinimum = output + 1   -> REVERTS   (the floor is enforced)
//   SETTLE_ALL cap   = amountIn - 1 -> REVERTS   (it cannot spend more)
//
// Native MON in means no ERC-20 approval and no Permit2: the router is paid
// with the transaction's own value.
// ---------------------------------------------------------------------------

import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  type Abi,
  type Hex,
  type LocalAccount,
} from "viem";
import { publicClient, walletClientFor } from "./swap";
import { AUSD } from "./kuru";

export const V4_POOL_MANAGER =
  "0x188d586ddcf52439676ca21a244753fa19f9ea8e" as const;
export const V4_QUOTER = "0xa222dd357a9076d1091ed6aa2e16c9742dd26891" as const;
/** Universal Router 2.1.1 on Monad. */
export const UNIVERSAL_ROUTER =
  "0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7" as const;

const NATIVE = "0x0000000000000000000000000000000000000000" as const;

/** MON/AUSD, 0.05% fee, tick spacing 1, no hooks. Native MON sorts first. */
export const MON_AUSD_POOL_KEY = {
  currency0: NATIVE,
  currency1: AUSD,
  fee: 500,
  tickSpacing: 1,
  hooks: NATIVE,
} as const;

/** keccak(abi.encode(MON_AUSD_POOL_KEY)) — the pool a September swap filled in. */
export const MON_AUSD_POOL_ID =
  "0xadaf30776f551bccdfb307c3fd8cdec198ca9a852434c8022ee32d1ccedd8219" as const;

const POOL_KEY_TYPE = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

export function poolIdOf(key: typeof MON_AUSD_POOL_KEY): Hex {
  return keccak256(encodeAbiParameters([POOL_KEY_TYPE], [key]));
}

const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    // Not view: the quoter runs the swap and reverts with the result. eth_call
    // through simulateContract reads it without changing anything.
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "poolKey", ...POOL_KEY_TYPE },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const satisfies Abi;

export const UNIVERSAL_ROUTER_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const V4_SWAP = "0x10" as const;
/** SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL. */
const ACTIONS = "0x060c0f" as const;

const EXACT_IN_SINGLE_TYPE = [
  {
    type: "tuple",
    components: [
      { name: "poolKey", ...POOL_KEY_TYPE },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;

const CURRENCY_AMOUNT = [{ type: "address" }, { type: "uint256" }] as const;

/** Floor of `quote` less `slippageBps`, rounded down. */
export function v4MinOut(quote: bigint, slippageBps: number): bigint {
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps >= 10_000
  ) {
    throw new Error(`v4: slippage ${slippageBps} bps is not a sane value`);
  }
  return (quote * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * The transaction for selling `monWei` MON into the pool for at least
 * `minAusdOut`. Pure, so the bytes about to be signed are testable.
 */
export function buildMonToAusdSwap(args: {
  monWei: bigint;
  minAusdOut: bigint;
  deadlineSec: bigint;
}): { to: typeof UNIVERSAL_ROUTER; data: Hex; value: bigint } {
  const { monWei, minAusdOut } = args;
  if (monWei <= 0n) throw new Error("v4: nothing to swap — the amount is zero");
  if (minAusdOut <= 0n) {
    // A zero floor would accept any price at all. Never sign that.
    throw new Error("v4: refusing a swap with no minimum output");
  }
  const params = [
    encodeAbiParameters(EXACT_IN_SINGLE_TYPE, [
      {
        poolKey: MON_AUSD_POOL_KEY,
        zeroForOne: true, // currency0 (MON) in, currency1 (AUSD) out
        amountIn: monWei,
        amountOutMinimum: minAusdOut,
        hookData: "0x",
      },
    ]),
    // Pay at most exactly what is being sold.
    encodeAbiParameters(CURRENCY_AMOUNT, [NATIVE, monWei]),
    // Take the AUSD, refusing less than the floor a second time.
    encodeAbiParameters(CURRENCY_AMOUNT, [AUSD, minAusdOut]),
  ];
  const input = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [ACTIONS, params],
  );
  return {
    to: UNIVERSAL_ROUTER,
    data: encodeFunctionData({
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: "execute",
      args: [V4_SWAP, [input], args.deadlineSec],
    }),
    value: monWei,
  };
}

/** AUSD (6dp) that `monWei` buys from the pool right now. Read-only. */
export async function quoteMonToAusdV4(monWei: bigint): Promise<bigint> {
  const { result } = await publicClient().simulateContract({
    address: V4_QUOTER,
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: MON_AUSD_POOL_KEY,
        zeroForOne: true,
        exactAmount: monWei,
        hookData: "0x",
      },
    ],
  });
  return result[0];
}

/**
 * Gas limit for the swap: the live estimate padded 1.5x.
 *
 * Measured 2026-10-31 with eth_estimateGas: 141,333 for 10 MON, 202,929 for
 * 843 MON — more ticks crossed, more gas. Monad charges the whole limit and
 * executes against state a few blocks on, so the raw estimate is not enough.
 */
export function v4GasLimit(estimate: bigint): bigint {
  if (estimate <= 0n) throw new Error("v4: no gas estimate for the swap");
  const padded = (estimate * 3n) / 2n;
  return padded > 600_000n ? 600_000n : padded;
}

/** A swap that was mined and reverted. Carries the hash so it can be looked up. */
export class V4Reverted extends Error {
  constructor(readonly hash: Hex) {
    super(`v4: transaction ${hash} reverted`);
    this.name = "V4Reverted";
  }
}

const AUSD_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "o", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * Sell MON for AUSD in the v4 pool, signed by the hunter's own wallet.
 *
 * Quote, floor, simulate, send with a padded limit, wait. `ausdOut` is the
 * wallet's AUSD balance change, not the quote. `onSent` hears the hash before
 * the receipt, so a revert still leaves something to look up.
 */
export async function swapMonToAusdViaV4(args: {
  account: LocalAccount;
  monWei: bigint;
  slippageBps?: number;
  onSent?: (hash: Hex) => void;
}): Promise<{ hash: Hex; ausdOut: bigint }> {
  const { account, monWei } = args;
  const pc = publicClient();
  const quote = await quoteMonToAusdV4(monWei);
  const tx = buildMonToAusdSwap({
    monWei,
    minAusdOut: v4MinOut(quote, args.slippageBps ?? 100),
    deadlineSec: BigInt(Math.floor(Date.now() / 1000) + 300),
  });
  // Simulated first, always: Monad charges the full gas limit on a revert.
  await pc.call({ account: account.address, ...tx });
  const gas = v4GasLimit(
    await pc.estimateGas({ account: account.address, ...tx }),
  );
  const balance = () =>
    pc.readContract({
      address: AUSD,
      abi: AUSD_BALANCE_ABI,
      functionName: "balanceOf",
      args: [account.address],
    }) as Promise<bigint>;
  const before = await balance();
  const hash = await walletClientFor(account).sendTransaction({ ...tx, gas });
  args.onSent?.(hash);
  const receipt = await pc.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new V4Reverted(hash);
  return { hash, ausdOut: (await balance()) - before };
}

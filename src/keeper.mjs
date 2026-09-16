import { BrowserProvider, Contract, Wallet, formatEther, parseEther } from "ethers";

const MONAD_CHAIN_ID = 143n;
const CONTRACT_ADDRESS = "0xC0A0808cbAF507b80df92b22feD8D3810eAB45d5";
const FEED_PRICE = parseEther("1");
const DEATH_AFTER_SECONDS = 48n * 60n * 60n;

const ABI = [
  "function ownerOf(uint256 id) view returns (address)",
  "function feed(uint256 id) payable",
  "function state(uint256 id) view returns (tuple(uint256 id,address owner,string name,bool started,bool alive,bool asleep,bool poop,bool crowned,bool crownEligible,uint8 food,uint8 clean,uint8 fun,uint8 energy,uint8 mood,uint16 streak,uint16 score,uint256 day,uint40 mintedAt,uint40 startsAt,uint40 bornAt,uint40 deadAt,uint40 poopAt,uint40 wakesAt,uint40 diesAt,uint24 feeds,uint24 washes,uint24 plays,uint24 naps,uint24 cleanups,uint24 pets,uint16 names,uint16 deaths,uint16 revives,uint128 monPaid))"
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim() || String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function formatDuration(seconds) {
  const safe = seconds > 0n ? seconds : 0n;
  const hours = safe / 3600n;
  const minutes = (safe % 3600n) / 60n;
  return `${hours}h ${minutes}m`;
}

function createProvider(rpcUrl) {
  let requestId = 0;
  const transport = {
    async request({ method, params = [] }) {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) throw new Error(`Monad RPC returned HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.error) {
        const error = new Error(payload.error.message || "Monad RPC error");
        error.code = payload.error.code;
        error.data = payload.error.data;
        throw error;
      }
      return payload.result;
    }
  };
  return new BrowserProvider(transport, { name: "monad", chainId: Number(MONAD_CHAIN_ID) });
}

async function main() {
  const rpcUrl = process.env.RPC_URL?.trim() || "https://rpc1.monad.xyz";
  const catId = BigInt(parseInteger("CAT_ID", 69869, 1, Number.MAX_SAFE_INTEGER));
  const thresholdHours = parseInteger("FEED_THRESHOLD_HOURS", 4, 1, 24);
  const thresholdSeconds = BigInt(thresholdHours) * 3600n;
  const dryRun = process.env.DRY_RUN?.toLowerCase() === "true";
  const forceFeed = process.env.FORCE_FEED?.toLowerCase() === "true";

  const privateKey = required("EMOGOTCHI_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("EMOGOTCHI_PRIVATE_KEY is not a valid 32-byte private key");
  }

  const provider = createProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== MONAD_CHAIN_ID) {
    throw new Error(`Wrong network: expected Monad chain 143, received ${network.chainId}`);
  }

  const wallet = new Wallet(privateKey, provider);
  const contract = new Contract(CONTRACT_ADDRESS, ABI, wallet);
  const [block, cat, balance] = await Promise.all([
    provider.getBlock("latest"),
    contract.state(catId),
    provider.getBalance(wallet.address)
  ]);

  if (!block) throw new Error("Could not read the latest Monad block");
  if (cat.owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `Safety stop: cat #${catId} is owned by ${cat.owner}, not automation wallet ${wallet.address}`
    );
  }
  if (!cat.alive) {
    throw new Error(`Safety stop: cat #${catId} is dead. This bot will never auto-revive for 1,000 MON.`);
  }

  const now = BigInt(block.timestamp);
  const deadline = cat.started ? BigInt(cat.diesAt) : BigInt(cat.startsAt) + DEATH_AFTER_SECONDS;
  const remaining = deadline - now;

  console.log(`Cat: #${catId}${cat.name ? ` (${cat.name})` : ""}`);
  console.log(`Owner: ${wallet.address}`);
  console.log(`Balance: ${formatEther(balance)} MON`);
  console.log(`Time until starvation: ${formatDuration(remaining)}`);
  console.log(`Feed threshold: ${thresholdHours}h`);

  if (forceFeed) {
    console.log("Manual force-feed requested. The normal threshold is bypassed for this run only.");
  }

  if (!forceFeed && remaining > thresholdSeconds) {
    console.log("No feed needed. Exiting without spending MON.");
    return;
  }

  if (remaining <= 0n) {
    throw new Error("Safety stop: the on-chain deadline has already passed.");
  }

  if (dryRun) {
    console.log("DRY_RUN=true: a 1 MON feed would be sent now, but no transaction was submitted.");
    return;
  }

  // Re-read immediately before signing to avoid unnecessary duplicate feeds.
  const latestBlock = await provider.getBlock("latest");
  const latestCat = await contract.state(catId);
  if (!latestBlock || !latestCat.alive) throw new Error("Safety stop during final state check.");
  const latestDeadline = latestCat.started
    ? BigInt(latestCat.diesAt)
    : BigInt(latestCat.startsAt) + DEATH_AFTER_SECONDS;
  const latestRemaining = latestDeadline - BigInt(latestBlock.timestamp);
  if (latestDeadline > deadline) {
    console.log("Another feed already extended the deadline. Exiting without spending MON.");
    return;
  }
  if (!forceFeed && latestRemaining > thresholdSeconds) {
    console.log("The cat no longer needs a feed. Exiting without spending MON.");
    return;
  }

  const gasEstimate = await contract.feed.estimateGas(catId, { value: FEED_PRICE });
  const gasLimit = (gasEstimate * 120n) / 100n;
  const feeData = await provider.getFeeData();
  const feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const estimatedMaximumCost = FEED_PRICE + gasLimit * feePerGas;
  if (balance < estimatedMaximumCost) {
    throw new Error(
      `Insufficient balance: have ${formatEther(balance)} MON, need about ${formatEther(estimatedMaximumCost)} MON`
    );
  }

  const transaction = await contract.feed(catId, { value: FEED_PRICE, gasLimit });
  console.log(`Submitted: https://monadscan.com/tx/${transaction.hash}`);
  const receipt = await transaction.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error("Feed transaction did not succeed");

  const updated = await contract.state(catId);
  if (!updated.alive || BigInt(updated.diesAt) <= latestDeadline) {
    throw new Error("Transaction confirmed, but the starvation deadline did not advance as expected");
  }

  console.log(`Feed confirmed in block ${receipt.blockNumber}.`);
  console.log(`New deadline: ${new Date(Number(updated.diesAt) * 1000).toISOString()}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

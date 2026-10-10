import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BrowserProvider, Contract, Wallet, formatEther, parseEther } from "ethers";

const MONAD_CHAIN_ID = 143n;
const CONTRACT_ADDRESS = "0xC0A0808cbAF507b80df92b22feD8D3810eAB45d5";
const FEED_PRICE = parseEther("1");
const DEATH_AFTER_SECONDS = 48n * 60n * 60n;
const DEFAULT_RPC_URLS = Object.freeze([
  "https://rpc.monad.xyz",
  "https://rpc1.monad.xyz",
  "https://rpc3.monad.xyz",
  "https://rpc-mainnet.monadinfra.com"
]);
const RPC_REQUEST_INTERVAL_MS = 125;
const RPC_ATTEMPT_TIMEOUT_MS = 12_000;
const RPC_RETRY_ROUNDS = 2;

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

function formatMon(value) {
  const [whole, fraction = ""] = formatEther(value).split(".");
  const shortFraction = fraction.slice(0, 4).replace(/0+$/, "");
  return shortFraction ? `${whole}.${shortFraction}` : whole;
}

function formatDeadline(timestamp) {
  return new Date(Number(timestamp) * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(".000Z", " UTC");
}

function catLabel(cat, catId) {
  const name = cat.name?.trim() || "Cat";
  return `${name} #${catId}`;
}

function catStats(cat) {
  const activity = cat.asleep ? "💤 Sleeping" : cat.poop ? "💩 Needs cleanup" : "😸 Chilling";
  return [
    `${activity}${cat.crowned ? " • 👑 Crowned" : ""}`,
    `🍗 Food ${cat.food}  •  🧼 Clean ${cat.clean}`,
    `🎾 Fun ${cat.fun}  •  ⚡ Energy ${cat.energy}`,
    `😺 Mood ${cat.mood}  •  🔥 Streak ${cat.streak}`,
    `🏆 Score ${cat.score}  •  🍽️ Lifetime feeds ${cat.feeds}`
  ].join("\n");
}

function workflowRunUrl() {
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  const runId = process.env.GITHUB_RUN_ID?.trim();
  return repository && runId ? `https://github.com/${repository}/actions/runs/${runId}` : null;
}

function setGithubOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT?.trim();
  if (!outputFile) return;
  const singleLine = String(value).replace(/[\r\n]+/g, " ");
  appendFileSync(outputFile, `${name}=${singleLine}\n`, "utf8");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function rpcUrlsFromEnvironment() {
  const configured = [
    ...(process.env.RPC_URLS?.split(",") || []),
    process.env.RPC_URL || ""
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([...configured, ...DEFAULT_RPC_URLS])];
}

class RetryableRpcError extends Error {}

async function notifyTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token && !chatId) return false;
  if (!token || !chatId) {
    throw new Error("Telegram setup is incomplete: both bot token and chat ID are required");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true
    }),
    signal: AbortSignal.timeout(15_000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    throw new Error(`Telegram rejected the alert with HTTP ${response.status}`);
  }
  console.log("Telegram alert sent.");
  return true;
}

export function createRpcTransport(
  rpcUrls,
  {
    fetchImpl = fetch,
    requestIntervalMs = RPC_REQUEST_INTERVAL_MS,
    requestTimeoutMs = RPC_ATTEMPT_TIMEOUT_MS,
    retryRounds = RPC_RETRY_ROUNDS,
    sleepImpl = sleep
  } = {}
) {
  if (!Array.isArray(rpcUrls) || rpcUrls.length === 0) {
    throw new Error("At least one Monad RPC endpoint is required");
  }

  let requestId = 0;
  let nextRequestAt = 0;
  let requestQueue = Promise.resolve();

  function enqueue(task) {
    const run = requestQueue.then(async () => {
      const wait = Math.max(0, nextRequestAt - Date.now());
      if (wait > 0) await sleepImpl(wait);
      nextRequestAt = Date.now() + requestIntervalMs;
      return task();
    });
    requestQueue = run.catch(() => undefined);
    return run;
  }

  async function callEndpoint(rpcUrl, method, params) {
    let response;
    try {
      response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
    } catch (error) {
      throw new RetryableRpcError(error instanceof Error ? error.message : "network request failed");
    }

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableRpcError(error.message);
      }
      throw error;
    }

    const payload = await response.json().catch(() => {
      throw new RetryableRpcError("invalid JSON response");
    });
    if (payload.error) {
      const message = payload.error.message || "Monad RPC error";
      if (/rate|limit|timeout|temporar|unavailable|busy|overload/i.test(message)) {
        throw new RetryableRpcError(message);
      }
      const error = new Error(message);
      error.code = payload.error.code;
      error.data = payload.error.data;
      throw error;
    }
    return payload.result;
  }

  return {
    async request({ method, params = [] }) {
      const totalAttempts = rpcUrls.length * retryRounds;
      let attempt = 0;
      let lastError;

      for (let round = 0; round < retryRounds; round += 1) {
        for (let endpointIndex = 0; endpointIndex < rpcUrls.length; endpointIndex += 1) {
          attempt += 1;
          try {
            return await enqueue(() => callEndpoint(rpcUrls[endpointIndex], method, params));
          } catch (error) {
            if (!(error instanceof RetryableRpcError)) throw error;
            lastError = error;
            console.warn(
              `RPC attempt ${attempt}/${totalAttempts} failed on endpoint ${endpointIndex + 1}: ${error.message}`
            );
          }
        }
        if (round + 1 < retryRounds) await sleepImpl(500 * 2 ** round);
      }

      throw new Error(
        `All ${rpcUrls.length} Monad RPC endpoints failed after ${totalAttempts} attempts. ` +
          `Last error: ${lastError?.message || "unknown RPC error"}`
      );
    }
  };
}

function createProvider(rpcUrls) {
  return new BrowserProvider(createRpcTransport(rpcUrls), {
    name: "monad",
    chainId: Number(MONAD_CHAIN_ID)
  });
}

export async function main() {
  const rpcUrls = rpcUrlsFromEnvironment();
  const catId = BigInt(parseInteger("CAT_ID", 25287, 1, Number.MAX_SAFE_INTEGER));
  const thresholdHours = parseInteger("FEED_THRESHOLD_HOURS", 24, 1, 24);
  const thresholdSeconds = BigInt(thresholdHours) * 3600n;
  const warningHours = parseInteger(
    "WARNING_THRESHOLD_HOURS",
    Math.max(26, thresholdHours),
    thresholdHours,
    47
  );
  const warningSeconds = BigInt(warningHours) * 3600n;
  const dryRun = process.env.DRY_RUN?.toLowerCase() === "true";
  const forceFeed = process.env.FORCE_FEED?.toLowerCase() === "true";
  const dailyStatus = process.env.DAILY_STATUS?.toLowerCase() === "true";

  const privateKey = required("EMOGOTCHI_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("EMOGOTCHI_PRIVATE_KEY is not a valid 32-byte private key");
  }

  console.log(`RPC endpoints configured: ${rpcUrls.length}`);
  const provider = createProvider(rpcUrls);
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
    const message = `Cat #${catId} is dead. The keeper is idle and will never auto-revive for 1,000 MON.`;
    console.log(message);
    setGithubOutput("verification_state", "failure");
    setGithubOutput("summary", `Cat ${catId} is dead; dry run spent 0 MON`);
    if (dailyStatus || dryRun || forceFeed) {
      await notifyTelegram(
        [
          "🛑 Emogotchi Keeper Is Paused",
          "",
          `🐱 ${catLabel(cat, catId)} is still dead.`,
          "The keeper will not spend the 1,000 MON revival fee.",
          `💰 Keeper wallet: ${formatMon(balance)} MON`,
          "If you revive this cat manually, the automatic checks will detect it and resume."
        ].join("\n")
      );
    }
    return;
  }

  const now = BigInt(block.timestamp);
  const deadline = cat.started ? BigInt(cat.diesAt) : BigInt(cat.startsAt) + DEATH_AFTER_SECONDS;
  const remaining = deadline - now;

  console.log(`Cat: #${catId}${cat.name ? ` (${cat.name})` : ""}`);
  console.log(`Owner: ${wallet.address}`);
  console.log(`Balance: ${formatEther(balance)} MON`);
  console.log(`Time until starvation: ${formatDuration(remaining)}`);
  console.log(`Feed threshold: ${thresholdHours}h`);
  console.log(`Warning threshold: ${warningHours}h`);

  if (forceFeed) {
    console.log("Manual force-feed requested. The normal threshold is bypassed for this run only.");
  }

  if (remaining <= 0n) {
    throw new Error("Safety stop: the on-chain deadline has already passed.");
  }

  if (dryRun) {
    const wouldFeed = forceFeed || remaining <= thresholdSeconds;
    console.log(
      wouldFeed
        ? "DRY_RUN=true: a 1 MON feed would be sent now, but no transaction was submitted."
        : "DRY_RUN=true: all checks passed and no feed is currently needed."
    );
    await notifyTelegram(
      [
        "🧪 Emogotchi Keeper Test Passed!",
        "",
        `🐱 ${catLabel(cat, catId)} is alive and connected.`,
        `⏳ Food deadline in ${formatDuration(remaining)}`,
        catStats(cat),
        `💰 Keeper wallet: ${formatMon(balance)} MON`,
        `🤖 Decision: ${wouldFeed ? "Would feed 1 MON now" : "No feed needed yet"}`,
        "💸 Test mode spent 0 MON."
      ].join("\n")
    );
    setGithubOutput("verification_state", "success");
    setGithubOutput(
      "summary",
      `Cat ${catId} alive; ${formatDuration(remaining)} left; dry run spent 0 MON`
    );
    return;
  }

  if (!forceFeed && remaining > thresholdSeconds) {
    console.log("No feed needed. Exiting without spending MON.");
    if (remaining <= warningSeconds) {
      await notifyTelegram(
        [
          "⚠️ Feeding Window Is Getting Close",
          "",
          `🐱 ${catLabel(cat, catId)} has ${formatDuration(remaining)} left.`,
          `🕒 Deadline: ${formatDeadline(deadline)}`,
          `🍗 Automatic feeding starts at ${thresholdHours}h remaining.`,
          `💰 Keeper wallet: ${formatMon(balance)} MON`,
          "If no feed confirmation arrives before the deadline, run the workflow manually."
        ].join("\n")
      );
    } else if (dailyStatus) {
      await notifyTelegram(
        [
          "🐾 Daily Emogotchi Report",
          "",
          `🐱 ${catLabel(cat, catId)} is alive and cruising.`,
          `⏳ Food deadline in ${formatDuration(remaining)}`,
          catStats(cat),
          `💰 Keeper wallet: ${formatMon(balance)} MON`,
          `🤖 Auto-feed begins at ${thresholdHours}h remaining.`
        ].join("\n")
      );
    }
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

  const [updated, updatedBalance] = await Promise.all([
    contract.state(catId),
    provider.getBalance(wallet.address)
  ]);
  if (!updated.alive || BigInt(updated.diesAt) <= latestDeadline) {
    throw new Error("Transaction confirmed, but the starvation deadline did not advance as expected");
  }

  console.log(`Feed confirmed in block ${receipt.blockNumber}.`);
  console.log(`New deadline: ${new Date(Number(updated.diesAt) * 1000).toISOString()}`);
  await notifyTelegram(
    [
      `🍗 NOM NOM — ${catLabel(updated, catId)} was fed!`,
      "",
      `🐱 ${catLabel(updated, catId)} received 1 MON of food.`,
      `⏳ Time left before feeding: ${formatDuration(latestRemaining)}`,
      `🛟 New deadline: ${formatDeadline(updated.diesAt)}`,
      `⏰ Next planned feed: ${formatDeadline(BigInt(updated.diesAt) - thresholdSeconds)}`,
      catStats(updated),
      `💰 Wallet remaining: ${formatMon(updatedBalance)} MON`,
      `🔗 https://monadscan.com/tx/${transaction.hash}`
    ].join("\n")
  );
}

async function handleFatalError(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  const runUrl = workflowRunUrl();
  try {
    await notifyTelegram(
      [
        "🚨 Emogotchi Keeper Alert",
        "",
        "🛑 The keeper stopped safely and needs a human look.",
        `Reason: ${message.slice(0, 800)}`,
        `🐱 Cat #${process.env.CAT_ID?.trim() || "25287"}`,
        `🕒 ${new Date().toISOString()}`,
        runUrl ? `🔧 Logs: ${runUrl}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    );
  } catch (telegramError) {
    console.error(
      `Telegram error alert also failed: ${telegramError instanceof Error ? telegramError.message : telegramError}`
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(handleFatalError);
}

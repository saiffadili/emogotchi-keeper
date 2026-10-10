import assert from "node:assert/strict";
import test from "node:test";

import { createRpcTransport } from "../src/keeper.mjs";

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    }
  };
}

test("fails over to the next endpoint after HTTP 429", async () => {
  const calls = [];
  const transport = createRpcTransport(["https://first.invalid", "https://second.invalid"], {
    fetchImpl: async (url) => {
      calls.push(url);
      return url.includes("first")
        ? response(429, {})
        : response(200, { jsonrpc: "2.0", id: 2, result: "0x8f" });
    },
    requestIntervalMs: 0,
    retryRounds: 1,
    sleepImpl: async () => {}
  });

  assert.equal(await transport.request({ method: "eth_chainId" }), "0x8f");
  assert.deepEqual(calls, ["https://first.invalid", "https://second.invalid"]);
});

test("retries temporary JSON-RPC errors on another endpoint", async () => {
  let calls = 0;
  const transport = createRpcTransport(["https://first.invalid", "https://second.invalid"], {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? response(200, { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limit" } })
        : response(200, { jsonrpc: "2.0", id: 2, result: "0x123" });
    },
    requestIntervalMs: 0,
    retryRounds: 1,
    sleepImpl: async () => {}
  });

  assert.equal(await transport.request({ method: "eth_blockNumber" }), "0x123");
  assert.equal(calls, 2);
});

test("does not retry contract execution errors", async () => {
  let calls = 0;
  const transport = createRpcTransport(["https://first.invalid", "https://second.invalid"], {
    fetchImpl: async () => {
      calls += 1;
      return response(200, {
        jsonrpc: "2.0",
        id: 1,
        error: { code: 3, message: "execution reverted" }
      });
    },
    requestIntervalMs: 0,
    retryRounds: 2,
    sleepImpl: async () => {}
  });

  await assert.rejects(
    transport.request({ method: "eth_call", params: [] }),
    /execution reverted/
  );
  assert.equal(calls, 1);
});

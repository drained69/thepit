import test from "node:test";
import assert from "node:assert/strict";
import { RNearClient } from "@rhea-finance/rnear-sdk";

test("rNEAR SDK builds registration and stake actions for the reserve owner", async () => {
  const client = new RNearClient({ network: "testnet" });
  client.rpc.viewFunction = async (_contract, method) => {
    assert.equal(method, "storage_balance_of");
    return null;
  };
  const tx = await client.buildStakeTransaction({ accountId: "coin.testnet", nearAmount: "1.5" });
  assert.equal(tx.receiverId, "lst.ref-dev.testnet");
  assert.deepEqual(tx.actions.map((a) => a.params.methodName), ["storage_deposit", "deposit_and_stake"]);
  assert.equal(tx.actions[1].params.deposit, "1500000000000000000000000");
});

test("rNEAR SDK converts shares to NEAR for delayed unstaking", async () => {
  const client = new RNearClient({ network: "testnet" });
  client.getSummary = async () => ({ ftPrice: { raw: "1200000000000000000000000", amount: "1.2" } });
  const tx = await client.buildUnstakeTransaction({ accountId: "coin.testnet", rNearAmount: "2" });
  assert.equal(tx.actions[0].params.methodName, "unstake");
  assert.equal(tx.actions[0].params.args.amount, "2400000000000000000000000");
});

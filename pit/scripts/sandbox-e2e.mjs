// Local-node rehearsal: after `deploy.mjs --launchpad --lock` with FIRST_COIN=doge on a sandbox,
// run `node pit/scripts/sandbox-e2e.mjs <test.near secret key>`. Sandbox only.
// Exercises every private callback on real receipts: stake, payout, harvest.
import { connect, KeyPair, keyStores, utils } from "near-api-js";
import BN from "bn.js";

const [secret] = process.argv.slice(2);
const COIN = "doge.pit.test.near";
const ks = new keyStores.InMemoryKeyStore();
await ks.setKey("sandbox", "test.near", KeyPair.fromString(secret));
const near = await connect({ networkId: "sandbox", nodeUrl: "http://localhost:3030", keyStore: ks });
const me = await near.account("test.near");
const TGAS = (n) => new BN(n).mul(new BN(10).pow(new BN(12)));
const NEAR = (n) => new BN(utils.format.parseNearAmount(String(n)));
const view = (m, a = {}) => me.viewFunction({ contractId: COIN, methodName: m, args: a });
const call = (m, a, gas, dep) => me.functionCall({ contractId: COIN, methodName: m, args: a, gas: TGAS(gas), attachedDeposit: dep });
const failures = (o) => o.receipts_outcome.filter((r) => r.outcome.status.Failure).map((r) => JSON.stringify(r.outcome.status.Failure).slice(0, 160));
const n = (s) => Number(BigInt(s) / 10n ** 21n) / 1000;
const show = (label, s) => console.log(`${label}: principal ${n(s.principal)} · liquid ${n(s.liquid)} · staked ${n(s.staked)} · surplus ${n(s.surplus)} · queue ${s.queue_len} · harvested ${n(s.total_harvested)}`);

let o = await call("buy", { min_tokens_out: "0" }, 50, NEAR(100));
console.log("buy 100 NEAR:", failures(o).length ? failures(o) : "ok");
show("after buy", await view("brain_stats"));

o = await call("rebalance", { pool_index: 0 }, 250, new BN(0));
console.log("rebalance (stake via on_pool_state → on_staked):", failures(o).length ? failures(o) : "ok");
let s = await view("brain_stats");
show("after stake", s);
if (BigInt(s.staked) === 0n || s.pool_op_in_flight) throw new Error("stake callback didn't book the stake / release the lock");

const bal = BigInt(await view("ft_balance_of", { account_id: "test.near" }));
o = await call("sell", { amount: (bal / 10n).toString(), min_near_out: "0" }, 100, NEAR(0.004));
console.log("sell 10% (on_payout):", failures(o).length ? failures(o) : "ok");
s = await view("brain_stats");
show("after sell", s);
if (s.queue_len !== 0) throw new Error("payout callback didn't settle the ticket");

// Unstake → wait out the pool's unbonding → withdraw, until surplus sits liquid.
for (let i = 0; i < 4; i++) {
  o = await call("rebalance", { pool_index: 0 }, 250, new BN(0));
  const result = Buffer.from(o.status.SuccessValue ?? "", "base64").toString();
  show(`rebalance ${i + 1} (${result || "promise"})`, await view("brain_stats"));
  if (BigInt((await view("brain_stats")).liquid) > BigInt((await view("brain_stats")).target_liquid) - 10n ** 21n) break;
  await new Promise((r) => setTimeout(r, 65_000));
}
o = await call("harvest", {}, 100, new BN(0));
console.log("harvest (on_harvest):", failures(o).length ? failures(o) : "ok");
s = await view("brain_stats");
show("after harvest", s);
if (BigInt(s.total_harvested) === 0n || (await view("get_harvest_claim", { creator: false }))) throw new Error("harvest callback didn't confirm");
console.log("ALL CALLBACKS OK");

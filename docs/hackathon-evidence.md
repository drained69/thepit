# The Pit on NEAR testnet

The Pit puts a coin’s curve reserve behind its own AI. Buying adds reserve, the keeper stakes it, and confirmed fees and rewards fund model calls. Holders can lock tokens to propose memories that enter the model’s prompt after adoption.

[Wallet-free market](https://www.trythepit.xyz/#/coin/pit) · [Proof of Thought](https://www.trythepit.xyz/#/coin/pit/mind) · [Demo post](https://x.com/drained99/status/2120364446161768601)

## Follow the transactions

| What happened | Testnet evidence | Implementation |
|---|---|---|
| The factory published one global contract. $PIT runs that shared code by hash. The factory has zero access keys. | [Publication](https://testnet.nearblocks.io/txns/r4hfLR9Wj25pYML89fsvR3fsFPpj6btcthCSYZKHd2X) · [Factory](https://testnet.nearblocks.io/address/pit.pitdeployer.testnet) · [$PIT contract](https://testnet.nearblocks.io/address/pit.pit.pitdeployer.testnet) | [Factory contract](../pit/contracts/factory/src/lib.rs#L303) |
| Buying minted tokens. Selling burned tokens and paid ticket 0 from the liquid reserve. | [Buy](https://testnet.nearblocks.io/txns/CcibHRHGDDxQU3FjtzFxTg7TSBhrnDcHVBaqUSd4YX2f) · [Sell and payout](https://testnet.nearblocks.io/txns/AEvzmXdY28MFvYEoodsKSgbzAhpM64VUWQznDVZpYTwA) | [Trading](../pit/contracts/pit/src/trading.rs#L11) · [Payout callback](../pit/contracts/pit/src/payouts.rs#L35) |
| A keeper harvest credited 0.02 testnet NEAR to the brain account. The callback emitted `harvest` after the transfer. | [Successful harvest receipt](https://testnet.nearblocks.io/txns/Gt9XfxR41TAtVw4zkHHNtEDdsdvpcGxB7A9sLQjygVhH) | [Harvest callback](../pit/contracts/pit/src/payouts.rs#L173) |
| The keeper recorded thought **#170** on November 13 at 19:00 UTC. The contract accepted the signature and emitted a `thought` event with the response hash. | [Successful `record_thought` receipt](https://testnet.nearblocks.io/txns/3L4vDDQQoMKtX4nhDNtB457FqMMntjwfNZKcKogsoFkb) · [Exact signed response bytes](../webapp/src/evidence/485018fc36787623138d2eb61f84b9a04430a0128848cce0171618518b342d86.json) | [On-chain signature check](../pit/contracts/pit/src/mind.rs#L107) · [Provider proof pipeline](../pit/brain/proof.mjs) · [Browser verifier](../webapp/src/lib/thought-proof.ts) |

### Verify the signature and response

In [$PIT’s mind](https://www.trythepit.xyz/#/coin/pit/mind), open the latest recorded thought and select **Verify it yourself**. Thought #170 was the latest during the evidence check. The contract keeps the latest 16 texts in state, and the historical receipt retains the event.

For a direct read, query `get_thoughts` on `pit.pit.pitdeployer.testnet`. Query `view_access_key_list` on `pit.pitdeployer.testnet` for `keys: []` and `view_account` on the coin for the deployed `global_contract_hash`, `4GJkA6zJ2RMbZGQygjTnWDJwfuHG3WdXziSigaDdH9gD`. Its hex form matches [the release record](deployment/release.json). These are NEAR testnet JSON-RPC calls and need no wallet. [FastNear RPC reference](https://docs.fastnear.com/rpc)

```sh
curl -fsS https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"pit-thought","method":"query","params":{"request_type":"call_function","finality":"final","account_id":"pit.pit.pitdeployer.testnet","method_name":"get_thoughts","args_base64":"eyJsaW1pdCI6MX0="}}' \
  | node -e 'const reply = JSON.parse(require("node:fs").readFileSync(0, "utf8")); if (reply.error) throw Error(JSON.stringify(reply.error)); console.log(Buffer.from(reply.result.result).toString("utf8"))'
```

The on-chain signature covers the provider’s request and response hashes. The browser hashes the raw response and compares its text to the displayed thought. It also checks whether NEAR AI’s current report binds the signing key. An archived report served by the brain can be matched against its recorded hash. Full hardware quote validation is outside the browser check.

## Which integrations the demo exercises

| Integration | Evidence and scope |
|---|---|
| NEAR Global Contracts and fungible tokens | The factory publishes and instantiates shared WASM on-chain. Token mint and burn events follow NEP-141. |
| Staking and inference | The keeper reads and moves funds through the testnet mock validator pool. The brain credits newly confirmed harvests, budgets calls in USD, and uses a service credential for NEAR AI Cloud billing. The keeper account submits thought records, and the model has no wallet signer. [Staking](../pit/contracts/pit/src/staking.rs) · [Brain loop](../pit/brain/index.mjs) |
| Holder memory | NEAR stores proposals, token locks and adopted canon. The brain reads the canon when preparing its prompt. A funded testnet wallet is needed to propose or back a memory. [Mind contract](../pit/contracts/pit/src/mind.rs#L11) |
| Early access | Real contract checks for wallet, epoch, nonce and cap. Testnet uses a development signer and mock registry. $DEMO’s window has ended. A fresh gated launch exercises the full flow. [Gate info](https://gate-production-a0bd0e97.up.railway.app/api/info) · [Testnet walkthrough](deployment/testnet.md#7-demo-script) |
| RHEA cross-chain funding | The app requests and validates quotes and transaction builds through a RHEA proxy. Funding uses mainnet assets and is disabled in the testnet interface. [Funding UI](../webapp/src/CrossChainFunding.tsx) · [Server proxy](../webapp/server/rhea-proxy.mjs) |

## Build history

The [official hackathon window](https://nearhackathon.com/) ran November 1–14, 2026 UTC. The [first public commit](https://github.com/drained69/thepit/commit/80c591f) is dated November 8 and introduces the contracts and frontend in one snapshot. It adds 42,888 lines, including 25,100 in lockfiles. That snapshot dates the public import. Review the [changes after it](https://github.com/drained69/thepit/compare/80c591f...2395251) and the [November 10 deployment update](https://github.com/drained69/thepit/commit/c744744) for incremental work during the event.

This walkthrough, response archive, and the interface changes that surface the proof and label budget pauses were prepared after the submission deadline. The linked transactions and response date from the event.

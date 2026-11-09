# The Pit — a NEAR launchpad for memecoins that grow a brain

**Status: NEAR testnet (hackathon build). Mainnet after an independent third-party audit.**
Security: [mainnet readiness audit, 2026-11-09](../docs/audits/MAINNET_READINESS_2026_11_09.md),
with every finding fixed and tested. Earlier reviews are in [docs/audits](../docs/audits/).
Deploy it: [testnet runbook](../docs/deployment/testnet.md) · [mainnet guide](../docs/deployment/mainnet.md).

> **Anyone can launch a memecoin in one transaction (~0.12 NEAR).** A creator
> can add an early-access window with wallet-bound passes. Each coin has a
> reserve behind its bonding curve, with a liquid buffer and validator stake,
> plus an AI brain funded by staking rewards and trade fees. Creators can take
> up to half of that AI budget. The Shade Agent TEE gate is implemented but is
> not active on the public preview.

Testnet build with an internal audit, not a third-party one. Don't put real money in it.

**Public preview (contracts not connected yet):** https://www.trythepit.xyz/ · brain feed: https://brain-production-11a4.up.railway.app/api/feed. The proposed RHEA cross-chain funding extension is scoped in [RHEA_INTEGRATION.md](RHEA_INTEGRATION.md).

## What users pay

| When | Amount | Why |
|---|---|---|
| Every buy and sell | 1% of the trade | feeds the brain |
| First buy | ~0.00125 NEAR, once | your token account's storage |
| Gated (early-access) buy | 0.002 NEAR | your pass records' storage |
| Sell | 0.002 NEAR deposit, **always returned** | covers a queue ticket if the instant buffer is empty |

## The mind: Proof of Thought + holder-owned memory

Other launchpads give a meme an AI budget. The Pit gives every coin a mind you can verify and holders own.

**Proof of Thought.** The brain thinks on NEAR AI Cloud's private inference and keeps the exact
request and response bytes. NEAR AI signs `"<sha256(req)>:<sha256(resp)>"` (gateway) or
`"<model>:<sha256(req)>:<sha256(resp)>"` (provider_tee) with an Ed25519 key that appears in a TEE
attestation report fetched *before* the completion. The brain calls `record_thought` on the coin;
**the contract re-verifies the signature on-chain** and stores the record (last 16 in state, all in events).
On each coin page, *Verify it yourself* re-checks in the browser: signature, that the raw response
(served by hash at `GET <brain>/api/blob/<sha256>`) re-hashes and contains the exact posted text, and
that the attestation report names the signing key. Full TDX quote verification: nearai-cloud-verifier.

**Holder-owned memory.** Anyone proposes a belief (≤ 280 bytes). Holders lock tokens behind it;
**conviction = tokens × time held**, so whales can't flip it instantly. At 1% of supply held for 3 days
(or any equal token·time) anyone can `adopt_memory`; it joins the coin's **canon** (last 64), the brain
reads the canon before every thought, and every thought records the canon hash it saw. Locked tokens
come back any time with `unback_memory`.

```text
mind   propose_memory(text) payable · back_memory(id, amount) payable · unback_memory(id) · adopt_memory(id)
       record_thought({text, model, chat_id, signature_kind, request_hash, response_hash,
                       signature_hex, signing_address, attestation_hash?}) payable · thinker only
       set_thinker(account?) · brain only
view   get_memory(id) · get_memories(from_index, limit, pending_only) · get_canon · get_backing(id, account)
       get_thoughts(limit) · get_mind
```

The factory gives every coin the same thinker (the keeper account). The brain needs
`NEAR_AI_API_KEY`; without it, it keeps the pits healthy but doesn't think or record.

## Launchpad

`contracts/factory` (`pit-factory`) creates coins at `<symbol>.<factory>`. Every coin
runs the same code, **published once as a NEAR global contract pinned by
hash**, so no coin can be changed after launch and a new coin doesn't store its own
copy of the code. No owner; everything is fixed at init.

| | NEAR (measured on a local node) |
|---|---|
| Publish the shared coin code, **once** (burned, ~10× storage rate; 325 KB with the mind) | 32.8 |
| Launch a coin (0.1 storage float + 0.02 record fee) | **0.12** |
| A launched coin's on-chain footprint | under 1 KB |
| Factory + brain + keeper accounts | ~3–4 |

Deploy it:

```bash
AGENT_REGISTRY=<shade agent contract> POOL=<validator pool> node pit/scripts/deploy.mjs --launchpad
```

`FIRST_COIN=doge FIRST_COIN_NAME="Doge Pit"` also launches a first coin. The script
prints the Railway variables: `PIT_FACTORY` + keeper key for the brain,
`VITE_PIT_FACTORY` for the web app.

```text
factory  new(coin_code_hash_hex, brain, thinker?, pools, agent_registry?, verifiers, defaults, coin_deposit)
         publish_coin_code(code: borsh Vec<u8>)  payable · once · only the pinned code
         create_coin(symbol, name, icon?, launch?: {starts_in_ms, epochs[{duration_ms, per_buyer_max_tokens}]}, creator_share_bps ≤ 5000)
                                                  payable create_cost(icon_bytes) · ≥150 Tgas · refunds on any failure
                  icon: an emoji, or data:image/(png|jpeg|webp|gif);base64,… ≤ 16 KB (no SVG, no URLs).
                  Images cost 10^19 yocto/byte extra, stored in the coin's ft_metadata;
                  the registry record keeps emoji only and sets has_image.
view     get_config  create_cost(icon_bytes?)  get_coins(from_index, limit)  get_coin(symbol)  coin_count
coin     new(…, launch?, creator?: {account_id, share_bps})  harvest splits creator / brain
```

## What a single coin costs to deploy (without the launchpad)

| Setup | NEAR |
|---|---|
| Real validator pool + real Shade agent contract | **3.57** (3.52 contract code + state, 0.05 brain account) |
| With the test-only mock pool and registry | 6.24 |

Mostly storage staking for the 322 KB contract (1 NEAR per 100 KB). `deploy.mjs` funds each account by its exact storage need.
The launchpad instead publishes the coin code once as a global contract: 32.16 NEAR burned, then ~0.12 NEAR per coin
([full cost table](../docs/deployment/testnet.md#what-mainnet-would-cost)).

```
      gate agent in a TEE (Shade Agent)          NEAR agent contract (Shade)
      key born in the enclave ── register_agent ─► verifies TDX quote, approved code
      (account = its pubkey)      (attestation)     measurements + PPID, expiry
            │ wallet check + challenge + PoW                      ▲ get_agent(signer) == "Valid"?
            ▼                                                     │
 human ──► pass {buyer, sale, epoch, cap, ──► buy_with_agent_pass ┴► Ed25519 verify · nullifier · caps
           nonce, expiry} + agent_id                │                  settle, or refund on any failure
 sniper ───────────────────────────────────────► buy ──► PassRequired (until the curve opens)
                                                              ▼
                                                       bonding curve ──► principal (owed to holders)
                                                                           ├─ 20% liquid ──► instant sells
                                                                           └─ 80% staked ──► validator pool
                                               rewards + 1% fees = surplus ──► harvest ──► brain ──► AI budget
                                                                     tier = f(principal) ──► model size
```

## Why the gate is trustworthy now

The pass signer is a [Shade Agent](https://github.com/NearDeFi/shade-agent-framework).
Inside a TEE (Phala Cloud / dstack) the agent's key is generated from enclave
entropy and its NEAR account **is** that key (an implicit account). It calls
`register_agent` on the agent contract with a TDX attestation whose report data
is that account; the contract verifies the quote (dcap-qvl), that the code's
measurements and the CPU's PPID are approved, and sets an expiry.

`buy_with_agent_pass` verifies the pass signature against the named agent's
key, then asks the agent contract `get_agent(agent)`. The buy settles only if
the answer is `"Valid"` — registered, approved code, unexpired attestation.
Revoked, expired or never-attested signers are refunded. So the contract does
not trust a server or a pinned key: it trusts **code measurements** that anyone
can reproduce from this repo's Docker image (`shade reproduce`).

## What's proven

| Property | Evidence |
|---|---|
| Nobody buys during gated epochs without a pass (wallet must exist and hold the minimum balance; not proof of personhood) | `buy` → `PassRequired`; unit + sandbox + live local node |
| A pass works once, for one wallet, one sale, one epoch, before expiry | `PassReplay` / `PassNotForYou` / `PassWrongSale` / `PassWrongEpoch` / `PassExpired`, 17 launch tests |
| Only the pinned gate key can sign; tampering breaks it | `PassUnknownVerifier` for forged signer and edited `max_amount` |
| Caps hold across passes | per-pass `max_amount` + per-buyer per-epoch cap (`PerBuyerCap`), checked before any state change |
| Real tee-gate passes verify on-chain | sandbox test with a pass issued by the running `tee-gate --sale-id PIT-001` |
| Agent passes only work while the agent is valid | 13 agent tests + sandbox cross-contract test: valid → minted; unregistered, revoked, invalid, registry down, epoch ended, cap hit → refunded and pass released |
| Gate agent works end to end | live local node: gate-agent registers itself, human buys through it, owner revokes it, its next pass is refunded |
| Holders are always backed | selling the entire supply returns ≤ principal; fuzzed over 400 random trades |
| Brain only eats surplus | harvest never touches the sell buffer or queued payouts |
| Big sells are safe | over-buffer sells retain their price; rotating batches skip blocked claims after unstake |
| Metabolism works end to end | live local node: rewards → unstake → withdraw → harvest → brain budget +$3 |
| No admin | no owner, withdraw or pause; pools, curve, schedule, verifier keys fixed at init; `--lock` deletes contract keys |

## Repo map

```
pit/contracts/pit/       NEP-141 + gated launch + bonding curve + staked reserve + queue + harvest
  tests/unit.rs              17 tests: curve, fees, queue, staking round-trips, harvest, lock, tiers, fuzz
  tests/launch.rs            17 tests: every pass rule, caps, phases (passes signed like tee-gate)
  tests/agent.rs             13 tests: Shade agent passes and every refund path
  tests/integration.rs       sandbox: metabolism · real tee-gate pass · Shade agent registry cross-call
pit/contracts/mock-pool/   TEST ONLY staking pool (60 s unstake, add_rewards)
pit/brain/                 keeper loop + yield-funded AI voice (NEAR AI Cloud, Telegram optional)
pit/web/index.html         zero-dependency brain meter (demo mode without a contract)
pit/contracts/mock-agent-registry/  TEST ONLY stand-in for the Shade agent contract in local mode
pit/gate-agent/            the human gate as a Shade Agent (Node; same HTTP API as tee-gate)
  src/gate.mjs · src/identity.mjs (shade | dev-key) · src/server.mjs · test/ (7 tests)
  Dockerfile · docker-compose.yaml · deployment.yaml (shade-agent-cli)
pit/scripts/               build · deploy (testnet|sandbox; AGENT_REGISTRY or pinned gate) · get-pass ·
                             demo-buy · registry-admin
webapp/pit.html            The Pit trading page: phase, human gate → pass → buy, sell, brain, schedule
tee-gate/                    the human gate (shared with $HUMAN; run with --sale-id PIT-001)
```

## Tests

```bash
cd pit/contracts/pit && cargo test --features unit-tests
```

```bash
node pit/scripts/build.mjs && cd pit/contracts/pit && cargo test --features integration --test integration
```

Gate → chain with a real pass (run the gate, fetch a pass for `alice.test.near`, then the sandbox test uses it):

```bash
(cd tee-gate && cargo run -- --port 8799 --sale-id PIT-001)
```

```bash
PIT_AUTO_ANSWER=1 node pit/scripts/get-pass.mjs alice.test.near 0 http://localhost:8799 /tmp/pass.json
```

```bash
cd pit/contracts/pit && PIT_REAL_PASS=/tmp/pass.json cargo test --features integration --test integration gated
```

## Railway (web + brain)

Project `the-pit` has two services:

- **web** — `webapp/` (`npm run build`, `npm start` → `serve.mjs`). Build-time variables:
  `VITE_PIT_FACTORY` (launchpad) or `VITE_PIT_CONTRACT` (one coin) — neither = preview mode — plus
  `VITE_PIT_BRAIN_URL`, `VITE_PIT_GATE_URL`, `VITE_NEAR_RPC`.
- **brain** — `pit/brain/` (`npm start`). Variables: `PIT_FACTORY` (launchpad: keeps and voices every coin) or `PIT_CONTRACT` (one coin), `KEEPER_ACCOUNT_ID`, `KEEPER_PRIVATE_KEY`,
  `NEAR_NETWORK`, optional `NEAR_AI_API_KEY` (without it: keeper + feed only). Serves `/api/feed` on `PORT`.

Redeploy after changes:

```bash
railway up webapp --path-as-root --service web --detach
```

```bash
railway up pit/brain --path-as-root --service brain --detach
```

## Run the Shade Agent gate

**Production (TEE, Phala Cloud)** — needs the [shade-agent-cli](https://github.com/NearDeFi/shade-agent-framework/tree/main/shade-agent-cli),
Docker, and a Phala API key:

1. Put NEAR's `shade-contract-template` next to the gate (`pit/gate-agent/shade-contract-template`),
   fill `contract_id` and `tag` in `pit/gate-agent/deployment.yaml`, and copy `.env.example` → `.env`.
2. `shade auth set`, then from `pit/gate-agent`: `shade deploy`. It deploys the agent contract with
   `requires_tee: true`, builds the image, approves its measurements and Phala's PPIDs, deletes the
   contract key (`delete_key: true`) and launches the CVM. The agent registers itself.
3. Deploy The Pit pointing at it: `AGENT_REGISTRY=<agent contract id> node pit/scripts/deploy.mjs`.
4. Point the webapp's `VITE_PIT_GATE_URL` at the CVM's public URL.

**Local (no TEE)** — the same flow against the TEST-ONLY registry:

```bash
AGENT_REGISTRY=mock LAUNCH_IN_MIN=0 node pit/scripts/deploy.mjs
```

```bash
cd pit/gate-agent && npm install && GATE_IDENTITY=dev-key AGENT_CONTRACT_ID=registry.YOU.testnet SPONSOR_ACCOUNT_ID=YOU.testnet SPONSOR_PRIVATE_KEY=ed25519:… PORT=3140 npm start
```

```bash
AGENT_REGISTRY=registry.YOU.testnet node pit/scripts/registry-admin.mjs whitelist <agent id the gate printed>
```

```bash
PIT_CONTRACT=pit.YOU.testnet GATE_URL=http://localhost:3140 node pit/scripts/demo-buy.mjs 0.5
```

## Mainnet

`NEAR_NETWORK=mainnet` makes `deploy.mjs` refuse the test-only mock pool and registry, a pinned
dev-key gate and non-`.near` deployers, and requires `CONFIRM_MAINNET=yes` (contracts are
immutable; publishing the coin code burns ~32.2 NEAR once) and `--lock`, which deletes the
factory's keys so nobody can change it. The web app picks the network with
`VITE_NEAR_NETWORK=mainnet` (RPC and nearblocks links follow). RPC defaults to FastNEAR
(`rpc.*.near.org` no longer answers); override with `NEAR_RPC` / `VITE_NEAR_RPC`.

**Mainnet is deferred until a third-party audit.** Read the
"Still required before mainnet" list in the [readiness audit](../docs/audits/MAINNET_READINESS_2026_11_09.md) first — a third-party audit is required.

## Run it on testnet (pinned-key gate)

1. Start the gate for this sale (keep it running; it signs passes):

```bash
(cd tee-gate && cargo run -- --port 8788 --sale-id PIT-001 --verifier-name pit-gate-sim-1)
```

2. Deploy. It reads the gate's key from `/api/info` and pins it; gated epochs start `LAUNCH_IN_MIN` from now.

```bash
cd pit/scripts && npm install && cp .env.example .env   # fill DEPLOYER_ID / DEPLOYER_PRIVATE_KEY
```

```bash
GATE_URL=http://localhost:8788 LAUNCH_IN_MIN=2 EPOCH_MIN=30 node pit/scripts/deploy.mjs
```

3. Watch a sniper fail and a human buy:

```bash
PIT_CONTRACT=pit.YOU.testnet GATE_URL=http://localhost:8788 node pit/scripts/demo-buy.mjs 0.5
```

4. Trading page (wallet, gate, buy, sell):

```bash
cd webapp && npm i && VITE_PIT_CONTRACT=pit.YOU.testnet VITE_PIT_GATE_URL=http://localhost:8788 npm run dev
```

Open `http://localhost:5173/pit.html`.

5. Brain (keeper + voice). Paste the lines `deploy.mjs` printed into `pit/brain/.env`, add `NEAR_AI_API_KEY`:

```bash
cd pit/brain && npm install && node index.mjs --once --dry
```

Simulate staking yield on the mock pool, then let two keeper ticks (60 s apart) unstake, withdraw and harvest it:

```bash
near contract call-function as-transaction pool.YOU.testnet add_rewards json-args '{"account_id":"pit.YOU.testnet"}' prepaid-gas '30 Tgas' attached-deposit '1 NEAR' sign-as YOU.testnet network-config testnet sign-with-keychain send
```

Local instead of testnet: run a `near-sandbox` node and pass `NEAR_NETWORK=sandbox` (deployer `test.near`, key from the sandbox's `validator_key.json`) to `deploy.mjs`, `demo-buy.mjs` and the brain; `.claude/launch.json` has the matching webapp config.

## Contract interface

```text
init   new(brain, pools[1..4], virtual_near, virtual_tokens, fee_bps≤500, buffer_bps 1000..10000, tiers,
           name, symbol, icon, launch?: {sale_id, starts_at_ms, gated_epochs[{ends_at_ms, per_buyer_max_tokens}], verifiers[{pubkey_hex, name, evidence_hash_hex}], agent_registry?})
trade  buy_with_agent_pass(pass, sig_b64, agent_id, min_tokens_out)  payable · ≥120 Tgas · signer must be a Valid
                                               Shade agent of launch.agent_registry; refunds on any failure
       buy_with_pass(pass, sig_b64, min_tokens_out)   payable · gated epochs only · statically pinned keys
       buy(min_tokens_out)                            payable · open phase (or no launch)
       sell(amount, min_near_out)                     0.004 NEAR refundable collateral → {status: paying|queued, near_out, ticket_id}
keeper rebalance(pool_index) ≥200 Tgas · process_queue(max?) · harvest()
brain  set_brain(new_brain)
view   launch_info  gated_bought  pass_used  brain_stats  quote_buy  quote_sell  spot_price
       get_pools  get_tiers  get_queue  + NEP-141 / NEP-145 / NEP-148
```

Pass (signed byte-exact, same as `$HUMAN`; `max_amount` is whole PIT):

```json
{"v":1,"sale":"PIT-001","kind":"human","buyer":"you.testnet","epoch":0,"max_amount":"250000","nonce":"<64 hex>","expires_at_ms":1793941331561}
```

## Honest limits

- **The gate is friction, not personhood.** A script can solve the challenge
  (the 2026-11-09 audit showed this). What limits bots is the per-wallet cap
  plus the wallet balance floor (1 NEAR on mainnet), so each extra bot wallet
  costs capital. One person can still run many funded wallets, and a
  pass-holder can transfer tokens after buying.
- **The TEE path isn't exercised here yet.** Local runs use the test registry
  (no attestation). The real agent contract wasn't built in this repo's checks:
  its attestation library needs a Linux/Docker build. Deploy it with
  `shade deploy` and run the gate on Phala before calling the launch attested.
- **Trust moves to the agent contract's owner.** Whoever owns it approves code
  measurements and PPIDs. Lock it after setup (`delete_key: true`, or hand
  `owner_id` to an account with no keys); then no one can approve other code.
  Trade-off: if Phala moves the CVM to a CPU whose PPID isn't approved, the
  gate stops working until a new deployment.
- **The gate's key exists only inside the enclave**, and the agent registration
  expires (7 days by default); the gate re-registers every 6 days. If an agent
  is revoked or expires, its outstanding passes are refunded, not honored.
- **Static verifier keys are immutable.** If you use the pinned-key path and the
  key leaks, the leak is bounded by the gated window and per-pass/per-buyer caps.
- **Shade framework is unaudited** (per its README), like this repo.
- **Real pools are slow.** Unstaking takes ~2–3 days; sells beyond the 20%
  buffer wait in the queue that long.
- **Inference payment is off-chain.** Harvested NEAR lands in the brain account;
  the brain's ledger only lets the AI spend what was actually harvested.
- **Pool trust, rounding, deleted accounts.** Fixed pool list (use known
  validators); 0.001 NEAR margin absorbs pool rounding; a queued payout to a
  deleted account is stranded, not stolen.
- **No external audit yet.** Internally audited
  ([report](../docs/audits/MAINNET_READINESS_2026_11_09.md)); mainnet waits for a third-party audit.

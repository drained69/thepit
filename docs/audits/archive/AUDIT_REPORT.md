# The Pit — Internal Security Audit

**Date**: 2026-11-06
**Scope**: `pit/contracts/pit` (NEAR, near-sdk 5.30, 1,180 lines), `pit/gate-agent`, `pit/brain`, `webapp/src/pit`, `webapp/src/lib`, deploy scripts
**Method**: line-by-line review of every contract entry point and callback; unit, launch, agent and sandbox tests for each fix; production-bundle testing of the web app
**Status**: internal review, not a third-party audit. Testnet only.

## Summary

| Severity | Found | Fixed |
|---|---|---|
| Critical | 0 | — |
| High | 2 (web app) | 2 |
| Medium | 3 | 3 |
| Low | 3 | 2 (1 accepted) |
| Informational | 5 | documented |

No path was found that lets anyone take holders' backing, mint without paying, bypass the launch gate, or reach the reserve as an admin. The issues below were about who pays for storage, denial of service, and a web app that didn't load in production.

## Findings

### [H-01] Production web app rendered a blank page — FIXED
**Where**: `webapp/vite.config.ts`
`near-api-js` v1 has circular `require`s (`common-index → providers → rpc_errors → common-index`). They work in Node's require order, but the production bundle hoisted modules, so `AccountMultisig` was defined before `Account` existed: `TypeError: Class extends value undefined`. The dev server hid it. This affected the whole web app.
**Fix**: `build.commonjsOptions.strictRequires: true` keeps Node's order. Verified on a local production build and on Railway.

### [H-02] Wallet sign-in popup was invisible — FIXED
**Where**: `webapp/src/lib/near.ts`
The wallet-selector modal opened but its stylesheet was never imported, so nobody could connect a wallet.
**Fix**: import `@near-wallet-selector/modal-ui/styles.css`. Verified: MyNearWallet modal shows.

### [M-01] Anyone could drain the contract's storage with tiny queued sells — FIXED
**Where**: `sell` → sell queue
When the instant-sell buffer was empty, every sell created a queue ticket paid from the contract's own balance (~0.0015 NEAR each). Many dust sells could exhaust that balance, after which the contract can no longer write state.
**Fix**: a sell that queues must attach `TICKET_DEPOSIT` (0.002 NEAR), stored on the ticket and returned with the payout. Instant sells return their whole deposit too. Tests: `queued_sell_must_fund_its_ticket`, `ticket_records_the_sellers_deposit`, `instant_sell_works_with_one_yocto_and_keeps_deposit_out_of_reserve`, sandbox `buy_stake_reward_harvest_sell`.

### [M-02] The contract paid storage for every pass it recorded — FIXED
**Where**: `buy_with_pass`, `buy_with_agent_pass`
Each gated buy stores a pass nullifier and a per-epoch cap entry at the contract's expense. With cheap Sybil wallets, this was a second storage-drain path.
**Fix**: gated buys keep `PASS_STORAGE_FEE` (0.002 NEAR) from the deposit as storage float; it never enters the reserve. Refunded agent buys return the full deposit. Tests: `gated_buy_pays_its_own_record_storage`, `gated_buy_must_cover_the_pass_fee`.

### [M-03] One client could lock everyone out of the gate — FIXED
**Where**: `pit/gate-agent/src/gate.mjs`
The gate had a global cap of 10,000 open challenges and 3 per buyer name. Rotating buyer names filled the table, returning `gate_busy` to everyone for 15 minutes.
**Fix**: at most 6 open challenges per client IP (`TRUST_PROXY=1` behind a proxy). Test: `one client can't exhaust the gate`.

### [L-01] `get_queue` could overflow — FIXED
`start + limit` with a huge `from` panicked. Now saturating. Test: `get_queue_does_not_overflow`.

### [L-02] Verifier names were interpolated into event JSON — FIXED
After removing `serde_json::Value` for size, events are formatted strings. Verifier names are now restricted at init to `[A-Za-z0-9._-]`, so they can't break event JSON. Every other interpolated value is an account id, a number or a fixed label.

### [L-03] Payouts to deleted accounts are stranded — ACCEPTED
If a seller deletes their account before a queued payout (or a refund) arrives, the NEAR bounces back to the contract unaccounted. It isn't stolen or reachable by anyone; it just sits in the account. Documented.

### Informational
1. **No upgrades or pause, by design.** Bugs can't be patched in place; a fix means a new deployment. This is the price of "no admin".
2. **Pool trust.** The pool list is fixed at init. A malicious pool contract could keep the stake. Use well-known validators.
3. **Lock timeout.** A stuck pool operation can be overridden after 15 minutes. If receipts were delayed longer than that under extreme congestion, two pool operations could overlap. Accounting stays conservative (surplus can be understated, never overstated).
4. **Agent contract owner.** With the Shade gate, whoever owns the agent contract approves code measurements and CPUs. Lock it after setup.
5. **The launch gate is friction, not personhood.** One person can run many wallets; a pass holder can transfer tokens after buying.

## Invariants checked

| Invariant | How |
|---|---|
| Selling the entire supply never pays more than `principal` | proof sketch in code comments + 400-trade random test |
| Harvest never touches the sell buffer or queued payouts | `harvest` subtracts both; `staking_rewards_flow_to_the_brain` |
| Every callback that receives a deposit refunds on failure, never panics | `on_agent_checked` returns `Result` paths; 7 refund tests + sandbox |
| Caps are checked before any state change | `try_settle_buy` returns errors before mutating; `pass_cap_limits_tokens` |
| Pass is single-use even while a cross-contract check is in flight | nullifier reserved before the call; `pass_cannot_be_double_spent_while_check_is_in_flight` |
| Deposits for storage never count as reserve | liquid unchanged by ticket/pass/registration deposits; 3 tests |

## Deploy-cost optimisation

| | Before | After |
|---|---|---|
| Contract wasm | 301 KB | 276 KB (removed `serde_json::Value`, `json!`, base64 crate) |
| NEAR to deploy (with test mocks) | 12.00 | 5.77 (fund accounts by exact storage need) |
| NEAR to deploy (real pool + real Shade registry) | 7.00+ | **3.11** |

## Test evidence

- 54 contract tests: 21 core, 19 launch, 14 agent (`cargo test --features unit-tests`)
- 3 sandbox end-to-end tests on the real wasm (`--features integration`)
- 8 gate tests (`node --test pit/gate-agent/test/gate.test.mjs`)
- Production bundle loaded locally and on Railway with no console errors; wallet modal opens

## Addendum — the mind (Proof of Thought + holder memory), reviewed 2026-11-07

New code: `propose_memory`, `back_memory`, `unback_memory`, `adopt_memory`, `record_thought`,
`set_thinker`, the mind views, and the brain's `proof.mjs`.

| Check | Result |
|---|---|
| Storage paid by the caller, measured per call, excess refunded | ✓ `charge_storage`; ring buffer overwrites cost nothing |
| Locked tokens can't be sold or double-counted | ✓ held in the contract's own token account; supply unchanged; test `locked_tokens_cannot_be_sold` |
| Conviction math can't underflow or be inflated by top-ups | ✓ running sums; top-ups weighted by time; saturating subtraction |
| Thought signatures can't be forged, reused for another response, or mislabelled | ✓ exact signed-text shape per kind, Ed25519 verified on-chain; 6 forgery cases tested |
| Only the thinker records; only the brain rotates the thinker | ✓ tests |
| Free text never enters event JSON | ✓ events carry ids, accounts and numbers only |
| A stale attestation can't vouch for a rotated signing key | ✓ brain cites a report only if it names the signer (test) |

**Accepted / informational**

- **Canon is holder-written text, so it's a prompt-injection surface.** It can change what the brain *says*,
  never what it can *do* (no keys that move funds), it costs capital × time to adopt, and the prompt frames
  it as untrusted. Treat adopted beliefs as community speech.
- **Adoption threshold uses current supply.** Large sells lower it; doing so costs the seller and is visible.
- **Unregistering your token account while tokens are locked** means `unback_memory` fails until you
  register again (`storage_deposit`). Tokens are safe, just delayed.
- **`get_memories` scans past adopted entries** to find pending ones; fine for thousands, paginate harder at scale.
- **Attestation is checked for key membership in the browser, not by full TDX quote verification**
  (use nearai-cloud-verifier for that).

Tests: 13 mind unit tests, 1 mind sandbox test, 5 Proof-of-Thought pipeline tests against a NEAR AI mock,
and a full local-node run where the brain recorded thoughts the contract verified and the browser re-checked.

## Mainnet-readiness review — 2026-11-06

Second pass over every entry point with mainnet conditions in mind (real validators, real money,
adversarial creators), plus a new randomized invariant simulation.

| ID | Severity | Finding | Status |
|---|---|---|---|
| MN-01 | Medium | **Canon capture on a small coin.** Adoption needed 1% of supply × 3 days of conviction. On a fresh coin with tiny supply, one buyer could adopt any belief for almost nothing. | FIXED — threshold floor of 1,000,000 tokens × 3 days (`MIN_ADOPT_TOKENS`). Test `small_supply_cant_cheaply_capture_the_canon`. |
| MN-02 | Medium | **Thought replay.** The same signed NEAR AI response could be recorded twice, inflating the brain's on-chain thought log. | FIXED — `recorded_responses` set; duplicates rejected. Test `the_same_response_cant_be_recorded_twice`. |
| MN-03 | Medium | **Tight pool gas.** Pool view/action calls had little headroom; validator pool upgrades or congestion could make every rebalance fail. | FIXED — 20 / 75 / 120 Tgas for view / action / callback. |
| MN-04 | Low | **Tokens sent to the contract itself** would be mixed with memory-backing escrow and lost. | FIXED — `ft_transfer`/`ft_transfer_call` to the contract are refused. Test `transfers_to_the_contract_are_refused`. |
| MN-05 | Low | **Spoofed names/icons.** Names could contain bidi-override or zero-width characters (e.g. render as another coin); icons could be SVG (script) or remote URLs (tracking). | FIXED — coin and factory reject control/zero-width/bidi characters; icons must be a short emoji or a PNG/JPEG/WebP/GIF data URL ≤ 16 KB. The web app re-validates before rendering and never loads remote images. Tests `names_and_icons_are_validated`, `coin_rejects_an_svg_icon`, factory sandbox. |
| MN-06 | Low | **Who pays for image icons.** A 16 KB icon stored in the coin costs ~0.16 NEAR of storage the fixed launch fee didn't cover. | FIXED — `create_cost(icon_bytes)` adds 10¹⁹ yocto per byte; the coin receives it. The registry record keeps emoji only (`has_image` flag), so the factory never stores images. |
| MN-07 | Info | **Deploy foot-guns.** The deploy script defaulted to the mock pool and accepted the mock agent registry. | FIXED — on `NEAR_NETWORK=mainnet` it refuses mock pool/registry, a pinned dev-key gate, non-`.near` deployers, and requires `CONFIRM_MAINNET=yes`. |

### Invariant simulation (`tests/fuzz.rs`)

5 seeds × 2,000 random operations: buys, partial sells, keeper rebalances against a simulated
validator pool (rewards, 52-hour unstake delay, 10% of pool calls failing), sell-queue
processing, harvests with a 25% creator cut, memory proposals, backing, unbacking and adoption.
Checked after **every** operation:

1. Solvency — liquid + staked + unstaking ≥ principal + queued payouts
2. Selling the whole supply never pays more than `principal`
3. Token conservation — balances sum to total supply
4. The contract's own token balance equals the outstanding memory backings
5. Queue debt equals the sum of open tickets

All hold. Each run exercised 150+ queued sells, 27–38 harvests and ~10 adoptions; after wind-down
every queued seller was paid (0 tickets left).

### Before mainnet — still required

- **A third-party audit.** This is an internal review by the same tooling that wrote the code.
- **Pick validators deliberately.** The pool list is immutable per coin; use established pools.
- **Shade gate on real TEE hardware** with `requires_tee = true`, and lock the agent contract owner.
- **Keeper and brain uptime.** If the keeper stops, sells still work from the buffer but queued sells
  wait; funds are never at risk.

Test totals at that point: 76 contract tests, 5 sandbox end-to-end runs, 9 gate tests, 5 Proof-of-Thought tests.

## Deployment & operations review — 2026-11-06 (pre-mainnet)

This pass looked past the contracts at what a mainnet deploy actually does: the deploy script,
key custody, RPC endpoints, the brain's model choice, and what "Proof of Thought" really proves.

| ID | Severity | Finding | Status |
|---|---|---|---|
| OP-01 | **High** | **The launchpad factory was never locked.** `--lock` only covered the single-coin path; the launchpad branch returned before it. The deployer's full-access key stayed on the factory, so whoever held it could redeploy the factory (coins already launched were safe — they never had keys). | FIXED — `--lock` deletes the factory's keys after the code is published and checks none remain. On mainnet `--lock` is mandatory. Verified on a local node: factory and coin both report **0 access keys**. |
| OP-02 | **High** | **Every default RPC was dead.** `rpc.mainnet.near.org` and `rpc.testnet.near.org` no longer answer. The web app, wallet-selector, deploy script, brain and gate defaulted to them (the brain and gate even used the *testnet* URL when `NEAR_NETWORK=mainnet`). | FIXED — all default to `https://rpc.<network>.fastnear.com` (verified live: mainnet and testnet both on nearcore 2.14). The wallet-selector and the Shade client now get an explicit RPC. `NEAR_RPC` / `VITE_NEAR_RPC` still override. |
| OP-03 | Medium | **"Verified on-chain" overclaimed.** `record_thought` checks the Ed25519 signature, but the signing key is supplied by the caller — the contract can't know it's NEAR AI's. The browser's attestation check downloaded the report *from our own brain server* and only did a substring match. A compromised brain could post any text with its own key and a fake report. | FIXED — the browser now fetches NEAR AI's attestation **directly from NEAR AI** (public, CORS-open) and requires the key to be the gateway TEE's key (gateway signatures) or a model TEE's key (provider_tee), **and** to lead that quote's `report_data`. The brain applies the same rule before citing a report. Labels say "signed · on-chain" and explain the key check. Tests: 7 binding cases. Residual: full Intel TDX quote verification isn't done in the browser (use `nearai-cloud-verifier`). |
| OP-04 | Medium | **The brain's models no longer existed**, and some candidates (OpenAI, Google, external DeepSeek) run *outside* NEAR AI's TEE, so their thoughts could never carry a proof. | FIXED — tiers use TEE-attested models only (Qwen3.8-27B → DeepSeek-V4.1-Flash → Kimi K2.6 → GLM-5.3), checked against NEAR AI's live list. The brain re-checks attestation for every tier model at startup and logs any that can't be proven. |
| OP-05 | Info | **WebAssembly features.** The coin wasm uses bulk-memory instructions (Rust's current wasm defaults). | VERIFIED OK — mainnet and testnet run nearcore 2.14.0, the same version as the sandbox where every test and both deploy paths ran. |
| OP-06 | Info | **Key custody.** The brain server holds only the keeper key (≈1 NEAR of gas + the right to post thoughts, which OP-03 now makes checkable). Harvested NEAR goes to `brain.<deployer>`, controlled by the deployer key, which should stay offline. The factory keeps ~1 NEAR of free balance so refunds for failed launches can always be paid. | Documented. |

### Size optimisation

The coin's `new` now takes Borsh args instead of JSON, removing JSON parsers for the launch, tier,
verifier and creator types that ran exactly once per coin.

| | Before | After |
|---|---|---|
| Coin wasm (published once, burned at 10× storage) | 327,505 B | **308,029 B** (−19.5 KB) |
| One-time publish burn | 32.75 NEAR | **30.80 NEAR** |

The factory's encoder is covered by the launchpad sandbox test; the deploy script's hand-written
encoder by a byte-level fixture test (`tests/init_abi.rs`) and a real single-coin deploy on a local node.
Stronger `wasm-opt` passes and `opt-level = "s"` were measured and are worse or ~0.6% better — not adopted.
Most remaining code is the SDK's JSON glue for each public method.

### Exact mainnet cost (from the deploy script run on a local nearcore 2.14 node)

| Item | NEAR | Kind |
|---|---|---|
| Publish shared coin code (308,029 B × 10⁻¹⁹ × 10) | **30.80** | burned, once |
| Factory account (code + state allowance + 1 NEAR refund float) | 2.94 | locked storage |
| Keeper account | 1.00 | gas money (top up) |
| Brain account | 0.05 | receives harvests |
| Gas for the whole deploy | ~0.3 | burned |
| **Launchpad total** | **≈ 35.1** | |
| First coin (optional) | 0.12 emoji / ≤ 0.28 with a 16 KB image | coin storage + record |
| Shade agent contract (separate deploy) | not measured | locked storage |

Real validator pool and real Shade registry replace the mocks on mainnet (the mocks cost 2.7 NEAR on the local run).

### Mainnet checklist

1. Third-party audit of `contracts/pit` and `contracts/factory`.
2. Rehearse the exact command on testnet first:
   `NEAR_NETWORK=testnet POOL=<real pool> AGENT_REGISTRY=<shade contract> node pit/scripts/deploy.mjs --launchpad --lock`
3. Mainnet: same with `NEAR_NETWORK=mainnet CONFIRM_MAINNET=yes`. The script refuses mocks, dev-key gates, non-`.near` deployers and a missing `--lock`.
4. Railway: brain `NEAR_NETWORK=mainnet PIT_FACTORY KEEPER_ACCOUNT_ID KEEPER_PRIVATE_KEY NEAR_AI_API_KEY`; web `VITE_NEAR_NETWORK=mainnet VITE_PIT_FACTORY VITE_PIT_BRAIN_URL VITE_PIT_GATE_URL`.
5. Shade gate on Phala with `requires_tee = true`; lock the agent contract's owner.

Test totals: **77 contract tests** (24 core, 19 launch, 14 agent, 18 mind, 1 invariant simulation, 1 init-encoding),
**5 sandbox end-to-end runs**, **15 gate + Proof-of-Thought tests**, plus both deploy paths run for real on a local node.

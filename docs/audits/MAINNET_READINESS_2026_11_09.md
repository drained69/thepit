# Mainnet readiness audit — 2026-11-09

**Scope**: the working tree as of 2026-11-09 (uncommitted changes included):
`pit/contracts/pit` (1,896 lines), `pit/contracts/factory` (551), `pit/brain`,
`pit/gate-agent`, `pit/scripts`, `webapp` (incl. the RHEA proxy in `webapp/server`).
**Method**: line-by-line read of both contracts and every service entry point;
full build and every test suite; executable proofs for the findings marked
[POC-PASS]; read-only mainnet checks. No transactions were sent; nothing was run
against the live Railway services.

## Verdict (updated after fixes, same day)

**Code: ready for a testnet rehearsal. Mainnet: blocked only on the
operational release gates** (funding, a chosen validator pool, the production
Shade registry, a testnet and RHEA rehearsal, and a third-party audit).

Every finding below is fixed, with a test, except M-04, which was a false
positive. H-01 is mitigated, not solved: the gate now puts a capital cost on
each wallet and the product no longer claims personhood-based access. See
[Fix log](#fix-log).

| Severity | Found | Fixed / mitigated | Retracted |
|---|---|---|---|
| High | 1 | 1 (mitigated) | — |
| Medium | 5 | 4 | 1 (M-04) |
| Low | 4 | 4 | — |
| Informational | 3 | 3 | — |

## Test evidence

| Suite | Result |
|---|---|
| Coin host tests (agent, fuzz, init ABI, launch, mind, recovery, unit) | 90 passed |
| Coin sandbox (nearcore 2.14, same as mainnet) | 5 passed |
| Factory host / sandbox | 9 / 1 passed |
| Brain / gate / scripts / web | 17 / 16 / 6 / 26 passed |
| Web typecheck + production build | clean |
| Clippy (wasm, release) | style warnings only |
| `npm run check:mainnet` | fails: parent has 0 NEAR; no pool; no registry |

Artifacts: coin 337,906 B, factory 183,135 B.

## Findings

### [H-01] A script passes the launch gate every time [POC-PASS]

**Where**: `pit/gate-agent/src/gate.mjs` (`generateChallenge`, `verify`)

The challenge picks three emoji from four fixed lists that ship in the source,
and the hint names the majority category. Proof of work is ~2^18 hashes. A
script that only reads those lists passed **200/200** challenges with valid
signed passes, at **~0.2 s per pass on one CPU core** (~300 passes/min/core).
Each pass is bound to a buyer account, and NEAR accounts are cheap, so a
sniper with fresh wallets gets the same gated access as people.

**Impact**: the "snipers get nothing" launch claim does not hold
against even a simple bot. Per-buyer caps limit each wallet, not each person.

**Recommendation**: before mainnet, either adopt real Sybil resistance (e.g.
a personhood credential checked inside the TEE, minimum account age or stake,
or an allowlist) or stop advertising personhood-based access. Harder puzzles alone
won't fix this, because the answer space is three options.

### [M-01] One malformed request crashes the gate and the brain [POC-PASS]

**Where**: `pit/gate-agent/src/server.mjs:41`, `pit/brain/index.mjs:161`

Both request handlers start with `new URL(req.url, …)` outside any try/catch.
The ordinary HTTP request target `//` makes `URL` throw; in Node a synchronous
throw in a request listener is an uncaught exception, and the process exits.
Proof: a server with the identical first statement answered 200, then received
one `GET //` and exited with code 1 (`TypeError: Invalid URL`).

**Impact**: anyone can take the gate offline during a gated launch, repeatedly,
one request at a time. The brain (also the keeper) restarts on Railway and
releases its lock on exit, so it loses uptime but recovers.

**Recommendation**: wrap URL parsing (and the handler body) in try/catch and
answer 400, as `webapp/serve.mjs` already does.

### [M-02] A pool success that returns data is booked as a failure [POC-PASS]

**Where**: `pit/contracts/pit/src/lib.rs` — `promise_ok()` (581–584), used by
`on_staked`, `on_unstaked`, `on_withdrawn`, `on_refund`, `on_harvest`; also
`on_payout` (973)

`env::promise_result_checked(0, 0)` returns an error when the result is longer
than 0 bytes, even if the call **succeeded**. With a pool whose methods return
a value, a successful stake is treated as failed: `on_staked` adds the staked
NEAR back to `liquid`.

Proof: `tests/pool_result.rs`. Buy 100 NEAR and stake 79.2 NEAR, with the pool
replying `Successful(b"true")`. `liquid` shows 99.99 NEAR (really 20.8). After
the next routine keeper sync, `surplus` is **80.2 NEAR instead of 1.0 NEAR**,
so `harvest` would send ~79 NEAR of holders' backing to the brain and creator.

**Likelihood**: low today. The standard staking pool (`*.poolv1.near`) returns
nothing from these methods. But pools are fixed per coin forever, and the code
should not depend on that.

**Recommendation** (one line): treat only `PromiseError::Failed` as failure:

```rust
fn promise_ok() -> bool {
    env::promise_results_count() == 1
        && !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed))
}
```

Use the same check in `on_payout` and the factory's `on_refund`. Then remove
`#[ignore]` from `tests/pool_result.rs`; it should pass.

### [M-03] The deploy script locks the factory even if code publication failed [CODE-TRACE]

**Where**: `pit/scripts/deploy.mjs` 340–352 and 390–398

`publish_coin_code` is sent, but `code_published` is never re-read before
`--lock` deletes the factory's keys. If publication fails, the factory keeps
the ~33.8 NEAR attached for the burn (the contract has no refund path for it).
The factory then becomes permanently keyless with no published code, so it can
never launch a coin and the NEAR is stranded.

**Recommendation**: after publishing, read `get_config` and abort (without
locking) unless `code_published === true` and `coin_code_hash` equals the local
artifact hash. Lock only after that check passes.

### [M-04] ~~Reviewed artifact hashes aren't enforced~~ — RETRACTED (false positive)

**Correction**: they are enforced. `deploy.mjs` calls `verifyArtifactPins`
(`pit/scripts/deployment-plan.mjs:25`) on mainnet, and
`test/deployment-plan.test.mjs` covers it. My search looked only for the
variable names in `deploy.mjs` and missed the helper. The original text is
kept below for the record.

**Where**: `docs/deployment/mainnet.md` §4; `pit/scripts/deploy.mjs`

The guide tells operators to export `MAINNET_COIN_CODE_SHA256` and
`MAINNET_FACTORY_CODE_SHA256`, and says the script rejects mismatched pins.
No script reads those variables. A rebuild between review and deployment
would publish unreviewed code, immutably.

**Recommendation**: on mainnet, require both variables and abort unless they
equal the SHA-256 of the wasm files being deployed.

### [M-05] A failed launch's refund can outrun the returning funds and strand the launch [CODE-TRACE]

**Where**: `pit/contracts/factory/src/lib.rs` — `on_coin_created` /
`dispatch_refund`

When a launch fails, `on_coin_created` immediately transfers
`attached − 0.002 NEAR` back to the creator. But the `cost − RECORD_FEE` sent
to the failed child account comes back in a **separate** refund receipt that
may arrive later. The factory's free float (~1 NEAR) covers the gap. If many
failed launches land together and exhaust it, the callback fails for lack of
balance. Its state changes revert, so the launch stays `creating` forever. The
factory is keyless, so nobody can recover those funds.

**Likelihood**: low (needs roughly ten concurrent failed launches in one block).
**Impact**: the creator's deposit is locked permanently.

**Recommendation**: before dispatching, check
`env::account_balance() − storage cost ≥ refund`. If short, record the claim as
retryable (not in flight) instead of transferring, and let `retry_refund` send
it later.

### [L-01] Spoofable client identity behind a proxy lets one client fill the gate

**Where**: `pit/gate-agent/src/server.mjs` (`TRUST_PROXY`)

With `TRUST_PROXY=1` the per-client cap uses the **leftmost**
`X-Forwarded-For` entry, which the client controls. Rotating it bypasses the
6-sessions-per-client cap. The 10,000-session table can then be filled,
returning `gate_busy` to everyone.

**Recommendation**: use the rightmost entry appended by your trusted proxy (or
the proxy's dedicated real-IP header).

### [L-02] RHEA proxy: shared rate limit and unvalidated report bodies

**Where**: `webapp/server/rhea-proxy.mjs`

Behind Railway every visitor shares the edge's socket address, so the
120 req/min bucket is site-wide (the code comment notes this). One client can
switch off funding for everyone. `/api/swap/report` and `/api/swap/order-submit`
forward any JSON object to RHEA under your API key.

**Recommendation**: key the limit on a trusted real-IP header; validate those
two bodies to the fields the app sends.

### [L-03] Single-coin keeper key can't attach deposits

**Where**: `pit/scripts/deploy.mjs:281`, `pit/brain/near.mjs:14`

Single-coin mode gives the keeper a function-call access key, and NEAR doesn't
let those keys attach deposits. The brain's `withdraw_refund` (1 yocto) and
`record_thought` (storage deposit) therefore always fail there, logging errors
every tick. Launchpad mode (full-access keeper account) is unaffected.

### [L-04] `storage_deposit` differs from NEP-145 for overpayments

Overpayments become refund credits instead of being returned immediately, and
an overpayment smaller than the credit-account fee panics. The team's own
mainnet guide already lists this. Test with the wallets and DEXes you expect
before listing.

### Informational

1. **I-01**: the header comment in `lib.rs` says `set_brain` is the only
   privileged call; `set_thinker` (brain-only) exists too.
2. **I-02**: Clippy style warnings (`div_ceil`, `map_or`, assign-op), none
   affecting behaviour.
3. **I-03**: publication cost at the current artifact (337,906 B) is
   **33.79 NEAR burned**. With factory, keeper and brain accounts, the total is
   **≈ 37.9 NEAR** before gas.

## What was checked and holds

- **Coin solvency**: storage deposits, ticket deposits, refund credits and
  in-flight harvests never count as reserve. Harvest can't touch the sell
  buffer or queued payouts. The 10,000-op invariant fuzz passes.
- **Payouts and refunds** stay locked until their callback confirms, with no
  timeout-based retry. Recovery redirects only confirmed failures, and only by
  the owner.
- **Pool lock** is released on every callback path; `on_pool_state` rejects a
  view for another account.
- **Gated buys**: the pass is bound to buyer, sale, epoch, cap and expiry,
  reserved before the registry check, and released on every refund path.
  Signatures cover the exact bytes.
- **Mind**: escrow conservation, conviction math (no underflow), adoption
  floor, response de-duplication, thinker-only recording.
- **Factory**: symbol races are refunded, the code is pinned by hash, init args
  are Borsh with a byte-level fixture test, and image icons are paid per byte.
- **Web**: static serving is traversal-safe; the RHEA key stays server-side;
  funding is bound to the signed-in NEAR account; deposit constants match the
  contract; agent-pass buys register the refund account first.
- **Deploy script**: mainnet refuses mocks, a dev gate, non-mainnet RPC, an
  existing target, a non-TEE registry and a missing `--lock`.

## Release gates (not code)

1. **H-01**: decide the launch-gate policy.
2. **M-01 to M-04**: fix, then re-run all suites. M-05 is recommended.
3. Fund `drained99.near` (≈ 38 NEAR plus gas and operating funds).
4. Choose and verify a standard validator pool. Deploy the production Shade
   registry with `requires_tee: true`.
5. Rehearse the exact command on testnet; rehearse one small RHEA transfer to
   native NEAR.
6. Rotate the RHEA credential that the guide says was shared in chat.
7. Get a third-party audit of both contracts.

## Fix log

All fixes landed in the working tree on 2026-11-09 and pass the full suite:
coin host 93, coin sandbox 5, factory host 10, factory sandbox 1, brain 21,
gate 24, scripts 7, web 28; clippy clean on both contracts; web typecheck and
build clean. Both deploy paths were then rehearsed on a local nearcore 2.14
node (see the end of this log).

| ID | Fix | Proof |
|---|---|---|
| H-01 | **Mitigated.** The gate now requires each buyer wallet to exist and hold `GATE_MIN_BALANCE_NEAR` (default 1 NEAR on mainnet) before it issues a challenge, with cached, concurrency-bounded RPC lookups. The hint that named the answer's category is gone. Product copy now says "early access pass" / "launch gate", and the FAQ explains what the gate does and doesn't prove. A bot can still pass with funded wallets: this adds a capital cost per wallet, not proof of personhood. | `gate-agent/test/eligibility.test.mjs` (4 tests, including through the HTTP handler) |
| M-01 | Gate and brain HTTP handling moved into tested modules (`gate-agent/src/http.mjs`, `brain/feed-http.mjs`). Unparseable targets get 400, dependency errors get 500, oversized bodies get 413; nothing can throw out of a handler. | `gate-agent/test/http.test.mjs`, `brain/test/feed-http.test.mjs`: real sockets, `GET //`, server still healthy afterwards |
| M-02 | `promise_ok()` treats only `PromiseError::Failed` as failure; used by every coin callback including `on_payout`, and by the factory's `on_refund`. | `pit/tests/pool_result.rs` failed before the fix (80.2 NEAR phantom surplus) and passes now |
| M-03 | `deploy.mjs` re-reads `get_config` after publishing and refuses to continue or lock unless `code_published` is true and the pinned hash equals the local artifact (`assertPublished`). | `scripts/test/deployment-plan.test.mjs`; rehearsal printed "coin code published ✓" before locking |
| M-04 | Retracted (see above). | — |
| M-05 | The factory dispatches a refund only if its free balance (beyond storage, plus 0.01 NEAR) covers it. Otherwise the claim stays `refund_retryable` and anyone, or the web app's Payouts panel, can send it with `retry_refund` once the funds are back. The callback can no longer fail and strand the launch. | `factory/tests/config.rs::failed_launch_refund_waits_for_returning_funds_instead_of_stranding` |
| L-01 | Behind `TRUST_PROXY=1`, gate and RHEA proxy use the **last** `X-Forwarded-For` hop (the one the proxy appended). | gate HTTP tests: rotating a forged header still hits the per-client cap; proxy unit test |
| L-02 | RHEA proxy limits are per client behind a trusted proxy. `report` and `order-submit` bodies must match the exact fields the app and RHEA SDK send, with bounded strings, a supported source chain, `near` destination and a valid recipient. | `webapp/test/cross-chain.test.mjs`: the app's real `fundingReportRequest` output passes; 10 malformed variants are refused |
| L-03 | The brain checks its keeper key at startup. With a function-call key it skips deposit-carrying calls (refund withdrawal, Proof-of-Thought recording), logs once, and doesn't send transactions that would fail. | brain suite |
| L-04 | `storage_deposit` no longer panics on small overpayments. Up to 0.01 NEAR comes straight back (NEP-145), and larger amounts still become withdrawable credits. `registration_only` works as specified. | `pit/tests/recovery.rs::nep145_small_overpayment_is_returned_not_rejected` |
| I-01 | Header comment lists both brain-only calls. | — |
| I-02 | Clippy: `is_none_or`; the `uint!` macro's lints allowed at its module. 0 warnings. | clippy run |
| I-03 | See "Size" below. `npm run artifacts` now regenerates `docs/deployment/artifacts.json`. | — |

### Size

Private callback arguments are internal (only the contract calls itself), so
they are now Borsh instead of JSON. That removes a JSON parser per callback.
Results from external contracts stay JSON.

| | Before | After |
|---|---|---|
| Coin wasm | 337,906 B | **321,756 B** |
| Publication burn | 33.79 NEAR | **32.18 NEAR** |
| Launchpad total before gas | ≈ 37.9 NEAR | **≈ 36.27 NEAR** |

A second pass made `record_thought` take Borsh too (−5.4 KB). Only the brain
calls it; `thoughtBorsh` in `pit/brain/proof.mjs` encodes it, and
`pit/tests/thought_abi.rs` decodes a fixture from that encoder byte for byte.

Hashes: coin `307ed612…785502`, factory `f95c8244…55dfa2` (full values in
`docs/deployment/artifacts.json`).

### Local-node rehearsal (nearcore 2.14, same as mainnet)

1. `deploy.mjs --launchpad --lock` with `FIRST_COIN=doge`: the factory deployed,
   the code was published and verified, the coin was created, and the factory
   was left with 0 keys.
2. `pit/scripts/sandbox-e2e.mjs` on the factory-created coin:
   - buy 100 NEAR;
   - stake (booked, lock released);
   - sell 10% (paid immediately);
   - unstake, unbond, withdraw;
   - harvest 3.587 NEAR to the brain, confirmed; surplus 0 afterwards,
     principal untouched.

### Still required before mainnet (unchanged)

1. Fund `drained99.near` (≈ 36.27 NEAR plus gas and operating funds; 32.18 of it is a permanent burn).
2. Choose a standard validator pool; deploy the production Shade registry
   (`requires_tee: true`) and gate with `GATE_MIN_BALANCE_NEAR` and
   `TRUST_PROXY=1`.
3. Rehearse on testnet with the exact command, then `npm run artifacts` and pin
   the hashes. Rehearse one small RHEA transfer to native NEAR.
4. Rotate the RHEA credential; set `TRUST_PROXY=1` on the web service.
5. Third-party audit of both contracts.
6. Optional, if personhood guarantees are wanted later: a personhood
   credential checked inside the TEE gate.

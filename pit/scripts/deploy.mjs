#!/usr/bin/env node
/**
 * Deploy The Pit (testnet by default, or a local sandbox).
 *
 *   node pit/scripts/deploy.mjs            # deploy + init
 *   node pit/scripts/deploy.mjs --lock     # …then delete the contract's keys (no admin, ever;
 *                                           required on mainnet, also locks the launchpad factory)
 *   node pit/scripts/deploy.mjs --launchpad  # the factory: anyone launches coins
 *        (FIRST_COIN=doge also launches one; publishing the shared coin code
 *         burns ~31 NEAR once, then each coin costs ~0.12 NEAR)
 *
 * Env (pit/scripts/.env, see .env.example):
 *   DEPLOYER_ID / DEPLOYER_PRIVATE_KEY — parent account; creates the subaccounts
 *   POOL       — validator pool id, or "mock" to deploy the test-only mock pool
 *   BRAIN_ID   — account that receives harvested NEAR (default: brain.<deployer>)
 *   AGENT_REGISTRY — Shade Agent contract whose valid agents may sign passes
 *                (production: the agent contract `shade deploy` created, with
 *                requires_tee = true). "mock" deploys the TEST-ONLY registry.
 *   GATE_URL   — a tee-gate whose key to pin statically (dev / simulated).
 *                Neither set → no gated phase.  SALE_ID=PIT-001
 *   LAUNCH_IN_MIN=2  GATED_EPOCHS=2  EPOCH_MIN=30  EPOCH_CAPS=2000000,5000000
 *   NEAR_NETWORK=testnet|mainnet|sandbox  NEAR_RPC=…
 *   Mainnet refuses the test-only mocks and a dev-key gate, and requires
 *   CONFIRM_MAINNET=yes: everything deployed is immutable and costs real NEAR.
 *
 * Creates pit.<deployer> (+ pool.<deployer> for mock, brain.<deployer> if
 * needed) and adds a keeper key on the deployer that can ONLY call
 * rebalance / process_queue / harvest on the contract.
 */
import { accountId, deploymentPlan, storageFundingNear, verifyArtifactPins } from "./deployment-plan.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import BN from "bn.js";
import { connect, KeyPair, keyStores, transactions, utils } from "near-api-js";

const ROOT = path.resolve(import.meta.dirname, "..");
const PLAN = process.argv.includes("--plan");
const LOCK = process.argv.includes("--lock");
const LAUNCHPAD = process.argv.includes("--launchpad");
const NEAR = (n) => new BN(utils.format.parseNearAmount(String(n)));
const TGAS = (n) => new BN(n).mul(new BN(10).pow(new BN(12)));
const ONE_TOKEN = 10n ** 18n;
const YOCTO = 10n ** 24n;

for (const line of fs.existsSync(path.join(ROOT, "scripts/.env")) ? fs.readFileSync(path.join(ROOT, "scripts/.env"), "utf8").split("\n") : []) {
  const m = /^\s*([\w-]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const DEPLOYER = process.env.DEPLOYER_ID;
const NETWORK = process.env.NEAR_NETWORK ?? "testnet";
// rpc.*.near.org no longer answers; FastNEAR's public RPC does.
const RPC = process.env.NEAR_RPC ?? (NETWORK === "sandbox" ? "http://localhost:3030" : `https://rpc.${NETWORK}.fastnear.com`);
const GATE_URL = process.env.GATE_URL ?? "";
const AGENT_REGISTRY = process.env.AGENT_REGISTRY ?? "";
const SALE_ID = process.env.SALE_ID ?? "PIT-001";
if (!DEPLOYER || (!PLAN && !process.env.DEPLOYER_PRIVATE_KEY)) throw new Error("set DEPLOYER_ID and DEPLOYER_PRIVATE_KEY in pit/scripts/.env");
const POOL = process.env.POOL ?? (NETWORK === "mainnet" ? "" : "mock");
if (!["mainnet", "testnet", "sandbox"].includes(NETWORK)) throw new Error("Invalid NEAR_NETWORK");
if (!accountId(DEPLOYER)) throw new Error("Invalid DEPLOYER_ID");
if (NETWORK === "mainnet" && !PLAN) {
  const problems = [
    !POOL && "set POOL to a real validator pool (e.g. a well-known *.poolv1.near)",
    POOL === "mock" && "POOL=mock deploys a TEST-ONLY pool",
    AGENT_REGISTRY === "mock" && "AGENT_REGISTRY=mock deploys a TEST-ONLY registry that whitelists anyone",
    GATE_URL && "GATE_URL pins a dev-key gate; on mainnet use AGENT_REGISTRY with requires_tee = true",
    !DEPLOYER.endsWith(".near") && "DEPLOYER_ID must be a mainnet account",
    !LOCK && "pass --lock: otherwise your deployer key stays a full-access (admin) key on the contract account",
    process.env.CONFIRM_MAINNET !== "yes" && "set CONFIRM_MAINNET=yes (contracts are immutable; publishing coin code burns ~31 NEAR)",
  ].filter(Boolean);
  if (problems.length) throw new Error(`refusing to deploy to mainnet:\n  - ${problems.join("\n  - ")}`);
}
const CONTRACT = `pit.${DEPLOYER}`;
const BRAIN = process.env.BRAIN_ID || `brain.${DEPLOYER}`;

/** Curve + evolution tiers. Tweak before deploying; immutable after. */
const INIT = {
  brain: BRAIN,
  pools: [POOL === "mock" ? `pool.${DEPLOYER}` : POOL],
  virtual_near: (3_000n * YOCTO).toString(),
  virtual_tokens: (1_073_000_000n * ONE_TOKEN).toString(),
  fee_bps: 100,
  buffer_bps: 2_000,
  tiers: [
    { name: "Larva", min_principal: "0" },
    { name: "Juvenile", min_principal: (1_000n * YOCTO).toString() },
    { name: "Adult", min_principal: (10_000n * YOCTO).toString() },
    { name: "Ascended", min_principal: (100_000n * YOCTO).toString() },
  ],
  name: "The Pit",
  symbol: "PIT",
  icon: null,
  launch: null,
};

/**
 * Human-first launch. Passes are accepted from valid Shade agents of
 * `registry` and/or from a statically pinned gate key read from GATE_URL.
 */
async function launchConfig(registry) {
  if (!GATE_URL && !registry) return null;
  const info = GATE_URL ? await (await fetch(`${GATE_URL}/api/info`)).json() : { sale_id: SALE_ID };
  if (GATE_URL && (!info.signing_address || !info.sale_id)) throw new Error(`gate ${GATE_URL} gave no signing_address/sale_id`);
  const caps = (process.env.EPOCH_CAPS ?? "2000000,5000000").split(",");
  const n = Number(process.env.GATED_EPOCHS ?? caps.length);
  const epochMs = Number(process.env.EPOCH_MIN ?? "30") * 60_000;
  const starts = Date.now() + Number(process.env.LAUNCH_IN_MIN ?? "2") * 60_000;
  const evidence = GATE_URL ? await fetch(`${GATE_URL}/api/gate/attestation?nonce=${"00".repeat(32)}`).then((r) => r.text()).catch(() => "") : "";
  return {
    sale_id: info.sale_id,
    starts_at_ms: starts,
    gated_epochs: Array.from({ length: n }, (_, i) => ({
      ends_at_ms: starts + (i + 1) * epochMs,
      per_buyer_max_tokens: caps[Math.min(i, caps.length - 1)],
    })),
    verifiers: GATE_URL
      ? [{
          pubkey_hex: info.signing_address,
          name: info.verifier_name ?? "tee-gate",
          evidence_hash_hex: crypto.createHash("sha256").update(evidence).digest("hex"),
        }]
      : [],
    agent_registry: registry || null,
  };
}

/**
 * NEAR locks 1 NEAR per 100 KB of storage (1e19 yocto/byte). Fund each
 * contract account with exactly its code + an allowance for state, instead of
 * round numbers. Leftover is recoverable later; locked storage is not.
 */
const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;
const fundFor = (code, stateBytes) => storageFundingNear(code.length, stateBytes);
let spent = 0;

/**
 * The coin's `new` takes Borsh args (smaller contract). Encode INIT in its
 * parameter order: strings/account ids are u32-length-prefixed UTF-8, U128 is
 * 16 bytes LE, Option is a 0/1 tag, Vec is a u32 count.
 */
function coinInitBorsh(a) {
  const out = [];
  const u8 = (n) => out.push(n & 0xff);
  const le = (v, bytes) => { let x = BigInt(v); for (let i = 0; i < bytes; i++) { out.push(Number(x & 0xffn)); x >>= 8n; } };
  const str = (t) => { const b = Buffer.from(t, "utf8"); le(b.length, 4); out.push(...b); };
  const opt = (v, f) => (v == null ? u8(0) : (u8(1), f(v)));
  const vec = (xs, f) => { le(xs.length, 4); xs.forEach(f); };
  str(a.brain);
  vec(a.pools, str);
  le(a.virtual_near, 16);
  le(a.virtual_tokens, 16);
  le(a.fee_bps, 2);
  le(a.buffer_bps, 2);
  vec(a.tiers, (t) => { str(t.name); le(t.min_principal, 16); });
  str(a.name);
  str(a.symbol);
  opt(a.icon, str);
  opt(a.launch, (l) => {
    str(l.sale_id);
    le(l.starts_at_ms, 8);
    vec(l.gated_epochs, (e) => { le(e.ends_at_ms, 8); le(e.per_buyer_max_tokens, 16); });
    vec(l.verifiers, (v) => { str(v.pubkey_hex); str(v.name); str(v.evidence_hash_hex); });
    opt(l.agent_registry, str);
  });
  opt(a.creator, (c) => { str(c.account_id); le(c.share_bps, 2); });
  opt(a.thinker, str);
  return Uint8Array.from(out);
}

const wasm = (dir, file) => {
  const p = path.join(ROOT, "contracts", dir, "target", "near", file);
  if (!fs.existsSync(p)) throw new Error(`missing ${p} — run: node pit/scripts/build.mjs`);
  return fs.readFileSync(p);
};

const main = async () => {
  if (PLAN) {
    if (NETWORK !== "mainnet") throw new Error("--plan currently requires NEAR_NETWORK=mainnet");
    console.log(JSON.stringify(deploymentPlan({deployer:DEPLOYER,brain:BRAIN,pool:POOL,registry:AGENT_REGISTRY,launchpad:LAUNCHPAD,coinCode:wasm("pit","pit.wasm"),factoryCode:LAUNCHPAD?wasm("factory","pit_factory.wasm"):null}),null,2));
    return;
  }
  const build = spawnSync(process.execPath, [path.join(ROOT, "scripts", "build.mjs")], { stdio: "inherit" });
  if (build.status !== 0) throw new Error("wasm build failed");

  if (NETWORK === "mainnet") {
    const plan = deploymentPlan({deployer:DEPLOYER,brain:BRAIN,pool:POOL,registry:AGENT_REGISTRY,launchpad:LAUNCHPAD,coinCode:wasm("pit","pit.wasm"),factoryCode:LAUNCHPAD?wasm("factory","pit_factory.wasm"):null});
    verifyArtifactPins(plan,process.env);
    const response = await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:"network",method:"status",params:[]}),signal:AbortSignal.timeout(15000)});
    const status = await response.json();
    if (!response.ok || status.error || status.result?.chain_id !== "mainnet") throw new Error("RPC is not verified mainnet");
  }
  const keyStore = new keyStores.InMemoryKeyStore();
  const deployerKey = KeyPair.fromString(process.env.DEPLOYER_PRIVATE_KEY);
  await keyStore.setKey(NETWORK, DEPLOYER, deployerKey);
  const near = await connect({ networkId: NETWORK, nodeUrl: RPC, keyStore });
  const deployer = await near.account(DEPLOYER);

  const exists = async (id) => {
    try { await (await near.account(id)).state(); return true; }
    catch (error) {
      if (error.type === "AccountDoesNotExist" || /does not exist while viewing/.test(error.message ?? "")) return false;
      throw error; // A network/RPC failure is not evidence that an account is absent.
    }
  };
  if (NETWORK === "mainnet" && await exists(CONTRACT)) throw new Error("Fresh mainnet deployment only: target already exists; this script does not migrate or resume it");
  if (NETWORK === "mainnet") {
    const pool = await deployer.viewFunction({contractId:POOL,methodName:"get_account",args:{account_id:CONTRACT}});
    if (pool.account_id !== CONTRACT || !/^\d+$/.test(pool.staked_balance) || !/^\d+$/.test(pool.unstaked_balance)) throw new Error("Validator pool does not expose the expected NEAR staking interface");
    if (AGENT_REGISTRY) {
      const registryInfo = await deployer.viewFunction({contractId:AGENT_REGISTRY,methodName:"get_contract_info",args:{}});
      if (registryInfo.requires_tee !== true) throw new Error("Mainnet registry must require TEE attestation");
    }
    if (process.env.BRAIN_ID && !await exists(BRAIN)) throw new Error("Configured BRAIN_ID does not exist on mainnet");
  }
  const subaccount = async (id, balance) => {
    if (await exists(id)) { console.log(`exists: ${id}`); return; }
    await deployer.createAccount(id, deployerKey.getPublicKey(), NEAR(balance));
    spent += balance;
    console.log(`created ${id} (${balance} NEAR)`);
  };

  if (POOL === "mock") {
    const poolId = `pool.${DEPLOYER}`;
    await subaccount(poolId, fundFor(wasm("mock-pool", "mock_pool.wasm"), 20_000));
    await keyStore.setKey(NETWORK, poolId, deployerKey);
    const pool = await near.account(poolId);
    await pool.signAndSendTransaction({
      receiverId: poolId,
      actions: [
        transactions.deployContract(wasm("mock-pool", "mock_pool.wasm")),
        transactions.functionCall("new", { unstake_delay_ms: 60_000 }, TGAS(30), new BN(0)),
      ],
    });
    console.log(`mock pool live: ${poolId} (TEST ONLY · 60 s unstake)`);
  }
  // An empty account just needs its own record (~182 bytes) + a little for gas.
  if (!process.env.BRAIN_ID) await subaccount(BRAIN, 0.05);

  let registry = AGENT_REGISTRY;
  if (AGENT_REGISTRY === "mock") {
    registry = `registry.${DEPLOYER}`;
    await subaccount(registry, fundFor(wasm("mock-agent-registry", "mock_agent_registry.wasm"), 20_000));
    await keyStore.setKey(NETWORK, registry, deployerKey);
    const reg = await near.account(registry);
    await reg.signAndSendTransaction({
      receiverId: registry,
      actions: [
        transactions.deployContract(wasm("mock-agent-registry", "mock_agent_registry.wasm")),
        transactions.functionCall("new", { owner_id: DEPLOYER, attestation_expiration_time_ms: String(7 * 86_400_000) }, TGAS(30), new BN(0)),
      ],
    });
    console.log(`mock agent registry live: ${registry} (TEST ONLY · no TEE verification · owner ${DEPLOYER} whitelists agents)`);
  }
  INIT.launch = await launchConfig(registry);
  if (INIT.launch) {
    const who = [registry && `Shade agents of ${registry}`, INIT.launch.verifiers[0] && `pinned key ${INIT.launch.verifiers[0].pubkey_hex.slice(0, 16)}…`].filter(Boolean).join(" + ");
    console.log(`human-first launch ${INIT.launch.sale_id}: passes from ${who}; opens ${new Date(INIT.launch.starts_at_ms).toLocaleTimeString()}`);
  }

  if (LAUNCHPAD) return deployLaunchpad({ near, keyStore, deployer, deployerKey, registry, subaccount, spentSoFar: () => spent });

  // State float: contract state + early token accounts/tickets/passes before
  // users' own storage deposits take over (each of those is user-funded).
  await subaccount(CONTRACT, fundFor(wasm("pit", "pit.wasm"), 30_000));
  await keyStore.setKey(NETWORK, CONTRACT, deployerKey);
  const contract = await near.account(CONTRACT);
  await contract.signAndSendTransaction({
    receiverId: CONTRACT,
    actions: [
      transactions.deployContract(wasm("pit", "pit.wasm")),
      transactions.functionCall("new", coinInitBorsh({ ...INIT, creator: null, thinker: DEPLOYER }), TGAS(50), new BN(0)),
    ],
  });
  console.log(`The Pit live: ${CONTRACT}`);

  // Keeper key: function-call only, these three methods, 1 NEAR gas allowance.
  const keeper = KeyPair.fromRandom("ed25519");
  writeKeeperFile({PIT_CONTRACT:CONTRACT,KEEPER_ACCOUNT_ID:DEPLOYER,KEEPER_PRIVATE_KEY:keeper.toString()});
  await deployer.addKey(keeper.getPublicKey(), CONTRACT, ["rebalance", "process_queue", "harvest"], NEAR(1));

  if (LOCK) {
    const keys = await contract.getAccessKeys();
    for (const k of keys) await contract.deleteKey(k.public_key);
    console.log(`🔒 deleted ${keys.length} key(s) on ${CONTRACT}: the code can never be changed or drained by anyone`);
  }

  console.log(`\nNEAR spent creating accounts: ${spent.toFixed(2)} (mostly locked for code storage)`);
  console.log(`
— put this in pit/brain/.env —
PIT_CONTRACT=${CONTRACT}
KEEPER_ACCOUNT_ID=${DEPLOYER}
KEEPER_PRIVATE_KEY=<read the private keeper file printed below>

— brain meter —
open "pit/web/index.html?contract=${CONTRACT}"
`);
};

/**
 * Launchpad: factory at pit.<deployer>; coins at <symbol>.pit.<deployer>.
 * The coin code is published once as a global contract pinned by hash.
 */
async function deployLaunchpad({ near, keyStore, deployer, deployerKey, registry, subaccount, spentSoFar }) {
  const FACTORY = `pit.${DEPLOYER}`;
  const coinCode = wasm("pit", "pit.wasm");
  const hash = crypto.createHash("sha256").update(coinCode).digest("hex");
  const pinned = INIT.launch?.verifiers ?? [];

  // A little extra float covers refunds that land before failed-launch deposits return.
  await subaccount(FACTORY, fundFor(wasm("factory", "pit_factory.wasm"), 20_000) + 1);
  await keyStore.setKey(NETWORK, FACTORY, deployerKey);
  const factory = await near.account(FACTORY);
  await factory.signAndSendTransaction({
    receiverId: FACTORY,
    actions: [
      transactions.deployContract(wasm("factory", "pit_factory.wasm")),
      transactions.functionCall("new", {
        coin_code_hash_hex: hash,
        brain: BRAIN,
        // The keeper account also records Proof-of-Thought entries.
        thinker: `keeper.${DEPLOYER}`,
        pools: INIT.pools,
        agent_registry: registry || null,
        verifiers: pinned,
        defaults: {
          virtual_near: INIT.virtual_near,
          virtual_tokens: INIT.virtual_tokens,
          fee_bps: INIT.fee_bps,
          buffer_bps: INIT.buffer_bps,
          tiers: INIT.tiers,
        },
        coin_deposit: utils.format.parseNearAmount("0.1"),
      }, TGAS(50), new BN(0)),
    ],
  });
  console.log(`factory live: ${FACTORY} (pinned coin code ${hash.slice(0, 16)}…)`);

  // Publish the coin code as a global contract (borsh Vec<u8>: u32 LE length + bytes).
  const info = await factory.viewFunction({ contractId: FACTORY, methodName: "get_config", args: {} });
  if (!info.code_published) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(coinCode.length);
    const burn = BigInt(coinCode.length) * STORAGE_YOCTO_PER_BYTE * 10n;
    console.log(`publishing shared coin code: ${coinCode.length} bytes, burns ${(Number(burn / 10n ** 21n) / 1000).toFixed(2)} NEAR once…`);
    await deployer.functionCall({
      contractId: FACTORY,
      methodName: "publish_coin_code",
      args: Buffer.concat([len, coinCode]),
      gas: TGAS(300),
      attachedDeposit: new BN(burn.toString()),
    });
  }

  // Keeper: coins are many contracts, so it's its own small account (gas money
  // only) whose key the brain holds; the brain only calls the 3 keeper methods.
  const KEEPER = `keeper.${DEPLOYER}`;
  let keeperLine = "KEEPER_PRIVATE_KEY=<keep the key you already have for this account>";
  try {
    await (await near.account(KEEPER)).state();
    console.log(`exists: ${KEEPER}`);
  } catch {
    const keeperKey = KeyPair.fromRandom("ed25519");
    writeKeeperFile({PIT_FACTORY:FACTORY,KEEPER_ACCOUNT_ID:KEEPER,KEEPER_PRIVATE_KEY:keeperKey.toString()});
    await deployer.createAccount(KEEPER, keeperKey.getPublicKey(), NEAR(1));
    keeperLine = "KEEPER_PRIVATE_KEY=<read the private keeper file printed above>";
    console.log(`created ${KEEPER} (1 NEAR for gas)`);
  }

  if (process.env.FIRST_COIN) {
    const cost = await factory.viewFunction({ contractId: FACTORY, methodName: "create_cost", args: {} });
    const sym = process.env.FIRST_COIN.toLowerCase();
    await deployer.functionCall({
      contractId: FACTORY,
      methodName: "create_coin",
      args: {
        symbol: sym,
        name: process.env.FIRST_COIN_NAME ?? sym.toUpperCase(),
        icon: null,
        launch: INIT.launch ? { starts_in_ms: "0", epochs: INIT.launch.gated_epochs.map((e, i, a) => ({ duration_ms: String(e.ends_at_ms - (i ? a[i - 1].ends_at_ms : INIT.launch.starts_at_ms)), per_buyer_max_tokens: e.per_buyer_max_tokens })) } : null,
        creator_share_bps: 0,
      },
      gas: TGAS(150),
      attachedDeposit: new BN(cost),
    });
    console.log(`first coin live: ${sym}.${FACTORY}`);
  }

  if (LOCK) {
    // Last step: the code is published, so the factory needs no key. Without
    // this, the deployer key could redeploy the factory.
    const keys = await factory.getAccessKeys();
    for (const k of keys) await factory.deleteKey(k.public_key);
    const left = await factory.getAccessKeys();
    if (left.length) throw new Error(`${FACTORY} still has ${left.length} key(s)`);
    console.log(`🔒 deleted ${keys.length} key(s) on ${FACTORY}: nobody can change the launchpad. Coins it creates have no keys at all.`);
  } else {
    console.log(`⚠️  ${FACTORY} still has your full-access key. Re-run with --lock (required on mainnet) to remove it.`);
  }

  console.log(`\nNEAR spent creating accounts: ${spentSoFar().toFixed(2)} (+ the one-time code publish)`);
  console.log(`
— brain (Railway "brain" service variables) —
PIT_FACTORY=${FACTORY}
KEEPER_ACCOUNT_ID=${KEEPER}
${keeperLine}

— web (Railway "web" service variables) —
VITE_PIT_FACTORY=${FACTORY}
`);
}

function writeKeeperFile(values) {
  const file = path.join(ROOT,"scripts",`.keeper-${NETWORK}-${Date.now()}.env`);
  fs.writeFileSync(file,Object.entries(values).map(([key,value])=>`${key}=${value}`).join("\n")+"\n",{flag:"wx",mode:0o600});
  console.log(`Keeper credentials written privately to ${file}. Store them in the brain service secret variables; do not commit this file.`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});

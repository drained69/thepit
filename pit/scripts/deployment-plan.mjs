import crypto from 'node:crypto';
export function accountId(value) {
  return typeof value === 'string' && /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
}
export function storageFundingNear(codeBytes, stateBytes) {
  if (![codeBytes,stateBytes].every(n=>Number.isSafeInteger(n)&&n>=0)) throw Error('Invalid storage size');
  const amount = BigInt(codeBytes + stateBytes) * 10n**19n;
  const cent = 10n**22n;
  return Number((amount + cent - 1n) / cent) / 100;
}
export function deploymentPlan({deployer,brain,pool,registry,launchpad,coinCode,factoryCode}) {
  if (!accountId(deployer) || !deployer.endsWith('.near')) throw Error('Use a valid mainnet parent account');
  const factory=`pit.${deployer}`;
  if (!accountId(factory) || (launchpad && factory.length + 17 > 64)) throw Error('Parent account is too long for coin subaccounts');
  if (!accountId(brain) || !accountId(pool) || pool==='mock' || !pool.endsWith('.near')) throw Error('Set a mainnet brain and validator pool');
  if (registry && (!accountId(registry) || !registry.endsWith('.near'))) throw Error('Invalid mainnet registry');
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  return {network:'mainnet',deployer,contract:factory,brain,pool,registry:registry||null,launchpad,
    coin_code_sha256:hash(coinCode),factory_code_sha256:launchpad?hash(factoryCode):null,
    coin_bytes:coinCode.length,factory_bytes:launchpad?factoryCode.length:null,
    contract_account_funding_near:storageFundingNear(launchpad?factoryCode.length:coinCode.length,launchpad?20000:30000)+(launchpad?1:0),
    // 10x storage price per byte, burned. Reported in NEAR, exact to 4 places.
    global_publish_near:launchpad?(Number(BigInt(coinCode.length)*10n**20n/10n**20n)/10_000).toFixed(4):'0',
    global_publish_yocto:launchpad?(BigInt(coinCode.length)*10n**20n).toString():'0',
    note:'Read-only plan. Funding excludes gas, gate deployment, keeper/brain accounts and future liquidity; confirm live protocol costs before signing.'};
}
export function verifyArtifactPins(plan,env) {
  if (env.MAINNET_COIN_CODE_SHA256 !== plan.coin_code_sha256) throw Error('MAINNET_COIN_CODE_SHA256 must match the reviewed rebuilt coin artifact');
  if (plan.launchpad && env.MAINNET_FACTORY_CODE_SHA256 !== plan.factory_code_sha256) throw Error('MAINNET_FACTORY_CODE_SHA256 must match the reviewed rebuilt factory artifact');
}

/**
 * Before deleting the factory's keys: the pinned coin code must really be
 * published. Locking a factory whose publish failed strands the NEAR attached
 * for the burn in a factory that can never launch a coin.
 */
export function assertPublished(config, coinSha256) {
  if (config?.code_published !== true) throw Error('Coin code is not published on the factory: refusing to lock. Inspect the publish transaction first.');
  if (config.coin_code_hash !== coinSha256) throw Error(`Factory pins ${config.coin_code_hash}, not the local artifact ${coinSha256}: refusing to lock.`);
}

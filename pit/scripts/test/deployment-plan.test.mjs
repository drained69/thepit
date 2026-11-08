import test from 'node:test';
import assert from 'node:assert/strict';
import {storageFundingNear,deploymentPlan,verifyArtifactPins} from '../deployment-plan.mjs';
const input={deployer:'drained99.near',brain:'brain.drained99.near',pool:'validator.poolv1.near',registry:null,launchpad:true,coinCode:Buffer.from('coin'),factoryCode:Buffer.from('factory')};
test('storage funding rounds up even just beyond cent boundaries',()=>{
  assert.equal(storageFundingNear(1000,0),.01);
  assert.equal(storageFundingNear(1001,0),.02);
  assert.equal(storageFundingNear(1,0),.01);
  assert.throws(()=>storageFundingNear(-1,10));
});
test('read-only plan binds immutable artifact hashes and public accounts',()=>{
  const plan=deploymentPlan(input);
  assert.equal(plan.contract,'pit.drained99.near');
  assert.equal(plan.coin_code_sha256.length,64);
  assert.equal(plan.global_publish_near,'400000000000000000000');
  assert.throws(()=>verifyArtifactPins(plan,{}),/COIN/);
  assert.throws(()=>verifyArtifactPins(plan,{MAINNET_COIN_CODE_SHA256:plan.coin_code_sha256}),/FACTORY/);
  verifyArtifactPins(plan,{MAINNET_COIN_CODE_SHA256:plan.coin_code_sha256,MAINNET_FACTORY_CODE_SHA256:plan.factory_code_sha256});
  assert.throws(()=>verifyArtifactPins({...plan,coin_code_sha256:'changed'},{MAINNET_COIN_CODE_SHA256:plan.coin_code_sha256}),/COIN/);
});
test('plan rejects mock pools, invalid accounts and oversized subaccounts',()=>{
  for(const invalid of [{pool:'mock'},{deployer:'drained99.testnet'},{brain:'bad..near'},{deployer:'a'.repeat(45)+'.near'}])assert.throws(()=>deploymentPlan({...input,...invalid}));
});

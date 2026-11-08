import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {emptyState,loadLedger,saveLedger,reserveBudget,settleBudget} from '../ledger.mjs';
function fixture(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pit-ledger-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'ledger.json');const state=emptyState();state.coins.pit={credits_usd:1,spent_usd:0,seen_harvested:'10',memory:[]};return {dir,file,state};}
test('atomic ledger replacement preserves data and private permissions',t=>{const {dir,file,state}=fixture(t);saveLedger(file,state);assert.deepEqual(loadLedger(file),state);assert.equal(fs.statSync(file).mode&0o777,0o600);state.ticks++;saveLedger(file,state);assert.equal(loadLedger(file).ticks,1);assert.deepEqual(fs.readdirSync(dir),['ledger.json']);});
test('missing ledger starts empty, corruption fails closed',t=>{const {file}=fixture(t);assert.deepEqual(loadLedger(file),emptyState());for(const data of ['{','{}',JSON.stringify({coins:{pit:{credits_usd:-1}},ticks:0,tg_offset:0})]){fs.writeFileSync(file,data);assert.throws(()=>loadLedger(file),/unreadable or invalid/);}});
test('reservation survives restart before provider returns; settlement refunds only unused reservation',t=>{const {file,state}=fixture(t);const coin=state.coins.pit;const checkpoint=()=>saveLedger(file,state);assert.equal(reserveBudget(coin,.4,checkpoint),true);assert.equal(loadLedger(file).coins.pit.credits_usd,.6);assert.equal(loadLedger(file).coins.pit.spent_usd,.4);settleBudget(coin,.4,.1,checkpoint);assert.equal(loadLedger(file).coins.pit.credits_usd,.9);assert.ok(Math.abs(coin.spent_usd-.1)<1e-12);});
test('failed checkpoint prevents request reservation and insufficient budget stays unchanged',()=>{const coin={credits_usd:1,spent_usd:0};assert.throws(()=>reserveBudget(coin,.2,()=>{throw Error('disk full');}),/disk full/);assert.deepEqual(coin,{credits_usd:1,spent_usd:0});assert.equal(reserveBudget(coin,2,()=>{throw Error('must not write');}),false);});

test('negative and nonfinite cost cannot create spendable credit',()=>{
  const coin={credits_usd:1,spent_usd:0};
  for(const invalid of [NaN,Infinity,-1]){
    assert.throws(()=>reserveBudget(coin,invalid,()=>{}),/Invalid/);
    assert.throws(()=>settleBudget(coin,.1,invalid,()=>{}),/Invalid/);
  }
  assert.deepEqual(coin,{credits_usd:1,spent_usd:0});
});

test('exclusive ledger lock rejects other writers and does not reclaim unknown locks',async t=>{
  const {acquireLedgerLock}=await import('../ledger.mjs');const {file}=fixture(t);
  const release=acquireLedgerLock(file);
  assert.throws(()=>acquireLedgerLock(file),/locked/);
  release();release();
  const releaseAgain=acquireLedgerLock(file);releaseAgain();
  fs.writeFileSync(file+'.lock','stale or unknown');
  assert.throws(()=>acquireLedgerLock(file),/locked/);
  assert.equal(fs.readFileSync(file+'.lock','utf8'),'stale or unknown');
});
test('mainnet requires explicit persistent ledger configuration',async()=>{
  const {assertPersistentLedger}=await import('../ledger.mjs');
  for(const [file,confirmed] of [[undefined,false],['relative.json',true],['/data/ledger.json',false]]) assert.throws(()=>assertPersistentLedger(file,{network:'mainnet',confirmed}),/persistent/);
  assertPersistentLedger('/data/ledger.json',{network:'mainnet',confirmed:true});
  assertPersistentLedger(undefined,{network:'testnet'});
});

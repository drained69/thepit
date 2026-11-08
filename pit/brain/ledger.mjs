/** Single-writer ledger persistence. Put BRAIN_STATE_FILE on a persistent volume. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export function emptyState() { return {coins:{},ticks:0,tg_offset:0}; }
export function validateState(state) {
  if (!state || typeof state !== 'object' || !state.coins || Array.isArray(state.coins) || typeof state.coins !== 'object' || !Number.isSafeInteger(state.ticks) || state.ticks < 0 || !Number.isSafeInteger(state.tg_offset) || state.tg_offset < 0) throw Error('Invalid brain ledger');
  for (const coin of Object.values(state.coins)) {
    if (!coin || !Number.isFinite(coin.credits_usd) || coin.credits_usd < 0 || !Number.isFinite(coin.spent_usd) || coin.spent_usd < 0 || (coin.seen_harvested != null && !/^\d+$/.test(coin.seen_harvested)) || !Array.isArray(coin.memory) || coin.memory.some(text => typeof text !== 'string')) throw Error('Invalid coin ledger');
  }
  return state;
}
export function loadLedger(file) {
  try { return validateState(JSON.parse(fs.readFileSync(file,'utf8'))); }
  catch(error) {
    if(error.code==='ENOENT') return emptyState();
    throw Error('Brain ledger is unreadable or invalid; restore it before resuming inference', {cause:error});
  }
}
export function saveLedger(file,state) {
  validateState(state);
  const temp=`${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd=fs.openSync(temp,'wx',0o600);
    fs.writeFileSync(fd,JSON.stringify(state,null,2));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(temp,file);
    const dir=fs.openSync(path.dirname(file),'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if(fd!==undefined) fs.closeSync(fd);
    try{fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
/** Persist a debit before starting a possibly billable request. On uncertain
 * failures leave it reserved: a timeout does not prove the provider did no work. */
export function reserveBudget(coin,amount,checkpoint) {
  if(!Number.isFinite(amount)||amount<=0) throw Error('Invalid budget reservation');
  if(coin.credits_usd<amount)return false;
  const before={credits_usd:coin.credits_usd,spent_usd:coin.spent_usd};
  coin.credits_usd-=amount;coin.spent_usd+=amount;
  try{checkpoint();}catch(error){Object.assign(coin,before);throw error;}
  return true;
}
export function settleBudget(coin,reserved,actual,checkpoint) {
  if(!Number.isFinite(actual)||actual<0)throw Error('Invalid inference usage cost');
  coin.credits_usd=Math.max(0,coin.credits_usd+reserved-actual);
  coin.spent_usd=Math.max(0,coin.spent_usd-reserved+actual);
  checkpoint();
}

/** Exclusive process lock. Never automatically reclaim an unknown/stale lock:
 * another replica may still be spending. After an unclean exit, stop every
 * replica and remove the lock manually before restarting one writer. */
export function acquireLedgerLock(file) {
  const lockFile=`${file}.lock`;
  const token=crypto.randomBytes(32).toString('hex');
  let fd;
  try {
    fd=fs.openSync(lockFile,'wx',0o600);
    fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token,created_at:new Date().toISOString()}));
    fs.fsyncSync(fd);
  } catch(error) {
    if(fd!==undefined) { fs.closeSync(fd); try{fs.unlinkSync(lockFile);}catch{} }
    throw Error('Brain ledger is locked or cannot be locked. Stop all writers before recovering an abandoned lock.',{cause:error});
  }
  fs.closeSync(fd);
  let released=false;
  return () => {
    if(released)return;
    const current=JSON.parse(fs.readFileSync(lockFile,'utf8'));
    if(current.token!==token)throw Error('Brain ledger lock ownership changed');
    fs.unlinkSync(lockFile);released=true;
  };
}

export function assertPersistentLedger(file,{network,simulation=false,confirmed=false}={}) {
  if(network==='mainnet' && !simulation && (!file || !path.isAbsolute(file) || confirmed!==true)) {
    throw Error('Mainnet brain requires an absolute BRAIN_STATE_FILE on persistent storage and BRAIN_PERSISTENT_STORAGE_CONFIRMED=yes');
  }
}

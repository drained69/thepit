#!/usr/bin/env node
/** Read-only mainnet checks. Never loads private keys or sends transactions. */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { accountId } from './deployment-plan.mjs';
export async function rpcCall(url,method,params,fetchImpl=fetch) {
  const response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'pit-readiness',method,params}),signal:AbortSignal.timeout(15000)});
  const data=await response.json();
  if(!response.ok)throw Error(`RPC HTTP ${response.status}`);
  if(data.error){const error=Error('RPC query failed');error.rpc=data.error;throw error;}
  return data.result;
}
export async function readAccount(rpc,account) {
  try{return await rpc('query',{request_type:'view_account',account_id:account,finality:'final'});}
  catch(error){if(error.rpc?.cause?.name==='UNKNOWN_ACCOUNT')return null;throw error;}
}
const near=(value)=>{const n=BigInt(value);return `${n/10n**24n}.${(n%10n**24n).toString().padStart(24,'0')}`;};
export async function readiness({deployer='drained99.near',url='https://rpc.mainnet.fastnear.com',pool,registry,fetchImpl=fetch}={}) {
  if(!accountId(deployer)||!deployer.endsWith('.near'))throw Error('Use a mainnet account');
  const rpc=(method,params)=>rpcCall(url,method,params,fetchImpl);
  const network=await rpc('status',[]);
  if(network.chain_id!=='mainnet')throw Error('RPC did not identify as mainnet');
  const target=`pit.${deployer}`;
  const [owner,factory,protocol]=await Promise.all([readAccount(rpc,deployer),readAccount(rpc,target),rpc('EXPERIMENTAL_protocol_config',{finality:'final'})]);
  const errors=[];
  if(!owner)errors.push('Deployment parent does not exist');
  if(factory)errors.push('Target already exists: fresh-deployment script must not be used as an upgrade');
  const storageCost=protocol.runtime_config?.storage_amount_per_byte;
  if(!/^\d+$/.test(storageCost||''))throw Error('RPC returned no storage byte cost');
  const available=owner?BigInt(owner.amount)-BigInt(owner.storage_usage)*BigInt(storageCost):0n;
  if(owner && available<=0n)errors.push('Deployment parent has no spendable NEAR');
  const callView=async(contract,method)=>{
    const result=await rpc('query',{request_type:'call_function',account_id:contract,method_name:method,args_base64:Buffer.from(JSON.stringify(method==='get_account'?{account_id:target}:{})).toString('base64'),finality:'final'});
    return JSON.parse(Buffer.from(result.result).toString());
  };
  if(pool){if(!accountId(pool)||!pool.endsWith('.near'))throw Error('Invalid pool account');const state=await callView(pool,'get_account');if(state.account_id!==target)errors.push('Pool returned a foreign account');}
  else errors.push('Validator pool has not been selected and verified');
  if(registry){if(!accountId(registry)||!registry.endsWith('.near'))throw Error('Invalid registry account');const info=await callView(registry,'get_contract_info');if(info.requires_tee!==true)errors.push('Registry does not require TEE attestation');}
  else errors.push('Production TEE gate registry has not been selected and verified');
  return {network:'mainnet',deployer,target,parent_exists:!!owner,target_exists:!!factory,parent_balance_near:owner?near(owner.amount):null,parent_available_after_storage_near:near(available>0n?available:0n),pool:pool||null,registry:registry||null,automated_checks_passed:errors.length===0,issues:errors,notice:'Read-only checks do not establish launch safety or authorize deployment. Verify final artifact pins, gate identity, persistent brain storage, native cross-chain delivery and budget before signing.'};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))readiness({deployer:process.env.DEPLOYER_ID||'drained99.near',url:process.env.NEAR_RPC||'https://rpc.mainnet.fastnear.com',pool:process.env.POOL,registry:process.env.AGENT_REGISTRY}).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});

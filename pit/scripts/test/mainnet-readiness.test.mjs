import test from 'node:test';
import assert from 'node:assert/strict';
import {readiness} from '../mainnet-readiness.mjs';
function mock({chain='mainnet',exists=false,networkFailure=false}={}){return async(url,opts)=>{
 const req=JSON.parse(opts.body);let result;
 if(req.method==='status')result={chain_id:chain};
 else if(req.method==='EXPERIMENTAL_protocol_config')result={runtime_config:{storage_amount_per_byte:'10000000000000000000'}};
 else if(req.params.account_id==='pit.drained99.near'&&!exists){if(networkFailure)throw Error('network unavailable');return new Response(JSON.stringify({error:{cause:{name:'UNKNOWN_ACCOUNT'}}}));}
 else result={amount:'100000000000000000000000000',storage_usage:1000};
 return new Response(JSON.stringify({result}));
};}
test('mainnet preflight is read-only and identifies missing production dependencies',async()=>{
 const result=await readiness({fetchImpl:mock()});assert.equal(result.parent_exists,true);assert.equal(result.target_exists,false);assert.equal(result.parent_available_after_storage_near,'99.990000000000000000000000');assert.equal(result.automated_checks_passed,false);assert.equal(result.issues.length,2);
});
test('preflight rejects testnet RPC, existing deployment, and unknown network errors',async()=>{
 await assert.rejects(()=>readiness({fetchImpl:mock({chain:'testnet'})}),/mainnet/);
 assert.ok((await readiness({fetchImpl:mock({exists:true})})).issues.some(s=>s.includes('Target already exists')));
 await assert.rejects(()=>readiness({fetchImpl:mock({networkFailure:true})}),/network unavailable/);
});

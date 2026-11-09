import test from 'node:test';
import assert from 'node:assert/strict';
import {maintainClaims} from '../claims.mjs';
test('keeper retries confirmed failures, leaves unknown transfers locked, and withdraws its credits',async()=>{
 const calls=[];
 const result=await maintainClaims({keeperId:'keeper.near',read:async(method,args)=>method==='get_refund_credit'?{available:'100',in_flight:'0'}:args.creator?{failed:false,in_flight:true}:{failed:true,in_flight:false},call:async(...args)=>{calls.push(args);return {ok:true};}});
 assert.equal(result.harvestPending,true);assert.deepEqual(calls,[['retry_harvest',{creator:false},'0'],['withdraw_refund',{},'1']]);
});
test('keeper does not resend unknown refunds or create unnecessary transactions',async()=>{
 let calls=0;
 const result=await maintainClaims({keeperId:'keeper.near',read:async(method)=>method==='get_refund_credit'?{available:'100',in_flight:'50'}:null,call:()=>{calls++;}});
 assert.equal(calls,0);assert.equal(result.harvestPending,false);
});

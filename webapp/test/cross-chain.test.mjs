import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createRheaProxy,validateRoute} from '../server/rhea-proxy.mjs';
import {toUnits,displayUnits,fundingClient} from '../src/pit/crossChain.ts';
const route={fromChain:'8453',toChain:'near',sender:'0x'+'a'.repeat(40),recipient:'buyer.near',amountIn:'1000000',slippage:50};
async function request(handle,path,body,method=body?'POST':'GET',headers={}) {
  const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);
  Object.assign(req,{url:'/api/cross-chain'+path,method,headers:{'content-type':'application/json',...headers},socket:{remoteAddress:'127.0.0.1'}});
  const result={};
  const res={writeHead(status,headers){result.status=status;result.headers=headers;},end(data){result.body=JSON.parse(data);}};
  assert.equal(await handle(req,res),true);return result;
}
test('exact source amounts reject rounding, exponent and zero',()=>{
  assert.equal(toUnits('1.000001',6),'1000001');
  assert.equal(displayUnits('1000001',6),'1.000001');
  for(const v of ['0','-1','1e6','1.0000001',' 2']) assert.throws(()=>toUnits(v,6));
});
test('funding routes only support EVM sources to a valid NEAR destination',()=>{
  validateRoute('/api/v2/swap/quote',route);
  for(const bad of [{toChain:'solana'},{fromChain:'near'},{recipient:'https://bad'},{sender:'wrong'},{amountIn:'0'},{slippage:500}]) assert.throws(()=>validateRoute('/api/v2/swap/quote',{...route,...bad}));
});
test('unconfigured service fails closed and exposes no credential',async()=>{
  const proxy=createRheaProxy({apiKey:()=>''});
  assert.equal((await request(proxy,'/config')).body.enabled,false);
  assert.equal((await request(proxy,'/api/v2/swap/quote',route)).status,503);
});
test('proxy pins upstream, protects credential, and forwards idempotency',async()=>{
  let sent;
  const proxy=createRheaProxy({apiKey:()=> 'test-server-secret',fetchImpl:async(url,opts)=>{sent={url,opts};return {ok:true,json:async()=>({code:0,data:{ok:true}})};}});
  const response=await request(proxy,'/api/v2/swap/quote',route,'POST',{'idempotency-key':'order-123',authorization:'Bearer attacker'});
  assert.equal(response.status,200);
  assert.equal(sent.url,'https://api.rhea.finance/api/v2/swap/quote');
  assert.equal(sent.opts.headers.authorization,'Bearer test-server-secret');
  assert.equal(sent.opts.headers['Idempotency-Key'],'order-123');
  assert.ok(!JSON.stringify(response).includes('test-server-secret'));
  assert.equal((await request(proxy,'/https://attacker.invalid')).status,404);
  assert.equal((await request(proxy,'/api/v2/swap/quote',{...route,toChain:'solana'})).status,400);
});
test('proxy sanitizes provider errors and rejects simple cross-site posts',async()=>{
  const proxy=createRheaProxy({apiKey:()=> 'secret',fetchImpl:async()=>({ok:false,status:401,json:async()=>({code:1,msg:'secret'})})});
  assert.equal((await request(proxy,'/api/v2/swap/quote',route,'POST',{'content-type':'text/plain'})).status,400);
  const r=await request(proxy,'/api/v2/swap/quote',route);assert.equal(r.status,503);assert.ok(!JSON.stringify(r).includes('secret'));
});
test('rate limit protects upstream credential',async()=>{
  let calls=0;
  const proxy=createRheaProxy({apiKey:()=> 'secret',fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({code:0,data:{}})};}});
  for(let i=0;i<120;i++)await request(proxy,'/get_chain_prices?chain=8453');
  assert.equal((await request(proxy,'/get_chain_prices?chain=8453')).status,429);
  assert.equal(calls,1);
});
test('SDK token discovery uses the same-origin proxy and preserves identity',async()=>{
  const oldWindow=globalThis.window, oldFetch=globalThis.fetch;
  globalThis.window={location:{origin:'https://pit.example'}};
  globalThis.fetch=async(url)=>{assert.equal(String(url),'https://pit.example/api/cross-chain/get_chain_prices?chain=8453');return new Response(JSON.stringify({code:0,msg:'success',data:{token:{address:'0x'+'b'.repeat(40),chainId:8453,decimals:6,symbol:'USDC',price:'1'}}}),{status:200});};
  try{const list=await fundingClient().getFromTokens({chainId:8453});assert.equal(list[0].address,'0x'+'b'.repeat(40));assert.equal(list[0].decimals,6);}finally{globalThis.window=oldWindow;globalThis.fetch=oldFetch;}
});

test('wallet adapter switches network, preserves exact value, and rejects changed accounts',async()=>{
  const {fundingEvmAdapter}=await import('../src/pit/crossChain.ts');
  const sender='0x'+'a'.repeat(40); const calls=[];let chain='0x1', account=sender;
  const oldWindow=globalThis.window;
  globalThis.window={ethereum:{async request(request){calls.push(request);switch(request.method){
    case 'eth_accounts':return [account];case 'eth_chainId':return chain;
    case 'wallet_switchEthereumChain':chain=request.params[0].chainId;return null;
    case 'eth_sendTransaction':return '0xhash';case 'eth_getTransactionReceipt':return {status:'0x1'};
  }}}};
  try{
    const adapter=fundingEvmAdapter(sender,8453);
    const tx={to:'0x'+'b'.repeat(40),data:'0x',value:'1000000000000000001',chainId:8453};
    assert.equal((await adapter.sendTransaction(tx,{})).txHash,'0xhash');
    assert.equal(chain,'0x2105');
    assert.equal(BigInt(calls.find(c=>c.method==='eth_sendTransaction').params[0].value),1000000000000000001n);
    assert.equal((await adapter.waitForTransaction('0xhash',{})).status,'confirmed');
    account='0x'+'c'.repeat(40);
    await assert.rejects(()=>adapter.sendTransaction(tx,{}),/Wallet changed/);
    account=sender;
    await assert.rejects(()=>adapter.sendTransaction({...tx,chainId:1},{}),/does not match/);
    assert.equal(calls.filter(c=>c.method==='eth_sendTransaction').length,1);
  }finally{globalThis.window=oldWindow;}
});

test('token lists coalesce and cache, but expire and retry failed providers',async()=>{
  let calls=0, time=100000;
  const proxy=createRheaProxy({apiKey:()=> 'secret',now:()=>time,fetchImpl:async()=>{calls++;await Promise.resolve();return new Response(JSON.stringify({code:0,data:{tokens:[]}}));}});
  await Promise.all([request(proxy,'/api/swap/supported_to_tokens?chain=900001'),request(proxy,'/api/swap/supported_to_tokens?chain=900001')]);
  assert.equal(calls,1);
  time+=60001;
  await request(proxy,'/api/swap/supported_to_tokens?chain=900001');assert.equal(calls,2);
  const failing=createRheaProxy({apiKey:()=> 'secret',fetchImpl:async()=>{calls++;throw Error('provider down');}});
  assert.equal((await request(failing,'/get_chain_prices?chain=8453')).status,502);
  assert.equal((await request(failing,'/get_chain_prices?chain=8453')).status,502);
  assert.equal(calls,4);
});
test('proxy rejects duplicate parameters, cross-origin posts, oversized bodies and invalid payloads',async()=>{
  let calls=0;
  const proxy=createRheaProxy({apiKey:()=> 'secret',fetchImpl:async()=>{calls++;throw Error('must not call');}});
  for (const query of ['/get_chain_prices?chain=8453&chain=1','/api/swap/order-status?secret=x','/api/swap/order-status']) assert.equal((await request(proxy,query)).status,400);
  assert.equal((await request(proxy,'/api/v2/swap/quote',route,'POST',{origin:'https://evil.example',host:'pit.example'})).status,403);
  assert.equal((await request(proxy,'/api/v2/swap/quote',{...route,extra:'x'.repeat(65536)})).status,413);
  assert.equal((await request(proxy,'/api/v2/swap/quote',[])).status,400);
  assert.equal(calls,0);
});
test('provider concurrency is bounded and failed requests release capacity',async()=>{
  const releases=[];
  const proxy=createRheaProxy({apiKey:()=> 'secret',fetchImpl:()=>new Promise(resolve=>releases.push(()=>resolve(new Response(JSON.stringify({code:0,data:{}}))))) });
  const requests=Array.from({length:8},(_,i)=>request(proxy,`/api/swap/order-status?recordId=${i}`));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await request(proxy,'/api/swap/order-status?recordId=9')).status,503);
  releases.forEach(resolve=>resolve()); await Promise.all(requests);
});

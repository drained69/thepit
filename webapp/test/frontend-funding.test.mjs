import test from 'node:test';
import assert from 'node:assert/strict';
import {assertFundingQuote, parseFundingOrder, isFundingOrderOpen, fundingEvmAdapter, toUnits} from '../src/pit/crossChain.ts';
const sender = '0x' + 'a'.repeat(40);
const context = {recipient:'buyer.near',sender,chain:8453,amountIn:'1000000',tokenIn:'0x'+'b'.repeat(40),tokenOut:'wrap.near'};
const quote = {fromChain:'8453',toChain:'near',amountIn:'1000000',tokenIn:{address:context.tokenIn},tokenOut:{address:'wrap.near'},receivedAt:10000,expiresAt:35000,buildContext:{request:{fromChain:'8453',toChain:'near',tokenIn:context.tokenIn,tokenOut:'wrap.near',amountIn:'1000000',sender,recipient:'buyer.near',slippage:50}}};
test('quote is bound to the exact account, network, amount and assets at signing',()=>{
  assert.doesNotThrow(()=>assertFundingQuote(quote,context,10001));
  for (const changed of [{recipient:'other.near'},{sender:'0x'+'c'.repeat(40)},{chain:1},{amountIn:'2000000'},{tokenIn:'0x'+'d'.repeat(40)},{tokenOut:'other.near'}]) {
    assert.throws(()=>assertFundingQuote(quote,{...context,...changed},10001),/changed/);
  }
  assert.throws(()=>assertFundingQuote({...quote,buildContext:{request:{...quote.buildContext.request,tokenOut:'attacker.near'}}},context,10001),/changed/);
  assert.throws(()=>assertFundingQuote(quote,context,35000),/expired/);
  assert.throws(()=>assertFundingQuote({...quote,receivedAt:Infinity},context,10001),/expired/);
});
test('restored orders reject incomplete, oversized and poisoned state',()=>{
  const order = {recipient:'buyer.near',sender,chain:8453,status:'needs-review',orderId:'order1',router:'near_intents'};
  assert.deepEqual(parseFundingOrder(JSON.stringify(order)),order);
  assert.equal(isFundingOrderOpen(order),true);
  assert.equal(isFundingOrderOpen({...order,status:'completed'}),false);
  for (const changed of [{chain:999},{sender:[]},{recipient:{}},{recipient:null},{recipient:1234},{status:'finished'},{recordId:123},{orderId:'x'.repeat(513)}]) assert.equal(parseFundingOrder(JSON.stringify({...order,...changed})),null);
  assert.equal(parseFundingOrder('['),null);
  assert.equal(parseFundingOrder('x'.repeat(8193)),null);
  assert.throws(()=>toUnits('1'.repeat(10000),24));
});
test('source account is rechecked after a wallet network-switch prompt',async()=>{
  const oldWindow=globalThis.window;let account=sender;let sends=0;
  globalThis.window={ethereum:{async request({method}){
    if(method==='eth_accounts')return [account];
    if(method==='eth_chainId')return account===sender?'0x1':'0x2105';
    if(method==='wallet_switchEthereumChain'){account='0x'+'c'.repeat(40);return null;}
    if(method==='eth_sendTransaction'){sends++;return '0xhash';}
  }}};
  try {
    await assert.rejects(()=>fundingEvmAdapter(sender,8453).sendTransaction({to:'0x'+'b'.repeat(40),data:'0x',value:'1',chainId:8453},{}),/Wallet changed/);
    assert.equal(sends,0);
  }finally{globalThis.window=oldWindow;}
});
test('typed-data domain cannot request a signature for another chain',async()=>{
  const oldWindow=globalThis.window;let signatures=0;
  globalThis.window={ethereum:{async request({method}){
    if(method==='eth_accounts')return [sender];
    if(method==='eth_chainId')return '0x2105';
    if(method==='eth_signTypedData_v4'){signatures++;return 'signature';}
  }}};
  try {
    await assert.rejects(()=>fundingEvmAdapter(sender,8453).signTypedData({chainId:8453,typedData:{domain:{chainId:1},types:{},message:{}}},{}),/domain/);
    assert.equal(signatures,0);
  }finally{globalThis.window=oldWindow;}
});

test('confirmed ERC20 allowance avoids repeat approvals after refreshing an expired quote',async()=>{
  const oldWindow=globalThis.window;const spender='0x'+'c'.repeat(40);const requests=[];
  globalThis.window={ethereum:{async request(request){requests.push(request);if(request.method==='eth_accounts')return [sender];if(request.method==='eth_chainId')return '0x2105';if(request.method==='eth_call')return '0x05';throw Error('Unexpected request');}}};
  try {
    const approval={spender,tx:{chainId:8453,to:context.tokenIn,data:'0x095ea7b3'+spender.slice(2).padStart(64,'0')+'5'.padStart(64,'0'),value:'0'}};
    assert.equal(await fundingEvmAdapter(sender,8453).isApprovalRequired(approval),false);
    assert.equal(requests.filter(request=>request.method==='eth_call').length,1);
    await assert.rejects(()=>fundingEvmAdapter(sender,8453).isApprovalRequired({...approval,spender:'0x'+'d'.repeat(40)}),/spender/);
  }finally{globalThis.window=oldWindow;}
});
test('SDK aborts after approval confirmation when quote expires, without requesting a funding transfer',async()=>{
  const {fundingClient,fundingFailureStatus}=await import('../src/pit/crossChain.ts');
  const oldWindow=globalThis.window,oldNow=Date.now;let now=10001, sends=0,approvalHash;let fundingRequested=false;
  Date.now=()=>now;
  const spender='0x'+'c'.repeat(40);
  globalThis.window={location:{origin:'https://pit.example'},ethereum:{async request(request){
    if(request.method==='eth_accounts')return [sender];
    if(request.method==='eth_chainId')return '0x2105';
    if(request.method==='eth_call')return '0x0';
    if(request.method==='eth_sendTransaction'){sends++;return '0xapproval';}
    if(request.method==='eth_getTransactionReceipt'){now=40000;return {status:'0x1'};}
    throw Error('Unexpected request '+request.method);
  }}};
  const build={executionId:'expiry-regression',isCrossChain:true,fromChain:'8453',toChain:'near',router:'near_intents',
    execution:{kind:'evm-transaction',chain:'8453',tx:{chainId:8453,to:spender,data:'0x',value:'0'},
      approval:{spender,tx:{chainId:8453,to:context.tokenIn,data:'0x095ea7b3'+spender.slice(2).padStart(64,'0')+'1'.padStart(64,'0'),value:'0'}}},raw:{}};
  try {
    await assert.rejects(()=>fundingClient(sender,8453).executeSwap({build,waitFor:'submitted',
      beforeSign(preview){assertFundingQuote(quote,context);if(preview.kind!=='evm-approval')fundingRequested=true;},
      onEvent(event){if(event.type==='approval-submitted')approvalHash=event.txHash;},
    }),/expired/);
    assert.equal(sends,1,'only the approval can be sent');
    assert.equal(fundingRequested,false);
    assert.equal(fundingFailureStatus(fundingRequested,approvalHash),'approval-only');
    assert.equal(fundingFailureStatus(true,approvalHash),'needs-review');
  } finally {globalThis.window=oldWindow;Date.now=oldNow;}
});
test('SDK reporting recovery retains source and destination identity through serialization',async()=>{
  const {fundingReportRequest,reportDataFromBuild}=await import('../src/pit/crossChain.ts');
  const build={request:{...quote.buildContext.request},estimatedOut:'999',reportContext:{},deposit:{depositAddress:'deposit-address'}};
  const order={recipient:context.recipient,sender,chain:8453,status:'submitted',router:'near_intents',txHash:'0xsource',sourceSubmitted:true,reportData:reportDataFromBuild(build),idempotencyKey:'one-order'};
  const restored=parseFundingOrder(JSON.stringify(order));assert.ok(restored);
  const report=fundingReportRequest(restored);
  assert.equal(report.from_hash,'0xsource');assert.equal(report.recipient,'buyer.near');assert.equal(report.from_token,context.tokenIn);assert.equal(report.to_token,'wrap.near');
  assert.equal(report.amount_in,'1000000');assert.equal(report.deposit_address,'deposit-address');
  assert.throws(()=>fundingReportRequest({...restored,txHash:undefined,orderId:'build-order-only',sourceSubmitted:false}),/Missing source/);
});
test('normalized funding builds cannot weaken the reviewed minimum or alter recipients',async()=>{
  const {assertFundingBuild}=await import('../src/pit/crossChain.ts');
  const reviewed={...quote,minAmountOut:'5'};
  const build={request:{...quote.buildContext.request},isCrossChain:true,fromChain:'8453',toChain:'near',amountIn:context.amountIn,tokenIn:{address:context.tokenIn},tokenOut:{address:'wrap.near'},execution:{chain:'8453',kind:'evm-transaction'},minAmountOut:'5'};
  assert.doesNotThrow(()=>assertFundingBuild(build,reviewed,context));
  assert.throws(()=>assertFundingBuild({...build,minAmountOut:'4'},reviewed,context),/differs/);
  assert.throws(()=>assertFundingBuild({...build,request:{...build.request,recipient:'other.near'}},reviewed,context),/differs/);
});
test('rNEAR failure inspection includes child receipts even when top-level execution succeeds',async()=>{
  const {inspectNearWalletOutcomes}=await import('../src/pit/crossChain.ts');
  const success={status:{SuccessValue:''},transaction_outcome:{outcome:{status:{SuccessReceiptId:'receipt'}}},receipts_outcome:[{outcome:{status:{SuccessValue:''}}}]};
  assert.equal(inspectNearWalletOutcomes([success]),'confirmed');
  assert.equal(inspectNearWalletOutcomes({...success,final_execution_status:'EXECUTED_OPTIMISTIC'}),'pending');
  assert.equal(inspectNearWalletOutcomes({...success,final_execution_status:'FINAL'}),'confirmed');
  assert.equal(inspectNearWalletOutcomes(undefined),'pending');
  assert.equal(inspectNearWalletOutcomes([{transactionHash:'pending'}]),'pending');
  assert.throws(()=>inspectNearWalletOutcomes({...success,receipts_outcome:[{outcome:{status:{Failure:{ActionError:'stake failed'}}}}]}),/receipt failed/);
  assert.throws(()=>inspectNearWalletOutcomes([success,{status:{Failure:'second transaction failed'}}]),/failed/);
  assert.throws(()=>inspectNearWalletOutcomes({...success,transaction_outcome:{outcome:{status:{Failure:'execution failed'}}}}),/failed/);
});

test('cross-tab funding lock rejects overlapping execution and releases after completion',async()=>{
  const {withFundingLock}=await import('../src/pit/crossChain.ts');
  const original=Object.getOwnPropertyDescriptor(globalThis,'navigator');let occupied=false;let release;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{async request(name,options,callback){
    assert.equal(name,'pit-cross-chain-funding');assert.equal(options.ifAvailable,true);
    if(occupied)return callback(null);occupied=true;
    try{return await callback({name});}finally{occupied=false;}
  }}}});
  try {
    const first=withFundingLock(()=>new Promise(resolve=>{release=resolve;}));
    await assert.rejects(()=>withFundingLock(async()=>assert.fail('must not start')),/Another tab/);
    release('done');assert.equal(await first,'done');
    assert.equal(await withFundingLock(async()=> 'next'),'next');
  }finally{if(original)Object.defineProperty(globalThis,'navigator',original);else delete globalThis.navigator;}
});

test('quote validity is checked again after asynchronous wallet network selection',async()=>{
  const oldWindow=globalThis.window, oldNow=Date.now;let now=10001,chain='0x1',sends=0;
  Date.now=()=>now;
  globalThis.window={ethereum:{async request({method,params}){
    if(method==='eth_accounts')return [sender];
    if(method==='eth_chainId')return chain;
    if(method==='wallet_switchEthereumChain'){chain=params[0].chainId;now=40000;return null;}
    if(method==='eth_sendTransaction'){sends++;return '0xsource';}
  }}};
  try {
    await assert.rejects(()=>fundingEvmAdapter(sender,8453,()=>assertFundingQuote(quote,context)).sendTransaction({chainId:8453,to:context.tokenIn,data:'0x',value:'0'},{}),/expired/);
    assert.equal(sends,0);
  }finally{globalThis.window=oldWindow;Date.now=oldNow;}
});

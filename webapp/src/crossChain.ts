import { SwapClient, type ChainExecutor, type SwapBuild, type SwapReportRequestRaw } from '@rhea-finance/cross-chain-aggregation-dex';
import { createEvmExecutor, type EvmWalletAdapter } from '@rhea-finance/cross-chain-aggregation-dex/executors/evm';
export const FUNDING_CHAINS = [{id:8453,name:'Base'}, {id:1,name:'Ethereum'}, {id:42161,name:'Arbitrum'}];
export type EvmProvider = { request(args: {method:string;params?: unknown[]}): Promise<unknown> };
export function evmProvider(): EvmProvider {
  const provider = (window as unknown as {ethereum?:EvmProvider}).ethereum;
  if (!provider) throw Error('Install or open an Ethereum-compatible wallet to fund from another chain.');
  return provider;
}
export function toUnits(value:string, decimals:number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || value.length > 80 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) throw Error('Enter a valid amount.');
  const [whole,fraction=''] = value.split('.');
  if (fraction.length > decimals) throw Error(`This asset supports ${decimals} decimal places.`);
  const amount = BigInt(whole + fraction.padEnd(decimals,'0'));
  if (amount <= 0n || amount.toString().length > 36) throw Error('Amount is outside supported limits.');
  return amount.toString();
}
export function displayUnits(value:string, decimals:number):string {
  const v = BigInt(value).toString().padStart(decimals+1,'0');
  return decimals ? `${v.slice(0,-decimals)}.${v.slice(-decimals)}`.replace(/\.?0+$/,'') : v;
}
function supportedEvmExecutor(adapter: Parameters<typeof createEvmExecutor>[0]): ChainExecutor {
  const executor = createEvmExecutor(adapter);
  return { kinds: executor.kinds,
    validate(execution, context) {
      if (execution.kind !== 'evm-transaction' && execution.kind !== 'evm-signature') throw Error('Unsupported source wallet');
      return executor.validate(execution, context);
    },
    execute(execution, context) {
      if (execution.kind !== 'evm-transaction' && execution.kind !== 'evm-signature') throw Error('Unsupported source wallet');
      return executor.execute(execution, context);
    },
  };
}
export function fundingEvmAdapter(sender: string, sourceChain: number, beforeWalletRequest?: () => void): EvmWalletAdapter {
  const selectedProvider = evmProvider();
  const provider = () => selectedProvider;
  const ensure = async (chainId:number) => {
    if (!sender || chainId !== sourceChain) throw Error('Route does not match the selected wallet network.');
    const accounts = await provider().request({method:'eth_accounts'}) as string[];
    if (accounts[0]?.toLowerCase() !== sender.toLowerCase()) throw Error('Wallet changed. Request a new quote.');
    const chain = `0x${chainId.toString(16)}`;
    if (await provider().request({method:'eth_chainId'}) !== chain) await provider().request({method:'wallet_switchEthereumChain',params:[{chainId:chain}]});
    if (await provider().request({method:'eth_chainId'}) !== chain) throw Error('Switch your wallet to the selected network.');
    const afterSwitch = await provider().request({method:'eth_accounts'}) as string[];
    if (afterSwitch[0]?.toLowerCase() !== sender.toLowerCase()) throw Error('Wallet changed during network selection. Request a new quote.');
  };
  return {
      async isApprovalRequired(approval) {
        await ensure(approval.tx.chainId);
        // Only skip an approval when a standard ERC20 allowance call proves it.
        // Unknown encodings retain the SDK's conservative approval behavior.
        const match = /^0x095ea7b3([0-9a-f]{64})([0-9a-f]{64})$/i.exec(approval.tx.data);
        if (!match) return true;
        const spender = `0x${match[1].slice(-40)}`;
        if (spender.toLowerCase() !== approval.spender.toLowerCase()) throw Error('Approval spender does not match the transaction.');
        const data = `0xdd62ed3e${sender.slice(2).padStart(64, '0')}${spender.slice(2).padStart(64, '0')}`;
        try {
          const allowance = await provider().request({method: 'eth_call', params: [{to: approval.tx.to, data}, 'latest']});
          return typeof allowance !== 'string' || !/^0x[0-9a-f]+$/i.test(allowance) || BigInt(allowance) < BigInt(`0x${match[2]}`);
        } catch { return true; }
      },
      async sendTransaction(tx, {signal}) {
        await ensure(tx.chainId);
        if (tx.from && tx.from.toLowerCase() !== sender.toLowerCase()) throw Error('Unexpected sender in route.');
        const hex = (v:string) => `0x${BigInt(v).toString(16)}`;
        const request:Record<string,string> = {from:sender,to:tx.to,data:tx.data,value:hex(tx.value)};
        for (const [key,value] of Object.entries({gas:tx.gasLimit,gasPrice:tx.gasPrice,maxFeePerGas:tx.maxFeePerGas,maxPriorityFeePerGas:tx.maxPriorityFeePerGas})) if (value != null) request[key] = hex(value);
        signal?.throwIfAborted();
        beforeWalletRequest?.();
        return {txHash: await provider().request({method:'eth_sendTransaction',params:[request]}) as string};
      },
      async signTypedData(request, {signal}) {
        await ensure(request.chainId);
        const domainChain = request.typedData.domain?.chainId;
        if (domainChain !== undefined && BigInt(String(domainChain)) !== BigInt(sourceChain)) throw Error('Signature domain does not match the selected network.');
        signal?.throwIfAborted();
        beforeWalletRequest?.();
        return await provider().request({method:'eth_signTypedData_v4',params:[sender,JSON.stringify(request.typedData)]}) as string;
      },
      async waitForTransaction(txHash, {signal}) {
        const deadline = Date.now()+180000;
        while (Date.now()<deadline) {
          if (signal?.aborted) throw Error('Confirmation tracking paused. The transaction may still complete.');
          await ensure(sourceChain!);
          const receipt = await provider().request({method:'eth_getTransactionReceipt',params:[txHash]}) as {status?:string}|null;
          if (receipt) return {status:receipt.status === '0x1' ? 'confirmed' : 'failed', raw:receipt};
          await new Promise(resolve=>setTimeout(resolve,2000));
        }
        throw Error('Source confirmation is taking longer than expected. Check your wallet before submitting again.');
      },
  };
}
export function fundingClient(sender?: string, sourceChain?: number, beforeWalletRequest?: () => void) {
  return new SwapClient({baseUrl: new URL('/api/cross-chain', window.location.origin).href,
    executors: sender && sourceChain ? [supportedEvmExecutor(fundingEvmAdapter(sender, sourceChain, beforeWalletRequest))] : [],
  });
}

export type FundingOrder = {
  recipient: string;
  chain: number;
  sender: string;
  router?: string;
  recordId?: string;
  orderId?: string;
  txHash?: string;
  status: string;
  approvalTxHash?: string;
  idempotencyKey?: string;
  reportData?: FundingReportData;
  sourceSubmitted?: boolean;
};
export type FundingReportData = {
  fromToken: string; toToken: string; amountIn: string; estimatedOut: string;
  depositAddress: string; txType: string; fromHash?: string; swapId?: string;
};
const ORDER_STATUSES = new Set(['awaiting-wallet', 'needs-review', 'submitted', 'source-confirmed', 'pending', 'processing', 'completed', 'failed', 'refunded', 'expired', 'unknown', 'approval-only', 'not-submitted']);
export function parseFundingOrder(value: string | null): FundingOrder | null {
  try {
    if (!value || value.length > 8192) return null;
    const order = JSON.parse(value);
    if (!order || typeof order !== 'object' || Array.isArray(order)
      || typeof order.recipient !== 'string' || !/^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(order.recipient)
      || !FUNDING_CHAINS.some(chain => chain.id === order.chain)
      || typeof order.sender !== 'string' || !/^0x[0-9a-f]{40}$/i.test(order.sender)
      || !ORDER_STATUSES.has(order.status)) return null;
    for (const key of ['router', 'recordId', 'orderId', 'txHash', 'approvalTxHash', 'idempotencyKey']) {
      if (order[key] !== undefined && (typeof order[key] !== 'string' || order[key].length === 0 || order[key].length > 512)) return null;
    }
    if (order.sourceSubmitted !== undefined && typeof order.sourceSubmitted !== 'boolean') return null;
    let reportData: FundingReportData | undefined;
    if (order.reportData !== undefined) {
      const report = order.reportData;
      if (!report || typeof report !== 'object' || Array.isArray(report)
        || ['fromToken', 'toToken', 'amountIn', 'estimatedOut', 'depositAddress', 'txType'].some(key => typeof report[key] !== 'string' || report[key].length > 512)
        || !/^[1-9][0-9]{0,35}$/.test(report.amountIn) || !/^[0-9]{1,80}$/.test(report.estimatedOut)) return null;
      for (const key of ['fromHash', 'swapId']) if (report[key] !== undefined && (typeof report[key] !== 'string' || report[key].length > 512)) return null;
      reportData = {fromToken: report.fromToken, toToken: report.toToken, amountIn: report.amountIn,
        estimatedOut: report.estimatedOut, depositAddress: report.depositAddress, txType: report.txType,
        ...(report.fromHash ? {fromHash: report.fromHash} : {}), ...(report.swapId ? {swapId: report.swapId} : {})};
    }
    return { recipient: order.recipient, chain: order.chain, sender: order.sender, status: order.status,
      ...(order.router ? {router: order.router} : {}), ...(order.recordId ? {recordId: order.recordId} : {}),
      ...(order.orderId ? {orderId: order.orderId} : {}), ...(order.txHash ? {txHash: order.txHash} : {}),
      ...(order.approvalTxHash ? {approvalTxHash: order.approvalTxHash} : {}),
      ...(order.idempotencyKey ? {idempotencyKey: order.idempotencyKey} : {}),
      ...(reportData ? {reportData} : {}),
      ...(order.sourceSubmitted !== undefined ? {sourceSubmitted: order.sourceSubmitted} : {}) };
  } catch { return null; }
}
export function isFundingOrderOpen(order: FundingOrder | null): boolean {
  return Boolean(order && !['completed', 'failed', 'refunded', 'expired', 'approval-only', 'not-submitted'].includes(order.status));
}
export type FundingQuoteContext = {
  recipient: string; sender: string; chain: number; amountIn: string; tokenIn: string; tokenOut: string;
};
export function assertFundingQuote(quote: import('@rhea-finance/cross-chain-aggregation-dex').Quote, context: FundingQuoteContext, now = Date.now()): void {
  const request = quote.buildContext.request;
  if (quote.fromChain !== String(context.chain) || quote.toChain !== 'near'
    || String(request.fromChain) !== String(context.chain) || request.toChain !== 'near'
    || request.tokenIn.toLowerCase() !== context.tokenIn.toLowerCase() || request.tokenOut !== context.tokenOut
    || quote.amountIn !== context.amountIn || request.amountIn !== context.amountIn
    || request.sender.toLowerCase() !== context.sender.toLowerCase() || request.recipient !== context.recipient
    || quote.tokenIn.address.toLowerCase() !== context.tokenIn.toLowerCase() || quote.tokenOut.address !== context.tokenOut
    || request.slippage !== 50) throw Error('Wallet, destination, or amount changed. Request a new quote.');
  if (!Number.isFinite(quote.receivedAt) || quote.receivedAt > now + 1000
    || (quote.expiresAt !== undefined && !Number.isFinite(quote.expiresAt))
    || now >= Math.min(quote.expiresAt ?? Infinity, quote.receivedAt + 30000)) throw Error('Quote expired. Get a new quote.');
}


/** Keeps failure-before-funding distinct from an ambiguous funding broadcast. */
export function fundingFailureStatus(fundingSignatureRequested: boolean, approvalTxHash?: string): string {
  return fundingSignatureRequested ? 'needs-review' : approvalTxHash ? 'approval-only' : 'not-submitted';
}
export function reportDataFromBuild(build: SwapBuild): FundingReportData {
  if (!build.request) throw Error('Funding build has no report context.');
  return {fromToken: build.request.tokenIn, toToken: build.request.tokenOut,
    amountIn: build.request.amountIn, estimatedOut: build.estimatedOut,
    depositAddress: build.reportContext?.depositAddress ?? build.deposit?.depositAddress ?? '',
    txType: build.reportContext?.txType ?? 'cross-chain',
    ...(build.reportContext?.fromHash ? {fromHash: build.reportContext.fromHash} : {}),
    ...(build.reportContext?.swapId ? {swapId: build.reportContext.swapId} : {})};
}
export function fundingReportRequest(order: FundingOrder): SwapReportRequestRaw {
  const data = order.reportData;
  const fromHash = data?.fromHash ?? order.txHash ?? order.orderId;
  if (!data || !fromHash || !order.router || (!order.txHash && !order.sourceSubmitted)) throw Error('Missing source submission details for reporting. Check the source wallet before funding again.');
  return {sender: order.sender, recipient: order.recipient, from_hash: fromHash,
    from_token: data.fromToken, to_token: data.toToken, deposit_address: data.depositAddress,
    from_chain: String(order.chain), to_chain: 'near', is_cross_chain: true,
    amount_in: data.amountIn, estimated_out: data.estimatedOut, router: order.router, tx_type: data.txType,
    ...((data.swapId || order.orderId) ? {swapId: data.swapId ?? order.orderId} : {})};
}
/** Check every returned receipt; a successful top-level result can mask a failed child. */
export function inspectNearWalletOutcomes(value: unknown): 'confirmed' | 'pending' {
  const outcomes = Array.isArray(value) ? value : value ? [value] : [];
  let confirmed = outcomes.length > 0;
  const inspectStatus = (status: unknown) => {
    if (status && typeof status === 'object' && 'Failure' in status) throw Error('A staking transaction or receipt failed. Check your wallet and position before retrying.');
    return Boolean(status && typeof status === 'object' && 'SuccessValue' in status);
  };
  for (const value of outcomes) {
    if (!value || typeof value !== 'object') { confirmed = false; continue; }
    const outcome = value as {final_execution_status?: unknown; status?: unknown; transaction_outcome?: {outcome?: {status?: unknown}}; receipts_outcome?: {outcome?: {status?: unknown}}[]};
    confirmed = inspectStatus(outcome.status) && confirmed;
    if (outcome.final_execution_status !== undefined && outcome.final_execution_status !== 'FINAL') confirmed = false;
    inspectStatus(outcome.transaction_outcome?.outcome?.status);
    if (Array.isArray(outcome.receipts_outcome)) for (const receipt of outcome.receipts_outcome) inspectStatus(receipt?.outcome?.status);
  }
  return confirmed ? 'confirmed' : 'pending';
}

export function assertFundingBuild(build: SwapBuild, quote: import('@rhea-finance/cross-chain-aggregation-dex').Quote, context: FundingQuoteContext): void {
  const request = build.request;
  if (!request || !build.isCrossChain || build.fromChain !== String(context.chain) || build.toChain !== 'near'
    || String(request.fromChain) !== String(context.chain) || request.toChain !== 'near'
    || request.sender.toLowerCase() !== context.sender.toLowerCase() || request.recipient !== context.recipient
    || request.amountIn !== context.amountIn || build.amountIn !== context.amountIn
    || request.tokenIn.toLowerCase() !== context.tokenIn.toLowerCase() || request.tokenOut !== context.tokenOut
    || build.tokenIn.address.toLowerCase() !== context.tokenIn.toLowerCase() || build.tokenOut.address !== context.tokenOut
    || build.execution.chain !== String(context.chain)
    || !['evm-transaction', 'evm-signature'].includes(build.execution.kind)
    || BigInt(build.minAmountOut) < BigInt(quote.minAmountOut) || BigInt(build.minAmountOut) <= 0n) {
    throw Error('Funding build differs from the reviewed quote. Get a fresh quote before signing.');
  }
}


/** Cross-tab mutual exclusion supplements the persisted unresolved-order barrier. */
export async function withFundingLock<T>(action: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) throw Error('This browser cannot safely coordinate funding tabs. Use a current browser with Web Locks support.');
  return navigator.locks.request('pit-cross-chain-funding', {ifAvailable: true}, async lock => {
    if (!lock) throw Error('Another tab is handling a funding order. Finish or check that order before continuing.');
    return action();
  });
}

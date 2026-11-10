import { useEffect, useMemo, useRef, useState } from 'react';
import type { Quote, SwapExecutionResult, SwapTokenListItem } from '@rhea-finance/cross-chain-aggregation-dex';
import { RNearClient } from '@rhea-finance/rnear-sdk';
import { NETWORK, connect } from './lib/near';
import { PREVIEW } from './config';
import { assertFundingBuild, assertFundingQuote, fundingFailureStatus, fundingReportRequest, reportDataFromBuild, withFundingLock, displayUnits, evmProvider, FUNDING_CHAINS, fundingClient, isFundingOrderOpen, parseFundingOrder, toUnits, type FundingOrder, type FundingQuoteContext } from './crossChain';

const KEY = 'pit-cross-chain-order-v1';
function load(): FundingOrder | null {
  try { return parseFundingOrder(localStorage.getItem(KEY)); } catch { return null; }
}
export function CrossChainFunding({accountId}: {accountId: string | null}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [chain, setChain] = useState(8453);
  const [sender, setSender] = useState('');
  const [inputs, setInputs] = useState<SwapTokenListItem[]>([]);
  const [output, setOutput] = useState<SwapTokenListItem | null>(null);
  const [asset, setAsset] = useState('');
  const [tokenSearch, setTokenSearch] = useState('');
  const visibleTokens = useMemo(() => {
    const query = tokenSearch.trim().toLowerCase();
    const matches = inputs.filter(token => `${token.symbol} ${token.address}`.toLowerCase().includes(query)).slice(0, 100);
    const selected = inputs.find(token => token.address === asset);
    return selected && !matches.some(token => token.address === asset) ? [selected, ...matches] : matches;
  }, [inputs, tokenSearch, asset]);
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [order, setOrder] = useState<FundingOrder | null>(load);
  const [reviewed, setReviewed] = useState(false);
  const generation = useRef(0), quoteGeneration = useRef(0), operation = useRef(false);
  const quoteId = useRef('');
  const lifecycle = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller;
    return () => controller.abort();
  }, []);
  const latest = useRef({accountId, sender, chain, asset, amount, output, inputs});
  latest.current = {accountId, sender, chain, asset, amount, output, inputs};
  const save = (next: FundingOrder, requireStorage = false) => {
    setOrder(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); }
    catch { if (requireStorage) throw Error('Enable browser storage to retain funding recovery details before signing.'); }
  };
  const run = async (action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true; setBusy(true);
    try { await action(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { operation.current = false; setBusy(false); }
  };
  useEffect(() => {
    const update = (event: StorageEvent) => { if (event.key === KEY) setOrder(parseFundingOrder(event.newValue)); };
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/cross-chain/config', {signal: controller.signal}).then(response => {
      if (!response.ok) throw Error('Funding service unavailable');
      return response.json();
    }).then(config => setEnabled(config.enabled === true)).catch(() => {
      if (!controller.signal.aborted) setEnabled(false);
    });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const id = ++generation.current;
    ++quoteGeneration.current; setQuote(null); setInputs([]); setOutput(null); setAsset('');
    if (!enabled || NETWORK !== 'mainnet' || PREVIEW) return;
    setTokensLoading(true);
    const client = fundingClient();
    Promise.all([client.getFromTokens({chainId: chain}), client.getCrossChainToTokens({chainId: 900001})])
      .then(([from, to]) => {
        if (id !== generation.current) return;
        setInputs(from); setAsset(''); setTokenSearch('');
        setOutput(to.find(token => token.chain === 'near' && token.isNative) || null);
      }).catch(() => {
        if (id === generation.current) setMessage('Could not load live routes. Change the source network to try again.');
      }).finally(() => { if (id === generation.current) setTokensLoading(false); });
    return () => { ++generation.current; };
  }, [chain, enabled, accountId]);
  useEffect(() => { ++quoteGeneration.current; setQuote(null); }, [amount, asset, sender]);
  const context = (): FundingQuoteContext => {
    const current = latest.current;
    const token = current.inputs.find(item => item.address === current.asset);
    if (!current.accountId || !current.output || !token || !current.sender) throw Error('Connect both wallets and choose a source asset.');
    return {recipient: current.accountId, sender: current.sender, chain: current.chain,
      amountIn: toUnits(current.amount, token.decimals), tokenIn: token.address, tokenOut: current.output.address};
  };
  const connectSource = () => run(async () => {
    const accounts = await evmProvider().request({method: 'eth_requestAccounts'}) as string[];
    if (!accounts[0] || !/^0x[0-9a-f]{40}$/i.test(accounts[0])) throw Error('The wallet did not return a valid account.');
    setSender(accounts[0]); setQuote(null);
  });
  const requestQuote = () => run(async () => {
    const current = context();
    setMessage('Finding a route…'); setQuote(null);
    const id = ++quoteGeneration.current;
    const token = inputs.find(item => item.address === current.tokenIn)!;
    const next = await fundingClient(current.sender, current.chain).quote({fromChain: `${current.chain}`, toChain: 'near',
      tokenIn: token, tokenOut: output!, amountIn: current.amountIn, slippageBps: 50, sender: current.sender, recipient: current.recipient});
    if (id !== quoteGeneration.current) return;
    assertFundingQuote(next, context());
    quoteId.current = crypto.randomUUID(); setQuote(next); setMessage('Review the quote and confirm funding.');
  });
  const track = async (stored: FundingOrder) => {
    let current = stored;
    const client = fundingClient();
    if (['approval-only', 'not-submitted', 'awaiting-wallet'].includes(current.status)) throw Error('No funding submission was recorded for this attempt. A token approval alone does not fund NEAR.');
    // Reporting is separate from moving funds and can be retried after a reload.
    if (!current.recordId && current.reportData && (current.txHash || (current.sourceSubmitted && current.orderId))) {
      try {
        const report = await client.reportRaw(fundingReportRequest(current));
        const id = report.id ?? report.recordId ?? report.record_id;
        if (id !== undefined && id !== null && String(id).trim()) {
          current = {...current, recordId: String(id)}; save(current);
        }
      } catch {
        // A failed history report must not hide a usable provider order ID.
        if (!current.orderId || !current.router) throw Error('Source submitted, but delivery reporting is unavailable. Retry Check delivery later; do not fund again.');
      }
    }
    if (!current.recordId && (!current.orderId || !current.router)) throw Error('Delivery tracking is not available yet. Check your source wallet before making another transfer.');
    const result = await client.waitForOrder({
      ...(current.recordId ? {recordId: current.recordId} : {orderId: current.orderId!, router: current.router}),
      intervalMs: 5000, timeoutMs: 600000, signal: lifecycle.current.signal,
    });
    save({...current, status: result.status});
    if (result.status === 'completed') {
      try {
        const balance = await new RNearClient({network: 'mainnet'}).getNearBalance(current.recipient);
        setMessage(`RHEA reports the order completed. ${current.recipient} currently holds ${balance.amount} native NEAR. Verify the expected native NEAR arrived before buying; keep NEAR for gas and storage.`);
      } catch { setMessage('RHEA reports delivery complete. Balance lookup failed; verify your NEAR wallet balance before buying.'); }
    } else setMessage(`Funding status: ${result.status}. Check the source wallet for any refund.`);
  };
  const execute = () => run(() => withFundingLock(async () => {
    const stored = load();
    if (isFundingOrderOpen(stored)) { setOrder(stored); throw Error('An unresolved funding attempt is already saved. Check it before sending again.'); }
    if (!quote || isFundingOrderOpen(order)) return;
    const current = context();
    assertFundingQuote(quote, current);
    let currentWalletAction = '';
    let fundingSignatureRequested = false;
    const client = fundingClient(current.sender, current.chain, () => {
      // Network switching itself can take longer than the quote. Recheck after
      // all asynchronous wallet checks, immediately before invoking signing.
      assertFundingQuote(quote, context());
      if (currentWalletAction !== 'evm-approval') fundingSignatureRequested = true;
    });
    // Build through the SDK, validate it, and retain recovery context before any
    // signature. No transaction payload is reconstructed by the application.
    const build = await client.buildSwap({quote, idempotencyKey: quoteId.current, signal: lifecycle.current.signal});
    assertFundingQuote(quote, context()); assertFundingBuild(build, quote, context());
    let pending: FundingOrder = {recipient: current.recipient, chain: current.chain, sender: current.sender,
      status: 'awaiting-wallet', router: build.router, idempotencyKey: quoteId.current,
      orderId: build.order?.orderId ?? build.deposit?.orderId, reportData: reportDataFromBuild(build)};
    save(pending, true);
    setMessage('Approve the funding transaction in your source wallet.');
    try {
      const result: SwapExecutionResult = await client.executeSwap({
        build, waitFor: 'submitted', signal: lifecycle.current.signal,
        beforeSign(preview) {
          assertFundingQuote(quote, context());
          currentWalletAction = preview.kind;
        },
        onEvent(event) {
          if (event.type === 'approval-submitted') {
            pending = {...pending, approvalTxHash: event.txHash}; save(pending);
            setMessage('Approval submitted. Waiting for source confirmation. A fresh quote may be needed before funding.');
          } else if (event.type === 'submitted') {
            pending = {...pending, status: 'submitted', sourceSubmitted: true, txHash: event.txHash,
              orderId: event.orderId ?? pending.orderId}; save(pending);
          }
        },
      });
      pending = {...pending, status: result.status, sourceSubmitted: true, router: result.router, recordId: result.report?.recordId,
        orderId: result.orderId || pending.orderId, txHash: result.txHash || pending.txHash};
      save(pending); setQuote(null);
      setMessage('Source submitted. Waiting for delivery to NEAR…'); await track(pending);
    } catch (error) {
      if (pending.status === 'awaiting-wallet') {
        pending = {...pending, status: fundingFailureStatus(fundingSignatureRequested, pending.approvalTxHash)}; save(pending);
      }
      setQuote(null);
      const nextStep = pending.status === 'approval-only'
        ? 'Only the approval was submitted. Get a fresh funding quote; existing allowance will be checked before approving again.'
        : pending.status === 'not-submitted' ? 'No funding signature was requested. Get a fresh quote.'
        : 'Check delivery and your source wallet before funding again.';
      throw Error(`${error instanceof Error ? error.message : String(error)} ${nextStep}`);
    }
  }));
  const unresolved = isFundingOrderOpen(order);
  return <section className="section" aria-label="Cross-chain funding"><div className="terminal">
    <div className="term-head"><span>Fund from another chain</span><span>RHEA · NEAR Intents</span></div>
    <div className="panel-body"><p>Move assets from an EVM wallet to native NEAR in your connected wallet. After delivery, buy your coin in a separate transaction.</p>
    {enabled === null ? <p role="status">Checking funding availability…</p> : !enabled ? <div className="notice">Cross-chain funding needs RHEA service configuration before live quotes are available.</div> : NETWORK!=='mainnet' || PREVIEW ? <div className="notice">Funding uses mainnet assets. This deployment is currently {PREVIEW?'a preview':'on NEAR testnet'}.</div> : !accountId ? <button className="btn light" onClick={()=>void connect()}>Connect NEAR wallet</button> : <>
      <p>Destination: <b>{accountId}</b> · Native NEAR</p>
      <div className="field"><label htmlFor="funding-network">Source network</label><select id="funding-network" disabled={busy} value={chain} onChange={e=>setChain(Number(e.target.value))}>{FUNDING_CHAINS.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <button className="btn dark" disabled={busy} onClick={()=>void connectSource()}>{sender?`${sender.slice(0,8)}…${sender.slice(-6)} · reconnect`:'Connect source wallet'}</button>
      <div className="field"><label htmlFor="funding-asset">Source asset</label><input aria-label="Search source assets by symbol or address" placeholder="Search symbol or token address" value={tokenSearch} maxLength={160} disabled={busy} onChange={event=>setTokenSearch(event.target.value)} /><select id="funding-asset" disabled={busy || tokensLoading} value={asset} onChange={e=>setAsset(e.target.value)}><option value="">Choose an asset</option>{visibleTokens.map(t=><option key={t.address} value={t.address}>{t.symbol} · {t.address}</option>)}</select></div>
      <div className="field"><label htmlFor="funding-amount">Amount</label><input id="funding-amount" inputMode="decimal" disabled={busy} value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.0" /></div>
      {tokensLoading && <p role="status">Loading supported assets…</p>}
      {!tokensLoading && !output && <p className="muted">No native NEAR destination is available from the live token list.</p>}
      <button className="btn light" disabled={busy||!sender||!output||!asset||!amount||Boolean(unresolved)} onClick={()=>void requestQuote()}>Get funding quote</button>
      {quote&&output&&<div className="notice"><p>Estimated: {displayUnits(quote.estimatedOut,output.decimals)} NEAR</p><p>Minimum: {displayUnits(quote.minAmountOut,output.decimals)} NEAR · Slippage: 0.5%</p><p>Route: {quote.route.router} · Quote valid for at most 30 seconds. If approval confirmation takes longer, request a fresh quote before funding. Network costs and approvals appear in your wallet.</p><button className="btn light" disabled={busy||Boolean(unresolved)} onClick={()=>void execute()}>Confirm funding</button></div>}
    </>}
    {order&&<div className="notice"><p>Last funding: {order.status} → {order.recipient}</p>{order.approvalTxHash&&<p style={{overflowWrap:'anywhere'}}>Token approval: {order.approvalTxHash} (this does not fund the destination)</p>}{order.txHash&&<p style={{overflowWrap:'anywhere'}}>Source transaction: {order.txHash}</p>}<button className="btn dark" disabled={busy||!enabled} onClick={()=>void run(()=>track(order))}>Check delivery</button>
      {unresolved && !order.txHash && !order.recordId && !order.orderId && <div><label><input type="checkbox" checked={reviewed} onChange={event=>setReviewed(event.target.checked)} /> I checked my source wallet and confirmed no funding transaction was submitted.</label><button className="btn dark" disabled={busy || !reviewed} onClick={()=>{try {localStorage.removeItem(KEY); setOrder(null); setReviewed(false); setQuote(null);} catch {setMessage('Browser storage could not be cleared.');}}}>Clear unsubmitted attempt</button></div>}</div>}
    {message&&<p role="status">{message}</p>}
    </div></div></section>;
}

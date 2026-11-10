import { useEffect, useRef, useState } from 'react';
import { sendFunctionCall } from './lib/near';
import { near, viewOf } from './chain';
import { PIT_FACTORY, PREVIEW } from './config';

type Credit = { available:string; in_flight:string; receiver_id:string; failed:boolean };
type Ticket = { id:number; account_id:string; receiver_id:string; amount:string; in_flight:boolean; failed:boolean };
type FactoryClaim = { amount:string; account_id:string; in_flight:boolean };
const validAccount = (value:string) => /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
const stored = (key:string) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };

export function CoinPayouts({contract,accountId}:{contract:string;accountId:string|null}) {
  const [credit,setCredit]=useState<Credit|null>(null),[ticket,setTicket]=useState<Ticket|null>(null);
  const [ticketId,setTicketId]=useState(''),[receiver,setReceiver]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const generation=useRef(0), operation=useRef(false);
  const load=async()=>{
    if(!accountId || PREVIEW)return;
    const id=++generation.current;
    try {
      const value=await viewOf<Credit|null>(contract,'get_refund_credit',{account_id:accountId});
      if(id===generation.current)setCredit(value);
    }catch{if(id===generation.current)setMessage('Recovery details could not be loaded. Refresh before retrying a transaction.');}
  };
  useEffect(()=>{
    setCredit(null);setTicket(null);setMessage('');setReceiver(accountId||'');
    setTicketId(stored(`pit-ticket:${contract}:${accountId}`));void load();
    const update=()=>{setTicketId(stored(`pit-ticket:${contract}:${accountId}`));void load();};
    window.addEventListener('pit-payout-update',update);
    return()=>{++generation.current;window.removeEventListener('pit-payout-update',update);};
  },[contract,accountId]);
  const lookup=async()=>{
    if(!/^\d{1,16}$/.test(ticketId)||!Number.isSafeInteger(Number(ticketId)))throw Error('Enter a valid ticket ID.');
    const id=generation.current;
    const value=await viewOf<Ticket|null>(contract,'get_ticket',{ticket_id:Number(ticketId)});
    if(id!==generation.current)return;
    setTicket(value);
    if(!value)setMessage('No outstanding claim for that ticket. Check its transaction history to confirm settlement.');
  };
  const run=async(action:()=>Promise<unknown>)=>{
    if(operation.current)return;
    operation.current=true;setBusy(true);setMessage('');
    try{await action();await load();}catch(e){setMessage(e instanceof Error?e.message:String(e));}
    finally{operation.current=false;setBusy(false);}
  };
  const send=async(method:string,args:object,deposit='0')=>{
    if(!accountId)throw Error('Connect the claim owner wallet.');
    await sendFunctionCall(contract,method,args,80,deposit,accountId);
    setMessage('Request submitted. Refresh the claim to check the confirmed outcome.');
  };
  const redirect=async(method:string,args:object)=>{
    if(!validAccount(receiver))throw Error('Enter a valid NEAR recipient account.');
    await send(method,{...args,receiver_id:receiver},'1');
  };
  if(PREVIEW||!accountId)return null;
  return <section className="section" aria-label="Your payout recovery"><div className="terminal"><div className="term-head"><span>Your payouts and refunds</span><span>On-chain claims</span></div><div className="panel-body">
    <p>Refunds from failed agent purchases, excess storage deposits, and released memory deposits accrue as withdrawable credit.</p>
    <p>Available credit: <b>{credit?near(BigInt(credit.available),6):'—'} NEAR</b> · Transfer in progress: {credit?near(BigInt(credit.in_flight),6):'—'} NEAR</p>
    {credit&&<p>Refund recipient: {credit.receiver_id}</p>}
    <button className="btn light" disabled={busy||!credit||BigInt(credit.available)===0n||BigInt(credit.in_flight)>0n} onClick={()=>void run(()=>send('withdraw_refund',{},'1'))}>Withdraw refund credit</button>
    <button className="btn dark" disabled={busy} onClick={()=>void run(load)}>Refresh credit</button>
    <div className="field"><label htmlFor="payout-ticket">Sell ticket ID</label><input id="payout-ticket" disabled={busy} value={ticketId} onChange={e=>{setTicketId(e.target.value);setTicket(null);}} inputMode="numeric" maxLength={16}/></div>
    <button className="btn dark" disabled={busy||!ticketId} onClick={()=>void run(lookup)}>Look up ticket</button>
    {ticket&&<div className="notice"><p>Ticket {ticket.id}: {near(BigInt(ticket.amount),6)} NEAR → {ticket.receiver_id}</p><p>{ticket.in_flight?'Transfer pending; it cannot be safely resent.':ticket.failed?'Transfer failed; the owner can change its recipient.':'Waiting for liquid funds and processing.'}</p><button className="btn dark" disabled={busy||ticket.in_flight} onClick={()=>void run(async()=>{await send('process_queue',{max:10});await lookup();})}>Process waiting payouts</button></div>}
    {(credit?.failed || (ticket?.failed&&ticket.account_id===accountId))&&<div className="field"><label htmlFor="payout-recipient">Recovery recipient</label><input id="payout-recipient" disabled={busy} value={receiver} maxLength={64} onChange={e=>setReceiver(e.target.value)}/>
      {credit?.failed&&<button className="btn dark" disabled={busy||BigInt(credit.in_flight)>0n} onClick={()=>void run(()=>redirect('recover_refund',{}))}>Change refund recipient</button>}
      {ticket?.failed&&ticket.account_id===accountId&&<button className="btn dark" disabled={busy||ticket.in_flight} onClick={()=>void run(async()=>{await redirect('recover_payout',{ticket_id:ticket.id});await lookup();})}>Change ticket recipient</button>}
    </div>}
    <p className="muted">Recovery actions require the original owner wallet. A pending transfer stays locked until its callback resolves. Refund-account storage remains registered.</p>
    {message&&<p role="status">{message}</p>}
  </div></div></section>;
}
export function FactoryRefund({accountId}:{accountId:string|null}) {
  const [launchId,setLaunchId]=useState(''),[claim,setClaim]=useState<FactoryClaim|null>(null),[status,setStatus]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const operation=useRef(false),generation=useRef(0);
  useEffect(()=>{++generation.current;setLaunchId(stored(`pit-launch:${PIT_FACTORY}:${accountId}`));setClaim(null);setStatus('');setMessage('');},[accountId]);
  const lookup=async()=>{
    if(!/^\d{1,20}$/.test(launchId)||BigInt(launchId)>18446744073709551615n)throw Error('Enter a valid launch ID from your transaction logs.');
    const id=generation.current;
    const [value,state]=await Promise.all([viewOf<FactoryClaim|null>(PIT_FACTORY,'get_refund',{launch_id:launchId}),viewOf<string>(PIT_FACTORY,'get_launch_status',{launch_id:launchId})]);
    if(id===generation.current){setClaim(value);setStatus(state);}
  };
  const run=async(retry=false)=>{
    if(operation.current)return;operation.current=true;setBusy(true);setMessage('');
    try{
      if(retry){await sendFunctionCall(PIT_FACTORY,'retry_refund',{launch_id:launchId},60,'0',accountId??undefined);setMessage('Refund retry submitted. Check the claim status before trying again.');}
      await lookup();
    }catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{operation.current=false;setBusy(false);}
  };
  if(!PIT_FACTORY||PREVIEW||!accountId)return null;
  return <section className="section" aria-label="Launch refund recovery"><div className="terminal"><div className="term-head"><span>Launch refunds</span><span>Factory claims</span></div><div className="panel-body">
    <p>An asynchronous failed launch retains 0.002 NEAR to fund its recovery record. The remainder is refunded or remains claimable until its transfer succeeds.</p>
    <div className="field"><label htmlFor="refund-launch-id">Launch ID</label><input id="refund-launch-id" disabled={busy} inputMode="numeric" maxLength={20} value={launchId} onChange={e=>{setLaunchId(e.target.value);setClaim(null);setStatus('');}}/></div>
    <button className="btn dark" disabled={busy||!launchId} onClick={()=>void run()}>Check launch refund</button>
    {status&&<p>Status: {status}</p>}{claim&&<p>{near(BigInt(claim.amount),6)} NEAR → {claim.account_id}</p>}
    {claim&&<button className="btn light" disabled={busy||claim.in_flight||claim.account_id!==accountId} onClick={()=>void run(true)}>Retry confirmed failed refund</button>}
    {message&&<p role="status">{message}</p>}
  </div></div></section>;
}

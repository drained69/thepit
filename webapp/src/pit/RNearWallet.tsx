import { useEffect, useRef, useState } from "react";
import { RNearClient, NearRpcProvider, getDefaultConfig, extractTransactionHashes, type StakingAccount, type TransactionSender } from "@rhea-finance/rnear-sdk";
import { NETWORK, connect, getAccount, wallet } from "../lib/near";
import { inspectNearWalletOutcomes } from "./crossChain";
import { PREVIEW } from "./config";

const client = new RNearClient({ network: NETWORK });
const rpc = new NearRpcProvider(import.meta.env.VITE_NEAR_RPC ? [String(import.meta.env.VITE_NEAR_RPC)] : getDefaultConfig(NETWORK).rpcUrls);

/** A wallet-owned RHEA position; The Pit's reserve is separate. */
export function RNearWallet({ accountId }: { accountId: string | null }) {
  const [position, setPosition] = useState<StakingAccount | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const activeAccount = useRef(accountId);
  const operation = useRef(false);
  const refreshGeneration = useRef(0);
  activeAccount.current = accountId;
  const refresh = async () => {
    if (!accountId || PREVIEW) return;
    const generation = ++refreshGeneration.current;
    try { const data = await client.getAccountDetails(accountId); if (activeAccount.current === accountId && generation === refreshGeneration.current) setPosition(data); }
    catch { if (activeAccount.current === accountId && generation === refreshGeneration.current) { setPosition(null); setMessage("Couldn't load your rNEAR position. Try again."); } }
  };
  useEffect(() => { ++refreshGeneration.current; setPosition(null); setAmount(""); setMessage(""); void refresh(); }, [accountId]);
  const act = async (action: "stake" | "unstake" | "withdraw") => {
    if (!accountId || PREVIEW || operation.current) return;
    if (action !== "withdraw" && (!/^(?:0|[1-9]\d*)(?:\.\d{1,24})?$/.test(amount) || !/[1-9]/.test(amount))) {
      setMessage("Enter a positive amount with up to 24 decimal places."); return;
    }
    operation.current = true; setBusy(true); setMessage("");
    try {
      const settlement: {status: 'confirmed' | 'pending'} = {status: 'pending'};
      const connectedWallet = await wallet();
      const sender: TransactionSender = {
        async signAndSendTransactions({transactions}) {
          // SDK builders fetch registration and pricing asynchronously. Verify the
          // signer again immediately before opening the wallet, after those reads.
          const current = await getAccount();
          const accounts = await connectedWallet.getAccounts();
          if (activeAccount.current !== accountId || current?.accountId !== accountId
            || !accounts.some(account => account.accountId === accountId)
            || transactions.some(transaction => transaction.signerId !== accountId)) {
            throw Error("Wallet changed. Review your current account before trying again.");
          }
          const result: unknown = await connectedWallet.signAndSendTransactions({transactions});
          settlement.status = inspectNearWalletOutcomes(result);
          const hashes = extractTransactionHashes(result);
          // Wallet-returned top status alone is not enough: query final outcomes
          // when hashes are available, then inspect every child receipt as well.
          if (hashes.length) {
            const finalResults: unknown[] = [];
            try {
              for (const hash of hashes) finalResults.push(await rpc.send('tx', {tx_hash: hash, sender_account_id: accountId, wait_until: 'FINAL'}));
            } catch { settlement.status = 'pending'; }
            if (finalResults.length === hashes.length) settlement.status = inspectNearWalletOutcomes(finalResults);
          }
          return result;
        },
      };
      if (action === "stake") await client.stake({ sender, accountId, nearAmount: amount });
      else if (action === "unstake") await client.unstake({ sender, accountId, rNearAmount: amount });
      else await client.withdraw({ sender, accountId });
      if (activeAccount.current !== accountId) return;
      setMessage(settlement.status === "confirmed" ? "Staking transaction and returned receipts confirmed. Your position is refreshed below." : "Wallet request submitted; final confirmation is unavailable. Check your wallet and refresh your position before trying again.");
      await refresh();
    } catch (e) { if (activeAccount.current === accountId) setMessage(e instanceof Error ? e.message : String(e)); }
    finally { operation.current = false; setBusy(false); }
  };
  return <section className="section" aria-label="Your rNEAR position"><div className="terminal">
    <div className="term-head"><span>Your RHEA staking position</span><span>NEAR {NETWORK.toUpperCase()}</span></div>
    <div className="panel-body"><p>Stake NEAR for rNEAR from your wallet, or request a delayed withdrawal. This position is separate from a coin's reserve.</p>
      {PREVIEW ? <p className="muted">Wallet actions are unavailable while this site is in preview.</p> : !accountId ? <button className="btn dark" onClick={() => connect().catch((e) => setMessage(String(e)))}>Connect NEAR wallet</button> : <>
        <p>Staked value: <b>{position?.stakedNear.amount ?? "—"} NEAR</b> · Pending: <b>{position?.pendingNear.amount ?? "—"} NEAR</b></p>
        {position?.estimatedUnlockAtMs != null && <p>Estimated unlock: {new Date(position.estimatedUnlockAtMs).toLocaleString()}</p>}
        <div className="field"><label htmlFor="rnear-amount">Amount (NEAR to stake or rNEAR to unstake)</label><div className="row"><input id="rnear-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" /></div></div>
        <div className="cta"><button className="btn light" disabled={busy} onClick={() => void act("stake")}>Stake NEAR</button><button className="btn dark" disabled={busy} onClick={() => void act("unstake")}>Request unstake</button><button className="btn dark" disabled={busy || !position?.canWithdraw} onClick={() => void act("withdraw")}>Withdraw unlocked</button><button className="btn dark" disabled={busy} onClick={() => void refresh()}>Refresh</button></div>
        <p className="muted">Delayed unstaking requires an unlock period. Review each wallet transaction before signing.</p>
      </>}{message && <div className="notice">{message}</div>}
    </div></div></section>;
}

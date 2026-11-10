import { useEffect, useState } from "react";
import { TESTNET_DEPLOYMENT as deployment } from "./config";
import { accessKeyCount } from "./lib/near";
import { AccountLink } from "./ui";

const accounts = [
  ["Launchpad factory", "Creates coins using shared contract code", deployment.factory],
  ["First coin ($PIT)", "The launchpad’s first market", deployment.coin],
  ["Mock validator pool", "Testnet staking and unbonding", deployment.pool],
  ["Mock agent registry", "Testnet registry for launch gate agents", deployment.registry],
  ["Brain", "Receives reserve harvests", deployment.brain],
  ["Keeper", "Signs on-chain actions for the brain service", deployment.keeper],
] as const;

export function TestnetDeployment({ factoryReady, coinReady }: { factoryReady: boolean | null; coinReady: boolean }) {
  const [keys, setKeys] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    const check = () => {
      void accessKeyCount(deployment.factory).then(
        (count) => { if (active) setKeys(count); },
        () => { if (active) setKeys(null); },
      );
    };
    check();
    const timer = window.setInterval(check, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <section className="section deployment" id="deployment" tabIndex={-1} aria-labelledby="deployment-h">
      <div className="deployment-heading">
        <div>
          <p className="eyebrow">NEAR testnet</p>
          <h2 id="deployment-h">The Pit <span className="hl">deployment</span></h2>
          <p>Explore the launchpad, its first market, and the accounts that support them.</p>
        </div>
        <a className="btn light" href="#/coin/pit">Open $PIT market <span aria-hidden>↗</span></a>
      </div>
      <dl className="deployment-summary">
        <div><dt>Shared code publication</dt><dd><span className="burn-amount">{deployment.publishBurn}</span> testnet NEAR burned</dd></div>
        <div><dt>Factory access</dt><dd className={keys === 0 ? "confirmed" : undefined}>{keys === null ? "Key count unavailable" : keys === 0 ? "Locked · 0 access keys" : `${keys} access ${keys === 1 ? "key" : "keys"}`}</dd></div>
        <div><dt>On-chain checks</dt><dd className={factoryReady && coinReady ? "confirmed" : undefined}>{factoryReady && coinReady ? "Code published · $PIT responding" : factoryReady ? "Code published · awaiting $PIT" : factoryReady === false ? "Shared code unpublished" : "Awaiting factory response"}</dd></div>
      </dl>
      <h3 className="deployment-account-heading" id="deployment-accounts-h">Deployment accounts</h3>
      <ul className="deployment-accounts" aria-labelledby="deployment-accounts-h">
        {accounts.map(([name, description, id]) => (
          <li key={id}>
            <div><strong>{name}</strong><small>{description}</small></div>
            <AccountLink id={id} />
          </li>
        ))}
      </ul>
    </section>
  );
}

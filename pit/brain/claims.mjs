/** Retry only confirmed-failed claims; never reset an unknown in-flight transfer. */
export async function maintainClaims({read,call,keeperId}) {
  const [brain,creator,credit]=await Promise.all([
    read('get_harvest_claim',{creator:false}), read('get_harvest_claim',{creator:true}),
    keeperId?read('get_refund_credit',{account_id:keeperId}):null,
  ]);
  const results=[];
  for(const [isCreator,claim] of [[false,brain],[true,creator]]) {
    if(claim?.failed && !claim.in_flight)results.push(await call('retry_harvest',{creator:isCreator},'0'));
  }
  // A factory keeper has its own gas account. Recover storage overpayments so
  // recording thoughts does not drain its spendable NEAR into refund credits.
  if(credit && BigInt(credit.available)>0n && BigInt(credit.in_flight)===0n)results.push(await call('withdraw_refund',{},'1'));
  return {harvestPending:Boolean(brain||creator),results};
}

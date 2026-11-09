import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeSuccessValue,receiptLogs,launchIdFromLogs} from '../src/lib/transaction-result.ts';
test('transaction results preserve explicit false, ticket IDs and Unicode',()=>{
 assert.equal(decodeSuccessValue(btoa('false')),false);assert.equal(decodeSuccessValue(''),undefined);
 assert.deepEqual(decodeSuccessValue(btoa('{"ticket_id":12}')),{ticket_id:12});
 assert.equal(decodeSuccessValue(Buffer.from(JSON.stringify('coin 🧠')).toString('base64')),'coin 🧠');
});
test('launch IDs come only from the factory event and invalid logs do not break recovery',()=>{
 const logs=receiptLogs({receipts_outcome:[{outcome:{logs:['noise','EVENT_JSON:{',JSON.stringify({}), 'EVENT_JSON:'+JSON.stringify({standard:'pit-factory',event:'launch_started',data:[{launch_id:'12'}]})]}}]});
 assert.equal(launchIdFromLogs(logs),'12');
 assert.equal(launchIdFromLogs(['EVENT_JSON:'+JSON.stringify({standard:'attacker',event:'launch_started',data:[{launch_id:'12'}]})]),null);
 assert.equal(launchIdFromLogs(['EVENT_JSON:'+JSON.stringify({standard:'pit-factory',event:'launch_started',data:[{launch_id:'18446744073709551616'}]})]),null);
});

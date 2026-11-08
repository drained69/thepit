#![cfg(feature = "unit-tests")]
use near_sdk::{env, json_types::U128, test_utils::VMContextBuilder, testing_env, AccountId, NearToken, PromiseResult, RuntimeFeesConfig, test_vm_config};
use near_contract_standards::{fungible_token::FungibleTokenCore, storage_management::StorageManagement};
use pit::{ThePit, Tier, ONE_NEAR, ONE_TOKEN, TICKET_DEPOSIT};
const ME:&str="pit.near";
const ALICE:&str="alice.near";
const BOB:&str="bob.near";
const BRAIN:&str="brain.near";
fn acc(s:&str)->AccountId{s.parse().unwrap()}
fn context(who:&str,deposit:u128)->VMContextBuilder{
 let mut b=VMContextBuilder::new();b.current_account_id(acc(ME)).predecessor_account_id(acc(who)).signer_account_id(acc(who)).account_balance(NearToken::from_near(1_000_000)).attached_deposit(NearToken::from_yoctonear(deposit));b
}
fn as_user(who:&str,deposit:u128){testing_env!(context(who,deposit).build());}
fn callback(ok:bool){testing_env!(context(ME,0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),vec![if ok{PromiseResult::Successful(vec![])}else{PromiseResult::Failed}]);}
fn init()->ThePit{
 as_user(ME,0);
 ThePit::new(acc(BRAIN),vec![acc("pool.near")],U128(3_000*ONE_NEAR),U128(1_073_000_000*ONE_TOKEN),100,2_000,vec![Tier{name:"Larva".into(),min_principal:U128(0)}],"Test".into(),"TST".into(),None,None,None,None)
}
fn buy(c:&mut ThePit,who:&str)->u128{as_user(who,100*ONE_NEAR);c.buy(U128(0)).0}
fn rejects(f:impl FnOnce()) { assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()); }

#[test]
fn unknown_oldest_transfer_does_not_block_later_pages(){
 let mut c=init();let supply=buy(&mut c,ALICE);
 for _ in 0..14{as_user(ALICE,TICKET_DEPOSIT);c.sell(U128(supply/20),U128(0));}
 assert_eq!(c.process_queue(Some(10)),9);
 for id in 1..10{callback(true);assert!(c.on_payout(id));}
 // ID 0 is still unknown/in flight. Previously all later IDs were unreachable.
 assert_eq!(c.process_queue(Some(10)),4);
 assert!(c.get_queue(None,Some(100)).iter().all(|ticket|ticket.in_flight));
 assert_eq!(c.process_queue(Some(10)),0);
 for id in 10..14{callback(true);assert!(c.on_payout(id));}
 assert_eq!(c.get_queue(None,None).len(),1);
 assert_eq!(c.brain_stats().queue_len,1);
 assert!(c.get_queue(None,None)[0].in_flight);
}

#[test]
fn seller_can_redirect_only_after_confirmed_failure(){
 let mut c=init();let supply=buy(&mut c,ALICE);
 as_user(ALICE,TICKET_DEPOSIT);let id=c.sell(U128(supply/2),U128(0)).ticket_id.unwrap();
 as_user(ALICE,1);rejects(||c.recover_payout(id,acc(BOB)));
 callback(false);assert!(!c.on_payout(id));
 as_user(BOB,1);rejects(||c.recover_payout(id,acc(BOB)));
 as_user(ALICE,1);c.recover_payout(id,acc(BOB));
 let ticket=c.get_queue(None,None)[0].clone();assert_eq!(ticket.account_id,acc(ALICE));assert_eq!(ticket.receiver_id,acc(BOB));
 assert_eq!(c.process_queue(Some(1)),1);
 as_user(ALICE,1);rejects(||c.recover_payout(id,acc(ALICE)));
 callback(true);assert!(c.on_payout(id));assert!(!c.on_payout(id));assert!(c.get_queue(None,None).is_empty());
}

#[test]
fn maximum_length_ticket_storage_is_funded(){
 let mut c=init();let who="a".repeat(64);let supply=buy(&mut c,&who);
 as_user(&who,TICKET_DEPOSIT);let before=env::storage_usage();c.sell(U128(supply/2),U128(0));
 let actual=u128::from(env::storage_usage()-before)*env::storage_byte_cost().as_yoctonear();
 assert!(actual<=TICKET_DEPOSIT,"ticket needs {actual}, collateral {TICKET_DEPOSIT}");
}

#[test]
fn refund_storage_and_small_credits_are_caller_funded(){
 let mut c=init();let who="b".repeat(64);let deposit=c.refund_registration_deposit().0;
 as_user(&who,deposit);let registered=c.register_refund_account();assert!(registered.storage_paid.0<=deposit);
 assert_eq!(registered.storage_paid.0+registered.available.0,deposit);
 as_user(&who,7);let before=env::storage_usage();c.register_refund_account();
 assert_eq!(env::storage_usage(),before);assert_eq!(c.get_refund_credit(acc(&who)).unwrap().available.0,registered.available.0+7);
 assert_eq!(c.brain_stats().liquid.0,0);
}

#[test]
fn failed_refund_preserves_credits_and_unknown_callback_stays_locked(){
 let mut c=init();as_user(ALICE,ONE_NEAR/50);c.propose_memory("hello".into());
 let available=c.get_refund_credit(acc(ALICE)).unwrap().available.0;assert!(available>0);
 as_user(ALICE,1);assert!(c.withdraw_refund());assert!(!c.withdraw_refund());
 // A later credit cannot overwrite the transfer already in flight.
 as_user(ALICE,13);c.register_refund_account();
 assert_eq!(c.get_refund_credit(acc(ALICE)).unwrap().available.0,13);
 callback(false);assert!(!c.on_refund(acc(ALICE)));
 assert_eq!(c.get_refund_credit(acc(ALICE)).unwrap().available.0,available+13);
 assert!(!c.on_refund(acc(ALICE)));
 as_user(ALICE,1);c.recover_refund(acc(BOB));assert!(c.withdraw_refund());
 assert_eq!(c.get_refund_credit(acc(ALICE)).unwrap().receiver_id,acc(BOB));
 callback(true);assert!(c.on_refund(acc(ALICE)));assert!(!c.on_refund(acc(ALICE)));
 assert_eq!(c.get_refund_credit(acc(ALICE)).unwrap().available.0,0);
 assert_eq!(c.brain_stats().liquid.0,0);
}

#[test]
fn harvest_counts_only_success_and_failed_claim_retries_without_redebit(){
 let mut c=init();buy(&mut c,ALICE);as_user(BOB,0);let amount=c.harvest().0;
 let liquid=c.brain_stats().liquid.0;assert_eq!(c.brain_stats().total_harvested.0,0);
 assert!(!c.retry_harvest(false));rejects(||{c.harvest();});
 callback(false);assert!(!c.on_harvest(false));assert!(!c.on_harvest(false));
 as_user(BOB,1);rejects(||c.recover_harvest(false,acc(BOB)));
 as_user(BRAIN,1);c.recover_harvest(false,acc(BOB));assert!(c.retry_harvest(false));
 assert_eq!(c.brain_stats().liquid.0,liquid);assert_eq!(c.brain_stats().total_harvested.0,0);
 callback(true);assert!(c.on_harvest(false));assert!(!c.on_harvest(false));
 assert_eq!(c.brain_stats().total_harvested.0,amount);assert_eq!(c.brain_stats().liquid.0,liquid);
}

#[test]
fn nep145_refunds_are_credits_not_detached_transfers(){
 let mut c=init();let cost=c.storage_balance_bounds().min;
 as_user(ALICE,cost.as_yoctonear());c.storage_deposit(None,None);
 assert!(c.get_refund_credit(acc(ALICE)).is_none());
 as_user(ALICE,c.refund_registration_deposit().0);c.register_refund_account();
 let previous=c.get_refund_credit(acc(ALICE)).unwrap().available.0;
 as_user(ALICE,1);assert!(c.storage_unregister(None));
 assert_eq!(c.get_refund_credit(acc(ALICE)).unwrap().available.0,previous+cost.as_yoctonear()+1);
 assert!(c.storage_balance_of(acc(ALICE)).is_none());
 assert_eq!(c.ft_total_supply().0,0);
}

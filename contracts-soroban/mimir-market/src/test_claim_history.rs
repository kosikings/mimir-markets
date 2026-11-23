//! Bounded claim history pagination keyed by event identity (#781).
//!
//! Covers: stable `(claim_id, seq)` references for every lifecycle transition,
//! cursor paging and its boundaries, cursor stability while new transitions are
//! appended, the page-size cap, unknown claims, explicit incomplete-history
//! boundaries (claims that predate tracking, archived entries), and that a
//! history read's cost does not grow with the challenger roster.
//!
//! All fixtures are synthetic: generated addresses and a local token contract.

#![cfg(test)]

extern crate std;

use soroban_sdk::Address;

use crate::contract::MimirMarketClient;
use crate::storage::DataKey;
use crate::test_common::{Fixture, USDC};
use crate::types::{
    ClaimHistoryPage, ClaimState, Error, TransitionKind, WinnerSide, MAX_CHALLENGERS,
    MAX_HISTORY_PAGE_SIZE,
};

/// Create a claim and add `n` challengers; returns the claim id and the
/// challengers in join order.
fn claim_with_challengers(f: &Fixture, n: u32) -> (u64, Address, std::vec::Vec<Address>) {
    let creator = f.user(10_000 * USDC);
    let mut params = f.params(500 * USDC);
    params.max_challengers = MAX_CHALLENGERS;
    let id = f.client().create_claim(&creator, &params);
    let mut challengers = std::vec::Vec::new();
    for _ in 0..n {
        let who = f.user(10 * USDC);
        f.client().challenge_claim(&who, &id, &(2 * USDC), &None);
        challengers.push(who);
    }
    (id, creator, challengers)
}

fn page(c: &MimirMarketClient, id: u64, cursor: u32, limit: u32) -> ClaimHistoryPage {
    c.get_claim_history(&id, &cursor, &limit)
}

fn seqs(p: &ClaimHistoryPage) -> std::vec::Vec<u32> {
    p.items.iter().map(|t| t.seq).collect()
}

/// Remove persistent entries directly, standing in for an archived entry or a
/// claim created before history tracking existed.
fn remove_key(f: &Fixture, key: DataKey) {
    f.env.as_contract(&f.contract_id, || {
        f.env.storage().persistent().remove(&key);
    });
}

#[test]
fn each_transition_gets_a_stable_sequential_reference() {
    let f = Fixture::new(500, 0);
    let (id, creator, challengers) = claim_with_challengers(&f, 3);

    let p = page(&f.client(), id, 0, 10);
    assert_eq!(seqs(&p), std::vec![1, 2, 3, 4]);
    assert_eq!(p.latest_seq, 4);
    assert!(p.from_genesis);
    assert_eq!(p.next_cursor, None);
    assert_eq!(p.missing_seq, None);
    assert_eq!(p.cursor, 0);

    let created = p.items.get(0).unwrap();
    assert_eq!(created.claim_id, id);
    assert_eq!(created.kind, TransitionKind::Created);
    assert_eq!(created.actor, Some(creator));
    assert_eq!(created.amount, 500 * USDC);
    assert_eq!(created.to_state, ClaimState::Open);

    let first = p.items.get(1).unwrap();
    assert_eq!(first.kind, TransitionKind::Challenged);
    assert_eq!(first.from_state, ClaimState::Open);
    assert_eq!(first.to_state, ClaimState::Active);
    assert_eq!(first.actor, Some(challengers[0].clone()));
    assert_eq!(first.amount, 2 * USDC);

    let third = p.items.get(3).unwrap();
    assert_eq!(third.from_state, ClaimState::Active);
    assert_eq!(third.actor, Some(challengers[2].clone()));
}

#[test]
fn cursor_pages_cover_history_exactly_once() {
    let f = Fixture::new(500, 0);
    let (id, _, _) = claim_with_challengers(&f, 7); // 8 transitions

    let p1 = page(&f.client(), id, 0, 3);
    assert_eq!(seqs(&p1), std::vec![1, 2, 3]);
    assert_eq!(p1.next_cursor, Some(3));

    let p2 = page(&f.client(), id, p1.next_cursor.unwrap(), 3);
    assert_eq!(seqs(&p2), std::vec![4, 5, 6]);
    assert_eq!(p2.next_cursor, Some(6));

    let p3 = page(&f.client(), id, p2.next_cursor.unwrap(), 3);
    assert_eq!(seqs(&p3), std::vec![7, 8]);
    assert_eq!(p3.next_cursor, None, "last page reaches latest_seq");

    // A page that ends exactly on latest_seq has no next cursor either.
    let exact = page(&f.client(), id, 5, 3);
    assert_eq!(seqs(&exact), std::vec![6, 7, 8]);
    assert_eq!(exact.next_cursor, None);

    // Cursor at or past the end: empty, complete, not an error.
    for cursor in [8u32, 9, u32::MAX] {
        let past = page(&f.client(), id, cursor, 3);
        assert_eq!(past.items.len(), 0);
        assert_eq!(past.next_cursor, None);
        assert_eq!(past.latest_seq, 8);
    }
}

#[test]
fn cursors_and_references_survive_new_transitions() {
    let f = Fixture::new(500, 0);
    let (id, _, _) = claim_with_challengers(&f, 2); // seq 1..3

    let before = page(&f.client(), id, 0, 2);
    assert_eq!(before.next_cursor, Some(2));

    // New transitions land after the cursor was handed out.
    for _ in 0..2 {
        f.client()
            .challenge_claim(&f.user(10 * USDC), &id, &(2 * USDC), &None);
    }

    let after = page(&f.client(), id, before.next_cursor.unwrap(), 10);
    assert_eq!(seqs(&after), std::vec![3, 4, 5]);
    assert_eq!(after.latest_seq, 5);
    assert_eq!(after.next_cursor, None);

    // The references read earlier still name the same transitions.
    let reread = page(&f.client(), id, 0, 2);
    assert_eq!(reread.items, before.items);
}

#[test]
fn page_size_is_bounded() {
    let f = Fixture::new(500, 0);
    let (id, _, _) = claim_with_challengers(&f, 55); // 56 transitions

    // limit = 0 means the maximum, never "everything".
    let p = page(&f.client(), id, 0, 0);
    assert_eq!(p.items.len(), MAX_HISTORY_PAGE_SIZE);
    assert_eq!(p.next_cursor, Some(MAX_HISTORY_PAGE_SIZE));

    let max = page(&f.client(), id, 0, MAX_HISTORY_PAGE_SIZE);
    assert_eq!(max.items.len(), MAX_HISTORY_PAGE_SIZE);

    let rest = page(&f.client(), id, max.next_cursor.unwrap(), 0);
    assert_eq!(seqs(&rest), std::vec![51, 52, 53, 54, 55, 56]);
    assert_eq!(rest.next_cursor, None);

    let refused = f
        .client()
        .try_get_claim_history(&id, &0, &(MAX_HISTORY_PAGE_SIZE + 1));
    assert_eq!(refused, Err(Ok(Error::HistoryPageTooLarge)));
}

#[test]
fn unknown_claim_is_not_found() {
    let f = Fixture::new(500, 0);
    assert_eq!(
        f.client().try_get_claim_history(&42, &0, &10),
        Err(Ok(Error::ClaimNotFound))
    );
    // The page-size guard runs before any storage read.
    assert_eq!(
        f.client()
            .try_get_claim_history(&42, &0, &(MAX_HISTORY_PAGE_SIZE + 1)),
        Err(Ok(Error::HistoryPageTooLarge))
    );
}

#[test]
fn resolution_is_recorded_with_oracle_and_verdict() {
    let f = Fixture::new(500, 0);
    let (id, _, _) = claim_with_challengers(&f, 2);
    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Creator,
        &f.str("done"),
        &90,
        &f.zero_hash(),
    );

    let p = page(&f.client(), id, 3, 10);
    assert_eq!(seqs(&p), std::vec![4]);
    let resolved = p.items.get(0).unwrap();
    assert_eq!(resolved.kind, TransitionKind::Resolved);
    assert_eq!(resolved.from_state, ClaimState::Active);
    assert_eq!(resolved.to_state, ClaimState::Resolved);
    assert_eq!(resolved.actor, Some(f.oracle.clone()));
    assert_eq!(resolved.winner_side, WinnerSide::Creator);
    assert_eq!(resolved.amount, 0);

    // An idempotent replay of the same verdict records nothing new.
    f.client().resolve_claim(
        &id,
        &WinnerSide::Creator,
        &f.str("done"),
        &90,
        &f.zero_hash(),
    );
    assert_eq!(page(&f.client(), id, 0, 10).latest_seq, 4);
}

#[test]
fn cancellation_and_expiry_are_recorded_with_their_refund() {
    let f = Fixture::new(500, 0);

    let creator = f.user(1_000 * USDC);
    let cancelled = f.client().create_claim(&creator, &f.params(100 * USDC));
    f.client().cancel_claim(&cancelled);
    let p = page(&f.client(), cancelled, 0, 10);
    assert_eq!(seqs(&p), std::vec![1, 2]);
    let t = p.items.get(1).unwrap();
    assert_eq!(t.kind, TransitionKind::Cancelled);
    assert_eq!(t.to_state, ClaimState::Cancelled);
    assert_eq!(t.actor, Some(creator.clone()));
    assert_eq!(t.amount, 100 * USDC);

    let expiring = f.client().create_claim(&creator, &f.params(100 * USDC));
    f.advance_by(3_600);
    f.client().transition_deadline(&expiring);
    let p = page(&f.client(), expiring, 0, 10);
    let t = p.items.get(1).unwrap();
    assert_eq!(t.kind, TransitionKind::Expired);
    assert_eq!(t.actor, None, "transition_deadline is permissionless");
    assert_eq!(t.amount, 100 * USDC);
}

#[test]
fn refused_and_replayed_calls_record_nothing() {
    let f = Fixture::new(500, 0);
    let (id, creator, challengers) = claim_with_challengers(&f, 1);
    assert_eq!(page(&f.client(), id, 0, 10).latest_seq, 2);

    // Same challenger again: idempotent no-op.
    f.client()
        .challenge_claim(&challengers[0], &id, &(2 * USDC), &None);
    // Self-challenge: refused.
    assert!(f
        .client()
        .try_challenge_claim(&creator, &id, &(2 * USDC), &None)
        .is_err());
    // Cancel after a challenge: refused.
    assert!(f.client().try_cancel_claim(&id).is_err());
    // Resolve before the deadline: refused.
    assert!(f
        .client()
        .try_resolve_claim(&id, &WinnerSide::Creator, &f.str("x"), &50, &f.zero_hash())
        .is_err());

    let p = page(&f.client(), id, 0, 10);
    assert_eq!(p.latest_seq, 2);
    assert_eq!(seqs(&p), std::vec![1, 2]);
}

#[test]
fn claim_that_predates_tracking_reports_missing_genesis() {
    let f = Fixture::new(500, 0);
    let (id, _, _) = claim_with_challengers(&f, 0);
    // Simulate a claim created before this contract version recorded history.
    remove_key(&f, DataKey::ClaimHistoryEntry(id, 1));
    remove_key(&f, DataKey::ClaimHistoryHead(id));

    let p = page(&f.client(), id, 0, 10);
    assert_eq!(p.items.len(), 0);
    assert_eq!(p.latest_seq, 0);
    assert!(!p.from_genesis, "nothing before tracking is on chain");
    assert_eq!(p.next_cursor, None);

    // Its first tracked transition starts the sequence, still flagged partial.
    let who = f.user(10 * USDC);
    f.client().challenge_claim(&who, &id, &(2 * USDC), &None);
    let p = page(&f.client(), id, 0, 10);
    assert_eq!(seqs(&p), std::vec![1]);
    assert_eq!(p.items.get(0).unwrap().kind, TransitionKind::Challenged);
    assert!(!p.from_genesis);
}

#[test]
fn archived_entry_stops_the_page_at_an_explicit_boundary() {
    let f = Fixture::new(500, 0);
    let (id, _, _) = claim_with_challengers(&f, 4); // seq 1..5
    remove_key(&f, DataKey::ClaimHistoryEntry(id, 3));

    let p = page(&f.client(), id, 0, 10);
    assert_eq!(seqs(&p), std::vec![1, 2], "never skips a gap silently");
    assert_eq!(p.missing_seq, Some(3));
    assert_eq!(p.next_cursor, Some(3), "caller may step past the gap");

    let p = page(&f.client(), id, 3, 10);
    assert_eq!(seqs(&p), std::vec![4, 5]);
    assert_eq!(p.missing_seq, None);
    assert_eq!(p.next_cursor, None);

    // A gap at the newest entry: boundary reported, nothing further to read.
    remove_key(&f, DataKey::ClaimHistoryEntry(id, 5));
    let p = page(&f.client(), id, 4, 10);
    assert_eq!(p.items.len(), 0);
    assert_eq!(p.missing_seq, Some(5));
    assert_eq!(p.next_cursor, None);
}

/// Before/after evidence: the pre-existing way to reconstruct who joined a
/// claim and in what order was reading the whole challenger roster
/// (`get_challenger_list`), whose cost grows with the roster. A history page of
/// a fixed size costs the same at 1 and at MAX_CHALLENGERS challengers.
///
/// Both claims live in the same environment so the host's ledger size is
/// identical for every measurement; only the claim's roster differs.
#[test]
fn history_read_cost_is_independent_of_roster_size() {
    let f = Fixture::new(500, 0);
    f.env.cost_estimate().budget().reset_unlimited();
    let (small, _, _) = claim_with_challengers(&f, 1);
    let (big, _, _) = claim_with_challengers(&f, MAX_CHALLENGERS);

    let mut rows = std::vec::Vec::new();
    for (id, n) in [(small, 1u32), (big, MAX_CHALLENGERS)] {
        f.env.cost_estimate().budget().reset_unlimited();
        let roster = f.client().get_challenger_list(&id);
        assert_eq!(roster.len(), n);
        let before = f.env.cost_estimate().resources();

        f.env.cost_estimate().budget().reset_unlimited();
        let p = f.client().get_claim_history(&id, &0, &2);
        assert_eq!(p.items.len(), 2);
        let after = f.env.cost_estimate().resources();

        std::println!(
            "challengers={:>3} | before (get_challenger_list): instructions={:>7} mem_bytes={:>6} read_entries={} | after (get_claim_history, limit 2): instructions={:>7} mem_bytes={:>6} read_entries={}",
            n,
            before.instructions,
            before.mem_bytes,
            before.disk_read_entries + before.memory_read_entries,
            after.instructions,
            after.mem_bytes,
            after.disk_read_entries + after.memory_read_entries,
        );
        rows.push((before, after));
    }

    let (roster_small, hist_small) = &rows[0];
    let (roster_big, hist_big) = &rows[1];
    // The roster read grows with the roster...
    assert!(roster_big.instructions > roster_small.instructions * 2);
    assert!(roster_big.mem_bytes > roster_small.mem_bytes + 10_000);
    // ...while a fixed-size history page does not.
    assert_eq!(
        hist_small.disk_read_entries + hist_small.memory_read_entries,
        hist_big.disk_read_entries + hist_big.memory_read_entries,
    );
    assert!(
        hist_big.instructions <= hist_small.instructions + hist_small.instructions / 20,
        "history page must be O(page), not O(challengers): {} vs {}",
        hist_small.instructions,
        hist_big.instructions
    );
    assert!(hist_big.mem_bytes <= hist_small.mem_bytes + hist_small.mem_bytes / 20);
    assert!(hist_big.instructions < roster_big.instructions);
}

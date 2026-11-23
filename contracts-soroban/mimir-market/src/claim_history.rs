//! Bounded claim transition history keyed by event identity (#781).
//!
//! Every successful lifecycle transition of a claim (create, each challenge,
//! resolve, cancel, deadline expiry) is appended as its own persistent entry
//! under `DataKey::ClaimHistoryEntry(claim_id, seq)`, where `seq` is a per-claim
//! counter that starts at 1, only ever increases, and is never reused.
//! `(claim_id, seq)` is therefore a stable transition reference: it keeps
//! naming the same transition however many transitions follow it.
//!
//! Reads are cursor-based and bounded: a page opens the claim's history head
//! plus at most `MAX_HISTORY_PAGE_SIZE` entries. It never loads the challenger
//! roster, so its cost does not grow with the number of challengers.
//!
//! Incomplete history is reported explicitly (see `ClaimHistoryPage`): a
//! claim that predates history tracking has `from_genesis == false`, and an
//! archived entry stops the page at `missing_seq` instead of being skipped
//! silently.
//!
//! Soroban state stays authoritative. This index is additive: recording never
//! moves funds, never changes an existing storage key, and adds one persistent
//! entry (plus the per-claim head) per transition.

use soroban_sdk::{Address, Env, Vec};

use crate::storage;
use crate::types::{
    ClaimHistoryHead, ClaimHistoryPage, ClaimState, ClaimTransition, Error, TransitionKind,
    WinnerSide, MAX_HISTORY_PAGE_SIZE,
};

/// Append one transition to `claim_id`'s history and return its `seq`.
///
/// Called by the lifecycle paths only after the claim write succeeded, so a
/// refused or replayed (idempotent no-op) call records nothing.
///
/// The first transition recorded for a claim decides `from_genesis`: it is
/// `true` only when that transition is the claim's `Created`. A claim that
/// existed before history tracking starts at seq 1 with its first post-upgrade
/// transition and `from_genesis == false`.
#[allow(clippy::too_many_arguments)]
pub fn record(
    env: &Env,
    claim_id: u64,
    kind: TransitionKind,
    from_state: ClaimState,
    to_state: ClaimState,
    actor: Option<Address>,
    amount: i128,
    winner_side: WinnerSide,
) -> Result<u32, Error> {
    let mut head = storage::claim_history_head(env, claim_id).unwrap_or(ClaimHistoryHead {
        latest_seq: 0,
        from_genesis: kind == TransitionKind::Created,
    });
    let seq = head.latest_seq.checked_add(1).ok_or(Error::Overflow)?;
    head.latest_seq = seq;

    storage::set_claim_history_entry(
        env,
        &ClaimTransition {
            claim_id,
            seq,
            kind,
            from_state,
            to_state,
            actor,
            amount,
            winner_side,
            ledger: env.ledger().sequence(),
            timestamp: env.ledger().timestamp(),
        },
    );
    storage::set_claim_history_head(env, claim_id, &head);
    Ok(seq)
}

/// Read up to `limit` transitions of `claim_id` with `seq > cursor`, oldest
/// first.
///
/// * `cursor = 0` starts at the beginning; pass the previous page's
///   `next_cursor` to continue. Because `seq` is never reused, a cursor stays
///   valid while new transitions are appended.
/// * `limit = 0` means `MAX_HISTORY_PAGE_SIZE`; `limit > MAX_HISTORY_PAGE_SIZE`
///   is refused with `Error::HistoryPageTooLarge` before any storage read.
/// * An unknown claim id is `Error::ClaimNotFound`. A known claim with nothing
///   recorded yet returns an empty page with `latest_seq == 0` and
///   `from_genesis == false`.
/// * A cursor at or past `latest_seq` returns an empty page with
///   `next_cursor == None`.
pub fn get_page(
    env: &Env,
    claim_id: u64,
    cursor: u32,
    limit: u32,
) -> Result<ClaimHistoryPage, Error> {
    if limit > MAX_HISTORY_PAGE_SIZE {
        return Err(Error::HistoryPageTooLarge);
    }
    let limit = if limit == 0 {
        MAX_HISTORY_PAGE_SIZE
    } else {
        limit
    };

    let head = match storage::claim_history_head(env, claim_id) {
        Some(head) => head,
        None => {
            if !storage::has_claim(env, claim_id) {
                return Err(Error::ClaimNotFound);
            }
            // Claim exists but predates history tracking and has not
            // transitioned since: nothing is recorded, and that is explicit.
            ClaimHistoryHead {
                latest_seq: 0,
                from_genesis: false,
            }
        }
    };

    let mut items = Vec::new(env);
    let mut missing_seq = None;
    let mut last_read = cursor;
    if cursor < head.latest_seq {
        let mut seq = cursor + 1;
        while seq <= head.latest_seq && items.len() < limit {
            match storage::claim_history_entry(env, claim_id, seq) {
                Some(entry) => {
                    items.push_back(entry);
                    last_read = seq;
                }
                None => {
                    missing_seq = Some(seq);
                    break;
                }
            }
            seq += 1;
        }
    }

    let next_cursor = match missing_seq {
        // Stop at the gap; let the caller step past it explicitly.
        Some(gap) if gap < head.latest_seq => Some(gap),
        Some(_) => None,
        None if last_read < head.latest_seq => Some(last_read),
        None => None,
    };

    Ok(ClaimHistoryPage {
        claim_id,
        items,
        cursor,
        next_cursor,
        latest_seq: head.latest_seq,
        from_genesis: head.from_genesis,
        missing_seq,
    })
}

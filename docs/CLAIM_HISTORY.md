# Claim transition history

`mimir-market` records every successful lifecycle transition of a claim on
chain and serves it back through one bounded, cursor-paginated view:

```
get_claim_history(claim_id: u64, cursor: u32, limit: u32) -> Result<ClaimHistoryPage, Error>
```

Soroban state is authoritative. The Postgres read index may mirror this view,
but a disagreement is resolved in favour of the contract.

## Event identity

Each transition is stored as its own persistent entry under
`DataKey::ClaimHistoryEntry(claim_id, seq)`. `(claim_id, seq)` is the
transition's stable identity:

- `seq` starts at `1` for a claim's first recorded transition and increases by
  exactly one per recorded transition.
- A `seq` is assigned once and never reused or rewritten, so a reference handed
  out today still names the same transition after any number of later ones.
- Refused calls and idempotent replays (re-challenging with the same address,
  replaying an identical verdict, cancelling an already-cancelled claim)
  record nothing.

| `TransitionKind` | Recorded by | `from_state → to_state` | `actor` | `amount` (USDC atomic units) |
| --- | --- | --- | --- | --- |
| `Created` (0) | `create_claim` | `Open → Open` | creator | creator stake |
| `Challenged` (1) | `challenge_claim` | `Open/Active → Active` | challenger | challenger stake |
| `Resolved` (2) | `resolve_claim`, `resolve_claim_versioned` | `Active → Resolved` | oracle | `0` (see `winner_side`, settlement events) |
| `Cancelled` (3) | `cancel_claim` | `Open → Cancelled` | creator | refund |
| `Expired` (4) | `transition_deadline` | `Open → Cancelled` | `None` (permissionless) | refund |

Every `ClaimTransition` also carries `winner_side` (the decoded verdict for
`Resolved`, `None` otherwise), the ledger sequence (`ledger`) and `timestamp` at which it happened.
Amounts are integer USDC; no value is expressed in XLM.

## Paging

- Returns transitions with `seq > cursor`, oldest first. Use `cursor = 0` for
  the first page, then the previous page's `next_cursor`.
- `limit` is capped at `MAX_HISTORY_PAGE_SIZE` (50). `limit = 0` means 50; a
  larger `limit` is refused with `HistoryPageTooLarge` (49) before any storage
  is read.
- A page opens the claim's history head plus one entry per returned
  transition. It never reads the challenger roster, so its cost is O(page)
  whatever the number of challengers (see the `history_read_cost_is_independent_of_roster_size`
  test).
- Because `seq` values are never reused, a cursor stays valid while new
  transitions are appended; the next page simply includes them.
- A cursor at or past `latest_seq` returns an empty page with
  `next_cursor = None`.
- An unknown claim id returns `ClaimNotFound` (12).

## Incomplete history is explicit

`ClaimHistoryPage` never lets a short or empty page stand in for "complete":

| Field | Meaning |
| --- | --- |
| `next_cursor` | `Some(c)` while transitions after this page exist; `None` once the page reached `latest_seq` (as of this read). |
| `latest_seq` | Newest recorded `seq` (0 = nothing recorded). |
| `from_genesis` | `true` when seq 1 is the claim's `Created` transition. `false` when the claim existed before history tracking: its earlier transitions were never recorded on chain and must be reconstructed from contract events or the read index. |
| `missing_seq` | `Some(s)` when entry `s` should exist but could not be read (absent from live state, e.g. archived after its TTL lapsed and not restored). The page stops *before* `s` instead of skipping it; `next_cursor` is then `Some(s)` if later entries exist, so a caller can step past the gap deliberately. |

Entries are bumped to the usual ~30-day TTL when written and when read, like
other persistent views.

## Compatibility

- Additive only: one new view, new `DataKey` variants
  (`ClaimHistoryHead`, `ClaimHistoryEntry`), new types and one new error code.
  No existing entry point, storage key, event or payout path changes; payouts
  stay pull-based.
- Claims created before this version have no recorded history until their
  next transition, and report `from_genesis = false` from then on.
- Each lifecycle write adds one persistent entry plus the per-claim head
  (written on every transition), so `challenge_claim` and `resolve_claim`
  each write two more entries than before.
- Error code 48 is left to `StaleClaimRevision`, which
  [`CONTRACT_ERRORS.md`](CONTRACT_ERRORS.md) already reserves.

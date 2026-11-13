# RECTIFY-01 — Build report, phase 0, trifidserverapp

## Result

Phase 0 (server) is built, reviewed once and fixed, on branch `feature/rectify-01-phase0-stop-withdraw`, cut
from `develop` at a0d4c07 (which carries `pile-fanout-recovery` and `gst-inclusive-rates`). Staff can stop and
restart any listing and withdraw any parked or live seller quote, with an impact preview before anything is
written. The emergency scripts, the `marketplace_paused` brake, the `pile_requote_enabled` kill switch and
the read-only data audit are in. **Flag state: `marketplace_paused` off, `pile_requote_enabled` off — both
are absent `Config` rows, which read as off.** Requote is therefore refused out of the box, as the brief
requires; every other behaviour is unchanged until a person uses a control. No STOP condition (S1–S4) was
hit. **This is the review gate: nothing is deployed and `dist/` is not rebuilt.**

## What is committed, and the PR

All on the branch, in this order:

| Commit    | Item  | What                                                                                                  |
| --------- | ----- | ----------------------------------------------------------------------------------------------------- |
| `2ad2fa2` | —     | The first build (reviewed by the client's Claude: "do not deploy yet", five defects)                  |
| `5b8fe49` | F1    | Withdraw runs the full stop closure; `confirmPile` refuses a stopped listing and writes conditionally |
| `2aad59d` | F2    | Pool check by current supplier; `confirmPaidPools`; blocked reason; the script skips loudly           |
| `7ee40ab` | F3    | Restart skips quote-born lines with no open quote ("seller re-quotes")                                |
| `9c2162d` | F4    | The brake closed on `relistListing`, `confirmPile`, `commitToPool`; the fan-out closes a stopped pile |
| `656c405` | F5    | `stoppedByTriFid` on `GET /listings/mine`                                                             |
| `6636813` | F6    | Tests that read the database (test 9) and check nobody else was notified (test 4)                     |
| (docs)    | notes | `PLAN_NOTES.md`, `CONTRACT_CHANGES.md` and this report — the commit that adds this file               |

Tests for F1–F5 are in the commit of the item they test.

**PR: none yet.** The branch is **not pushed** — the first `git push` was refused by the permission
classifier and no push was asked for in this round — so there is nothing to open a pull request from. BUILD §1.6
wants one against `develop`; it is opened as soon as the branch is pushed. `dist/` is not rebuilt (EC2 cannot
build; refresh and commit it when this is cleared for deploy).

## Review round 1 — what was wrong, what changed

| Item | Defect                                                                                                                                                                                                                                 | Fix                                                                                                                                                                                                                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1   | Withdrawing a quote paused its line but left the buyers' open piles on it open; the seller could confirm them and the fan-out would give buyers 24-hour deals at the withdrawn rate. `confirmPile`'s decision write was unconditional. | A withdrawal that pauses its line runs the Stop's pile closure (one shared function): decline, no strike, no message, Sales told. `confirmPile` refuses a staff-stopped listing whatever the flag says, and writes its decision with `findOneAndUpdate({decision: null})`.                                                        |
| F2   | The pool check was wrong in scope: any active pool on the same pack counted, whoever supplied it. The bulk script skipped such listings silently.                                                                                      | Only a pool the stopped listing's seller _supplies_ counts (`findCurrentSupplier`); others are listed in the preview and never block. Paid commitments: Admin only, `confirmPools` + `confirmPaidPools`, notice to the Admins by product and pack. The preview carries a `gate`. The script prints every skip and exits non-zero. |
| F3   | A restart revived a quote-born line whose quote was withdrawn: an all-India line at the old rate for 45 days with no quote behind it.                                                                                                  | A quote-born line with no open quote is skipped and reported as `seller re-quotes`, by the route and by the batch restart.                                                                                                                                                                                                        |
| F4   | The brake left `confirmPile`, `relistListing` and `commitToPool` open; a pile confirmed but not yet fanned out still sent offers after a stop.                                                                                         | All three are guarded (10 entry points now). The fan-out closes such a pile as a desk decline when its listing is staff-stopped.                                                                                                                                                                                                  |
| F5   | The seller app could not tell a TriFid stop from its own pause.                                                                                                                                                                        | Optional `stoppedByTriFid: true` on `GET /listings/mine` items; no reason or note is sent.                                                                                                                                                                                                                                        |
| F6   | Test 9 compared the plan with a copy of itself; test 4 did not check who else was notified.                                                                                                                                            | Test 9 reads the database; test 4 asserts only the buyers' Sales owners got a notice.                                                                                                                                                                                                                                             |

`CONTRACT_CHANGES.md` says the two note fields (`stopNote`, `withdrawNote`) stay out of every non-Purchase
response; a test confirms a distinctive note reaches no seller response and no notice.

## Files

Created: `src/modules/marketplace/` — `marketplace.guard.ts`, `marketplace.service.ts`,
`marketplace.closure.ts` (the pile-closing and Sales-notice helpers, shared with the fan-out job),
`marketplace.bulk.ts`, `marketplace.audit.ts`, `marketplace.controller.ts`, `marketplace.routes.ts`,
`marketplace.validation.ts`; `src/shared/scriptSupport.ts`; `src/scripts/stopMarketplace.ts`,
`restartStopped.ts`, `auditRectify01.ts`; `tests/rectify01Phase0.test.ts`, `tests/requoteFlag.ts`;
`docs/rectify-01/` (`RECTIFY-01_BUILD.md`, `RECTIFY-01_PLAN.md` — copies; `PLAN_NOTES.md`,
`CONTRACT_CHANGES.md`, this report).

Modified (small, additive; exact lines are in `PLAN_NOTES.md` §4): `src/app.ts`, `config/permissions.ts`,
`config/positions.ts`, `models/{Listing,Quote,Pile,StaffNotice}.ts`, `shared/errors.ts`,
`modules/listing/{listing.service,listing.groups}.ts`,
`modules/demand/{demand.service,pileOffer.service,pileFanout.job}.ts`, `modules/pool/pool.service.ts` (one
`export`, one guard), `modules/desk/sales/sales.stageActions.ts`, `modules/notice/notice.routes.ts`,
`package.json` (3 npm scripts), and two existing tests (`tests/m8.test.ts`, `tests/optionalCallNote.test.ts`,
one call each — see Deviations). `LOCK-36` was not in the folder I was given, so it is not saved under
`docs/rectify-01/`; the reviewer says Rajat will copy it in. The Buyer app was not touched.

## Contract

`CONTRACT_CHANGES.md` has six entries plus the stored fields, the staff routes and the scripts: the new error
code `MARKETPLACE_PAUSED` (HTTP 409, **app should show the message and not retry**) and the ten calls that can
raise it; the seller's relist being refused for a staff-stopped listing; a listing `paused` by staff, with the
optional `stoppedByTriFid` on `GET /listings/mine`; a quote `withdrawn` (**the Buyer app team must confirm its
screens handle that status** — it is the first time anything writes it); stop closing open piles as a decline,
also on a quote withdrawal and in the fan-out; **requote refused by default** (a visible change to the seller
app, on by default because it is the kill switch); the optional stored fields, and the rule that the two note
fields stay out of every non-Purchase response. The Buyer app team gets that file the same day.

## Tests

Acceptance tests of BUILD §1.5, all in `tests/rectify01Phase0.test.ts` (45 tests):

| #   | Test                                                                                                                                                                                                                       | Result           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | Stop without `confirm` returns the preview, writes nothing                                                                                                                                                                 | pass             |
| 2   | Stop sets `paused` + staff fields; feed and offers drop the line; new pile request refused                                                                                                                                 | pass             |
| 3   | Seller's relist refused; restart lifts it (fresh 45 days; the line takes requests again); a quote-born line with no quote behind it is skipped                                                                             | pass             |
| 4   | Open pile declined, no strike, buyers not messaged, Sales notified, enquiries `declined`, **and no staff member other than the buyers' Sales owners notified**                                                             | pass             |
| 5   | Offered deal survives and can still be taken; raised order untouched                                                                                                                                                       | pass             |
| 6   | Withdrawing a live quote: ask → `open`, hold cleared, rate change lapsed, Sales notified; two live quotes → ask stays `quoted`                                                                                             | pass             |
| 7   | Quote-born line paused **and its open piles declined**; a quote that reused the seller's own line leaves it live and its piles open                                                                                        | pass             |
| 8   | Second call changes nothing (key replay and fresh key); no permission → 403                                                                                                                                                | pass             |
| 9   | `stop-marketplace` dry run writes nothing; **the listings and quotes changed in the database are exactly the plan's**; `restart-stopped --batch` restarts exactly that batch; run end to end through the real command line | pass             |
| 10  | Each of the 10 entry points returns `MARKETPLACE_PAUSED` (and over HTTP); with it off they work; a new ask is left unguarded                                                                                               | pass             |
| 11  | Wall: no seller name in any Sales notice, no buyer name in any Purchase response or notice; neither note reaches a seller response or any notice                                                                           | pass             |
| 12  | Existing tests pass with the flags off                                                                                                                                                                                     | pass (see below) |

Added with the fixes: the pool gate by supplier (not the supplier → listed only; New-tier seller → never
supplies; unpaid → Admin + `confirmPools`; paid → Admin + both ticks + notice to the Admins, by product and
pack, no buyer); the preview `gate`; the script's loud skip and non-zero exit, from the command line;
`confirmPile` on a stopped listing (seller and Purchase on a call) and its lost race; the fan-out closing a
confirmed pile after a stop, and giving the deals if the listing was restarted first; the restart rule for
quote-born lines, by route and by batch; `stoppedByTriFid` and the two notes.
The data audit's seven checks and the database allow-list are as before.

Before the work was split into commits, each fix was broken on purpose, one at a time, and the test written
for it failed (fan-out, conditional confirm, pile closure on withdrawal, supplier scope, quote-born restart);
the files were then restored. The split was checked by diffing the final commit's files against that
verified tree: identical.

Full suite, flags off (the default): `npm test` — **76 files, 726 tests, all pass** (the first build had 710; the Phase 0 file grew from 29 to 45 tests), including the CH §23.5 dead-name check. One earlier run, made while other work was using the machine, hit a 20-second timeout in an unrelated test (`chainM4` INV-16); that file passes on its own (23/23) and the clean re-run above passes in full. `npm run lint`, `npm run format:check` and
`npm run type-check` (the other CI gates) are clean. "Flags on": each switch is turned on and off inside the
Phase 0 tests; the full suite cannot be run with `marketplace_paused` on, because refusing trade is what it
does. Every item commit was type-checked, linted and run against the Phase 0 test file on its own.

## Deviations

1. Script names/places follow the repo (`src/scripts/stopMarketplace.ts`, npm `stop:marketplace` etc.), not
   `scripts/stop-marketplace.ts`.
2. The database allow-list rule applies to dry runs too; the allow-list is `trifid_test`.
3. The banner flags ride on `GET /staff/notices` (Sales and Purchase cannot read `GET /admin/config`).
4. `settleAskAfterQuoteLeaves` was extracted from `acceptAskFill` so the withdraw reuses the short-fill code
   rather than copying it — same statements, same order.
5. `Pile.deskDeclined` and a 3-line change in `listing.groups.ts`, without which a restarted listing would stay
   shut by the stop's own decline.
6. Two existing tests now switch `pile_requote_enabled` on around their requote call. With the kill switch off
   by default they would otherwise fail; the requote mechanism they test is unchanged.
7. (Fixes) The pile-closing helpers moved from `marketplace.service.ts` into `marketplace.closure.ts`, so the
   fan-out job can use them without an import cycle; `findCurrentSupplier` in `pool.service.ts` is now
   exported (one word) so the stop can ask who supplies a pool.
8. (Fixes) The "blocked reason" F2 asks for is `preview.gate.blocked` (`{code: "admin_only", message}`), beside
   `gate.needsConfirm`, rather than a top-level `blocked` field.
9. (Fixes) The Sales call list now goes to the buyer's book owner only. The first build also told the owner's
   Sales Leader; test 4 as specified allows only the owners.
10. (Fixes) A restart of a quote-born line with no open quote answers 200 with `skipped: "seller re-quotes"`
    rather than an error, as F3 words it ("skip … report it").

## Skipped / not done

- **Push and the pull request.** Pushing is outward-facing; the first push was refused by the permission
  classifier and is the user's to do. `dist/` is not rebuilt.
- **`releaseQuote` refusing a quote whose line is paused** — a condition the reviewer attached to A2. It is not
  on the F1–F6 list, so it is not built; it belongs with A2 in Phase 1.
- No STOP item. The one state the brief calls S3 — a pool with paid commitments — needs an Admin and two
  ticks, and tells the Admins which pools to settle; whether to freeze the 24-hour clocks during a pause is a
  later founder decision.
- **`messageHi` for `MARKETPLACE_PAUSED`**: no Hindi wording exists. It must be supplied before the flag is
  ever switched on in front of buyers.

## Out of scope

Seen and left alone (details in `PLAN_NOTES.md` §7 and §5): a seller can reprice a quote-born line during the
binding (the quote keeps its rate); `closeParkedQuotes` leaves the published line live; a duplicate-ask merge
does not refresh `ttlAt`; the idempotency middleware replays a stored 400 for the same key and body;
`pauseListing`/`relistListing` pass `seller?._id` straight into the query; `undoPileConfirm` does not check
that the pile is still `confirmed`. The Admin screens are the next session.

## Switch-on

Nothing here needs switching on except by a person in an emergency. In this order, after the founder clears
the gate, the branch is pushed and the PR is merged:

1. **Rebuild `dist/` and commit it, then deploy.** Admin gets the two new permissions on boot.
2. **Purchase Leaders must sign out and in again** — position permissions are read into the token at sign-in,
   so without this they do not hold `listing:stop` / `quote:withdraw`.
3. **Send `CONTRACT_CHANGES.md` to the Buyer app team** before anything else, and confirm the apps show the
   message for `MARKETPLACE_PAUSED` without retrying, handle a quote with `status: "withdrawn"`, hide Relist for
   `stoppedByTriFid`, and show the requote refusal.
4. **Rehearse on staging, flags on and off.** Stop/Withdraw: try them on a test listing and quote — preview,
   confirm, check the Sales notice, restart. Check that `GET /staff/notices` as Sales returns
   `marketplacePaused: false`. `marketplace_paused`: at a quiet hour, `PUT /admin/config/marketplace_paused`
   with `true`, check the banner and that each of the ten entry points refuses, then set it back to `false`.
   `pile_requote_enabled`: leave off and check a seller's requote answers "Requote is being rebuilt. Decline
   or confirm instead."; it is turned on again only when RECTIFY-01 §5 ships.
5. **`marketplace_paused`:** leave off in production. **Before it is ever turned on in front of buyers,** get
   the Hindi wording for its message. Keep any pause short: the 24-hour deal and quote clocks keep running
   while accepting is refused, so a long pause silently kills deals.
6. **Scripts:** the first time, on staging, run each without `--apply` and read the CSV before using
   `--apply`. On the live database a run needs `--i-know-this-is-prod`. A run that skips a listing exits
   non-zero — read the skipped list. `npm run audit:rectify01` is read-only and is the audit
   RECTIFY-01_PLAN §3.2 wants read before any Phase 1 flag is switched on.

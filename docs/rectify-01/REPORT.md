# RECTIFY-01 — Build report, phase 0, trifidserverapp

## Result

Phase 0 (server) is built and tested on branch `feature/rectify-01-phase0-stop-withdraw`, cut from
`develop` at a0d4c07 (which carries `pile-fanout-recovery` and `gst-inclusive-rates`). Staff can now stop
and restart any listing and withdraw any parked or live seller quote, with an impact preview before
anything is written. The emergency scripts, the `marketplace_paused` brake, the `pile_requote_enabled`
kill switch and the read-only data audit are in. **Flag state: `marketplace_paused` off,
`pile_requote_enabled` off — both are absent `Config` rows, which read as off.** Requote is therefore
refused out of the box, as the brief requires; every other behaviour is unchanged until a person uses a
control. Nothing is committed, pushed or deployed (see Skipped). No STOP condition (S1–S4) was hit.

## Files

Created: `src/modules/marketplace/` — `marketplace.guard.ts` (43), `marketplace.service.ts` (885),
`marketplace.bulk.ts` (357), `marketplace.audit.ts` (339), `marketplace.controller.ts` (43),
`marketplace.routes.ts` (34), `marketplace.validation.ts` (37); `src/shared/scriptSupport.ts` (69);
`src/scripts/stopMarketplace.ts` (124), `restartStopped.ts` (89), `auditRectify01.ts` (65);
`tests/rectify01Phase0.test.ts` (1226), `tests/requoteFlag.ts` (22); `docs/rectify-01/` (`RECTIFY-01_BUILD.md`, `RECTIFY-01_PLAN.md` — copies;
`PLAN_NOTES.md`, `CONTRACT_CHANGES.md`, this report).

Modified (small, additive; exact lines are in `PLAN_NOTES.md` §4): `src/app.ts`, `config/permissions.ts`,
`config/positions.ts`, `models/{Listing,Quote,Pile,StaffNotice}.ts`, `shared/errors.ts`,
`modules/listing/{listing.service,listing.groups}.ts`, `modules/demand/{demand.service,pileOffer.service}.ts`,
`modules/desk/sales/sales.stageActions.ts`, `modules/notice/notice.routes.ts`, `package.json` (3 npm scripts),
and two existing tests (`tests/m8.test.ts`, `tests/optionalCallNote.test.ts`, one call each — see Deviations).
`LOCK-36` was not in the folder I was given, so it is not saved under `docs/rectify-01/`.

## Contract

`CONTRACT_CHANGES.md` has six entries (A1–A6) plus the stored fields, the staff routes and the scripts: the new error code `MARKETPLACE_PAUSED` (HTTP 409, **app
should show the message and not retry**); the seller's relist being refused for a staff-stopped listing; a
listing `paused` and a quote `withdrawn` by staff (feed and offers need no change); stop closing open piles
as a decline; **requote refused by default** (a visible change to the seller app, on by default because it is
the kill switch); the optional stored fields; the three staff routes and the two optional booleans on
`GET /staff/notices`; the scripts. The Buyer app team gets that file the same day.

## Tests

Acceptance tests of BUILD §1.5, all in `tests/rectify01Phase0.test.ts` (29 tests):

| #   | Test                                                                                                                                                                 | Result           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | Stop without `confirm` returns the preview, writes nothing                                                                                                           | pass             |
| 2   | Stop sets `paused` + staff fields; feed and offers drop the line; new pile request refused                                                                           | pass             |
| 3   | Seller's relist refused; restart lifts it (fresh 45 days; the line takes requests again)                                                                             | pass             |
| 4   | Open pile declined, no strike, buyers not messaged, Sales notified, enquiries `declined`                                                                             | pass             |
| 5   | Offered deal survives and can still be taken; raised order untouched                                                                                                 | pass             |
| 6   | Withdrawing a live quote: ask → `open`, hold cleared, rate change lapsed, Sales notified; two live quotes → ask stays `quoted`                                       | pass             |
| 7   | Quote-born line paused; a quote that reused the seller's own line leaves it live                                                                                     | pass             |
| 8   | Second call changes nothing (key replay and fresh key); no permission → 403                                                                                          | pass             |
| 9   | `stop-marketplace` dry run writes nothing and matches `--apply`; `restart-stopped --batch` restarts exactly that batch; run end to end through the real command line | pass             |
| 10  | Each of the 7 entry points returns `MARKETPLACE_PAUSED` (and over HTTP); with it off they work                                                                       | pass             |
| 11  | Wall: no seller name in any Sales notice, no buyer name in any Purchase response or notice                                                                           | pass             |
| 12  | Existing tests pass with the flags off                                                                                                                               | pass (see below) |

Also covered: open pools (S3) — count, Purchase Leader refused, Admin needs `confirmPools`, paid commitment
refuses outright; the requote kill switch off and on; the data audit's seven checks; the database allow-list.
A deliberate break of one guard was caught by the test (then restored).

Full suite, flags off (the default): `npm test` — **76 files, 710 tests, all pass**, including the CH §23.5
dead-name check. `npm run lint`, `npm run format:check` and `npm run type-check` (the other CI gates) are
clean. "Flags on": each switch is turned on and off inside the Phase 0 tests; the full suite cannot be run
with `marketplace_paused` on, because refusing trade is what it does.

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

## Skipped

- **Commit, push and the pull request.** BUILD §1.6 asks for a PR against `develop`. Pushing is outward-facing,
  so I left the work uncommitted on the branch for your go-ahead. `dist/` is not rebuilt either (EC2 cannot
  build; refresh and commit it when this is cleared for deploy).
- No STOP item. The one state the brief calls S3 — a pool with paid commitments — is refused in the server, not
  cascaded over; whether Admin should be able to override that is Question 1 in `PLAN_NOTES.md` §6.

## Out of scope

Seen and left alone (details in `PLAN_NOTES.md` §7 and §5): a seller can reprice a quote-born line during the
binding (the quote keeps its rate); `closeParkedQuotes` leaves the published line live; a duplicate-ask merge
does not refresh `ttlAt`; the idempotency middleware replays a stored 400 for the same key and body;
`pauseListing`/`relistListing` pass `seller?._id` straight into the query. The Admin screens are the next session.

## Switch-on

Nothing here needs switching on except by a person in an emergency. In this order, after the founder clears the
gate and the PR is merged:

1. **Deploy** (rebuild and commit `dist/` first). Admin gets the two new permissions on boot; **Purchase Leaders
   must sign out and in again** — position permissions are read into the token at sign-in.
2. **Send `CONTRACT_CHANGES.md` to the Buyer app team** before anything else, and confirm the apps show the
   message for `MARKETPLACE_PAUSED` without retrying, and for the requote refusal.
3. **Stop/Withdraw:** try them on a test listing and quote on staging first — preview, confirm, check the Sales
   notice, restart. Check: `GET /staff/notices` as Sales returns `marketplacePaused: false`.
4. **`pile_requote_enabled`:** leave off. Check: a seller's requote answers "Requote is being rebuilt. Decline
   or confirm instead." It is turned on again only when RECTIFY-01 §5 ships.
5. **`marketplace_paused`:** leave off. Rehearse once at a quiet hour on staging: `PUT /admin/config/marketplace_paused`
   with `true`, check the banner and that each of the seven entry points refuses, then set it back to `false`.
6. **Scripts:** the first time, on staging, run each without `--apply` and read the CSV before using `--apply`.
   On the live database a run needs `--i-know-this-is-prod`. `npm run audit:rectify01` is read-only and is the
   audit RECTIFY-01_PLAN §3.2 wants read before any Phase 1 flag is switched on.

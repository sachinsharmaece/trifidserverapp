# LOCK-34 — Build report

## Result

Built and tested on `feature/lock-34-dormant-pool` in `trifidserverapp` and `trifidadminapp`
(from `feature/work-2026-11-03`; local commits only, nothing pushed or deployed). The buyer/seller
app is untouched. **The policy is OFF by default**: with the switch off nothing new is written, the
new routes answer 403 "Dormant policy is switched off." (except `status`), and the screens look as
they did. The nightly job also needs the server env key `DORMANCY_JOB_ENABLED=true`.

## Files

See `PLAN.md` §4 — it matches what was built. Commits: server `31783b6` (backend), `68a0b85`
(tests, docs), `c5f8b9b` (dist); admin `2680b30`.

## Tests

| Run                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server, whole suite, switch off         | 73 files, **693 tests pass** (incl. the route-inventory guard tests and the dead-name check)                                                                                                                                                                                                                                                                                                                                                                                      |
| Server, new: `holdingRules` + `holding` | 56 tests pass: clock start and threshold (exact, in paise), windows, working-hours examples, intake and 20 concurrent leads, uncalled, claim race, Pool visibility and search, `zzzzz`, Team Leader list / Leave / Assign, nightly clocks (day 89/90/97, restart, lead and claim conversion, expired claim, rejected firm), idempotent re-run, backlog 100 a week, bills counted once, placeholders never matched, Change owner refused, transfer, policy API, a caller over HTTP |
| Admin, whole suite                      | 34 files, **192 tests pass** (incl. 8 new)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Admin lint, build                       | clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Server typecheck, lint                  | clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Baseline note: the admin type-check of _test files_ already fails on the base branch in
`DemandByProduct.test.tsx` (×2) and `HomeRedirect.test.tsx`; unchanged by this work.

## Deviations (and why)

- `GET /staff/sales/holdings/status` always answers 200 with `{enabled, isCaller, isTeamLeader}`, so the screens can tell the switch is off without a 403 on every page load.
- `via = 'transfer'` (a leaver's holdings handed to the person taking over) is added to the spec's list and is never counted as uncalled, so the heir is not flooded.
- Net amount = invoice value; refunds and returned boxes are not deducted (client, 3 Nov). `returnedValuePaise()` is the one place to change.
- Uncalled counts a `call` or `update_request` by the holder since the holding began; a bare `note` does not.
- A rejected, blacklisted or deleted firm is left out of counts and the Pool; the nightly job closes its holding quietly.
- Team Leader switches _Receiving leads_ only for callers in his own team; Admin for anyone.
- The Book tab puts uncalled parties first within the page loaded, not across the whole list.
- Register / Approve forms are unchanged: with the switch on their "Assigned to" picker has no effect (the server skips that write).
- Scripts refuse a non-local database unless `LOCK34_TEST_DB_MARKER` matches the URI or `--i-know-this-is-prod` is passed.

## Skipped

- Lead upload (Meta / field associate) — marketing phase later (client, 3 Nov). The `source` values are in the data model.
- Caller incentives, margin attribution, buyer credit — out of scope per the spec.

## Not verified

- The three CLI scripts were **not run** against any database (only their matching and go-live logic is tested). Run each with `--dry-run` first.
- The screens were exercised by component tests, not opened in a browser.
- Placeholder data (`zzzzz`, 9999999991 upward) is not in the repos; confirm the real range in the database.

## Out of scope — noticed, left alone

- The admin test-file type errors above.
- Uncommitted `.env.production` in both repos and line-ending noise in `dist/` (git `autocrlf`) were there before and are not part of this work.

## Switch-on

1. Give every caller a position (Sales Executive or Sr. Sales Executive) and a Sales Leader (Team page); run `npm run check:scopeReadiness`; set `OWNERSHIP_SCOPE_ENFORCED=true` (otherwise any caller can open any Pool party's full file).
2. Manage → Dormant policy: set the go-live date (leave the switch off).
3. Test database only: `npm run migrate:owners -- --report out.csv` → review → add `--apply`.
4. `npm run import:margBills -- <file.csv> --report out.csv` → review → `--apply`.
5. `npm run import:callerLists -- <file.csv> --report out.csv` → review → `--apply` (after step 4).
6. Decide about the ~850 imported pending buyers (approve them first, or keep the nightly job off) — they cannot bill until approved and would all reach day 67 together.
7. Dormant policy: switch ON. Intake, the Pool and claims start working.
8. Set `DORMANCY_JOB_ENABLED=true` on the worker and restart it. Next morning confirm the log line `LOCK-34 clocks ran` and its counts.

Turning the switch off after it has been on leaves the holdings in place while the old assignment screens work again; treat "on" as one-way, or re-run `migrate:owners` to bring the two back in step.

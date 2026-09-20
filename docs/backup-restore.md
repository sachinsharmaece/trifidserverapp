# Backup and restore

`CH §24.5`–`§24.7`; `ARCHITECTURE.md` §8: _"restore tested by actually restoring before launch."_
This page records what has been **proven** and what **has not**, so nobody reads a green drill as
more than it is.

## What was proven — the logical restore (20 September 2026, M9)

`npm run drill:restore` ([`src/scripts/backupRestoreDrill.ts`](../src/scripts/backupRestoreDrill.ts))
takes a backup of the source database, restores it into an isolated target and verifies it.

|              |                                                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source**   | the development MongoDB Atlas cluster, database `trifid` — **read-only**; the script never writes to the source                                          |
| **Target**   | a throw-away in-memory MongoDB replica set (`trifid_restore_drill`), dropped afterwards — nothing was written to any shared cluster                      |
| **Restored** | **73 collections, 684 documents, 295,238 bytes** of canonical EJSON, every index recreated                                                               |
| **Backup**   | 3.85 s                                                                                                                                                   |
| **Restore**  | 10.70 s (dominated by recreating indexes on 73 collections, not by the data)                                                                             |
| **Verify**   | 0.34 s — per collection: same document count, same SHA-256 over every document in `_id` order (one changed field anywhere fails it), same index key sets |
| **Result**   | `problems: []` — every collection identical                                                                                                              |
| **Cleanup**  | the dump directory was deleted; it held real documents                                                                                                   |

**Do not extrapolate the timings.** 684 documents is a development database. The backup and verify
steps scale roughly with data volume; restore time is index-bound at this size. Re-run the drill
against a production-sized copy before quoting a recovery time to anyone.

To run it again, into a target you name on purpose:

```
npm run drill:restore -- --target-uri "mongodb://…/some_scratch_db" --keep
```

`--keep` leaves the dump on disk for inspection (it contains real data — delete it). The script
refuses to restore onto its own source.

## What was NOT proven — and cannot be by a script

These are provider-side and belong to the owner. **None of them is done.**

1. **A daily snapshot exists.** The development cluster's tier and backup settings were not
   inspected — no Atlas credentials are available to this project's tooling. Confirm in the Atlas
   console that snapshots are enabled and being taken on the production cluster.
2. **Point-in-time recovery reaches back "to within minutes"** (`CH §24.5`). Enable it on the
   production cluster and perform one PITR restore to a chosen timestamp.
3. **An off-site copy at a different provider exists and is readable** (`CH §24.6`). No second
   provider has been chosen — `QR-061`.
4. **A restore from the provider's own snapshot** (as opposed to this logical dump) into a fresh
   cluster, with the application started against it and `GET /health` green.
5. **The restore target of a few hours** (`CH §24.5`) — measured on production-sized data.

The logical dump above is a useful _second_ line of defence (it is provider-independent and
verifiable), but it is not a substitute for items 1–4.

## Launch gate

`ARCHITECTURE.md` §8 makes a real restore **required before launch, not optional hygiene**. Until
items 1–4 are done by the owner, the honest status is: _the data can be dumped and restored exactly;
the production backup regime is unverified._

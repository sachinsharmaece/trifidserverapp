# LOCK-34 Build: Dormant parties, lead intake and the Pool (Sales desk)

**Version 2, 3 November 2026.** Replaces the 25 October version. What changed:

- the Sr. Sales Executive position now counts as a caller;
- placeholder party data (tehsil `zzzzz`, mobiles in the 9999999991 series) is handled;
- incentives and credit are explicitly out of scope.

> **For Claude Code.** Save this file in the repo as `docs/lock-34/LOCK-34_BUILD.md`, then run:
> `Read docs/lock-34/LOCK-34_BUILD.md and execute it end to end.`

---

## 0. Your role, and the one rule above all others

You are a senior engineer adding **one feature** to a working app that is already in testing
(TriFid Admin app, on a test database). It is someone else's codebase, and other work depends
on it staying exactly as it is.

**With the feature switch off, the app must behave exactly as it does today, byte for byte.**

Working rules:

- **Add; do not rewrite.** Touch only the areas listed in §10. Anything else needs a written
  reason in `PLAN.md` before you edit it.
- **No collateral edits.** No refactoring, renaming, reformatting, dependency upgrades, lint
  autofix runs over existing files, or "while I'm here" fixes.
- **Out-of-scope bugs.** If you see one, write it in `REPORT.md` and leave the code alone.
- **Copy the codebase's own patterns** for everything: folder layout, data access, validation
  (Zod), API style, auth and role checks, the Idempotency-Key convention, UI components, date and
  money formatting, and the test style. Read before you write.
- **Run every phase in one go.** Do not stop between phases to ask for confirmation. The only
  exception is a STOP condition (§1.2).
- **Track progress** in your task list, one item per phase.
- **If the repo has a `CLAUDE.md`,** read it first and follow it. Where it conflicts with this
  file on code style, follow `CLAUDE.md`. On business rules, this file wins.

---

## 1. Workflow

### 1.1 Phases, in order

**Phase 0: Recon. Read only, change nothing.** Map the codebase and write
`docs/lock-34/PLAN.md` with the following sections:

1. **Stack.** Framework, database and ODM/ORM, auth, test runner, scheduler, deploy target.
2. **Where each concept lives.** Give file paths and model or field names for each of these:
   - the party/buyer/counterparty model, including which model the call log refers to;
   - staff and positions: how a _Sales Executive_, a _Sr. Sales Executive_ and a _Sales Team
     Leader_ are identified. One person can hold several positions;
   - **placeholder data** in party records (§12.1): how many parties have tehsil `zzzzz`, and
     the exact range of placeholder mobiles in use;
   - the sales order, the state that means _billed in Marg_, its bill date and amount, and the
     **money unit** (paise or rupees);
   - refunds and returned boxes recorded against a sales order;
   - the call log: party, staff, timestamp, direction, outcome, and the outcome enum;
   - the admin settings / master, and any change log;
   - **the existing owner / book / queue field, with every place that reads or writes it**;
   - the Sales desk _Buyers_ screen and its tabs, and the _Today_ screen and its groups;
   - **every code path that creates a party/buyer** (registration, field associate, imports,
     staff entry, call log);
   - any existing scheduler or cron;
   - existing tests, especially any test asserting there is no dormancy field on a buyer.
3. **Mapping table.** Each concept in §3 against the existing code it maps to.
4. **Exact files.** Every file to create and every file to modify, each with a one-line
   purpose.
5. **Risks and questions.**
6. **Baseline.** The current results of typecheck, lint, tests and build. Record them; do not
   fix them.

Print a 10-line summary of the plan, then continue to Phase 1 without waiting.

**Phase 1: Branch.** Create `feature/lock-34-dormant-pool`. Commit `PLAN.md`.

**Phase 2: Backend.** Settings and switch (§4.1), data model (§5), services (§6), clock job
(§7). Commit.

**Phase 3: Frontend.** Sales desk and admin screens (§8). Commit.

**Phase 4: Tests.** Every acceptance test in §11, plus unit tests for the working-hours
function and the clock-start function. Commit.

**Phase 5: Scripts.** Migration and imports (§9), each defaulting to `--dry-run`. Commit.

**Phase 6: Verify and report.**

- Run typecheck, lint, all tests (old and new) and build, with the switch on and off.
- Review your own diff with `git diff --stat` against the branch you started from. Every file
  in it must appear in `PLAN.md`; revert anything that doesn't.
- Write `docs/lock-34/REPORT.md` using the template in §13. Commit.

### 1.2 STOP conditions

On any of these, write the problem in `PLAN.md`, print one short question, and stop.

- **S1.** No call log that records party, staff and timestamp. Uncalled (§3) cannot be computed
  without it.
- **S2.** No reliable way to tell that a sales order was billed in Marg, with its date and
  amount.
- **S3.** No way to tell a caller (Sales Executive or Sr. Sales Executive) from a Sales Team
  Leader (no position or role).
- **S4.** The work cannot be done without changing an area forbidden in §10.
- **S5.** The baseline build is broken, so your work cannot be verified. Failing _unrelated
  tests_ are not a STOP: record them and continue.

**Partial stop, then continue:** the Meta lead upload (§9.4) needs a party record that holds
only name, mobile and tehsil. If the party model requires more (GSTIN, for example), **do not
loosen its validation.** Skip that one item, report it, and build everything else.

---

## 2. What this feature is

TriFid's callers each hold a set of parties (buyers).

- A party who stops buying is released to a shared **Pool** after 90 days without enough
  billing, and another caller can claim him.
- New leads (from Meta ads, field associates, app registration) are dealt to callers by **who
  has the fewest leads not yet called**, so a fresh lead is rung within hours, not weeks.
- Every hand-over records **why** the previous holder let the party go, so the next caller does
  not repeat the failed pitch.

This replaces the earlier rule that a buyer left a book only when a person decided it, and that
rule's "no dormancy" principle.

---

## 3. Glossary. Use these words exactly, in code and on screen.

| Term                  | Meaning                                                                                                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Party**             | A buyer (the existing party/buyer/counterparty record)                                                                                                                                                                                   |
| **Holder**            | The one staff member currently responsible for a party                                                                                                                                                                                   |
| **Holding**           | One period of one holder holding one party. A party has **at most one open holding**                                                                                                                                                     |
| **Bill**              | A platform sales order that has reached the _billed in Marg_ state, or an imported historical Marg bill (§4.2)                                                                                                                           |
| **Lead**              | A party with no bill                                                                                                                                                                                                                     |
| **Ordered party**     | A party with at least one bill                                                                                                                                                                                                           |
| **Pool**              | All parties with **no open holding**                                                                                                                                                                                                     |
| **Uncalled**          | An open holding of kind _lead_ or _claim_ (not created at go-live, not own-call) with **no call logged by its holder for that party since the holding started**. Any outcome counts, including _no answer_. Always derived, never stored |
| **Reason window**     | 7 days before a release, in which the holder logs why                                                                                                                                                                                    |
| **Caller**            | A staff member with the Sales Executive or Sr. Sales Executive position                                                                                                                                                                  |
| **Sales Team Leader** | Takes overflow leads and owns the Pool                                                                                                                                                                                                   |

**Name collisions to avoid:**

- The order's existing `claimed` field (the buyer says he has paid) is unrelated to a pool
  claim. So is the seller _claim board_.
- The seller-side _Dormant_ state on demand rows is unrelated.
- Never reuse any of those for this feature.
- **Do not add any field named `dormant`, `isDormant`, `active` or `isActive` to the party
  model.** "Dormant" means _no open holding_, and that is derived.

---

## 4. Rules (LOCK-34)

All dates and times are in **Asia/Kolkata**. "Day N" means N calendar days after the start date
(the start date is day 0).

### 4.1 Settings, held in the admin master and editable

| Key                                     | Default                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| `dormancy.enabled` (the feature switch) | `false`                                                                                       |
| `dormancy.goLiveDate`                   | empty                                                                                         |
| `dormancy.orderedDays`                  | 90                                                                                            |
| `dormancy.billingThreshold`             | ₹10,000, stored **in the same unit as sales-order amounts**                                   |
| `dormancy.reasonWindowDays`             | 7                                                                                             |
| `dormancy.uncalledCap`                  | 50                                                                                            |
| `dormancy.firstCallWorkingHours`        | 4                                                                                             |
| `dormancy.leadDays`                     | 60 (also used for claims)                                                                     |
| `dormancy.unclaimedDays`                | 3                                                                                             |
| `dormancy.backlogPerWeek`               | 100                                                                                           |
| `dormancy.seasons`                      | Kharif Jun–Sep · Rabi Oct–Feb · Zaid Mar–May. **Stored for reporting only. Nothing reads it** |

- Every settings change is logged: who, when, from, to. Use the existing change log if there is
  one; otherwise add a small `settings_log`.
- **Working hours** are 09:30–19:00, Monday to Saturday. Sunday does not count.

### 4.2 Billing

- **The bills for a party** are its sales orders that reached _billed in Marg_, each with:
  - the bill date;
  - **net amount** = billed amount − refunds − value of returned boxes recorded against that
    order.

  If the codebase has no per-order refund or return record, use the billed amount and say so in
  `REPORT.md`.

- **Historical bills** from the Marg import (§9.3) also count, but only those dated before
  `goLiveDate` and whose invoice number is not already linked to a platform order. This stops a
  bill being counted twice.
- **Clock start** (one function, used everywhere). Bills are sorted by date, then id:
  ```
  clockStart(bills, T):
    if no bills: return null
    start = bills[0].date ; total = 0
    for b in bills:
      total += b.net
      if total >= T: start = b.date ; total = 0      # remainder is not carried
    return start
  ```
  Examples:
  - ₹4,000 on day 20 and ₹7,000 on day 50 restarts the clock on day 50.
  - ₹9,999 in total never restarts it.

### 4.3 Ordered party clock

- **Day 90** from `clockStart`: the reason window opens.
- **Day 7 of the window** (day 97): the party is released to the Pool.
- If a restart (§4.2) happens while the window is open, the window is cancelled and the holder
  keeps the party.

### 4.4 Reason window

- **The holder stays the holder** while the window is open.
- **Reasons** are the existing call-outcome enum without _placed an order_. Reuse the existing
  keys:
  _asked for a rate · wants something we don't have · rate too high · already holds stock · buys
  direct from the company · not now, call later · no answer · wrong number._
- **The holder can log or change his reason** until the window ends. **Logging a reason does
  not release early**: release happens only at the end of the window.
- **No reason by the end** means the party is released anyway, marked
  `systemMarked = true`. Show this as **"owner did not diagnose"**.
- **There is no "keep" option.**
- **Every move into the Pool goes through this window.** That covers ordered parties (§4.3),
  leads (§4.5) and claims (§4.7).

### 4.5 Intake: every new party, whatever its source

- **Call `assignNewParty` once from every creation path.** This includes Meta, field associate,
  app registration, staff entry and import.
- **Own-call exception:** a party a caller creates from his own call becomes a holding for that
  caller with `via = own_call`. It does **not** count as uncalled.
- **Assignment.** Candidates are callers with `receivingLeads = true` and an uncalled count
  under the cap.
  - Pick the one with the **fewest uncalled**.
  - On a tie, pick the one whose **last intake assignment is oldest**; never assigned counts as
    oldest.
  - **No candidate:** assign to the Sales Team Leader. Overflow has no cap. If there are several
    Team Leaders, pick the one with the fewest uncalled.
  - **No Team Leader exists:** leave the party in the Pool and log an error.
- **Serialize assignments** (one at a time) so concurrent leads cannot push a caller past the
  cap. Use the codebase's transaction or locking mechanism; if it has none, use a single lock
  document updated atomically.
- **First call within 4 working hours** of the assignment. This applies to `via = intake` only.
  A breach shows against the holder and has no other consequence.
- **A lead converts on its first bill, of any amount.** Close the lead holding
  (`end = ordered`) and open a _book_ holding for the same holder, starting on that bill's date.
- **No bill by day 60** of the holding: the reason window opens, then release.

### 4.6 Pool

- **The Pool is every party with no open holding.**
- **Pool entry time** is the `endedAt` of the party's last holding. The **last holder** is that
  holding's holder.
  - A party that has never had a holding entered the Pool at its creation or at go-live,
    whichever is later. It has no last holder.
- **Two sections, derived:** _Ordered parties_ (has at least one bill) and _New leads_.
- **Card fields:** party name · tehsil · district · previous holders, each with from–to dates
  and their reason (or "owner did not diagnose") · **Claim** button.
  - **Nothing else.** No mobile, no GSTIN, no amounts. These appear only after a claim, in the
    normal buyer file.
- **Visibility:** callers see every card **except** those where they are the last holder. An
  earlier holder can claim again.
- **Order:** longest in the Pool first.
- **Pool search** matches party name, tehsil and district only.
- **Placeholder tehsil `zzzzz`** (parties outside MP) is never displayed. Show the district and
  state in its place, and leave it out of search.

### 4.7 Claim

- **Who can claim:** any caller, provided he is not the last holder and his uncalled count is
  **under the cap**. A caller with _receiving leads_ off may still claim.
- **When the claim is refused,** the button stays visible but disabled, with the reason:
  "You have 50 uncalled. Call them first." Use the cap setting, not a hard-coded 50.
- **First claim wins.** Enforce it in the database (see §5), not in the UI. The loser sees
  "Already claimed by someone else."
- **The new holding:**
  - Ordered party: `kind = claim`.
  - Lead: `kind = lead`.
  - Either way: `via = pool_claim`, `startedAt = now`.
- **A claimed party counts as uncalled** until the claimer logs a call.
- **Conversion before release** (inside the 60 days or the reason window):
  - _claim_: a restart (§4.2) on or after `startedAt` closes the claim (`end = billed`) and opens
    a _book_ holding for the claimer, starting on the restart date.
  - _lead_: the first bill converts it, as in §4.5.
- **No conversion by day 60:** the reason window opens, then release. The claimer becomes the
  last holder.

### 4.8 Sales Team Leader

- **The 3-day list.** Pool parties with **3 days or more** since pool entry, and not yet
  reviewed since that entry, appear on the Team Leader's list.
  - **Assign:** pick a caller who is not the last holder and is under the cap. This creates the
    same holding as a claim, with `via = desk_assign`.
  - **Leave:** record a review, and the party drops off his list. It shows again only after it
    next re-enters the Pool.
- **The receiving-leads switch.** The Team Leader turns `receivingLeads` on or off for each
  caller, for leave.
  - Off stops new intake assignments only.
  - The caller's existing holdings stay with him.

### 4.9 Go-live

- **Starting holdings** come from the imported caller lists, with `via = go_live`.
  - A party with bills gets `kind = book`.
  - A party without bills gets `kind = lead`, starting on the go-live date.
  - A party with no caller starts in the Pool, with no reason window.
- **Uncalled exclusion:** go-live holdings never count as uncalled.
- **The backlog.** A book holding already at day 90 or more on the go-live date is marked
  `backlog = true`.
  - **Its window does not open on its own.** The job opens backlog windows at most
    `backlogPerWeek` (100) in any rolling 7 days, **oldest last bill first**.
  - **If a restart happens before its turn,** clear `backlog`.

### 4.10 Not built (parked)

- **A minimum number of call attempts before release.**
- **Routing field-associate leads by tehsil.** Field-associate leads use §4.5 like any other.
- **An exit rule for parties who never buy.** The Team Leader's _Leave_ is the only exit for
  now.

---

## 5. Data model

Follow the codebase's ODM and naming conventions. If it uses MongoDB (the ObjectIds in the app
suggest it does), use these shapes:

```
holding {
  partyId        -> existing party/buyer/counterparty (the one the call log refers to)
  holderId       -> staff
  kind           'lead' | 'claim' | 'book'
  via            'intake' | 'own_call' | 'pool_claim' | 'desk_assign' | 'go_live' | 'conversion'
  source?        'meta' | 'fa' | 'app' | 'call' | 'staff' | 'import'        (intake only)
  startedAt      Date
  windowOpenedAt? Date
  backlog?       boolean
  reason?        release-reason key        reasonAt? Date
  endedAt?       Date
  end?           'ordered' | 'billed' | 'released'
  systemMarked?  boolean                   (released with no reason)
  isOpen         boolean                   (true until ended)
  createdAt, updatedAt
}
UNIQUE partial index { partyId } where isOpen = true     <- enforces one holder, and makes the claim race safe
index { holderId, isOpen }    index { isOpen, endedAt }

poolReview   { partyId, poolEnteredAt, reviewedBy, reviewedAt }        (the Team Leader's "Leave")
margBillImport { gstin, partyId, invoiceNo, billDate, netAmount, importedAt }   (go-live history only)
staff        + receivingLeads: boolean, default true
settings     + the dormancy.* keys in §4.1
```

**Derived, never stored:** section, uncalled, day counts, clock start, the 4-hour due time,
last intake assignment, and the 3-day list.

**The existing owner/book/queue field.** If the codebase already stores one on the party, keep
it **as a mirror written only by the holding service**, in the same write as the holding.

- When the switch is on, every other writer of that field must not run.
- Wrap the old book/queue gate in `if (!dormancy.enabled)`. Do not patch the old gate. It has a
  known bug: a buyer with 2 orders still shows "queue". With the switch on, the holding service
  replaces it.
- All readers keep working unchanged.

---

## 6. Backend operations

Expose these through the app's existing API pattern, with the existing auth and role checks.

- **Every POST and PUT** follows the existing Idempotency-Key convention, and **the frontend
  must send the header.**
- **Refusals** return a human sentence saying why.

| Operation                                              | Who                | Does                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assignNewParty(partyId, source, actor?)`              | internal           | §4.5. Called from every creation path; does nothing when the switch is off                                                                                             |
| `reevaluateParty(partyId)`                             | internal           | Runs §7's per-holding step for one party. Used by the job and by tests. **Do not hook it into order or Accounts code**: the nightly job picks up new bills and refunds |
| `myHoldings()`                                         | caller             | His open holdings, uncalled first, each with kind, clock and window state                                                                                              |
| `myUncalledCount()`                                    | caller             | For the counter "Uncalled 12 / 50"                                                                                                                                     |
| `poolList(section, search)`                            | caller             | §4.6, filtered for the viewer                                                                                                                                          |
| `claim(partyId)`                                       | caller             | §4.7, atomic                                                                                                                                                           |
| `logReason(holdingId, reason)`                         | holder             | §4.4. Only while the window is open                                                                                                                                    |
| `teamLeaderPoolQueue()`                                | Team Leader        | §4.8, the 3-day list                                                                                                                                                   |
| `deskAssign(partyId, callerId)` / `deskLeave(partyId)` | Team Leader        | §4.8                                                                                                                                                                   |
| `setReceivingLeads(staffId, on)`                       | Team Leader, admin | §4.8                                                                                                                                                                   |
| settings get / update                                  | admin              | §4.1, logged                                                                                                                                                           |
| `uploadLeads(csv)`                                     | Team Leader        | §9.4                                                                                                                                                                   |

With the switch off, every new endpoint returns 403 "Dormant policy is switched off", and
nothing new is written.

---

## 7. The clock job

- **Schedule:** daily at 02:00 IST. Use the existing scheduler if there is one. On Vercel, add a
  Cron Job (`30 20 * * *` UTC) to a route protected by `CRON_SECRET`.
- **Signature:** `runDormancyClocks(now)` takes `now` as a parameter so tests can control time.
- **Idempotent:** running it twice on the same day changes nothing the second time.

```
runDormancyClocks(now):
  if !enabled: return
  today = IST date of now
  for each open holding h:
    bills = billsFor(h.partyId)                         # §4.2
    if h.kind == 'lead':
      b = first bill dated >= date(h.startedAt)
      if b: convert(h, end='ordered', bookStart=b.date); continue
      step(h, start=h.startedAt, limit=leadDays)
    elif h.kind == 'claim':
      cs = clockStart(bills, threshold)
      if cs and cs >= date(h.startedAt): convert(h, end='billed', bookStart=cs); continue
      step(h, start=h.startedAt, limit=leadDays)
    else:  # book
      cs = clockStart(bills, threshold)
      if h.windowOpenedAt and cs >= h.windowOpenedAt: clear window; continue   # restart cancels
      if h.backlog and !h.windowOpenedAt:
        if days(cs, today) < orderedDays: h.backlog = false
        else: continue                                   # waits for the batch to open its window
      step(h, start=cs, limit=orderedDays)
  openBacklogBatch(today)   # up to backlogPerWeek in a rolling 7 days, oldest last bill first

step(h, start, limit):
  if !h.windowOpenedAt and days(start, today) >= limit: h.windowOpenedAt = today
  if h.windowOpenedAt and days(h.windowOpenedAt, today) >= reasonWindowDays: release(h)

convert:  close h (isOpen=false, end, endedAt=now); open book holding, same holder,
          via='conversion', startedAt=bookStart. Atomic: close first, then open.
release:  close h (end='released', systemMarked = !h.reason); update the owner mirror.
```

---

## 8. Frontend

**General rules:**

- Use the app's existing components and layout.
- **When the switch is off**, every screen looks exactly as it does today.
- **The one-sentence rule** stands: if a screen cannot be explained to a new hire in one
  sentence, it does not ship. Add **no new screen**.

**Sales desk → Buyers**

- **In the book.** Everything the caller holds.
  - Uncalled first.
  - Each row shows a kind badge (_Lead_ · _Claimed_ · _Book_) and its clock.
- **Queue becomes Pool** (when the switch is on).
  - Two sections, _Ordered parties_ and _New leads_, with counts.
  - The card shows exactly the §4.6 fields. Holder history is a compact list: name · DD/MM/YYYY
    – DD/MM/YYYY · reason.
  - The **Claim** button, disabled with its reason when refused.
  - A search box (name, tehsil, district).
  - **For the Team Leader only:** a _Waiting 3+ days_ block at the top, with **Assign** and
    **Leave**.
    - Assign opens a picker of eligible callers, each showing "uncalled N / 50".
- **Waiting on us:** unchanged.

**Sales desk → Today:** one new group, **Clocks**, at the top.

- New leads not yet called, each with "Call by 13:00" or "**Overdue by 2h 10m**".
- Claimed or desk-assigned parties not yet called: "Claimed 2 days ago, not called".
- Open reason windows: "Releasing in 4 days", with the reason picker inline (one tap).
- A counter: "Uncalled 12 / 50".

**Admin**

- **Settings / master:** a _Dormant policy_ section with the §4.1 values, the switch, the
  go-live date and the seasons.
- **Staff edit:** a _Receiving leads_ switch.

**Display rules.** Each of these is a bug QA has already found in this app; do not repeat it.

- Names only. **Never show raw IDs**: no Mongo ids, no hash ids, no typed-ID fields. Use
  pickers.
- Clocks never go negative. Show "Overdue by …", never "-175.1h".
- Dates in IST, DD/MM/YYYY. Never a raw ISO string.
- Amounts as ₹10,000 with Indian digit grouping.
- Validation messages at the field, in plain words. Never raw Zod text.
- Number inputs must not be pre-filled in a way that makes typing append (e.g. 1 → 12).
- Every refusal says why.

---

## 9. Scripts (CLI)

Common rules for all scripts:

- **Default `--dry-run`.** It writes a report CSV and changes nothing; `--apply` writes.
- **Refuse to run** if the database URI is not the test database, unless `--i-know-this-is-prod`
  is passed.
- **Match parties by GSTIN, then by real mobile. Never by name.** Names like Patel or Balaji
  repeat across many firms.
  - **A placeholder mobile (§12.1) is never used to match** and never counts as a duplicate.
  - Unmatched rows go to the report and are never created.
- **These scripts never create parties.** Every party must already exist in the app.

1. **`migrate-owners`** (test DB). Converts the existing owner/book/queue field into holdings.
   - Owner set: a `go_live` holding (book if billed, else lead).
   - Queue: Pool.
2. **`import-marg-bills <csv>`**. Columns: `gstin, invoice_no, bill_date (DD/MM/YYYY),
net_amount (₹)`.
   - Writes `margBillImport`, converting ₹ into the codebase's money unit.
   - Skips duplicate invoice numbers.
3. **`import-caller-lists <csv>`**. Columns: `gstin, mobile, caller`, where `caller` is the
   staff login.
   - Creates `go_live` holdings and applies the backlog rule (§4.9).
   - **Run it after `import-marg-bills`**, because the backlog rule needs the bills.
4. **Lead upload** (Team Leader, in the Pool tab, sharing a parser with a CLI twin). Columns:
   `name, mobile, tehsil, source (meta|fa)`.
   - Creates each party through the **existing** creation path, so §4.5 assigns it.
   - Skips a real mobile that already exists, and reports it. Placeholder mobiles never count
     as existing.
   - **The §1.2 partial stop applies.**

---

## 10. Allowed and forbidden changes

**Create (new files):** the holding, poolReview and margBillImport models · the dormancy
service and API · the clock job · Pool and Clocks UI components · the settings section · the
scripts · tests · `docs/lock-34/*`.

**Modify, minimally.** Each must be listed in `PLAN.md` with its exact lines:

- the Buyers screen (tab swap behind the switch);
- the Today screen (Clocks group behind the switch);
- each party-creation path, including the Buyer app's registration handler and the
  field-associate path: **one call to `assignNewParty`, and nothing else**;
- the old book/queue gate (wrap with the switch);
- the staff model and staff edit form (`receivingLeads`);
- the admin settings page;
- the scheduler config;
- `CLAUDE.md`, if it exists: one line pointing to this file.

**Forbidden:**

- the Purchase desk, Accounts desk, Logistics and dock, the Seller app and the Buyer app. The
  only exception is the single `assignNewParty` line in a party-creation path;
- pricing, margin and listings;
- the order state machine and the Marg keying code. Bills are read, never hooked;
- auth;
- changing any existing API response shape (adding fields is allowed);
- package upgrades. A new dependency needs a reason in `PLAN.md`;
- **caller incentives, margin attribution and buyer credit.** They are separate policies, not
  yet built. Build nothing for them, even where a holding looks like the obvious place to hang
  it;
- **existing placeholder values** (`zzzzz`, placeholder mobiles). Read and handle them; never
  rewrite or "clean" them.

---

## 11. Acceptance tests (all must pass, switch on)

Control time with `now`. Every date below is IST.

1. **Ordered clock.** `clockStart` 01/01/2026.
   - 31/03/2026 (day 89): no window.
   - 01/04/2026 (day 90): window open.
   - 08/04/2026, no reason given: released, `systemMarked`, in the Pool under _Ordered parties_.
2. **Restart cancels.** With the window open since 01/04, a ₹10,000 net bill dated 03/04:
   - the window is cleared;
   - the holder keeps the party;
   - `clockStart` = 03/04.
3. **Threshold.** ₹9,999 in total: no restart. ₹4,000 on day 20 then ₹7,000 on day 50: restart
   on day 50. Then ₹9,000 more: no further restart. Test exactly at the threshold, in the
   codebase's money unit.
4. **Intake.**
   - Uncalled counts A = 3, B = 3, C = 10, where B's last intake assignment is older than A's:
     B gets the lead.
   - All callers at 50: the Team Leader gets it.
   - A caller with `receivingLeads` off is skipped.
   - 20 concurrent intakes never push anyone past the cap.
5. **Uncalled.**
   - Logging any outcome (_no answer_ included) removes the lead from the count at once.
   - Go-live, own-call and book holdings never count.
6. **Working hours.**
   - Lead at Sat 18:30: due Mon 13:00.
   - Mon 08:00: due Mon 13:30.
   - Fri 17:00: due Sat 11:30.
7. **Claim.**
   - Refused at 50 uncalled, with the reason.
   - Two simultaneous claims on one party: exactly one holding is created.
8. **Visibility.**
   - The last holder does not see the card; another caller does.
   - The card on day 3 is on the Team Leader's list.
   - After _Leave_, it is off his list until its next pool entry.
9. **Expired claim.** Claim on D, no conversion:
   - D+60: window opens.
   - D+67: released; the last holder is the claimer, and his reason (or "owner did not
     diagnose") shows on the card.
10. **Claim converts.** A restart after the claim started gives a _book_ holding for the
    claimer, starting on the restart date.
11. **Lead converts.** A first bill of ₹500 gives a _book_ holding for the same holder,
    with `clockStart` = that bill's date.
12. **Backlog.** 250 parties past day 90 at go-live:
    - week 1 opens 100 windows, oldest last bill first;
    - week 2 opens the next 100;
    - week 3 opens the last 50.

    A backlog party that bills before its turn leaves the backlog.

13. **Job idempotent.** A second run on the same day changes nothing.
14. **Switch off.**
    - All pre-existing tests pass.
    - No holding is written.
    - The Buyers and Today screens are unchanged.
    - New endpoints return 403.
15. **Schema.** The party model has no `dormant`, `isDormant`, `active` or `isActive` field.
    Any existing test of this kind still passes.
16. **Double count.** A Marg-imported bill whose invoice number is linked to a platform order is
    not counted twice.
17. **Placeholders.**
    - Two parties with placeholder mobiles are never matched to each other or to an import row.
    - A lead upload row with a placeholder mobile is not rejected as a duplicate.
    - A pool card for a party with tehsil `zzzzz` shows district and state, never `zzzzz`.
18. **Sr. Sales Executive.** A Sr. Sales Executive with `receivingLeads` on receives intake leads
    and can claim, exactly like a Sales Executive.

---

## 12. Pitfalls already found in this codebase. Check each one.

- **Paise vs rupees.** Listings were once entered in paise (₹0.29 bug). Confirm the unit of the
  billed amount before comparing it with ₹10,000.
- **The Idempotency-Key header** was missing from frontend POSTs in the dock and Marg forms
  (blocker). Every new form must send it.
- **Raw IDs on screens and ID-typed fields** (the call log needs a counterparty ID). Use names
  and pickers on everything new.
- **Negative timers and raw UTC timestamps** on Today. Follow the §8 display rules.
- **The broken book gate.** Replace it behind the switch as in §5. Do not patch it.

### 12.1 Placeholder data already in the app

Parties from the Marg party master were loaded with two placeholders:

- **Tehsil `zzzzz`:** a party outside MP, or one with no known tehsil. State and district are
  real.
- **Mobile from 9999999991 upward:** a party with no known mobile.

Build one helper, `isPlaceholderMobile(m)`, and one, `isPlaceholderTehsil(t)`, and use them
everywhere. Confirm the exact mobile range from the data during recon, and record it in
`PLAN.md`. A party with a placeholder mobile shows **"No mobile"** in its buyer file.

---

## 13. REPORT.md template

```
# LOCK-34 — Build report
## Result        one paragraph: built, tested, switch state
## Files         created / modified (with line counts) — must match PLAN.md
## Mapping       spec concept → code
## Tests         new tests and results; full-suite results switch on and off; baseline comparison
## Deviations    anything built differently from this file, and why
## Skipped       items skipped under §1.2, with reason
## Out of scope  bugs noticed and left alone
## Switch-on     exact steps:
                 1. set dormancy.goLiveDate
                 2. (test DB only) migrate-owners --dry-run → review → --apply
                 3. import-marg-bills --dry-run → review report → --apply
                 4. import-caller-lists --dry-run → review report → --apply
                 5. set dormancy.enabled = true
                 6. confirm the job ran next morning (log line + counts)
```

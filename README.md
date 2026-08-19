# Crown Superior — AI phone agent, payment lookup and promise-to-pay

The piece that has to be right: **deciding whether a promise-to-pay date is acceptable**.

Everything else in the plan (greeting, intent, transfer to a human) is configuration inside
Voiceflow. This part is not, and it should not be left to a language model. A model that is
asked "is August 28th before the cancellation date of August 28th?" will usually be right —
and *usually* is not good enough when the wrong answer means a customer is told their policy
is safe and it cancels anyway.

So the rule lives here, in code, with tests. Voiceflow asks; this answers; Voiceflow reads
the answer out.

```
Customer calls
      ↓
  Twilio number
      ↓
  Voiceflow  ──── one HTTPS call ───▶  this service  ──▶  Google Sheet
      ↓                                     │
  reads out the answer  ◀──────────────────┘
      ↓
  transfer to a person when this service says so
```

---

## What is here

| File | What it is |
|---|---|
| `lib.gs` | All the decisions. No Google calls, so it can be tested outside Apps Script. |
| `Code.gs` | The web app: authenticate, read the sheet, call the decision, write, log. |
| `Customers_template.csv` | The sheet layout, with eight test customers that exercise every path. |
| `tests/run_tests.js` | 164 checks against `lib.gs` itself. `node tests/run_tests.js` |
| `demo.js` | Plays seven calls end to end using the real code. `node demo.js` |

There is no server to rent and no service account to manage: the code runs as a Google Apps
Script attached to the spreadsheet, so it reads and writes as the sheet's owner.

---

## The rules it enforces

**Verification.** Phone number **and** month/day of birth, both exact, both matching the
same row.

- No match on name, ever. Not even as a tie-breaker.
- More than one matching row is **not** a match — it transfers instead of guessing.
  `Test Twin A` and `Test Twin B` in the template exist to prove this.
- "Wrong birthday" and "no such customer" return the identical response, so nobody can use
  the difference to find out whether a phone number is on the books.
- An unparseable birthday fails verification. It never falls through to a partial match.

**What may be spoken.** Only: name, insurance company, policy number, policy status, payment
amount, due date, cancellation date, promise-to-pay date. The allow-list is enforced in
code, so adding a column to the sheet — including one holding something sensitive — cannot
put it on the phone. There is a test that asserts this with an SSN and a card number in the
row.

**Promise-to-pay.**

| Situation | What happens |
|---|---|
| Date is on or before (cancellation − 1 day) | Accepted, written to the sheet |
| Date is the cancellation date itself | Refused, offers the latest date it *can* take |
| Date is after cancellation | Refused, offers the latest date it can take |
| Date is in the past | Asks again |
| **Cancellation date is blank** | **Transfers to a live agent** — your rule |
| Cancellation date already passed | Transfers to a live agent |
| **A promise is already on file and still ahead** | **Reads out the existing date and transfers** |

A promise whose date has already gone by is spent, and does not block a new one.

The one-day gap is `MIN_DAYS_BEFORE_CANCELLATION` at the top of `Code.gs`. Set it to 3 if
you want the money in three days before cancellation instead; the tests cover that too.

**What the caller says.** Nobody speaks a date the way a spreadsheet stores one. What comes
out of speech-to-text is "august twenty sixth", "the 26th", "next friday", "in three days",
"the end of the month" — and almost never a year, so the year is inferred forwards: said in
December, "January third" is next year.

Two rules keep that safe. An unclear reading becomes *ask the caller again*, never a guess —
"the twentieth or the twenty sixth" is two dates, so it is no date. And whatever it settles
on is read back before anything is written, so the caller is the one who confirms it.

Amounts are never calculated. The sheet says `187.42`, the agent says `$187.42`. If the
amount cell is blank the agent says it cannot retrieve it and transfers — it does not say
zero.

---

## Setup

### 1. The sheet

Import `Customers_template.csv` into a new spreadsheet. Name the tab **Customers**.

Two formatting points that will bite otherwise:

- Format column **D (DOB_MMDD)** as **Plain text** *before* pasting, or Google eats the
  leading zero and `0517` becomes `517`.
- Format **Phone** as Plain text too, for the same reason.

Do not put Social Security numbers, driver's licence numbers, card numbers or bank details
in this sheet. Restrict sharing to the people who need it.

### 2. The script

Extensions → Apps Script. Create `lib.gs` and `Code.gs`, paste these in.

Project Settings → Script Properties → add `AGENT_TOKEN` = a long random string you invent.
The service refuses to run if this is missing or under 16 characters.

Deploy → New deployment → **Web app**, *Execute as: Me*, *Who has access: Anyone*. Copy the
`/exec` URL. Access has to be "Anyone" for Voiceflow to reach it — the token is what
protects it, which is why it must be long.

### 3. Voiceflow

Two API steps. Both are `POST`, `Content-Type: application/json`, to the `/exec` URL.

**Look up a customer**

```json
{ "token": "YOUR_TOKEN", "action": "lookup",
  "phone": "{user_id}", "dob": "{dob_spoken}" }
```

Returns either `{"verified": false, ...}` or:

```json
{ "verified": true,
  "customer": { "payment_amount": "$187.42",
                "due_date_spoken": "August 23, 2026",
                "cancellation_date_spoken": "August 28, 2026",
                "policy_number": "UA12345678", "...": "..." } }
```

**Set a promise-to-pay date**

```json
{ "token": "YOUR_TOKEN", "action": "promise",
  "phone": "{user_id}", "dob": "{dob_spoken}", "date": "{promise_spoken}" }
```

`date` is passed through exactly as the caller said it — do not try to tidy it up first.

Returns `allowed`, `action` (`RECORD` / `ASK_AGAIN` / `TRANSFER_TO_AGENT`), `reason`,
`heard_date` (what it made of the words) and a ready-made `say` string. **Have the agent speak `say` verbatim** — it already contains the
right date, phrased for the situation.

Note the promise call re-verifies from phone and birthday rather than trusting a customer id
passed back from the conversation. It writes to the sheet, so it authenticates itself.

Route on `action`: `RECORD` → confirm and continue. `ASK_AGAIN` → ask for another date.
`TRANSFER_TO_AGENT` → Voiceflow's Call Forward.

### 4. Test before any real customer data goes in

The template's eight rows are built for this. Call from `4045551212` and say May 17th, then
work down the list. Every row's Notes column says what should happen.

Then change `Payment_Amount` on row 2 from `187.42` to `204.18`, call again, and confirm the
agent says `$204.18`. If it still says `$187.42` the lookup is not live and nothing real
should go in the sheet yet.

---

## Two things about the plan worth deciding before build

**1. The "calling from a different phone" path is the weak one.** Verifying with the caller's
own number plus month/day of birth is reasonable, because the caller has to be holding the
right phone. But the fallback — caller *tells* you the policy phone number, plus month/day of
birth — has no such anchor. Someone's phone number and birthday are not hard to come by, and
that path hands over the policy number and payment details. Suggestion: on that path only,
ask for a third item — ZIP code is easiest, or the last four of the policy number. The
`ZIP` column is already in the template for this. Your call, and it is a small change.

**2. A recorded promise-to-pay is a commitment.** Whatever the AI says, the policy still
cancels on the carrier's schedule unless somebody acts. Worth agreeing: does a recorded
promise trigger anything on your side, or is the sheet just a note? The `Agent_Log` tab
records every lookup and every promise with a timestamp, which is what you would want if a
customer ever says "your system told me I had until the 27th".

Call recording is left off. It is not needed for a payment lookup, and turning it on brings
consent rules with it.

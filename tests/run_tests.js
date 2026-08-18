/**
 * Tests for the phone agent's decision logic.
 *
 * These load lib.gs itself, not a copy, so passing here means the deployed file is what was
 * tested. Run with:  node tests/run_tests.js
 *
 * The date cases are the point of this file. "Before the cancellation date" has two edges
 * one day apart, and getting either wrong means either promising a customer a date that
 * will not save their policy, or refusing a date that would have.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'lib.gs'), 'utf8');
const sandbox = { module: { exports: {} }, console: console, Date: Date, Math: Math, Object: Object, String: String, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat };
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(src, sandbox, { filename: 'lib.gs' });

const L = sandbox.module.exports;

let passed = 0;
const failures = [];
let group = '';

function section(name) {
  group = name;
  console.log('\n' + name);
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);

  if (a === b) {
    passed++;
    console.log('  ok   ' + label);
  } else {
    failures.push(group + ' / ' + label + '\n        expected ' + b + '\n        got      ' + a);
    console.log('  FAIL ' + label + '   expected ' + b + ', got ' + a);
  }
}

/* ---------------------------------------------------------------- phone numbers ------ */
section('normPhone_');
eq(L.normPhone_('(404) 555-1212'), '4045551212', 'formatted US number');
eq(L.normPhone_('+1 404 555 1212'), '4045551212', 'leading country code dropped');
eq(L.normPhone_('4045551212'), '4045551212', 'already bare');
eq(L.normPhone_(4045551212), '4045551212', 'arrives as a number from Sheets');
eq(L.normPhone_(''), '', 'blank');
eq(L.normPhone_(null), '', 'null');
eq(L.normPhone_('1112223333'), '1112223333', 'a real 10-digit number starting with 1 is kept');

/* ------------------------------------------------------------------ date of birth ---- */
section('normDobMmdd_');
eq(L.normDobMmdd_('0517'), '0517', 'four digits');
eq(L.normDobMmdd_('5/17'), '0517', 'slash form');
eq(L.normDobMmdd_('517'), '0517', 'three digits');
eq(L.normDobMmdd_('1231'), '1231', 'december 31');
eq(L.normDobMmdd_('0229'), '0229', 'leap day is a real birthday');
eq(L.normDobMmdd_('1301'), '', 'month 13 rejected');
eq(L.normDobMmdd_('0230'), '', '30 february rejected');
eq(L.normDobMmdd_('0431'), '', '31 april rejected');
eq(L.normDobMmdd_('abc'), '', 'not a date at all');
eq(L.normDobMmdd_(''), '', 'blank');
eq(L.normDobMmdd_('05171990'), '', 'full birth date refused - this field is month/day only');

/* -------------------------------------------------------------------- date parsing --- */
section('toYmd_');
eq(L.toYmd_('2026-08-23'), '2026-08-23', 'ISO');
eq(L.toYmd_('08/23/2026'), '2026-08-23', 'US slashes');
eq(L.toYmd_('8/23/26'), '2026-08-23', 'two-digit year');
eq(L.toYmd_('8-23-2026'), '2026-08-23', 'dashes');
eq(L.toYmd_('August 23, 2026'), '2026-08-23', 'spoken month');
eq(L.toYmd_('aug 23 2026'), '2026-08-23', 'abbreviated month');
eq(L.toYmd_(new Date(2026, 7, 23)), '2026-08-23', 'Date object from a Sheets cell');
eq(L.toYmd_(''), '', 'blank');
eq(L.toYmd_(null), '', 'null');
eq(L.toYmd_('02/31/2026'), '', '31 february does not roll into march');
eq(L.toYmd_('13/01/2026'), '', 'month 13 rejected');
eq(L.toYmd_('not a date'), '', 'free text');

/* a date-only cell is midnight local; check it does not slide a day in any timezone */
section('toYmd_ across timezones');
for (const tz of ['UTC', 'America/New_York', 'Pacific/Auckland', 'Asia/Kolkata']) {
  const before = process.env.TZ;
  process.env.TZ = tz;
  eq(L.toYmd_(new Date(2026, 0, 1)), '2026-01-01', 'new year midnight in ' + tz);
  process.env.TZ = before;
}

/* ------------------------------------------------------------------ date arithmetic -- */
section('addDaysYmd_');
eq(L.addDaysYmd_('2026-08-23', -1), '2026-08-22', 'one day back');
eq(L.addDaysYmd_('2026-09-01', -1), '2026-08-31', 'across a month boundary');
eq(L.addDaysYmd_('2026-01-01', -1), '2025-12-31', 'across a year boundary');
eq(L.addDaysYmd_('2028-03-01', -1), '2028-02-29', 'into a leap day');
eq(L.addDaysYmd_('2026-03-09', -1), '2026-03-08', 'across the US DST change');
eq(L.addDaysYmd_('2026-11-02', -1), '2026-11-01', 'across the US DST change back');

/* -------------------------------------------------------------------------- money ---- */
section('money_');
eq(L.money_('187.4'), '$187.40', 'one decimal');
eq(L.money_('187'), '$187.00', 'whole number');
eq(L.money_(187.42), '$187.42', 'arrives as a number');
eq(L.money_('1234.5'), '$1,234.50', 'thousands separator added');
eq(L.money_('$396.00'), '$396.00', 'dollar sign not doubled');
eq(L.money_('3,435.00'), '$3,435.00', 'comma as thousands');
eq(L.money_('154,99'), '$154.99', 'comma as decimal');
eq(L.money_('N/A'), 'N/A', 'not a number, left alone and given no dollar sign');
eq(L.money_(''), '', 'blank stays blank');

/* ------------------------------------------------------------- promise to pay -------- */
section('decidePromiseToPay_  (cancellation 2026-08-28, today 2026-08-18)');
const CANCEL = '2026-08-28';
const TODAY = '2026-08-18';
const d = (proposed, cancel, today) => L.decidePromiseToPay_(proposed, cancel === undefined ? CANCEL : cancel, today || TODAY, 1);

eq(d('2026-08-26').allowed, true, 'comfortably before cancellation');
eq(d('2026-08-27').allowed, true, 'BOUNDARY: the day before cancellation is allowed');
eq(d('2026-08-27').promise_date, '2026-08-27', 'and the accepted date comes back');
eq(d('2026-08-28').allowed, false, 'BOUNDARY: the cancellation date itself is refused');
eq(d('2026-08-28').reason, 'AFTER_DEADLINE', 'and says why');
eq(d('2026-08-28').latest_allowed_date, '2026-08-27', 'and offers the latest date it can take');
eq(d('2026-08-29').allowed, false, 'after cancellation refused');
eq(d('2026-08-18').allowed, true, 'today is acceptable');
eq(d('2026-08-17').allowed, false, 'yesterday refused');
eq(d('2026-08-17').reason, 'DATE_IN_PAST', 'and says why');
eq(d('2026-08-17').action, 'ASK_AGAIN', 'a past date is worth one more try, not a transfer');

section('decidePromiseToPay_  the client rule: no cancellation date means a person handles it');
eq(d('2026-08-26', '').allowed, false, 'blank cancellation date is not allowed');
eq(d('2026-08-26', '').action, 'TRANSFER_TO_AGENT', 'and goes to a live agent');
eq(d('2026-08-26', '').reason, 'NO_CANCELLATION_DATE', 'with a reason the log can show');
eq(d('', '').action, 'TRANSFER_TO_AGENT', 'no date and no cancellation date still transfers');

section('decidePromiseToPay_  edges');
eq(d('', CANCEL).action, 'ASK_AGAIN', 'unparsed date asks again rather than guessing');
eq(d('2026-08-26', '2026-08-18').action, 'TRANSFER_TO_AGENT', 'deadline already gone -> transfer');
eq(d('2026-08-26', '2026-08-18').reason, 'DEADLINE_PASSED', 'with the right reason');
eq(d('2026-08-19', '2026-08-20').allowed, true, 'cancellation tomorrow, promise today+1 is the last chance');
eq(d('2026-09-01', '2026-09-02').allowed, true, 'across a month boundary');
eq(d('2026-01-01', '2026-01-02', '2025-12-30').allowed, true, 'across a year boundary');
eq(L.decidePromiseToPay_('2026-08-25', CANCEL, TODAY, 3).allowed, true, 'a 3-day rule still allows the 25th');
eq(L.decidePromiseToPay_('2026-08-26', CANCEL, TODAY, 3).allowed, false, 'a 3-day rule refuses the 26th');
eq(d('2026-08-27').say.indexOf('August 27, 2026') > -1, true, 'the spoken confirmation names the date');
eq(d('2026-08-29').say.indexOf('August 27, 2026') > -1, true, 'the refusal offers the latest workable date');

/* ------------------------------------------------------------------ verification ----- */
section('findCustomer_');
const ROWS = [
  { __row: 2, Customer_ID: '10001', Customer_Name: 'Jane Smith', Phone: '4045551212', DOB_MMDD: '0517' },
  { __row: 3, Customer_ID: '10002', Customer_Name: 'John Smith', Phone: '4045559999', DOB_MMDD: '0101' },
  { __row: 4, Customer_ID: '10003', Customer_Name: 'John Smyth', Phone: '4045558888', DOB_MMDD: '0101' },
  { __row: 5, Customer_ID: '10004', Customer_Name: 'Twin One', Phone: '4045557777', DOB_MMDD: '0303' },
  { __row: 6, Customer_ID: '10005', Customer_Name: 'Twin Two', Phone: '4045557777', DOB_MMDD: '0303' }
];
eq(L.findCustomer_(ROWS, '4045551212', '0517').status, 'FOUND', 'exact match');
eq(L.findCustomer_(ROWS, '4045551212', '0517').matches[0].row.Customer_ID, '10001', 'the right one');
eq(L.findCustomer_(ROWS, '(404) 555-1212', '5/17').status, 'FOUND', 'caller formatting does not matter');
eq(L.findCustomer_(ROWS, '4045551212', '0518').status, 'NOT_FOUND', 'right phone, wrong DOB');
eq(L.findCustomer_(ROWS, '4045550000', '0517').status, 'NOT_FOUND', 'unknown phone, real DOB');
eq(L.findCustomer_(ROWS, '4045559999', '0101').matches[0].row.Customer_Name, 'John Smith', 'Smith not Smyth');
eq(L.findCustomer_(ROWS, '4045557777', '0303').status, 'AMBIGUOUS', 'two matching rows is NOT a match');
eq(L.findCustomer_(ROWS, '4045557777', '0303').matches.length, 2, 'and both are reported');
eq(L.findCustomer_(ROWS, '404555', '0517').status, 'BAD_INPUT', 'short phone rejected');
eq(L.findCustomer_(ROWS, '4045551212', 'banana').status, 'BAD_INPUT', 'unparseable DOB rejected');
eq(L.findCustomer_(ROWS, '4045551212', '').status, 'BAD_INPUT', 'missing DOB is never a match');

/* --------------------------------------------------------------- what leaks out ------ */
section('publicRecord_  (nothing beyond the allow-list may escape)');
const FULL = {
  __row: 2,
  Customer_ID: '10001', Customer_Name: 'Jane Smith', Phone: '4045551212', DOB_MMDD: '0517',
  ZIP: '30315', Insurance_Company: 'United Auto', Policy_Number: 'UA12345678',
  Payment_Amount: '187.4', Due_Date: '08/23/2026', Cancellation_Date: '08/28/2026',
  Policy_Status: 'Active', Promise_To_Pay_Date: '', Promise_Set_At: '',
  SSN: '123-45-6789', Card_Number: '4111111111111111', Notes: 'internal only'
};
const pub = L.publicRecord_(FULL);
eq(Object.keys(pub).sort(), [
  'cancellation_date', 'cancellation_date_spoken', 'customer_id', 'customer_name',
  'due_date', 'due_date_spoken', 'insurance_company', 'payment_amount',
  'payment_amount_raw', 'policy_number', 'policy_status', 'promise_to_pay_date',
  'promise_to_pay_date_spoken'
], 'exactly the allowed fields');
eq(JSON.stringify(pub).indexOf('123-45-6789'), -1, 'SSN never appears');
eq(JSON.stringify(pub).indexOf('4111111111111111'), -1, 'card number never appears');
eq(JSON.stringify(pub).indexOf('0517'), -1, 'date of birth never appears');
eq(JSON.stringify(pub).indexOf('internal only'), -1, 'internal notes never appear');
eq(JSON.stringify(pub).indexOf('30315'), -1, 'ZIP not read out');
eq(pub.payment_amount, '$187.40', 'amount formatted for speech');
eq(pub.due_date_spoken, 'August 23, 2026', 'due date spoken in full');
eq(pub.cancellation_date, '2026-08-28', 'cancellation date normalised');

/* ------------------------------------------------------------------------ summary ---- */
console.log('\n' + '='.repeat(70));

if (failures.length === 0) {
  console.log(passed + ' checks passed, 0 failed');
} else {
  console.log(passed + ' passed, ' + failures.length + ' FAILED\n');
  failures.forEach(function (f) { console.log('  * ' + f); });
  process.exitCode = 1;
}

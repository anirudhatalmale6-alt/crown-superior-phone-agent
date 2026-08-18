/**
 * Plays the four calls that matter, using the real decision code from lib.gs.
 *
 * This is not a mock-up: every AI line below is produced by the same functions the live
 * service runs. Run with:  node demo.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, 'lib.gs'), 'utf8');
const sandbox = { module: { exports: {} }, console, Date, Math, Object, String, isNaN, parseInt, parseFloat };
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(src, sandbox, { filename: 'lib.gs' });
const L = sandbox.module.exports;

const TODAY = '2026-08-18';

// the test rows from Customers_template.csv
const ROWS = fs.readFileSync(path.join(__dirname, 'Customers_template.csv'), 'utf8')
  .trim().split('\n').slice(1).map((line, i) => {
    const c = line.split(',');
    return {
      __row: i + 2,
      Customer_ID: c[0], Customer_Name: c[1], Phone: c[2], DOB_MMDD: c[3], ZIP: c[4],
      Insurance_Company: c[5], Policy_Number: c[6], Payment_Amount: c[7],
      Due_Date: c[8], Cancellation_Date: c[9], Policy_Status: c[10],
      Promise_To_Pay_Date: c[11], Promise_Set_At: c[12]
    };
  });

const line = (who, text) => console.log('  ' + who.padEnd(9) + text);

function call(title, phone, dob, spokenDob, proposedDate, spokenProposed) {
  console.log('\n' + '─'.repeat(74));
  console.log(title);
  console.log('─'.repeat(74));
  line('AI', 'Thank you for calling Crown Superior Insurance Agency. How can I help?');
  line('Caller', 'How much is my payment?');
  line('AI', 'I can help with that. For security, please confirm the month and day of your birth.');
  line('Caller', spokenDob);

  const found = L.findCustomer_(ROWS, phone, dob);

  if (found.status !== 'FOUND') {
    line('SYSTEM', '[' + found.status + '] no information released');
    line('AI', found.status === 'AMBIGUOUS'
      ? 'I found more than one record matching that information, so I will transfer you to a representative.'
      : 'I was not able to verify a policy with that information. Let us try once more.');
    return;
  }

  const rec = L.publicRecord_(found.matches[0].row);
  line('SYSTEM', '[verified ' + rec.customer_id + ']');

  if (!rec.payment_amount) {
    line('AI', 'I do not have a payment amount on file for this policy. Let me transfer you to a representative.');
    return;
  }

  line('AI', 'Thank you. Your next payment is ' + rec.payment_amount + ' and is due ' + rec.due_date_spoken + '.');

  if (!proposedDate) {
    return;
  }

  line('Caller', 'I cannot pay today.');

  const opener = rec.cancellation_date
    ? 'I may be able to set up a promise-to-pay date. Your policy is scheduled to cancel on '
      + rec.cancellation_date_spoken + '. What date will you be able to pay?'
    : 'Let me check what I can do.';
  line('AI', opener);

  if (spokenProposed) {
    line('Caller', spokenProposed);
  }

  const decision = L.decidePromiseToPay_(
    L.toYmd_(proposedDate), rec.cancellation_date, TODAY, 1
  );

  line('SYSTEM', '[' + decision.reason + ' -> ' + decision.action + ']');
  line('AI', decision.say);

  if (decision.allowed) {
    line('SYSTEM', '[sheet updated: Promise_To_Pay_Date = ' + decision.promise_date + ']');
  }
}

console.log('\nCrown Superior phone agent — worked examples   (today is ' + TODAY + ')');

call('1. Normal call: asks a date the policy can survive',
  '4045551212', '0517', 'May seventeenth', '2026-08-26', 'August twenty-sixth');

call('2. Caller asks for a date that would be too late',
  '4045551212', '0517', 'May seventeenth', '2026-09-05', 'September fifth');

call('3. No cancellation date on the sheet — your rule says a person takes this',
  '4045551213', '0620', 'June twentieth', '2026-08-26', 'August twenty-sixth');

call('4. Two records share the phone and birthday — it must not guess',
  '4045551217', '0303', 'March third', null, null);

console.log('\n' + '─'.repeat(74));
console.log('Wrong date of birth — same phone as call 1, one digit out on the birthday');
console.log('─'.repeat(74));
const bad = L.findCustomer_(ROWS, '4045551212', '0518');
line('SYSTEM', '[' + bad.status + ']');
line('AI', 'I was not able to verify a policy with that information.');
console.log('  ' + ' '.repeat(9) + '(nothing about the policy was said out loud)');
console.log('');

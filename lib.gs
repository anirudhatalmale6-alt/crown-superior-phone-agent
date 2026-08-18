/**
 * Crown Superior phone agent — pure logic.
 *
 * Everything in this file is deliberately free of Google/Sheets calls so it can be run and
 * unit-tested outside Apps Script. tests/run_tests.js loads THIS FILE and exercises these
 * exact functions, so what is tested is what is deployed.
 *
 * The reason this logic sits here at all, rather than in the Voiceflow agent, is that the
 * promise-to-pay rule is a money decision with a deadline attached. A language model is the
 * wrong thing to be doing date arithmetic and boundary comparisons. This file decides;
 * Voiceflow only reads out the answer.
 */

/** Digits only, and drop a leading US country code. '(404) 555-1212' -> '4045551212' */
function normPhone_(value) {
  var digits = String(value == null ? '' : value).replace(/\D/g, '');

  if (digits.length === 11 && digits.charAt(0) === '1') {
    digits = digits.substring(1);
  }

  return digits;
}

/**
 * Month/day of birth as exactly four digits. Accepts '0517', '517', '5/17', '5-17'.
 * Returns '' for anything that is not a real month/day - an unparseable answer must fail
 * verification, never fall through to a partial match.
 */
function normDobMmdd_(value) {
  var raw = String(value == null ? '' : value).trim();

  if (raw === '') {
    return '';
  }

  var month;
  var day;
  var parts = raw.split(/[^0-9]+/).filter(function (p) { return p !== ''; });

  if (parts.length === 2) {
    month = parseInt(parts[0], 10);
    day = parseInt(parts[1], 10);
  } else {
    var digits = raw.replace(/\D/g, '');

    if (digits.length === 4) {
      month = parseInt(digits.substring(0, 2), 10);
      day = parseInt(digits.substring(2, 4), 10);
    } else if (digits.length === 3) {
      // '517' is ambiguous only in principle: months are 1-12, so the first digit wins
      month = parseInt(digits.substring(0, 1), 10);
      day = parseInt(digits.substring(1, 3), 10);
    } else {
      return '';
    }
  }

  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) {
    return '';
  }

  // reject days that cannot exist in that month (29 Feb is allowed - it is a real birthday)
  var maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

  if (day > maxDay) {
    return '';
  }

  return pad2_(month) + pad2_(day);
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

/**
 * Any of the shapes a date arrives in -> 'YYYY-MM-DD', or '' if it is not a date.
 *
 * Dates are compared as plain YYYY-MM-DD strings throughout, never as Date objects. A
 * date-only cell read from Sheets becomes midnight in the script's timezone, and any
 * timezone arithmetic on that can shift it a day - which on this system is the difference
 * between a promise-to-pay being accepted and a policy cancelling.
 */
function toYmd_(value) {
  if (value == null || value === '') {
    return '';
  }

  // a real Date from a Sheets date cell
  if (Object.prototype.toString.call(value) === '[object Date]') {
    if (isNaN(value.getTime())) {
      return '';
    }

    return value.getFullYear() + '-' + pad2_(value.getMonth() + 1) + '-' + pad2_(value.getDate());
  }

  var text = String(value).trim();

  if (text === '') {
    return '';
  }

  var m;

  // 2026-08-23
  m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);

  if (m) {
    return buildYmd_(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
  }

  // 08/23/2026, 8/23/26, 8-23-2026  (US order - this is a US agency)
  m = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);

  if (m) {
    var year = parseInt(m[3], 10);

    if (m[3].length === 2) {
      year += 2000;
    }

    return buildYmd_(year, parseInt(m[1], 10), parseInt(m[2], 10));
  }

  // 'August 23, 2026' / '23 August 2026'
  var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
                'august', 'september', 'october', 'november', 'december'];
  var lower = text.toLowerCase();

  for (var i = 0; i < MONTHS.length; i++) {
    if (lower.indexOf(MONTHS[i].substring(0, 3)) === -1) {
      continue;
    }

    var nums = lower.replace(/[^0-9]+/g, ' ').trim().split(/\s+/).filter(function (p) { return p !== ''; });

    if (nums.length < 2) {
      return '';
    }

    var d = parseInt(nums[0], 10);
    var y = parseInt(nums[1], 10);

    if (d > 31) {           // 'August 2026 23' style - year came first
      y = d;
      d = parseInt(nums[1], 10);
    }

    if (y < 100) {
      y += 2000;
    }

    return buildYmd_(y, i + 1, d);
  }

  return '';
}

/** Reject impossible calendar dates rather than letting them roll over into next month. */
function buildYmd_(year, month, day) {
  if (!(year >= 1900 && year <= 2200) || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) {
    return '';
  }

  var probe = new Date(Date.UTC(year, month - 1, day));

  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return '';   // e.g. 31 February
  }

  return year + '-' + pad2_(month) + '-' + pad2_(day);
}

/** Whole days added to a 'YYYY-MM-DD', in UTC so daylight saving cannot shift it. */
function addDaysYmd_(ymd, days) {
  var p = ymd.split('-');
  var t = Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  var d = new Date(t + days * 86400000);

  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

/** 'Saturday, August 23, 2026' - what the agent should read out loud. */
function spokenDate_(ymd) {
  if (!ymd) {
    return '';
  }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];
  var p = ymd.split('-');

  return MONTHS[parseInt(p[1], 10) - 1] + ' ' + parseInt(p[2], 10) + ', ' + p[0];
}

/** '187.4' -> '$187.40'. Anything that is not a plain number is returned untouched. */
function money_(value) {
  var original = String(value == null ? '' : value);
  var s = original.trim();

  if (s === '') {
    return '';
  }

  s = s.replace(/[\s$ ]/g, '');

  var negative = false;

  if (s.charAt(0) === '-' || s.charAt(0) === '+') {
    negative = s.charAt(0) === '-';
    s = s.substring(1);
  }

  var number;

  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    number = s.replace(/,/g, '');
  } else if (/^\d+,\d{1,2}$/.test(s)) {
    number = s.replace(',', '.');
  } else if (/^\d+(\.\d+)?$/.test(s)) {
    number = s;
  } else {
    return original;
  }

  var n = Math.round(parseFloat(number) * 100) / 100;
  var whole = Math.floor(n);
  var cents = Math.round((n - whole) * 100);

  return (negative ? '-$' : '$') + String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + pad2_(cents);
}

/**
 * Decide a promise-to-pay date. This is the whole point of the service.
 *
 * @param {string} proposedYmd     what the caller asked for
 * @param {string} cancellationYmd from the sheet - blank means we do not know
 * @param {string} todayYmd        passed in, never read from the clock, so it is testable
 * @param {number} minDaysBefore   how many days before cancellation the money must be in
 * @return {object} decision
 */
function decidePromiseToPay_(proposedYmd, cancellationYmd, todayYmd, minDaysBefore) {
  var gap = (minDaysBefore == null) ? 1 : minDaysBefore;

  // No cancellation date on the sheet -> we cannot know the deadline, so we must not guess.
  // The client's rule: hand these to a person.
  if (!cancellationYmd) {
    return {
      allowed: false,
      action: 'TRANSFER_TO_AGENT',
      reason: 'NO_CANCELLATION_DATE',
      say: 'I do not have a cancellation date on file for this policy, so I will transfer you to a representative who can set that up.'
    };
  }

  var latestAllowed = addDaysYmd_(cancellationYmd, -gap);

  // The deadline has already gone by. Never accept a promise we know is too late.
  if (latestAllowed < todayYmd) {
    return {
      allowed: false,
      action: 'TRANSFER_TO_AGENT',
      reason: 'DEADLINE_PASSED',
      cancellation_date: cancellationYmd,
      latest_allowed_date: latestAllowed,
      say: 'This policy is past the date I am able to arrange a promise to pay for. Let me transfer you to a representative.'
    };
  }

  if (!proposedYmd) {
    return {
      allowed: false,
      action: 'ASK_AGAIN',
      reason: 'NO_DATE_UNDERSTOOD',
      cancellation_date: cancellationYmd,
      latest_allowed_date: latestAllowed,
      say: 'I did not catch a date. The latest I can accept is ' + spokenDate_(latestAllowed) + '. What date will you be able to make the payment?'
    };
  }

  if (proposedYmd < todayYmd) {
    return {
      allowed: false,
      action: 'ASK_AGAIN',
      reason: 'DATE_IN_PAST',
      cancellation_date: cancellationYmd,
      latest_allowed_date: latestAllowed,
      say: 'That date has already passed. I can accept any date up to ' + spokenDate_(latestAllowed) + '. What date works?'
    };
  }

  if (proposedYmd > latestAllowed) {
    return {
      allowed: false,
      action: 'ASK_AGAIN',
      reason: 'AFTER_DEADLINE',
      cancellation_date: cancellationYmd,
      latest_allowed_date: latestAllowed,
      say: 'I am not able to go that far out. This policy is scheduled to cancel on '
        + spokenDate_(cancellationYmd) + ', so the latest date I can accept is '
        + spokenDate_(latestAllowed) + '. Would that work?'
    };
  }

  return {
    allowed: true,
    action: 'RECORD',
    reason: 'OK',
    promise_date: proposedYmd,
    cancellation_date: cancellationYmd,
    latest_allowed_date: latestAllowed,
    say: 'Thank you. I have recorded your promise to pay for ' + spokenDate_(proposedYmd) + '.'
  };
}

/**
 * Match a caller against the customer rows.
 *
 * Exact match on both values or nothing. Two rules matter more than anything else here:
 *   - more than one match is NOT a match. Never pick the closest or the first.
 *   - never match on name.
 */
function findCustomer_(rows, phone, dobMmdd) {
  var wantPhone = normPhone_(phone);
  var wantDob = normDobMmdd_(dobMmdd);

  if (wantPhone.length !== 10 || wantDob.length !== 4) {
    return { status: 'BAD_INPUT', matches: [] };
  }

  var matches = [];

  for (var i = 0; i < rows.length; i++) {
    if (normPhone_(rows[i].Phone) === wantPhone && normDobMmdd_(rows[i].DOB_MMDD) === wantDob) {
      matches.push({ row: rows[i], rowNumber: rows[i].__row });
    }
  }

  if (matches.length === 0) {
    return { status: 'NOT_FOUND', matches: [] };
  }

  if (matches.length > 1) {
    return { status: 'AMBIGUOUS', matches: matches };
  }

  return { status: 'FOUND', matches: matches };
}

/** Only these fields ever leave the service. Nothing else on the row is exposed. */
function publicRecord_(row) {
  return {
    customer_id: String(row.Customer_ID == null ? '' : row.Customer_ID),
    customer_name: String(row.Customer_Name == null ? '' : row.Customer_Name),
    insurance_company: String(row.Insurance_Company == null ? '' : row.Insurance_Company),
    policy_number: String(row.Policy_Number == null ? '' : row.Policy_Number),
    policy_status: String(row.Policy_Status == null ? '' : row.Policy_Status),
    payment_amount: money_(row.Payment_Amount),
    payment_amount_raw: String(row.Payment_Amount == null ? '' : row.Payment_Amount),
    due_date: toYmd_(row.Due_Date),
    due_date_spoken: spokenDate_(toYmd_(row.Due_Date)),
    cancellation_date: toYmd_(row.Cancellation_Date),
    cancellation_date_spoken: spokenDate_(toYmd_(row.Cancellation_Date)),
    promise_to_pay_date: toYmd_(row.Promise_To_Pay_Date),
    promise_to_pay_date_spoken: spokenDate_(toYmd_(row.Promise_To_Pay_Date))
  };
}

// Make the pure functions reachable from the Node test harness. Apps Script has no
// `module`, so this block is simply skipped when running on Google's side.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normPhone_: normPhone_,
    normDobMmdd_: normDobMmdd_,
    toYmd_: toYmd_,
    addDaysYmd_: addDaysYmd_,
    spokenDate_: spokenDate_,
    money_: money_,
    decidePromiseToPay_: decidePromiseToPay_,
    findCustomer_: findCustomer_,
    publicRecord_: publicRecord_
  };
}

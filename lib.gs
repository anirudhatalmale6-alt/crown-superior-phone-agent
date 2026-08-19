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
 * @param {string} existingYmd     a promise already on the sheet, if there is one
 * @return {object} decision
 */
function decidePromiseToPay_(proposedYmd, cancellationYmd, todayYmd, minDaysBefore, existingYmd) {
  var gap = (minDaysBefore == null) ? 1 : minDaysBefore;

  // A promise already on file and still ahead of us. Checked before anything else, because
  // the caller needs to hear the date they already gave rather than be walked through
  // setting a second one - and moving an existing commitment is a person's decision, not
  // this service's. A promise whose date has gone by is spent, and does not block a new one.
  if (existingYmd && existingYmd >= todayYmd) {
    return {
      allowed: false,
      action: 'TRANSFER_TO_AGENT',
      reason: 'PROMISE_ALREADY_SET',
      existing_promise_date: existingYmd,
      cancellation_date: cancellationYmd,
      say: 'I already have a promise to pay on file for this policy, dated '
        + spokenDate_(existingYmd)
        + '. I will transfer you to a representative if you need to change it.'
    };
  }

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

/* ================================================================= spoken dates ======== */

/**
 * What a caller actually says, turned into 'YYYY-MM-DD'.
 *
 * A speech-to-text transcript is nothing like a date field. What arrives is "august twenty
 * sixth", "the 26th", "next friday", "tomorrow", "in three days" - and almost never a year,
 * so the year has to be inferred. That inference is where this quietly goes wrong: on
 * 28 December, "January third" means next year, not eleven months into the past.
 *
 * The contract is that an UNCERTAIN reading returns '' rather than a guess. '' becomes
 * NO_DATE_UNDERSTOOD in decidePromiseToPay_, which asks the caller again - the one outcome
 * that can never hurt anybody. So "the twentieth or the twenty sixth" is two dates, which
 * means it is no date.
 *
 * Whatever comes out of here is read back to the caller for confirmation before anything is
 * written. This function only has to be safe; the confirmation makes it correct.
 */
function parseSpokenDate_(text, todayYmd) {
  var raw = String(text == null ? '' : text).trim();

  if (raw === '' || !todayYmd) {
    return '';
  }

  // 1. Already a real date - '2026-08-26', '08/26/2026'.
  //
  //    Only numeric input is handed to toYmd_. It is built for a spreadsheet cell, where the
  //    whole string is the date, and it is too trusting with a sentence: given "August 26 or
  //    September 2" it pulls out the digits 26 and 2 and reads them as day and year, which
  //    is how a question about two dates became 26 August 2002. Month names go through the
  //    path below instead, which counts how many months were named before believing any.
  if (/^[\d\s\/\-.]+$/.test(raw)) {
    var explicit = toYmd_(raw);

    if (explicit) {
      return withinHorizon_(explicit, todayYmd);
    }
  }

  var t = wordNumbers_(raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());

  t = t.replace(/(\d+)\s*(?:st|nd|rd|th)\b/g, '$1');   // '26th' -> '26'
  t = ' ' + t.replace(/\s+/g, ' ').trim() + ' ';

  if (t.trim() === '') {
    return '';
  }

  // 2. A month with a day beside it. Every month requires an adjacent number, which is what
  //    stops "I may be able to pay" being read as the month of May.
  var byMonth = monthAndDay_(t);

  if (byMonth === null) {
    return '';                       // two different months named - ambiguous, ask again
  }

  if (byMonth) {
    var spokenYear = t.match(/\s((?:19|20)\d\d)(?=\s)/);

    return withinHorizon_(
      spokenYear
        ? buildYmd_(parseInt(spokenYear[1], 10), byMonth.month, byMonth.day)
        : nearestFutureYear_(byMonth.month, byMonth.day, todayYmd),
      todayYmd
    );
  }

  // 3. Relative phrases. These must be tried before any bare number is read as a day of the
  //    month, or "in 3 days" becomes the 3rd.
  var relative = relativeDate_(t, todayYmd);

  if (relative) {
    return withinHorizon_(relative, todayYmd);
  }

  // 4. A bare day of the month - "the 26th", "the first".
  var days = [];

  // lookahead, not a consumed space: '20 26' must be seen as two numbers, not one
  t.replace(/\s(\d{1,2})(?=\s)/g, function (whole, n) {
    var v = parseInt(n, 10);

    if (v >= 1 && v <= 31 && days.indexOf(v) === -1) {
      days.push(v);
    }

    return whole;
  });

  if (days.length > 1) {
    return '';                       // "the 20th or the 26th"
  }

  if (days.length === 1) {
    return withinHorizon_(nextDayOfMonth_(days[0], todayYmd), todayYmd);
  }

  // 5. A weekday - "friday", "next tuesday".
  return withinHorizon_(weekdayDate_(t, todayYmd), todayYmd);
}

/**
 * Nothing a caller says about paying a bill is more than a year away in either direction. A
 * reading that lands further out is a misheard one, and a misheard date has to become "say
 * that again" rather than a rejection the caller cannot make sense of.
 *
 * The backstop matters as much as the forward one: a date a few days behind us is a caller
 * misspeaking and should be answered with "that date has already passed", but a date years
 * behind us is the parser being wrong about what it heard.
 */
function withinHorizon_(ymd, todayYmd) {
  if (!ymd) {
    return '';
  }

  if (ymd > addDaysYmd_(todayYmd, 400) || ymd < addDaysYmd_(todayYmd, -400)) {
    return '';
  }

  return ymd;
}

/** Number words to digits, including 'twenty six' and 'thirty first'. */
function wordNumbers_(text) {
  var UNITS = {
    one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4,
    five: 5, fifth: 5, six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8,
    nine: 9, ninth: 9, ten: 10, tenth: 10, eleven: 11, eleventh: 11, twelve: 12,
    twelfth: 12, thirteen: 13, thirteenth: 13, fourteen: 14, fourteenth: 14,
    fifteen: 15, fifteenth: 15, sixteen: 16, sixteenth: 16, seventeen: 17,
    seventeenth: 17, eighteen: 18, eighteenth: 18, nineteen: 19, nineteenth: 19
  };
  var TENS = { twenty: 20, twentieth: 20, thirty: 30, thirtieth: 30 };

  var tokens = text.split(/\s+/);
  var out = [];

  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];

    if (TENS[token] != null) {
      var next = tokens[i + 1];

      if (next != null && UNITS[next] != null && UNITS[next] <= 9) {
        out.push(String(TENS[token] + UNITS[next]));
        i++;
        continue;
      }

      out.push(String(TENS[token]));
      continue;
    }

    if (UNITS[token] != null) {
      out.push(String(UNITS[token]));
      continue;
    }

    out.push(token);
  }

  return out.join(' ');
}

var SPOKEN_MONTHS_ = [
  ['january', 'jan'], ['february', 'feb'], ['march', 'mar'], ['april', 'apr'],
  ['may'], ['june', 'jun'], ['july', 'jul'], ['august', 'aug'],
  ['september', 'sept', 'sep'], ['october', 'oct'], ['november', 'nov'], ['december', 'dec']
];

/**
 * {month, day} for 'august 26' / '26 of august', false when no month is named,
 * or null when two different months are - which is not a date, it is a question.
 */
function monthAndDay_(padded) {
  var hits = [];

  for (var i = 0; i < SPOKEN_MONTHS_.length; i++) {
    var names = SPOKEN_MONTHS_[i].join('|');
    var patterns = [
      new RegExp('\\b(?:' + names + ')\\s+(?:the\\s+)?(\\d{1,2})\\b'),
      new RegExp('\\b(\\d{1,2})\\s+(?:of\\s+)?(?:' + names + ')\\b')
    ];

    for (var p = 0; p < patterns.length; p++) {
      var m = padded.match(patterns[p]);

      if (!m) {
        continue;
      }

      var day = parseInt(m[1], 10);

      if (day < 1 || day > 31) {
        continue;
      }

      var key = (i + 1) + '/' + day;

      if (hits.indexOf(key) === -1) {
        hits.push(key);
      }
    }
  }

  if (hits.length > 1) {
    return null;
  }

  if (hits.length === 0) {
    return false;
  }

  var parts = hits[0].split('/');

  return { month: parseInt(parts[0], 10), day: parseInt(parts[1], 10) };
}

/** 'august 26' with no year -> the next 26 August that has not already gone. */
function nearestFutureYear_(month, day, todayYmd) {
  var year = parseInt(todayYmd.substring(0, 4), 10);

  for (var i = 0; i < 5; i++) {
    var ymd = buildYmd_(year + i, month, day);

    if (ymd && ymd >= todayYmd) {
      return ymd;
    }
  }

  return '';
}

/** 'the 26th' with no month -> the next 26th, rolling into the following month if needed. */
function nextDayOfMonth_(day, todayYmd) {
  var year = parseInt(todayYmd.substring(0, 4), 10);
  var month = parseInt(todayYmd.substring(5, 7), 10);

  for (var i = 0; i < 60; i++) {
    var ymd = buildYmd_(year, month, day);

    if (ymd && ymd >= todayYmd) {
      return ymd;
    }

    month++;

    if (month > 12) {
      month = 1;
      year++;
    }
  }

  return '';
}

function relativeDate_(padded, todayYmd) {
  if (/\bday after tomorrow\b/.test(padded)) {
    return addDaysYmd_(todayYmd, 2);
  }

  if (/\btomorrow\b/.test(padded)) {
    return addDaysYmd_(todayYmd, 1);
  }

  if (/\btoday\b/.test(padded) || /\bright now\b/.test(padded) || /\bthis afternoon\b/.test(padded)) {
    return todayYmd;
  }

  var m = padded.match(/\bin\s+(?:a\s+|an\s+)?(\d{1,3})?\s*days?\b/);

  if (m) {
    return addDaysYmd_(todayYmd, m[1] ? parseInt(m[1], 10) : 1);
  }

  m = padded.match(/\bin\s+(?:a\s+|an\s+)?(\d{1,3})?\s*weeks?\b/);

  if (m) {
    return addDaysYmd_(todayYmd, 7 * (m[1] ? parseInt(m[1], 10) : 1));
  }

  if (/\bnext week\b/.test(padded)) {
    return addDaysYmd_(todayYmd, 7);
  }

  if (/\bend of (?:the )?month\b/.test(padded)) {
    var year = parseInt(todayYmd.substring(0, 4), 10);
    var month = parseInt(todayYmd.substring(5, 7), 10);

    for (var day = 31; day >= 28; day--) {
      var ymd = buildYmd_(year, month, day);

      if (ymd) {
        return ymd;
      }
    }
  }

  return '';
}

var SPOKEN_WEEKDAYS_ = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2,
  wednesday: 3, weds: 3, wed: 3, thursday: 4, thurs: 4, thur: 4, thu: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6
};

function weekdayDate_(padded, todayYmd) {
  var found = [];

  for (var name in SPOKEN_WEEKDAYS_) {
    if (!Object.prototype.hasOwnProperty.call(SPOKEN_WEEKDAYS_, name)) {
      continue;
    }

    if (new RegExp('\\b' + name + '\\b').test(padded) && found.indexOf(SPOKEN_WEEKDAYS_[name]) === -1) {
      found.push(SPOKEN_WEEKDAYS_[name]);
    }
  }

  if (found.length !== 1) {
    return '';
  }

  var delta = (found[0] - weekdayIndexYmd_(todayYmd) + 7) % 7;

  // "next friday" said on a Friday is a week away; a bare "friday" said on a Friday is today.
  if (delta === 0 && /\bnext\b/.test(padded)) {
    delta = 7;
  }

  return addDaysYmd_(todayYmd, delta);
}

/** 0 = Sunday. Computed in UTC so a daylight-saving change cannot move the day. */
function weekdayIndexYmd_(ymd) {
  var p = ymd.split('-');

  return new Date(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10))).getUTCDay();
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
    publicRecord_: publicRecord_,
    parseSpokenDate_: parseSpokenDate_,
    weekdayIndexYmd_: weekdayIndexYmd_
  };
}

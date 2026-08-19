/**
 * Crown Superior phone agent — web app entry point.
 *
 * Deployed as a Google Apps Script Web App bound to the customer spreadsheet. Voiceflow
 * calls it over HTTPS; it reads and writes the sheet as the spreadsheet's owner, so there
 * is no service account, no API key and no separate hosting to pay for or keep patched.
 *
 * Everything that makes a decision lives in lib.gs and is unit-tested. This file only does
 * plumbing: authenticate, read rows, call the decision, write the result, log it.
 *
 * ---------------------------------------------------------------------------------------
 * SETUP  (about five minutes, all inside the spreadsheet)
 *
 *   1. Open the spreadsheet -> Extensions -> Apps Script.
 *   2. Create two files, lib.gs and Code.gs, and paste these in.
 *   3. Project Settings -> Script Properties -> add:
 *         AGENT_TOKEN   = a long random string you invent (this is the shared password)
 *   4. Deploy -> New deployment -> type "Web app"
 *         Execute as:       Me
 *         Who has access:   Anyone            <- required; the token is what protects it
 *   5. Copy the /exec URL it gives you. That URL plus the token go into Voiceflow.
 *
 * Rotating the token later = change the Script Property and update Voiceflow. No redeploy.
 * ---------------------------------------------------------------------------------------
 */

var SHEET_CUSTOMERS = 'Customers';
var SHEET_LOG       = 'Agent_Log';

/** How many days before the cancellation date the money has to be in. */
var MIN_DAYS_BEFORE_CANCELLATION = 1;

function doPost(e) {
  var body = {};

  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOut_({ ok: false, error: 'BAD_JSON' });
  }

  return jsonOut_(handle_(body));
}

/** GET is supported only as a health check, so a browser hitting the URL reveals nothing. */
function doGet(e) {
  var token = (e && e.parameter && e.parameter.token) || '';

  if (!tokenOk_(token)) {
    return jsonOut_({ ok: false, error: 'UNAUTHORISED' });
  }

  return jsonOut_({ ok: true, service: 'crown-superior-phone-agent', today: todayYmd_() });
}

function handle_(body) {
  if (!tokenOk_(body.token)) {
    logRow_('-', '-', body.action || '?', 'UNAUTHORISED', '');

    return { ok: false, error: 'UNAUTHORISED' };
  }

  switch (String(body.action || '').toLowerCase()) {
    case 'ping':    return { ok: true, today: todayYmd_() };
    case 'lookup':  return actionLookup_(body);
    case 'promise': return actionPromise_(body);
    default:        return { ok: false, error: 'UNKNOWN_ACTION' };
  }
}

/**
 * Verify a caller and return what they are allowed to hear.
 * Deliberately returns the SAME shape for "wrong DOB" and "no such customer" - a caller
 * must not be able to use the difference to discover whether a number is on the books.
 */
function actionLookup_(body) {
  var rows = readCustomers_();
  var result = findCustomer_(rows, body.phone, body.dob);

  if (result.status !== 'FOUND') {
    logRow_(body.phone, body.dob, 'lookup', result.status, '');

    return {
      ok: true,
      verified: false,
      reason: result.status === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'NOT_VERIFIED',
      action: result.status === 'AMBIGUOUS' ? 'TRANSFER_TO_AGENT' : 'RETRY',
      say: result.status === 'AMBIGUOUS'
        ? 'I found more than one record matching that information, so I will transfer you to a representative.'
        : 'I was not able to verify a policy with that information.'
    };
  }

  var record = publicRecord_(result.matches[0].row);

  logRow_(body.phone, body.dob, 'lookup', 'VERIFIED', record.customer_id);

  return { ok: true, verified: true, customer: record };
}

/**
 * Set a promise-to-pay date.
 *
 * Re-verifies from the phone and DOB rather than trusting a customer id handed back by the
 * caller's side of the conversation: this endpoint WRITES, so it authenticates itself.
 */
function actionPromise_(body) {
  var rows = readCustomers_();
  var result = findCustomer_(rows, body.phone, body.dob);

  if (result.status !== 'FOUND') {
    logRow_(body.phone, body.dob, 'promise', 'NOT_VERIFIED', '');

    return {
      ok: true,
      verified: false,
      allowed: false,
      action: 'TRANSFER_TO_AGENT',
      reason: 'NOT_VERIFIED',
      say: 'I was not able to verify the policy, so I will transfer you to a representative.'
    };
  }

  var row = result.matches[0].row;
  var today = todayYmd_();

  // body.date is whatever the caller said, as text. parseSpokenDate_ handles both a proper
  // date and "next friday"; an unclear one comes back blank, which asks the caller again.
  var heard = parseSpokenDate_(body.date, today);

  var decision = decidePromiseToPay_(
    heard,
    toYmd_(row.Cancellation_Date),
    today,
    MIN_DAYS_BEFORE_CANCELLATION,
    toYmd_(row.Promise_To_Pay_Date)
  );

  decision.ok = true;
  decision.verified = true;
  decision.heard_date = heard;
  decision.heard_date_spoken = spokenDate_(heard);
  decision.said = String(body.date == null ? '' : body.date);
  decision.customer_id = String(row.Customer_ID == null ? '' : row.Customer_ID);

  if (decision.allowed) {
    writePromise_(result.matches[0].rowNumber, decision.promise_date);
  }

  logRow_(body.phone, body.dob, 'promise', decision.reason,
          decision.customer_id + ' ' + (decision.promise_date || String(body.date || '')));

  return decision;
}

/* ------------------------------------------------------------------ sheet access ------ */

function book_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/** Every row as an object keyed by the Row 1 headings, plus __row for writing back. */
function readCustomers_() {
  var sheet = book_().getSheetByName(SHEET_CUSTOMERS);

  if (!sheet) {
    throw new Error('Missing worksheet: ' + SHEET_CUSTOMERS);
  }

  var values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return [];
  }

  var headers = values[0].map(function (h) { return String(h).trim(); });
  var rows = [];

  for (var r = 1; r < values.length; r++) {
    var obj = { __row: r + 1 };
    var blank = true;

    for (var c = 0; c < headers.length; c++) {
      if (headers[c] === '') {
        continue;
      }

      obj[headers[c]] = values[r][c];

      if (String(values[r][c]).trim() !== '') {
        blank = false;
      }
    }

    if (!blank) {
      rows.push(obj);
    }
  }

  return rows;
}

/** The only write this service performs. */
function writePromise_(rowNumber, promiseYmd) {
  var sheet = book_().getSheetByName(SHEET_CUSTOMERS);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });

  var dateCol = headers.indexOf('Promise_To_Pay_Date') + 1;
  var stampCol = headers.indexOf('Promise_Set_At') + 1;

  if (dateCol > 0) {
    // written as text so the cell cannot be re-interpreted by locale settings
    sheet.getRange(rowNumber, dateCol).setNumberFormat('@').setValue(promiseYmd);
  }

  if (stampCol > 0) {
    sheet.getRange(rowNumber, stampCol).setNumberFormat('@').setValue(nowStamp_());
  }
}

/**
 * Append to the audit tab. Wrapped in try/catch on purpose: a logging failure must never
 * stop a caller getting an answer. The DOB is recorded as matched/not, never the value.
 */
function logRow_(phone, dob, action, outcome, detail) {
  try {
    var sheet = book_().getSheetByName(SHEET_LOG);

    if (!sheet) {
      sheet = book_().insertSheet(SHEET_LOG);
      sheet.appendRow(['When', 'Phone', 'DOB given?', 'Action', 'Outcome', 'Detail']);
      sheet.setFrozenRows(1);
    }

    sheet.appendRow([
      nowStamp_(),
      normPhone_(phone) || '-',
      normDobMmdd_(dob) ? 'yes' : 'no',
      action,
      outcome,
      detail
    ]);
  } catch (err) {
    // deliberately swallowed
  }
}

/* ---------------------------------------------------------------------- helpers ------- */

function tokenOk_(given) {
  var expected = PropertiesService.getScriptProperties().getProperty('AGENT_TOKEN');

  if (!expected || String(expected).length < 16) {
    return false;   // refuse to run unprotected
  }

  var a = String(given == null ? '' : given);

  if (a.length !== String(expected).length) {
    return false;
  }

  var diff = 0;

  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ String(expected).charCodeAt(i);
  }

  return diff === 0;
}

function scriptTz_() {
  return Session.getScriptTimeZone() || 'America/New_York';
}

function todayYmd_() {
  return Utilities.formatDate(new Date(), scriptTz_(), 'yyyy-MM-dd');
}

function nowStamp_() {
  return Utilities.formatDate(new Date(), scriptTz_(), 'yyyy-MM-dd HH:mm:ss');
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

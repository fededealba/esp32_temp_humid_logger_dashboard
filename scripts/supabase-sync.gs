/**
 * Google Apps Script — Supabase sync trigger
 *
 * Paste this into your Google Sheet's Script Editor
 * (Extensions → Apps Script), then:
 *
 *  1. Set script properties (Project Settings → Script Properties):
 *       SUPABASE_URL              https://xxxx.supabase.co
 *       SUPABASE_SERVICE_ROLE_KEY  <your service_role key>
 *
 *  2. Add a trigger (Triggers → Add Trigger):
 *       Function:    onFormSubmit
 *       Event type:  On form submit
 *
 * Sheet column order expected (set by Google Forms):
 *   [0] Timestamp          — form submission time (auto-added by Forms)
 *   [1] Temperature        — °C float
 *   [2] Humidity           — % float
 *   [3] Device ID          — MAC address string
 *   [4] Device Timestamp   — ISO-8601 UTC string from ESP32
 */

function onFormSubmit(e) {
  const props = PropertiesService.getScriptProperties();
  const supabaseUrl = props.getProperty("SUPABASE_URL");
  const supabaseKey = props.getProperty("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in Script Properties.");
    return;
  }

  const values = e.values;

  const temperature = parseFloat(values[1]);
  const humidity    = parseFloat(values[2]);

  if (!isFinite(temperature) || !isFinite(humidity)) {
    console.warn("Skipping row with invalid temperature or humidity:", values);
    return;
  }

  const receivedAt  = values[0] ? new Date(values[0]).toISOString() : new Date().toISOString();
  const deviceId    = (values[3] || "unknown").trim();
  const deviceTs    = values[4] ? new Date(values[4]).toISOString() : null;

  const payload = JSON.stringify({
    temperature,
    humidity,
    device_id:   deviceId,
    device_ts:   deviceTs,
    received_at: receivedAt,
  });

  const response = UrlFetchApp.fetch(supabaseUrl + "/rest/v1/readings", {
    method:            "post",
    contentType:       "application/json",
    headers: {
      "apikey":        supabaseKey,
      "Authorization": "Bearer " + supabaseKey,
      "Prefer":        "return=minimal",
    },
    payload:           payload,
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code >= 400) {
    console.error("Supabase insert failed (" + code + "):", response.getContentText());
  } else {
    console.log("Inserted reading: temp=" + temperature + " hum=" + humidity);
  }
}


/**
 * One-time backfill — run this manually from the Script Editor
 * to copy all existing Sheet rows into Supabase.
 *
 * Run it by selecting "backfillToSupabase" in the function dropdown
 * and clicking ▶ Run.
 */
function backfillToSupabase() {
  const props = PropertiesService.getScriptProperties();
  const supabaseUrl = props.getProperty("SUPABASE_URL");
  const supabaseKey = props.getProperty("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in Script Properties.");
  }

  const sheet  = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    console.log("No data rows found.");
    return;
  }

  // Skip header row; build rows array
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const temperature = parseFloat(row[1]);
    const humidity    = parseFloat(row[2]);
    if (!isFinite(temperature) || !isFinite(humidity)) continue;

    const receivedAt = row[0] ? new Date(row[0]).toISOString() : null;
    const deviceId   = (row[3] || "unknown").toString().trim();
    const deviceTs   = row[4] ? new Date(row[4]).toISOString() : null;

    rows.push({ temperature, humidity, device_id: deviceId, device_ts: deviceTs, received_at: receivedAt });
  }

  // Insert in batches of 500
  const batchSize = 500;
  let inserted = 0;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const response = UrlFetchApp.fetch(supabaseUrl + "/rest/v1/readings", {
      method:            "post",
      contentType:       "application/json",
      headers: {
        "apikey":        supabaseKey,
        "Authorization": "Bearer " + supabaseKey,
        "Prefer":        "return=minimal",
      },
      payload:           JSON.stringify(batch),
      muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    if (code >= 400) {
      console.error("Batch insert failed (" + code + "):", response.getContentText());
      throw new Error("Backfill aborted at row " + start);
    }
    inserted += batch.length;
    console.log("Inserted " + inserted + " / " + rows.length + " rows");
    Utilities.sleep(300); // stay within Apps Script quota
  }

  console.log("Backfill complete: " + inserted + " rows inserted.");
}

#pragma once

const char* WIFI_SSID = "your-wifi-name";
const char* WIFI_PASSWORD = "your-wifi-password";

// Supabase direct ingestion. Run scripts/supabase-schema.sql once in the
// Supabase SQL Editor to create the `readings` table before setting these.
// This is the service_role key (Project Settings -> API) so it bypasses RLS
// entirely: anyone who extracts it from this device gets full read/write/
// delete access to the database, not just insert. Leave both empty ("") to
// disable Supabase writes and only post to Google Forms.
const char* SUPABASE_URL = "https://xxxxxxxxxxxx.supabase.co";
const char* SUPABASE_SERVICE_ROLE_KEY = "your-service-role-key";

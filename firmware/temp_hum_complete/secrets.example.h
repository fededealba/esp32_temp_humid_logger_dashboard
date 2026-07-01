#pragma once

const char* WIFI_SSID = "your-wifi-name";
const char* WIFI_PASSWORD = "your-wifi-password";

// Supabase direct ingestion. Run scripts/supabase-schema.sql once in the
// Supabase SQL Editor to create the `readings` table and its insert-only
// RLS policy before setting these. This is the anon/publishable key
// (Project Settings -> API), not service_role: the RLS policy restricts it
// to INSERT only, so a captured key can add fake rows but can't read,
// modify, or delete anything. Leave both empty ("") to disable Supabase
// writes and only post to Google Forms.
const char* SUPABASE_URL = "https://xxxxxxxxxxxx.supabase.co";
const char* SUPABASE_ANON_KEY = "your-anon-key";

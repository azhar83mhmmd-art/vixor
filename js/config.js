// Isi dengan URL project dan publishable/anon key Supabase kamu.
// JANGAN pernah memasukkan service_role key di sini.
export const SUPABASE_URL = "https://muuiwbavezuaatmkonks.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable__evf7_RkTMloDdZ5ck5G-A_o3JpCcnM";
// Panggilan: server STUN publik (opsional, boleh diganti). Sengaja TANPA TURN. Format: array RTCIceServer.
export const CALL_STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
// Web Push: kunci PUBLIK VAPID (aman di frontend). Hasil `node scripts/gen-vapid.mjs`. Kosong = push belum dikonfigurasi.
export const VAPID_PUBLIC_KEY = "BDkXlAjZ64F56LWwfQc2rRiK5WxifHGBj8R6KWtmRr8fq1uQE7RXlvc5_KVlLkY0UAD2trGmCP1U62iE0Npzp4w";

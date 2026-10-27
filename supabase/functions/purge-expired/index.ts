// Pembersihan pesan sementara yang sudah kedaluwarsa: hapus berkas lampiran di Storage lebih dulu, baru baris pesannya.
// Dijadwalkan (mis. tiap 15 menit) lewat Supabase Scheduled Function / pg_cron + pg_net. Dilindungi header x-cron-secret.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (otomatis tersedia di Edge Function), CRON_SECRET (atur sendiri).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return new Response('Forbidden', { status: 403 });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  let rows = 0, files = 0;
  for (let round = 0; round < 10; round++) {            // maks. 10 x 200 pesan per eksekusi
    const { data, error } = await sb.from('messages').select('id, media_path').lte('expires_at', new Date().toISOString()).limit(200);
    if (error) return Response.json({ ok: false, error: error.message, rows, files }, { status: 500 });
    if (!data?.length) break;
    const paths = data.map((m) => m.media_path).filter(Boolean) as string[];
    if (paths.length) {
      const { error: se } = await sb.storage.from('chat-media').remove(paths);
      if (se) return Response.json({ ok: false, error: se.message, rows, files }, { status: 500 });   // jangan hapus baris jika berkas gagal dihapus
      files += paths.length;
    }
    const { error: de } = await sb.from('messages').delete().in('id', data.map((m) => m.id));
    if (de) return Response.json({ ok: false, error: de.message, rows, files }, { status: 500 });
    rows += data.length;
    if (data.length < 200) break;
  }
  return Response.json({ ok: true, rows, files });
});

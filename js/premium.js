// ORVIX Premium Hub: status langganan, gaya bubble/aksen, bingkai profil, insight chat.
import { sb, cacheMe, errMsg } from './supabase.js';
import { $, $$, esc, icon, openModal, toast, setBusy, isPremium, applyLook } from './utils.js';

const SWATCH = {
  default: ['Standar', 'linear-gradient(135deg,#123a8f,#0b5d9e)'], aurora: ['Aurora', 'linear-gradient(135deg,#2dd4bf,#6366f1 60%,#a855f7)'],
  sunset: ['Senja', 'linear-gradient(135deg,#ff7a45,#ff3d71)'], mint: ['Mint', 'linear-gradient(135deg,#10b981,#34d399)'],
  rose: ['Mawar', 'linear-gradient(135deg,#fb7185,#e11d48)'], mono: ['Mono', 'linear-gradient(135deg,#475569,#1e293b)'], gold: ['Emas', 'linear-gradient(135deg,#f5b301,#b45309)'],
};
const PERKS = [
  ['palette', 'Gaya bubble dan warna aksen', 'Pilih 6 gaya bubble dan 5 aksen warna untuk seluruh aplikasi.'],
  ['sparkle', 'Aura profil animasi', 'Bingkai cahaya bergerak di sekeliling foto profilmu.'],
  ['pin', 'Sematkan hingga 10 chat', 'Pengguna biasa dibatasi 3 chat.'],
  ['edit', 'Edit pesan hingga 1 jam', 'Pengguna biasa hanya 15 menit.'],
  ['chart', 'Insight aktivitas chat', 'Ringkasan 30 hari: pesan terkirim, jam tersibuk, kontak teratas.'],
  ['download', 'Ekspor riwayat chat', 'Unduh percakapan sebagai berkas teks dari menu chat.'],
  ['badge', 'Badge Premium emas', 'Tampil di profil dan chat selama langganan aktif.'],
];
const fmtDate = (d) => new Intl.DateTimeFormat('id-ID', { dateStyle: 'long' }).format(new Date(d));
const daysLeft = (d) => Math.max(0, Math.ceil((new Date(d) - Date.now()) / 86400000));

export function lockedHint() { toast('Fitur ini khusus ORVIX Premium', 'info'); }

export async function openPremiumHub(me, onChange) {
  const on = isPremium(me), pr = { bubble: 'default', accent: 'default', ring: false, ...(me.premium_prefs || {}) };
  const sw = (kind, list) => list.map((k) => `<button class="pswatch ${pr[kind] === k ? 'on' : ''}" data-k="${kind}" data-v="${k}" aria-pressed="${pr[kind] === k}" ${on ? '' : 'disabled'}><i style="background:${SWATCH[k]?.[1] || SWATCH.default[1]}"></i><span>${SWATCH[k]?.[0] || k}</span></button>`).join('');
  const m = openModal({ title: 'ORVIX Premium', wide: true, cls: 'phub', html: `
    <div class="phero ${on ? 'active' : ''}"><span class="phero-ic">${icon('crown', 26)}</span>
      <div class="grow"><b class="phero-t">${on ? 'Premium aktif' : 'Belum berlangganan'}</b>
      <small>${on ? `Sampai ${fmtDate(me.premium_until)} · sisa ${daysLeft(me.premium_until)} hari` : 'Aktifkan Premium untuk membuka semua fitur di bawah.'}</small></div></div>
    <ul class="pperks">${PERKS.map(([ic, t, d]) => `<li><span class="pp-ic">${icon(ic, 18)}</span><span><b>${t}</b><small>${d}</small></span><span class="pp-ok ${on ? 'on' : ''}">${on ? icon('check', 16) : icon('lock', 15)}</span></li>`).join('')}</ul>
    ${on ? `<p class="sec">Gaya bubble chat</p><div class="pswatches" id="sB">${sw('bubble', ['default', 'aurora', 'sunset', 'mint', 'rose', 'mono', 'gold'])}</div>
      <p class="sec">Warna aksen aplikasi</p><div class="pswatches" id="sA">${sw('accent', ['default', 'aurora', 'sunset', 'mint', 'rose', 'gold'])}</div>
      <div class="setrow" style="margin-top:12px">${icon('sparkle', 22)}<span class="grow"><b>Aura profil</b><small>Bingkai cahaya animasi di foto profil</small></span><button class="switch" role="switch" id="swRing" aria-checked="${!!pr.ring}" aria-label="Aura profil"></button></div>
      <button class="btn block" id="bIns" style="margin-top:12px">${icon('chart', 18)} Lihat insight chat 30 hari</button><div id="ins"></div>`
    : `<div class="alert info" style="margin-top:12px">Pembayaran dilakukan manual: hubungi admin ORVIX, lakukan pembayaran, lalu kirim bukti. Setelah dikonfirmasi, admin mengaktifkan Premium sesuai masa aktif yang disepakati. Saat masa aktif habis, fitur Premium berhenti otomatis dan bisa diperpanjang lewat admin.</div>`}`
  });
  if (!on) return m;
  const save = async () => {
    const { data, error } = await sb.rpc('orvix_set_premium_prefs', { p: pr });
    if (error) return toast(/function|schema cache/i.test(errMsg(error)) ? 'Jalankan sql-parts/13d-premium.sql di Supabase terlebih dahulu.' : errMsg(error), 'error');
    me.premium_prefs = data; cacheMe(me); applyLook(me); onChange?.(me);
  };
  m.el.onclick = async (e) => {
    const b = e.target.closest('.pswatch');
    if (b) { pr[b.dataset.k] = b.dataset.v; $$(`[data-k="${b.dataset.k}"]`, m.el).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); }); applyLook({ ...me, premium_prefs: pr }); return save(); }
    if (e.target.closest('#swRing')) { const s = $('#swRing', m.el); pr.ring = !pr.ring; s.setAttribute('aria-checked', pr.ring); applyLook({ ...me, premium_prefs: pr }); return save(); }
    if (e.target.closest('#bIns')) {
      const btn = $('#bIns', m.el); setBusy(btn, true);
      const { data, error } = await sb.rpc('orvix_premium_insights'); setBusy(btn, false);
      if (error) return toast(/function|schema cache/i.test(errMsg(error)) ? 'Jalankan sql-parts/13d-premium.sql di Supabase terlebih dahulu.' : errMsg(error), 'error');
      const top = data.top || [], mx = Math.max(1, ...top.map((t) => t.n));
      $('#ins', m.el).innerHTML = `<div class="ins"><div class="ins-g"><div><b>${data.sent_30d}</b><small>pesan terkirim</small></div><div><b>${data.media_30d}</b><small>foto/video</small></div><div><b>${data.active_chats}</b><small>chat aktif</small></div><div><b>${data.busiest_hour == null ? '-' : String(data.busiest_hour).padStart(2, '0') + ':00'}</b><small>jam tersibuk</small></div></div>
        ${top.length ? `<p class="sec" style="margin:10px 0 6px">Kontak teratas</p>${top.map((t) => `<div class="ins-r"><span class="ell">${esc(t.name)}</span><i style="--w:${Math.round((t.n / mx) * 100)}%"></i><b>${t.n}</b></div>`).join('')}` : '<p class="dim" style="margin-top:8px">Belum ada aktivitas chat pribadi.</p>'}</div>`;
    }
  };
  return m;
}

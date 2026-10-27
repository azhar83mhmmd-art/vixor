// Halaman Panggilan: riwayat masuk / keluar / tidak terjawab, panggil balik, dan gabung panggilan grup yang masih berjalan.
import { sb, requireAuth, fetchProfiles, errMsg } from './supabase.js';
import { $, esc, icon, mountShell, avatar, listTime, toast } from './utils.js';
import { startCall, joinCall, openCalls, activeSession, bus, callsAvailable, rpcErr } from './calls-core.js';

const { profile } = await requireAuth({ shell: '/calls' });
mountShell('/calls', profile.role === 'admin');
const body = $('#body');
const dur = (s) => { const m = Math.floor(s / 60); return m >= 60 ? Math.floor(m / 60) + ' j ' + (m % 60) + ' m' : m ? m + ' m ' + (s % 60) + ' d' : s + ' d'; };
let openKey = '';

function label(r, meId) {
  const out = r.created_by === meId, ans = !!r.answered_at, d = r.duration_secs != null ? ' · ' + dur(r.duration_secs) : '';
  if (ans && r.my_state !== 'declined' && r.my_state !== 'missed') return { t: (out ? 'Keluar' : 'Masuk') + d, miss: false };
  if (out) return { t: r.end_reason === 'declined' ? 'Ditolak' : r.end_reason === 'cancelled' ? 'Dibatalkan' : 'Tidak dijawab', miss: false };
  if (r.my_state === 'declined') return { t: 'Kamu menolak', miss: false };
  return { t: 'Tidak terjawab', miss: true };
}

async function load() {
  if (!callsAvailable()) { body.innerHTML = '<div class="empty"><h3>Fitur panggilan belum aktif</h3><p>Jalankan <code>sql-parts/14a-panggilan.sql</code> di SQL Editor Supabase, lalu muat ulang halaman ini.</p></div>'; return; }
  const { data, error } = await sb.rpc('call_history', { lim: 60 });
  if (error) {
    const e = rpcErr(error);
    body.innerHTML = `<div class="empty"><h3>${e.code === 'NOSQL' ? 'Fitur panggilan belum aktif' : 'Gagal memuat riwayat'}</h3><p>${esc(e.text)}</p><button class="btn" id="rtry" style="margin-top:12px">Coba lagi</button></div>`;
    $('#rtry').onclick = load; return;
  }
  const rows = data || [];
  const profs = await fetchProfiles(rows.map((r) => r.other_id)).catch(() => new Map());
  const open = [...openCalls().values()]; openKey = open.map((o) => o.call_id).sort().join();
  const openHtml = open.length ? `<div style="margin-bottom:14px">${open.map((o) => `<div class="ch-row"><span class="pill good">Berlangsung</span><div class="grow"><b>Panggilan ${o.kind === 'video' ? 'video' : 'suara'}${o.scope === 'group' ? ' grup' : ''}</b><small>${o.joined_count || 0} peserta</small></div><button class="btn primary" data-open="${o.call_id}">${o.my_state === 'joined' ? 'Kembali' : 'Gabung'}</button></div>`).join('')}</div>` : '';
  if (!rows.length && !open.length) { body.innerHTML = '<div class="empty"><h3>Belum ada panggilan</h3><p>Mulai panggilan suara atau video dari header percakapan di tab Chat.</p><a class="btn" href="/chat" style="margin-top:12px">Buka Chat</a></div>'; return; }
  body.innerHTML = openHtml + rows.map((r, i) => {
    const grp = r.scope === 'group', p = profs.get(r.other_id), nm = grp ? r.title || 'Grup' : (p && p.display_name) || 'Pengguna', l = label(r, profile.id);
    return `<div class="ch-row${l.miss ? ' missed' : ''}">${grp ? `<span class="av" style="width:44px;height:44px">${icon('users')}</span>` : avatar(nm, p && p.avatar_url, 44)}<div class="grow"><b class="ell" style="display:block">${esc(nm)}</b><small>${icon(r.kind === 'video' ? 'video' : 'phone', 14)} ${esc(l.t)} · ${esc(listTime(r.created_at))}</small></div><button class="ibtn" data-cb="${i}" aria-label="${r.kind === 'video' ? 'Video call' : 'Telepon'} ${esc(nm)}">${icon(r.kind === 'video' ? 'video' : 'phone')}</button></div>`;
  }).join('');
  body.querySelectorAll('[data-cb]').forEach((b) => { b.onclick = async () => {
    const r = rows[+b.dataset.cb], grp = r.scope === 'group', p = profs.get(r.other_id);
    if (activeSession()) return toast('Kamu masih dalam panggilan.', 'error');
    try { await startCall(r.conversation_id, r.kind, { isGroup: grp, title: grp ? r.title || 'Grup' : (p && p.display_name) || 'Pengguna', avatar: p && p.avatar_url, otherId: grp ? null : r.other_id }); }
    catch (e) { if (!e.shown) toast(e.message || errMsg(e), 'error'); }
  }; });
  body.querySelectorAll('[data-open]').forEach((b) => { b.onclick = async () => {
    const o = open.find((x) => x.call_id === b.dataset.open); if (!o || activeSession()) return;
    try { await joinCall({ callId: o.call_id, convId: o.conversation_id, kind: o.kind, scope: o.scope, ctx: { isGroup: o.scope === 'group', title: o.scope === 'group' ? 'Grup' : 'Panggilan' } }); }
    catch (e) { if (!e.shown) toast(e.message || errMsg(e), 'error'); }
  }; });
}
await load().catch((e) => { body.innerHTML = `<div class="empty"><h3>Gagal memuat riwayat</h3><p>${esc(errMsg(e))}</p></div>`; });
bus.on('session-end', () => load().catch(() => {}));
bus.on('open', (m) => { const k = [...m.values()].map((o) => o.call_id).sort().join(); if (k !== openKey && !activeSession()) load().catch(() => {}); });

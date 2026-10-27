// ORVIX — inti panggilan suara/video (pribadi + grup).
// Lapisan: (1) MeshTransport = koneksi WebRTC peer-to-peer per pasangan (bisa diganti SFU kelak tanpa menyentuh UI),
//          (2) CallSession   = signaling (Supabase Realtime private Broadcast) + roster dari database + kontrol,
//          (3) manajer global = panggilan masuk, banner "Gabung", notifikasi tidak terjawab.
// Hanya STUN publik. Tidak ada TURN/SFU: koneksi bisa gagal pada sebagian jaringan (NAT simetris, CGNAT, firewall).
import { sb, errMsg, fetchProfiles, cachedMe } from './supabase.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import * as CFG from './config.js';

// ---------- util ----------
(() => { if (typeof document === 'undefined' || document.querySelector('link[data-calls]')) return; const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/css/calls.css'; l.dataset.calls = ''; document.head.append(l); })();

export class Emitter {
  constructor() { this.h = {}; }
  on(e, f) { (this.h[e] ||= new Set()).add(f); return () => this.h[e].delete(f); }
  emit(e, d) { [...(this.h[e] || [])].forEach((f) => { try { f(d); } catch (x) { console.error('[calls]', x); } }); }
}
export const bus = new Emitter();
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const iceConfig = () => ({
  iceServers: Array.isArray(CFG.CALL_STUN) && CFG.CALL_STUN.length ? CFG.CALL_STUN : [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
  bundlePolicy: 'max-bundle',
});

export function mediaErrMsg(e) {
  const n = e && e.name;
  if (n === 'InsecureContext') return 'Panggilan hanya bisa dipakai lewat HTTPS. Buka ORVIX dari alamat https://.';
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Izin mikrofon/kamera ditolak. Aktifkan izin di pengaturan browser, lalu coba lagi.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Mikrofon atau kamera tidak ditemukan di perangkat ini.';
  if (n === 'NotReadableError' || n === 'AbortError') return 'Mikrofon/kamera sedang dipakai aplikasi lain.';
  return 'Tidak bisa mengakses mikrofon/kamera.';
}
// Pesan galat RPC: "KODE: teks" -> { code, text }
export function rpcErr(e) {
  const m = errMsg(e); const hit = /^(BUSY_SELF|BUSY_OTHER|FULL):\s*(.*)$/s.exec(m);
  if (hit) return { code: hit[1], text: hit[2] };
  if (/could not find the function|does not exist|schema cache|42883|42P01|permission denied/i.test(m)) return { code: 'NOSQL', text: 'Fitur panggilan belum aktif di database. Jalankan sql-parts/14a-panggilan.sql di SQL Editor Supabase.' };
  return { code: 'ERR', text: m };
}

const AUDIO_C = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const videoC = (facing, grp) => ({ facingMode: { ideal: facing }, width: { ideal: grp ? 640 : 1280 }, height: { ideal: grp ? 360 : 720 }, frameRate: { ideal: 24, max: 30 } });
const gum = (c) => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection) { const e = new Error('insecure'); e.name = 'InsecureContext'; return Promise.reject(e); }
  return navigator.mediaDevices.getUserMedia(c);
};

// ---------- transport mesh ----------
// Satu RTCPeerConnection per pasangan peserta. Penawar (initiator) = yang bergabung lebih belakangan -> tidak ada glare.
class MeshTransport {
  constructor(h) { this.h = h; this.peers = new Map(); this.early = new Map(); this.qs = new Map(); this.rb = new Map(); this.busy = new Set(); this.closed = false; }
  _enq(uid, fn) { const prev = this.qs.get(uid) || Promise.resolve(); const next = prev.then(fn).catch((e) => console.warn('[calls] peer', uid, e)); this.qs.set(uid, next); return next; }
  has(uid) { return this.peers.has(uid); }
  _mk(uid, sid, initiator) {
    const pc = new RTCPeerConnection(iceConfig());
    const p = { uid, sid, initiator, pc, g: 0, cands: [], remoteSet: false, state: 'connecting', stream: new MediaStream(), tries: 0, t: {}, cb: [], tx: null };
    pc.onicecandidate = (e) => { if (e.candidate) this._cand(p, e.candidate); else this._flush(p); };
    pc.ontrack = (e) => {
      if (e.track.kind === 'video' && this.h.kind !== 'video') return;           // panggilan suara: abaikan video
      if (!p.stream.getTracks().includes(e.track)) p.stream.addTrack(e.track);
      this.h.onStream(uid, p.stream); e.track.onunmute = () => this.h.onStream(uid, p.stream);
    };
    pc.onconnectionstatechange = () => this._conn(p);
    this.peers.set(uid, p); return p;
  }
  _drop(uid) {
    const p = this.peers.get(uid); if (!p) return;
    Object.values(p.t).forEach(clearTimeout); p.closed = true;
    p.pc.onicecandidate = p.pc.ontrack = p.pc.onconnectionstatechange = null; try { p.pc.close(); } catch { /* abaikan */ }
    this.peers.delete(uid); this.h.onStream(uid, null);
  }
  _cand(p, c) { p.cb.push(c.toJSON ? c.toJSON() : c); if (!p.t.cb) p.t.cb = setTimeout(() => this._flush(p), 200); }
  _flush(p) { clearTimeout(p.t.cb); p.t.cb = 0; if (!p.cb.length || p.closed) return; const c = p.cb.splice(0, 40); this.h.send({ t: 'cand', to: p.uid, sid: p.sid, c }); }
  _local(p) {
    const L = this.h.getLocal(); p.tx = {};
    p.tx.audio = L.audio ? p.pc.addTransceiver(L.audio, { direction: 'sendrecv', streams: [L.stream] }) : p.pc.addTransceiver('audio', { direction: 'sendrecv' });
    if (this.h.kind === 'video') p.tx.video = L.video ? p.pc.addTransceiver(L.video, { direction: 'sendrecv', streams: [L.stream] }) : p.pc.addTransceiver('video', { direction: 'sendrecv' });
  }
  // dipanggil bila saya yang menawar
  connect(uid, keep = false) {
    if (this.busy.has(uid)) return Promise.resolve(); this.busy.add(uid); if (!keep) this.rb.delete(uid);
    return this._enq(uid, async () => {
      try {
        if (this.closed) return; this._drop(uid);
        const p = this._mk(uid, rid(), true); this.h.onPeerState(uid, 'connecting'); this._local(p);
        await this._offer(p, false);
        p.t.est = setTimeout(() => { if (p.state !== 'connected') this._recover(p); }, 12000);
      } finally { this.busy.delete(uid); }
    });
  }
  async _offer(p, restart) {
    p.g++; const o = await p.pc.createOffer(restart ? { iceRestart: true } : undefined); await p.pc.setLocalDescription(o);
    this.h.send({ t: 'offer', to: p.uid, sid: p.sid, g: p.g, sdp: p.pc.localDescription.sdp });
  }
  handle(m) {
    const uid = m.from;
    return this._enq(uid, async () => {
      if (this.closed) return;
      if (m.t === 'offer') return this._onOffer(m);
      if (m.t === 'answer') return this._onAnswer(m);
      if (m.t === 'cand') return this._onCand(m);
      if (m.t === 'rtr') { const p = this.peers.get(uid); if (!p || (p.initiator && p.sid === m.sid)) return this.connect(uid, true); }
    });
  }
  async _onOffer(m) {
    if (typeof m.sdp !== 'string' || m.sdp.length > 120000 || typeof m.sid !== 'string' || !Number.isInteger(m.g)) return;
    let p = this.peers.get(m.from);
    if (p && p.sid === m.sid) { if (m.g <= p.g) return; }                       // duplikat / terlambat
    else { this._drop(m.from); p = this._mk(m.from, m.sid, false); this.h.onPeerState(m.from, 'connecting'); }
    p.g = m.g;
    await p.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp }); p.remoteSet = true;
    if (!p.tx) {
      p.tx = {}; const L = this.h.getLocal();
      for (const t of p.pc.getTransceivers()) {
        const k = t.receiver.track.kind; if (p.tx[k] || (k === 'video' && this.h.kind !== 'video')) continue;
        p.tx[k] = t; t.direction = 'sendrecv'; if (L[k]) await t.sender.replaceTrack(L[k]);
      }
    }
    await this._drain(p);
    const a = await p.pc.createAnswer(); await p.pc.setLocalDescription(a);
    this.h.send({ t: 'answer', to: m.from, sid: p.sid, g: p.g, sdp: p.pc.localDescription.sdp });
    clearTimeout(p.t.est); p.t.est = setTimeout(() => { if (p.state !== 'connected') this._recover(p); }, 15000);
  }
  async _onAnswer(m) {
    const p = this.peers.get(m.from);
    if (!p || p.sid !== m.sid || m.g !== p.g || typeof m.sdp !== 'string' || p.pc.signalingState !== 'have-local-offer') return;
    await p.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); p.remoteSet = true; await this._drain(p);
  }
  async _onCand(m) {
    if (!Array.isArray(m.c) || m.c.length > 40) return;
    const p = this.peers.get(m.from);
    if (p && p.sid === m.sid) { if (p.remoteSet) { for (const c of m.c) { try { await p.pc.addIceCandidate(c); } catch { /* kandidat basi */ } } } else p.cands.push(...m.c); return; }
    const k = m.from + '|' + m.sid; const arr = this.early.get(k) || []; if (arr.length < 60) arr.push(...m.c); this.early.set(k, arr);
    setTimeout(() => this.early.delete(k), 15000);
  }
  async _drain(p) {
    const e = this.early.get(p.uid + '|' + p.sid); if (e) { p.cands.push(...e); this.early.delete(p.uid + '|' + p.sid); }
    for (const c of p.cands.splice(0)) { try { await p.pc.addIceCandidate(c); } catch { /* abaikan */ } }
  }
  _conn(p) {
    if (p.closed || this.peers.get(p.uid) !== p) return;
    const s = p.pc.connectionState;
    if (s === 'connected') { Object.values(p.t).forEach(clearTimeout); p.t = {}; p.state = 'connected'; p.tries = 0; this.rb.delete(p.uid); this.h.onPeerState(p.uid, 'connected'); }
    else if (s === 'disconnected') {
      if (p.state !== 'failed') { p.state = 'reconnecting'; this.h.onPeerState(p.uid, 'reconnecting'); }
      clearTimeout(p.t.dc); p.t.dc = setTimeout(() => { if (p.state !== 'connected') this._recover(p); }, 3000);
    } else if (s === 'failed') this._recover(p);
  }
  _recover(p) {
    if (p.closed || this.closed || this.peers.get(p.uid) !== p) return;
    p.tries++;
    if (p.tries > 3) { p.state = 'failed'; this.h.onPeerState(p.uid, 'failed'); return; }
    if (p.state !== 'connected') this.h.onPeerState(p.uid, p.tries === 1 && p.state === 'reconnecting' ? 'reconnecting' : 'connecting');
    if (p.initiator) {
      if (p.tries === 1 && p.pc.connectionState !== 'failed') this._enq(p.uid, () => this._offer(p, true));   // ICE restart (sid sama, g naik)
      else { const n = (this.rb.get(p.uid) || 0) + 1; this.rb.set(p.uid, n); if (n > 3) { p.state = 'failed'; this.h.onPeerState(p.uid, 'failed'); return; } this.connect(p.uid, true); return; }   // bangun ulang (sid baru), maks 3x
      clearTimeout(p.t.est); p.t.est = setTimeout(() => { if (p.state !== 'connected') this._recover(p); }, 12000);
    } else {
      this.h.send({ t: 'rtr', to: p.uid, sid: p.sid });                                                       // minta penawar mengulang
      clearTimeout(p.t.est); p.t.est = setTimeout(() => { if (p.state !== 'connected') this._recover(p); }, 12000);
    }
  }
  retry(uid) { const p = this.peers.get(uid); this.rb.delete(uid); if (p && p.pc.connectionState === 'connected') { p.state = 'connected'; this.h.onPeerState(uid, 'connected'); return; } if (p) p.tries = 0; if (p && !p.initiator) { this.h.onPeerState(uid, 'connecting'); this.h.send({ t: 'rtr', to: uid, sid: p.sid }); p.state = 'connecting'; p.t.est = setTimeout(() => { if (p.state !== 'connected') this._recover(p); }, 12000); } else return this.connect(uid); }
  async setTrack(kind, track) { for (const p of this.peers.values()) { const t = p.tx && p.tx[kind]; if (t) { try { await t.sender.replaceTrack(track); } catch (e) { console.warn('[calls] replaceTrack', e); } } } }
  async applyBitrate() {
    const n = this.peers.size; const max = n <= 1 ? 1500000 : n === 2 ? 600000 : n === 3 ? 350000 : 250000;
    for (const p of this.peers.values()) for (const s of p.pc.getSenders()) {
      if (!s.track || s.track.kind !== 'video') continue;
      try { const prm = s.getParameters(); if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}]; prm.encodings[0].maxBitrate = max; await s.setParameters(prm); } catch { /* tidak didukung */ }
    }
  }
  async stats() {
    const out = {};
    for (const p of this.peers.values()) {
      const o = { state: p.state, bytesSent: 0, bytesRecv: 0, lost: 0, rttMs: null };
      try { (await p.pc.getStats()).forEach((r) => { if (r.type === 'outbound-rtp') o.bytesSent += r.bytesSent || 0; if (r.type === 'inbound-rtp') { o.bytesRecv += r.bytesReceived || 0; o.lost += r.packetsLost || 0; } if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime != null) o.rttMs = Math.round(r.currentRoundTripTime * 1000); }); } catch { /* abaikan */ }
      out[p.uid] = o;
    }
    return out;
  }
  dropPeer(uid) { this._drop(uid); }
  closeAll() { this.closed = true; [...this.peers.keys()].forEach((u) => this._drop(u)); this.early.clear(); }
}

// ---------- deteksi bicara (RMS WebRTC) ----------
class Speak {
  constructor(cb) { this.cb = cb; this.m = new Map(); this.timer = 0; this.ac = null; }
  _ctx() { if (!this.ac) { try { this.ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { this.ac = false; } } if (this.ac && this.ac.state === 'suspended') this.ac.resume().catch(() => {}); return this.ac; }
  add(id, stream) {
    this.remove(id); const ac = this._ctx(); if (!ac || !stream || !stream.getAudioTracks().length) return;
    try { const an = ac.createAnalyser(); an.fftSize = 512; ac.createMediaStreamSource(stream).connect(an); this.m.set(id, { an, buf: new Uint8Array(an.fftSize), on: false, hits: 0, off: 0 }); } catch { /* abaikan */ }
    if (!this.timer) this.timer = setInterval(() => this._tick(), 160);
  }
  remove(id) { const e = this.m.get(id); if (e) { try { e.an.disconnect(); } catch { /* abaikan */ } this.m.delete(id); this.cb(id, false); } }
  _tick() {
    this.m.forEach((e, id) => {
      e.an.getByteTimeDomainData(e.buf); let s = 0; for (let i = 0; i < e.buf.length; i++) { const v = (e.buf[i] - 128) / 128; s += v * v; }
      const rms = Math.sqrt(s / e.buf.length);
      if (rms > 0.04) { e.hits++; e.off = 0; if (!e.on && e.hits >= 2) { e.on = true; this.cb(id, true); } } else { e.hits = 0; e.off++; if (e.on && e.off >= 5) { e.on = false; this.cb(id, false); } }
    });
  }
  stop() { clearInterval(this.timer); this.timer = 0; [...this.m.keys()].forEach((k) => this.remove(k)); if (this.ac) this.ac.close().catch(() => {}); this.ac = null; }
}

// ---------- sesi panggilan ----------
export class CallSession extends Emitter {
  constructor({ callId = null, kind, scope, convId, ctx, me, max = 2, ringSecs = 45 }) {
    super(); Object.assign(this, { callId, kind, scope, convId, ctx, me, max, ringSecs });
    this.status = 'preparing'; this.endInfo = null; this.connectedAt = null; this.roster = new Map(); this.pending = [];
    this.local = { stream: new MediaStream(), audio: null, video: null }; this.micOn = true; this.camOn = false; this.facing = 'user'; this.canSwitch = false; this.camNote = '';
    this.outQ = []; this.outTimer = 0; this.timers = {}; this.pendingProfiles = new Set(); this.wake = null;
    this.speak = new Speak((id, on) => { const r = id === 'me' ? this.roster.get(this.me) : this.roster.get(id); if (r && r.speaking !== on) { r.speaking = on; this._notify(); } });
    this.tr = new MeshTransport({
      kind, send: (m) => this._send(m), getLocal: () => this.local,
      onStream: (uid, s) => this._stream(uid, s), onPeerState: (uid, st) => this._conn(uid, st),
    });
    this.roster.set(me, this._row(me)); this._row_me();
  }
  _row(id) { return { id, db: 'invited', joinedAt: 0, conn: 'idle', mic: true, cam: false, speaking: false, stream: null, name: '', avatar: null }; }
  _row_me() { const r = this.roster.get(this.me); const p = cachedMe() || {}; r.name = 'Kamu'; r.avatar = p.avatar_url || null; r.db = 'joined'; r.conn = 'connected'; }
  _notify() { if (this._nt) return; this._nt = setTimeout(() => { this._nt = 0; this.emit('roster', this.view()); }, 40); }
  view() { const me = this.roster.get(this.me); me.mic = this.micOn; me.cam = this.camOn; return [me, ...[...this.roster.values()].filter((r) => r.id !== this.me).sort((a, b) => (a.joinedAt || 9e15) - (b.joinedAt || 9e15))]; }
  setStatus(s, extra) { if (this.status === s && !extra) return; this.status = s; this.emit('status', { status: s, ...extra }); this._notify(); }

  // 1) izin & media lokal. Dipanggil langsung dari klik pengguna.
  async acquire() {
    this.speak._ctx();
    let s;
    if (this.kind === 'video') {
      try { s = await gum({ audio: AUDIO_C, video: videoC(this.facing, this.scope === 'group') }); }
      catch (e) {
        if (e.name === 'InsecureContext') throw e;
        s = await gum({ audio: AUDIO_C });                                          // mikrofon tetap jalan walau kamera gagal
        this.camNote = 'Kamera tidak tersedia: ' + mediaErrMsg(e) + ' Panggilan lanjut tanpa video.';
      }
    } else s = await gum({ audio: AUDIO_C });
    this.local.audio = s.getAudioTracks()[0] || null; this.local.video = s.getVideoTracks()[0] || null;
    s.getTracks().forEach((t) => this.local.stream.addTrack(t));
    this.camOn = !!this.local.video; this.speak.add('me', this.local.stream);
    this._devices(); if (navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', this._dc = () => this._devices());
    this.emit('local', this.local);
  }
  async _devices() { try { const d = await navigator.mediaDevices.enumerateDevices(); this.canSwitch = this.kind === 'video' && d.filter((x) => x.kind === 'videoinput').length > 1; this.emit('local', this.local); } catch { /* abaikan */ } }

  // 2) hubungkan signaling + roster setelah callId & status "joined" saya ada di database
  async run(joinedList = []) {
    this.setStatus(this.scope === 'direct' && this.creator ? 'ringing' : 'connecting');
    await this._channels();
    await this.syncRoster();
    this._hb();
    this.timers.sync = setInterval(() => this.syncRoster().catch(() => {}), 8000);
    this.timers.hb = setInterval(() => this._hb(), 20000);
    const left = this.ringSecs * 1000;
    if (this.creator) this.timers.ring = setTimeout(() => { if (![...this.roster.values()].some((r) => r.id !== this.me && r.db === 'joined')) this.finish('timeout', { text: this.scope === 'direct' ? 'Tidak dijawab' : 'Belum ada yang bergabung' }); }, left);
    this._wakeLock(); addEventListener('pagehide', this._ph = () => this._beacon()); addEventListener('beforeunload', this._bu = (e) => { e.preventDefault(); e.returnValue = ''; });
    document.addEventListener('visibilitychange', this._vc = () => { if (!document.hidden) { this._wakeLock(); this._hb(); this.syncRoster().catch(() => {}); this.speak._ctx(); } });
    window.__orvixCall = this;
  }
  async _channels() {
    const { data } = await sb.auth.getSession(); const tok = data.session && data.session.access_token;
    try { sb.realtime.setAuth(tok); } catch { /* abaikan */ }
    this.ch = sb.channel('call:' + this.callId, { config: { private: true, broadcast: { self: false, ack: false } } });
    this.ch.on('broadcast', { event: 'sig' }, ({ payload }) => this._recv(payload));
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('Signaling tidak tersambung. Periksa internet atau pengaturan Realtime Authorization.')), 10000);
      this.ch.subscribe((st, err) => {
        if (st === 'SUBSCRIBED') { clearTimeout(to); res(); }
        else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') { clearTimeout(to); rej(new Error('Signaling ditolak: ' + ((err && err.message) || 'pastikan sql-parts/14a dijalankan dan Realtime Authorization aktif.'))); }
      });
    });
    this.rowCh = sb.channel('callrow:' + this.callId + ':' + this.me)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_participants', filter: 'call_id=eq.' + this.callId }, () => this.syncRoster().catch(() => {}))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls', filter: 'id=eq.' + this.callId }, ({ new: n }) => { if (n && n.status === 'ended') this._remoteEnd(n.end_reason); })
      .subscribe();
  }
  async syncRoster() {
    if (this.status === 'ended') return;
    const { data, error } = await sb.from('call_participants').select('user_id,state,joined_at').eq('call_id', this.callId);
    if (error) throw error;
    const mine = data.find((x) => x.user_id === this.me);
    if (mine) { const r0 = this.roster.get(this.me); r0.db = mine.state; if (mine.joined_at) r0.joinedAt = new Date(mine.joined_at).getTime(); if (mine.state !== 'joined') { this._remoteEnd('left'); return; } }
    for (const row of data) {
      let r = this.roster.get(row.user_id);
      if (!r) { r = this._row(row.user_id); this.roster.set(row.user_id, r); this.pendingProfiles.add(row.user_id); }
      const ja = row.joined_at ? new Date(row.joined_at).getTime() : 0; const was = r.db, wasJa = r.joinedAt;
      if (row.user_id === this.me) continue;
      r.db = row.state; r.joinedAt = ja;
      if (row.state === 'joined') {
        if (was !== 'joined' || wasJa !== ja) { this.tr.dropPeer(row.user_id); r.conn = 'connecting'; }
        if (!this.tr.has(row.user_id) && this._iInitiate(r)) this.tr.connect(row.user_id);
        else if (!this.tr.has(row.user_id) && r.conn === 'idle') r.conn = 'connecting';
      } else { this.tr.dropPeer(row.user_id); this.speak.remove(row.user_id); r.stream = null; r.conn = row.state === 'invited' ? 'idle' : 'left'; }
    }
    this.pendingProfiles.size && this._profiles();
    this._flushPending(); this._recompute(); this._notify();
    this.tr.applyBitrate();
    // direct: lawan keluar -> selesai
    if (this.scope === 'direct') { const o = [...this.roster.values()].find((r) => r.id !== this.me); if (o && ['left', 'declined', 'missed'].includes(o.db)) this._remoteEnd(o.db === 'declined' ? 'declined' : o.db === 'missed' ? 'missed' : 'completed'); }
  }
  _iInitiate(r) { const m = this.roster.get(this.me); return m.joinedAt > r.joinedAt || (m.joinedAt === r.joinedAt && this.me > r.id); }
  async _profiles() {
    const ids = [...this.pendingProfiles]; this.pendingProfiles.clear();
    try { const m = await fetchProfiles(ids); m.forEach((p, id) => { const r = this.roster.get(id); if (r) { r.name = p.display_name || p.username || 'Pengguna'; r.avatar = p.avatar_url || null; } }); this._notify(); } catch { /* nama tetap kosong */ }
  }
  _conn(uid, st) {
    const r = this.roster.get(uid); if (!r) return; r.conn = st; this._recompute(); this._notify();
    if (st === 'connected') { this._sendState(uid); this.tr.applyBitrate(); }
  }
  _stream(uid, s) { const r = this.roster.get(uid); if (!r) return; r.stream = s; if (s) this.speak.add(uid, s); else this.speak.remove(uid); this.emit('stream', { id: uid, stream: s }); this._notify(); }
  _recompute() {
    if (this.status === 'ended' || this.status === 'preparing') return;
    const others = [...this.roster.values()].filter((r) => r.id !== this.me && r.db === 'joined');
    if (!others.length) return this.setStatus(this.scope === 'group' ? 'waiting' : this.creator ? 'ringing' : 'connecting');
    if (others.some((r) => r.conn === 'connected')) { if (!this.connectedAt) this.connectedAt = Date.now(); return this.setStatus('connected'); }
    if (others.every((r) => r.conn === 'failed')) return this.setStatus('failed');
    if (this.connectedAt || others.some((r) => r.conn === 'reconnecting')) return this.setStatus('reconnecting');
    this.setStatus('connecting');
  }

  // ---------- signaling ----------
  _send(m) {
    if (this.status === 'ended' && m.t !== 'bye') return;
    this.outQ.push({ ...m, cid: this.callId, from: this.me }); this._pump();
  }
  _pump() {
    if (this.outTimer || !this.outQ.length) return;
    const go = () => { const m = this.outQ.shift(); if (m && this.ch) this.ch.send({ type: 'broadcast', event: 'sig', payload: m }).catch(() => {}); this.outTimer = 0; if (this.outQ.length) { this.outTimer = setTimeout(go, 115); } };
    this.outTimer = setTimeout(go, 0);                                             // <= ~8 pesan/detik, di bawah eventsPerSecond=10
  }
  _recv(m) {
    if (!m || typeof m !== 'object' || m.cid !== this.callId || typeof m.from !== 'string' || m.from === this.me) return;
    if (m.to !== this.me && m.to !== '*') return;
    if (!['offer', 'answer', 'cand', 'rtr', 'st', 'bye'].includes(m.t)) return;
    const r = this.roster.get(m.from);
    if (!r || r.db !== 'joined') { if (this.pending.length < 40) this.pending.push({ m, at: Date.now() }); this._syncSoon(); return; }   // pengirim belum terlihat joined: tahan sebentar
    this._dispatch(m, r);
  }
  _syncSoon() { if (this._ss) return; this._ss = setTimeout(() => { this._ss = 0; this.syncRoster().catch(() => {}); }, 150); }
  _flushPending() { const q = this.pending.splice(0); q.forEach(({ m, at }) => { const r = this.roster.get(m.from); if (Date.now() - at > 8000) return; if (r && r.db === 'joined') this._dispatch(m, r); else this.pending.push({ m, at }); }); }
  _dispatch(m, r) {
    if (m.t === 'st') { r.mic = m.mic !== false; r.cam = !!m.cam; this._notify(); return; }
    if (m.t === 'bye') { this.tr.dropPeer(m.from); return; }
    if (m.t === 'rtr' && !this._iInitiate(r)) return;
    this.tr.handle(m);
  }
  _sendState(to = '*') { this._send({ t: 'st', to, mic: this.micOn, cam: this.camOn }); }

  // ---------- kontrol ----------
  toggleMic() { if (!this.local.audio) return; this.micOn = !this.micOn; this.local.audio.enabled = this.micOn; this._sendState(); this._notify(); return this.micOn; }
  async toggleCam() {
    if (this.kind !== 'video') return false;
    if (this.camOn) { const t = this.local.video; this.camOn = false; this.local.video = null; await this.tr.setTrack('video', null); if (t) { this.local.stream.removeTrack(t); t.stop(); } }
    else {
      try { const s = await gum({ video: videoC(this.facing, this.scope === 'group') }); await this._setVideo(s.getVideoTracks()[0]); this.camNote = ''; }
      catch (e) { this.camNote = mediaErrMsg(e); this.emit('error', this.camNote); return false; }
    }
    this._sendState(); this._notify(); this.emit('local', this.local); return this.camOn;
  }
  async _setVideo(t) { const old = this.local.video; this.local.video = t; if (old) { this.local.stream.removeTrack(old); old.stop(); } this.local.stream.addTrack(t); this.camOn = true; await this.tr.setTrack('video', t); this.tr.applyBitrate(); }
  async switchCam() {
    if (!this.camOn) return;
    const next = this.facing === 'user' ? 'environment' : 'user'; const old = this.local.video; if (old) old.stop();    // lepas kamera lama dulu (beberapa HP hanya mengizinkan satu)
    try { const s = await gum({ video: videoC(next, this.scope === 'group') }); this.facing = next; await this._setVideo(s.getVideoTracks()[0]); }
    catch (e) { try { const s = await gum({ video: videoC(this.facing, this.scope === 'group') }); await this._setVideo(s.getVideoTracks()[0]); } catch { this.camOn = false; } this.emit('error', 'Tidak bisa mengganti kamera.'); }
    this.emit('local', this.local); this._notify();
  }
  retryPeer(uid) { const r = this.roster.get(uid); if (r) { r.conn = 'connecting'; this._notify(); } this.tr.retry(uid); }
  retryAll() { this.roster.forEach((r) => { if (r.id !== this.me && r.db === 'joined' && r.conn === 'failed') this.retryPeer(r.id); }); }
  stats() { return this.tr.stats(); }

  // ---------- siklus hidup ----------
  async _hb() { try { const { data } = await sb.rpc('call_heartbeat', { cid: this.callId }); if (data === false && this.status !== 'ended' && this.status !== 'preparing') this._remoteEnd('left'); } catch { /* jaringan putus: coba lagi pada siklus berikut */ } }
  async _wakeLock() { try { if (navigator.wakeLock && !this.wake && !document.hidden) { this.wake = await navigator.wakeLock.request('screen'); this.wake.addEventListener('release', () => { this.wake = null; }); } } catch { /* tidak didukung */ } }
  _remoteEnd(reason) {
    const t = { declined: 'Panggilan ditolak', missed: 'Tidak dijawab', cancelled: 'Panggilan dibatalkan', timeout: 'Tidak dijawab', completed: 'Panggilan berakhir', empty: 'Panggilan berakhir', failed: 'Panggilan gagal', left: 'Kamu terputus dari panggilan' }[reason] || 'Panggilan berakhir';
    this.finish(reason || 'completed', { text: t, remote: true });
  }
  _beacon() { try { fetch(SUPABASE_URL + '/rest/v1/rpc/call_leave', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + (window.__orvixTok || SUPABASE_ANON_KEY) }, body: JSON.stringify({ cid: this.callId, reason: 'completed' }) }); } catch { /* abaikan */ } }
  async finish(reason = 'completed', info = {}) {
    if (this.status === 'ended') return; const prev = this.status;
    this.status = 'ended'; this.endInfo = { reason, text: info.text || 'Panggilan berakhir', failed: reason === 'failed', prev };
    Object.values(this.timers).forEach((t) => { clearTimeout(t); clearInterval(t); }); clearTimeout(this.outTimer);
    removeEventListener('pagehide', this._ph); removeEventListener('beforeunload', this._bu); document.removeEventListener('visibilitychange', this._vc);
    if (navigator.mediaDevices && navigator.mediaDevices.removeEventListener && this._dc) navigator.mediaDevices.removeEventListener('devicechange', this._dc);
    if (!info.remote && this.callId) { try { this.ch && this.ch.send({ type: 'broadcast', event: 'sig', payload: { t: 'bye', to: '*', cid: this.callId, from: this.me } }); } catch { /* abaikan */ } }
    this.tr.closeAll(); this.speak.stop();
    this.local.stream.getTracks().forEach((t) => t.stop()); try { this.wake && this.wake.release(); } catch { /* abaikan */ }
    if (this.callId && !info.remote) { try { await withTimeout(sb.rpc('call_leave', { cid: this.callId, reason: ['completed', 'cancelled', 'failed', 'timeout'].includes(reason) ? reason : 'completed' }), 3500); } catch { /* server akan membersihkan lewat heartbeat basi */ } }
    for (const c of [this.ch, this.rowCh]) if (c) { try { await sb.removeChannel(c); } catch { /* abaikan */ } }
    if (window.__orvixCall === this) window.__orvixCall = null;
    this.emit('status', { status: 'ended', ...this.endInfo }); this.emit('ended', this.endInfo);
    if (active === this) { active = null; bus.emit('session-end', this); refreshOpen(); }
  }
  hangup() { return this.finish(this.status === 'ringing' && this.creator ? 'cancelled' : 'completed', { text: 'Panggilan berakhir' }); }
}

// ---------- manajer global ----------
let active = null, me = null, available = true, limits = { max_group_voice: 8, max_group_video: 4, ring_timeout_secs: 45, allow_late_join: true };
export const activeSession = () => active;
export const callsAvailable = () => available;
export const getLimits = () => limits;
export const maxFor = (scope, kind) => (scope === 'direct' ? 2 : kind === 'video' ? limits.max_group_video : limits.max_group_voice);
let uiP = null; export const ensureUI = () => (uiP ||= import('./calls-ui.js'));
const openMap = new Map(); export const openCalls = () => openMap;

async function begin(session, fn) {
  if (active) throw Object.assign(new Error('Kamu masih dalam panggilan lain'), { code: 'BUSY_SELF' });
  active = session; await ensureUI(); bus.emit('session', session);
  try { await session.acquire(); await fn(); }
  catch (e) { const msg = e.name ? mediaErrMsg(e) : rpcErr(e).text; await session.finish('failed', { text: msg, remote: !session.callId }); active = null; e.shown = true; if (!e.code) e.code = rpcErr(e).code; throw e; }
}
async function token() { const { data } = await sb.auth.getSession(); window.__orvixTok = data.session && data.session.access_token; if (!me && data.session) me = data.session.user.id; }

export async function startCall(convId, kind, ctx = {}) {
  if (!available) throw new Error('Fitur panggilan belum aktif di database.');
  await token();
  const s = new CallSession({ kind, scope: ctx.isGroup ? 'group' : 'direct', convId, ctx, me, max: maxFor(ctx.isGroup ? 'group' : 'direct', kind), ringSecs: limits.ring_timeout_secs });
  s.creator = true;
  await begin(s, async () => {
    s.setStatus('preparing');
    const { data, error } = await sb.rpc('call_start', { conv: convId, k: kind });
    if (error) throw error;
    s.callId = data.call_id;
    if (data.existing) { const j = await sb.rpc('call_join', { cid: data.call_id }); if (j.error) throw j.error; s.creator = false; s.max = j.data.max; }
    s.likelyOnline = data.likely_online;
    await s.run();
  });
  return s;
}
export async function joinCall(info) {            // info: {callId, convId, kind, scope, ctx}
  await token();
  const s = new CallSession({ callId: info.callId, kind: info.kind, scope: info.scope, convId: info.convId, ctx: info.ctx || {}, me, max: maxFor(info.scope, info.kind), ringSecs: limits.ring_timeout_secs });
  s.creator = false;
  await begin(s, async () => {
    const { data, error } = await sb.rpc('call_join', { cid: info.callId }); if (error) throw error;
    s.max = data.max; await s.run(data.joined);
  });
  incoming.delete(info.callId); bus.emit('incoming-gone', info.callId);
  return s;
}
export async function declineCall(info) { incoming.delete(info.callId); bus.emit('incoming-gone', info.callId); try { await sb.rpc('call_decline', { cid: info.callId }); } catch { /* abaikan */ } }

// ---- panggilan masuk ----
const incoming = new Map();
async function describe(callId, row) {
  const { data: c } = await sb.from('calls').select('id,conversation_id,kind,scope,created_by,status,created_at').eq('id', callId).maybeSingle();
  if (!c || c.status === 'ended') return null;
  const { data: cv } = await sb.from('conversations').select('type,title').eq('id', c.conversation_id).maybeSingle();
  let p = null; try { p = (await fetchProfiles([c.created_by])).get(c.created_by); } catch { /* abaikan */ }
  const grp = c.scope === 'group';
  return { callId, convId: c.conversation_id, kind: c.kind, scope: c.scope, creatorId: c.created_by, createdAt: new Date(c.created_at).getTime(), name: grp ? (cv && cv.title) || 'Grup' : (p && p.display_name) || 'Pengguna', by: p && p.display_name, avatar: p && p.avatar_url, ctx: { isGroup: grp, title: grp ? (cv && cv.title) || 'Grup' : (p && p.display_name) || 'Pengguna', avatar: p && p.avatar_url, otherId: grp ? null : c.created_by }, rejoin: !!(row && row.my_state === 'joined') };
}
async function onInvite(callId) {
  if (incoming.has(callId) || (active && active.callId === callId)) return;
  const info = await describe(callId); if (!info) return;
  if (info.createdAt < Date.now() - limits.ring_timeout_secs * 1000) return;
  if (active) { try { await sb.rpc('call_decline', { cid: callId }); } catch { /* abaikan */ } bus.emit('toast', `Panggilan dari ${info.by || info.name} terlewat karena kamu sedang menelepon.`); return; }
  incoming.set(callId, info); await ensureUI(); bus.emit('incoming', info);
  setTimeout(() => { if (incoming.has(callId)) { incoming.delete(callId); bus.emit('incoming-gone', callId); } }, limits.ring_timeout_secs * 1000);
}
export async function refreshOpen() {
  if (!available) return;
  try {
    const { data, error } = await sb.rpc('call_open_for_me'); if (error) throw error;
    openMap.clear(); (data || []).forEach((r) => openMap.set(r.conversation_id, r));
    bus.emit('open', openMap);
    for (const r of data || []) if (r.my_state === 'invited' && r.status === 'ringing') onInvite(r.call_id);
  } catch (e) { if (rpcErr(e).code === 'NOSQL') { available = false; bus.emit('open', openMap); } }
}

let inited = false;
export async function initCalls(user) {
  if (inited) return; inited = true; me = user.id;
  try { const { data, error } = await sb.rpc('call_limits'); if (error) throw error; limits = { ...limits, ...data }; }
  catch (e) { if (rpcErr(e).code === 'NOSQL') { available = false; return; } }
  await ensureUI();
  await refreshOpen();
  sb.channel('calls-in-' + me)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_participants', filter: 'user_id=eq.' + me }, ({ new: n }) => { if (n.state === 'invited') onInvite(n.call_id); refreshOpen(); })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'call_participants', filter: 'user_id=eq.' + me }, ({ new: n }) => { if (n.state === 'missed') missed([n.call_id]); if (n.state !== 'invited') { incoming.delete(n.call_id); bus.emit('incoming-gone', n.call_id); } refreshOpen(); })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls' }, ({ new: n }) => { if (n.status === 'ended') { incoming.delete(n.id); bus.emit('incoming-gone', n.id); } refreshOpen(); })
    .subscribe();
  setInterval(() => { if (!document.hidden) refreshOpen(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshOpen(); });
  sb.auth.onAuthStateChange((_e, s) => { window.__orvixTok = s && s.access_token; });
  token(); checkMissedSinceLast();
}
async function missed(ids) {
  for (const id of ids) {
    try { const i = await describe0(id); bus.emit('toast', `Panggilan ${i.kind === 'video' ? 'video' : 'suara'} tidak terjawab dari ${i.name}`); } catch { /* abaikan */ }
  }
}
async function describe0(callId) {
  const { data: c } = await sb.from('calls').select('kind,scope,created_by,conversation_id').eq('id', callId).maybeSingle(); if (!c) throw new Error('x');
  let name = 'seseorang'; try { name = ((await fetchProfiles([c.created_by])).get(c.created_by) || {}).display_name || name; } catch { /* abaikan */ }
  if (c.scope === 'group') { const { data: cv } = await sb.from('conversations').select('title').eq('id', c.conversation_id).maybeSingle(); name = (cv && cv.title) || 'grup'; }
  return { kind: c.kind, name };
}
async function checkMissedSinceLast() {
  const K = 'orvix:calls:seen'; let last = 0; try { last = +localStorage.getItem(K) || 0; } catch { /* abaikan */ }
  try {
    const { data } = await sb.rpc('call_history', { lim: 20 }); if (!data) return;
    const miss = data.filter((r) => r.my_state === 'missed' && new Date(r.created_at).getTime() > last && r.created_by !== me);
    if (miss.length && last) bus.emit('toast', miss.length === 1 ? 'Ada 1 panggilan tidak terjawab. Lihat di tab Panggilan.' : `Ada ${miss.length} panggilan tidak terjawab. Lihat di tab Panggilan.`);
  } catch { /* abaikan */ }
  try { localStorage.setItem(K, String(Date.now())); } catch { /* abaikan */ }
}

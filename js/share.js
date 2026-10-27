// Bagikan link grup/saluran. Domain mengikuti situs yang sedang dibuka (location.origin).
import { sb, errMsg } from './supabase.js';
import { openModal, esc, icon, copyText, toast } from './utils.js';
export const inviteUrl = (code) => `${location.origin}/join/${code}`;
export async function shareInvite(conv, title, kind = 'grup') {
  const { data: code, error } = await sb.rpc('get_invite_code', { conv }); if (error) return toast(errMsg(error), 'error');
  const url = inviteUrl(code);
  const m = openModal({ title: `Bagikan ${kind}`, html: `<p class="muted">Siapa pun yang membuka link ini bisa bergabung ke <b>${esc(title)}</b>.</p><input class="inp" id="lk" readonly value="${esc(url)}" style="margin:12px 0" aria-label="Link undangan"><div class="col"><button class="btn primary" id="cp">${icon('copy')} Salin link</button>${navigator.share ? `<button class="btn" id="sh">${icon('share')} Bagikan lewat…</button>` : ''}</div>` });
  m.el.querySelector('#lk').onfocus = (e) => e.target.select();
  m.el.querySelector('#cp').onclick = () => copyText(url);
  const sh = m.el.querySelector('#sh'); if (sh) sh.onclick = () => navigator.share({ title: `${title} di ORVIX`, text: `Gabung ${kind} "${title}" di ORVIX`, url }).catch(() => {});
}

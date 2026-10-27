// Animasi halaman awal ORVIX: ketik tagline, kata berputar, dan demo chat mini. Tanpa dependensi.
const calm = matchMedia('(prefers-reduced-motion:reduce)').matches;
const $ = (s) => document.querySelector(s), wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) tagline diketik huruf demi huruf
const tagT = $('#tagT'), full = tagT.textContent;
if (!calm) { tagT.textContent = ''; (async () => { await wait(1100); for (const ch of full) { tagT.textContent += ch; await wait(38); } $('.cur').classList.add('idle'); })(); }

// 2) kata berputar: "Ngobrol dengan ___"
const words = ['teman', 'keluarga', 'komunitas', 'teman sekelas', 'siapa saja'], rw = $('#rw');
if (!calm) { let i = 0; setInterval(() => { rw.classList.add('out'); setTimeout(() => { i = (i + 1) % words.length; rw.textContent = words[i]; rw.classList.remove('out'); rw.classList.add('in'); setTimeout(() => rw.classList.remove('in'), 320); }, 280); }, 2300); }

// 3) demo chat mini (berulang): kirim, centang biru, foto, pesan dihapus
const box = $('#demoB');
const bub = (cls, html) => { const d = document.createElement('div'); d.className = 'db ' + cls; d.innerHTML = html; box.append(d); requestAnimationFrame(() => d.classList.add('show')); box.scrollTop = box.scrollHeight; return d; };
const dots = () => bub('in typing', '<i></i><i></i><i></i>');
const tick = '<span class="dt">✓</span>';
async function demo() {
  for (;;) {
    box.innerHTML = '';
    let t = dots(); await wait(900); t.remove(); bub('in', 'Halo! Besok jadi kumpul? <small>16.40</small>'); await wait(1100);
    const o = bub('out', 'Jadi dong, jam 4 ya <small>16.41 <span class="dt">✓</span></small>'); await wait(700); o.querySelector('.dt').textContent = '✓✓'; await wait(500); o.querySelector('.dt').classList.add('rd'); await wait(900);
    bub('out img', '<span class="ph"></span><small>16.42 <span class="dt rd">✓✓</span></small>'); await wait(1300);
    const w = bub('out', 'Salah kirim, abaikan <small>16.43</small>'); await wait(1300);
    w.classList.add('gone'); w.innerHTML = '<span class="ban"></span> Kamu menghapus pesan ini'; await wait(2600);
    box.classList.add('fade'); await wait(500); box.classList.remove('fade');
  }
}
if (calm) { box.innerHTML = '<div class="db in show">Halo! Besok jadi kumpul?</div><div class="db out show">Jadi dong, jam 4 ya</div><div class="db out gone show"><span class="ban"></span> Kamu menghapus pesan ini</div>'; } else demo();

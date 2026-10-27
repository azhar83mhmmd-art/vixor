// Logika murni (tanpa Deno/jaringan) untuk menyusun payload notifikasi. Diuji terpisah dengan Node.
export type Prefs = { messages?: boolean; groups?: boolean; friends?: boolean; calls?: boolean; preview?: boolean };
export type Payload = { type: string; title: string; body: string; tag: string; url: string };
export const DEFAULTS: Required<Prefs> = { messages: true, groups: true, friends: true, calls: true, preview: true };
export const prefsOf = (p: Prefs | null | undefined): Required<Prefs> => ({ ...DEFAULTS, ...(p ?? {}) });

export const clip = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};
const safeId = (s: string) => String(s).replace(/[^0-9a-zA-Z-]/g, "").slice(0, 40);

export function messageBody(m: { content?: string | null; media_type?: string | null }, preview: boolean): string {
  if (!preview) return "Pesan baru";
  const text = clip(m.content, 110);
  if (text) return text;
  return m.media_type === "video" ? "Mengirim video" : m.media_type === "image" ? "Mengirim foto" : "Pesan baru";
}
export function buildMessage(o: { senderName: string; isGroup: boolean; groupTitle?: string | null; convId: string; m: { content?: string | null; media_type?: string | null }; preview: boolean }): Payload {
  const sender = clip(o.senderName || "Seseorang", 40), body = messageBody(o.m, o.preview);
  return {
    type: "message", tag: "msg-" + safeId(o.convId), url: "/chat?c=" + safeId(o.convId),
    title: o.isGroup ? clip(o.groupTitle || "Grup", 50) : sender,
    body: o.isGroup ? (o.preview ? `${sender}: ${body}` : `${sender} mengirim pesan`) : body,
  };
}
export const buildFriend = (name: string): Payload => ({ type: "friend", tag: "friend", url: "/chat?req=1", title: "Permintaan pertemanan", body: `${clip(name || "Seseorang", 40)} ingin berteman denganmu` });
export const buildCall = (o: { name: string; kind: string; isGroup: boolean; groupTitle?: string | null; callId: string; convId: string }): Payload => ({
  type: "call", tag: "call-" + safeId(o.callId), url: "/chat?c=" + safeId(o.convId),
  title: o.isGroup ? clip(o.groupTitle || "Grup", 50) : clip(o.name, 40),
  body: `${o.isGroup ? clip(o.name, 30) + " memanggil · " : "Panggilan "}${o.kind === "video" ? "video" : "suara"} masuk`,
});
export const buildTest = (): Payload => ({ type: "test", tag: "test", url: "/profile", title: "Notifikasi ORVIX aktif", body: "Notifikasi uji berhasil diterima di perangkat ini." });

export type Kind = "message" | "group" | "friend" | "call";
export const wants = (p: Prefs | null | undefined, k: Kind): boolean => { const x = prefsOf(p); return k === "message" ? x.messages : k === "group" ? x.groups : k === "friend" ? x.friends : x.calls; };
// Status HTTP dari push service yang berarti langganan sudah tidak berlaku (hapus dari database)
export const isGone = (status: number): boolean => status === 404 || status === 410;
export const WEBPUSH = { message: { TTL: 86400, urgency: "normal" }, friend: { TTL: 259200, urgency: "normal" }, call: { TTL: 30, urgency: "high" }, test: { TTL: 120, urgency: "high" } } as const;

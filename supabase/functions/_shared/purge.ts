// Menghapus semua berkas Storage milik seorang pengguna (folder <uid>/ di bucket avatars & stories).
// deno-lint-ignore no-explicit-any
export async function purgeUserFiles(admin: any, uid: string): Promise<void> {
  for (const bucket of ["avatars", "stories"]) {
    for (let i = 0; i < 10; i++) {
      const { data, error } = await admin.storage.from(bucket).list(uid, { limit: 1000 });
      if (error || !data?.length) break;
      await admin.storage.from(bucket).remove(data.map((f: { name: string }) => `${uid}/${f.name}`));
      if (data.length < 1000) break;
    }
  }
}

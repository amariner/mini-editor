import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ImageAttachment } from '../src/shared';
export interface PreparedImage {
  attachment: ImageAttachment;
  path: string;
  mediaType: string;
  data: string;
}
export function imageType(data: Buffer) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString())) return 'image/gif';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  throw new Error('Formato no compatible. Selecciona PNG, JPEG, GIF o WebP.');
}
export class Attachments {
  private removedSessions = new Set<string>();
  private used = new Set<string>();
  private files = new Map<
    string,
    { sessionId: string; path: string; mediaType: string; attachment: ImageAttachment }
  >();
  constructor(
    private root: string,
    private preview: (data: Buffer) => string,
  ) {}
  async add(sessionId: string, paths: string[]) {
    if (paths.length > 4) throw new Error('Puedes adjuntar hasta 4 imágenes por mensaje.');
    const images = [];
    for (const filename of paths) {
      const stat = await fs.stat(filename);
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024)
        throw new Error('Cada imagen debe ocupar como máximo 5 MB.');
      images.push({ name: path.basename(filename), data: await fs.readFile(filename) });
    }
    return this.save(sessionId, images);
  }
  async addData(sessionId: string, images: { name: string; data: string }[]) {
    if (!images.length || images.length > 4)
      throw new Error('Puedes adjuntar hasta 4 imágenes por mensaje.');
    const decoded = images.map((image) => {
      if (image.data.length > 6990508) throw new Error('Cada imagen debe ocupar como máximo 5 MB.');
      const data = Buffer.from(image.data, 'base64');
      if (data.toString('base64') !== image.data)
        throw new Error('Los datos de la imagen no son válidos.');
      return { name: path.basename(image.name), data };
    });
    return this.save(sessionId, decoded);
  }
  private async save(sessionId: string, images: { name: string; data: Buffer }[]) {
    if (this.removedSessions.has(sessionId)) throw new Error('Este chat se ha eliminado.');
    const prepared = images.map(({ name, data }) => {
      if (data.length > 5 * 1024 * 1024)
        throw new Error('Cada imagen debe ocupar como máximo 5 MB.');
      const mediaType = imageType(data),
        id = randomUUID();
      return {
        sessionId,
        path: path.join(this.root, `${id}.${mediaType.split('/')[1]}`),
        mediaType,
        attachment: { id, name, preview: this.preview(data) },
        data,
      };
    });
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      for (const p of prepared) await fs.writeFile(p.path, p.data, { mode: 0o600 });
      if (this.removedSessions.has(sessionId)) throw new Error('Este chat se ha eliminado.');
    } catch (error) {
      await Promise.allSettled(prepared.map((p) => fs.rm(p.path, { force: true })));
      throw error;
    }
    for (const p of prepared) {
      const { data: _data, ...entry } = p;
      this.files.set(p.attachment.id, entry);
    }
    return prepared.map((p) => p.attachment);
  }
  markUsed(ids: string[]) {
    for (const id of ids) this.used.add(id);
  }
  async removeSessions(
    sessions: { id: string; messages: { attachments?: ImageAttachment[] }[] }[],
  ) {
    const owners = new Set(sessions.map((s) => s.id));
    for (const id of owners) this.removedSessions.add(id);
    const ids = new Set(
      sessions.flatMap((s) => s.messages.flatMap((m) => m.attachments?.map((a) => a.id) ?? [])),
    );
    for (const [id, entry] of this.files) if (owners.has(entry.sessionId)) ids.add(id);
    for (const id of ids) {
      if (!/^[a-f0-9-]{36}$/i.test(id)) continue;
      for (const ext of ['png', 'jpeg', 'gif', 'webp'])
        await fs.rm(path.join(this.root, `${id}.${ext}`), { force: true });
      this.files.delete(id);
      this.used.delete(id);
    }
  }
  async discard(sessionId: string, ids: string[]) {
    for (const id of ids) {
      const entry = this.files.get(id);
      if (!entry || entry.sessionId !== sessionId)
        throw new Error('El adjunto no pertenece a este chat.');
      if (!this.used.has(id)) await fs.rm(entry.path, { force: true });
      this.files.delete(id);
    }
  }
  async cleanup() {
    for (const [id, entry] of this.files)
      if (!this.used.has(id)) await fs.rm(entry.path, { force: true });
    this.files.clear();
  }
  async resolve(sessionId: string, ids: string[]): Promise<PreparedImage[]> {
    if (ids.length > 4 || new Set(ids).size !== ids.length) throw new Error('Adjuntos no válidos.');
    return Promise.all(
      ids.map(async (id) => {
        const f = this.files.get(id);
        if (!f || f.sessionId !== sessionId)
          throw new Error('La imagen no pertenece a este chat. Vuelve a adjuntarla.');
        const data = await fs.readFile(f.path);
        if (data.length > 5 * 1024 * 1024 || imageType(data) !== f.mediaType)
          throw new Error('La imagen ha cambiado. Vuelve a adjuntarla.');
        return {
          attachment: f.attachment,
          path: f.path,
          mediaType: f.mediaType,
          data: data.toString('base64'),
        };
      }),
    );
  }
}
export const claudeImageContent = (text: string, images: PreparedImage[]) => [
  ...(text ? [{ type: 'text', text }] : []),
  ...images.map((i) => ({
    type: 'image',
    source: { type: 'base64', media_type: i.mediaType, data: i.data },
  })),
];
export const codexImageContent = (text: string, images: PreparedImage[]) => [
  ...(text ? [{ type: 'text', text, text_elements: [] }] : []),
  ...images.map((i) => ({ type: 'localImage', path: i.path })),
];

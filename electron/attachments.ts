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
    const prepared = [];
    for (const filename of paths) {
      const stat = await fs.stat(filename);
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024)
        throw new Error('Cada imagen debe ocupar como máximo 5 MB.');
      const data = await fs.readFile(filename);
      if (data.length > 5 * 1024 * 1024) throw new Error('La imagen supera 5 MB.');
      const mediaType = imageType(data),
        id = randomUUID();
      const attachment = { id, name: path.basename(filename), preview: this.preview(data) };
      prepared.push({
        sessionId,
        path: path.join(this.root, `${id}.${mediaType.split('/')[1]}`),
        mediaType,
        attachment,
        data,
      });
    }
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const p of prepared) {
      await fs.writeFile(p.path, p.data, { mode: 0o600 });
      const { data: _data, ...entry } = p;
      this.files.set(p.attachment.id, entry);
    }
    return prepared.map((p) => p.attachment);
  }
  markUsed(ids: string[]) {
    for (const id of ids) this.used.add(id);
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

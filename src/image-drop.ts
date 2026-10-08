export async function readDroppedImages(files: File[]) {
  if (!files.length || files.length > 4)
    throw new Error('Puedes adjuntar hasta 4 imágenes por mensaje.');
  for (const file of files) {
    if (file.size > 5 * 1024 * 1024) throw new Error('Cada imagen debe ocupar como máximo 5 MB.');
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', ''].includes(file.type))
      throw new Error('Formato no compatible. Usa PNG, JPEG, GIF o WebP.');
  }
  return Promise.all(
    files.map(
      (file) =>
        new Promise<{ name: string; data: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error(`No se pudo leer ${file.name}.`));
          reader.onload = () =>
            resolve({ name: file.name, data: String(reader.result).split(',')[1] });
          reader.readAsDataURL(file);
        }),
    ),
  );
}

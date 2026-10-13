export async function readDroppedFiles(files: File[]) {
  if (!files.length) throw new Error('Selecciona al menos un archivo.');
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

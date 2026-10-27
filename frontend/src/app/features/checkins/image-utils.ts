import type { ImageUpload } from './checkin.service';

const MAX_SIDE = 1280;
const JPEG_QUALITY = 0.7;

function stripPrefix(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

/** Canvas content as PNG base64 (signature). */
export function canvasToPng(canvas: HTMLCanvasElement): ImageUpload {
  return { mime: 'image/png', base64: stripPrefix(canvas.toDataURL('image/png')) };
}

/** Compresses a photo on the client: max 1280 px on the longest side, JPEG 0.7. */
export async function compressPhoto(file: File): Promise<ImageUpload> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('Canvas no disponible');
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { mime: 'image/jpeg', base64: stripPrefix(canvas.toDataURL('image/jpeg', JPEG_QUALITY)) };
}

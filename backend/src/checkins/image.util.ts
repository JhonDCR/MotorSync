export const IMAGE_MIMES = ['image/jpeg', 'image/png'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

/** US1-AC4: 1 MB decoded per image (also enforced by a CHECK on checkin_images.data). */
export const MAX_IMAGE_BYTES = 1_048_576;

const MAGIC: Record<ImageMime, Buffer> = {
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};

export interface DecodedImage {
  mime: ImageMime;
  data: Buffer;
}

export class InvalidImageError extends Error {}

/** Decodes a base64 upload and checks size and magic bytes against the declared mime. */
export function decodeImage(upload: { mime: string; base64: string }): DecodedImage {
  const mime = IMAGE_MIMES.find((m) => m === upload.mime);
  if (!mime) throw new InvalidImageError('Tipo de imagen no permitido');
  const data = Buffer.from(upload.base64, 'base64');
  if (data.length > MAX_IMAGE_BYTES) throw new InvalidImageError('La imagen supera 1 MB');
  const magic = MAGIC[mime];
  if (data.length < magic.length || !data.subarray(0, magic.length).equals(magic)) {
    throw new InvalidImageError('La imagen no es JPEG ni PNG válida');
  }
  return { mime, data };
}

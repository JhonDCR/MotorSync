// T004: decodeImage (US1-AC4). Contract: decodeImage({ mime, base64 }) returns { mime, data: Buffer }
// or throws when the bytes are not the declared JPEG/PNG or exceed MAX_IMAGE_BYTES.
import { decodeImage, MAX_IMAGE_BYTES } from './image.util.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('decodeImage (T004)', () => {
  it('[US1-AC4] decodifica un JPEG por magic bytes FFD8FF', () => {
    const out = decodeImage({ mime: 'image/jpeg', base64: JPEG.toString('base64') });
    expect(out.mime).toBe('image/jpeg');
    expect(Buffer.compare(out.data, JPEG)).toBe(0);
  });

  it('[US1-AC4] decodifica un PNG por magic bytes 89504E47', () => {
    const out = decodeImage({ mime: 'image/png', base64: PNG.toString('base64') });
    expect(Buffer.compare(out.data, PNG)).toBe(0);
  });

  it('[US1-AC4] rechaza bytes que no son JPEG ni PNG', () => {
    const gif = Buffer.from('GIF89a').toString('base64');
    expect(() => decodeImage({ mime: 'image/jpeg', base64: gif })).toThrow();
  });

  it('[US1-AC4] rechaza bytes que no coinciden con el mime declarado', () => {
    expect(() => decodeImage({ mime: 'image/png', base64: JPEG.toString('base64') })).toThrow();
  });

  it('[US1-AC4] acepta 1 048 576 bytes y rechaza uno más', () => {
    expect(MAX_IMAGE_BYTES).toBe(1_048_576);
    const ok = Buffer.alloc(MAX_IMAGE_BYTES);
    JPEG.copy(ok);
    expect(() => decodeImage({ mime: 'image/jpeg', base64: ok.toString('base64') })).not.toThrow();
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    JPEG.copy(big);
    expect(() => decodeImage({ mime: 'image/jpeg', base64: big.toString('base64') })).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { detectMimeType, extensionFor } from './magic-number.js';

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBP_HEADER = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
]);

describe('detectMimeType', () => {
  it('detects PNG by magic number', () => {
    expect(detectMimeType(PNG_HEADER)).toBe('image/png');
  });

  it('detects JPEG by magic number', () => {
    expect(detectMimeType(JPEG_HEADER)).toBe('image/jpeg');
  });

  it('detects WebP by magic number', () => {
    expect(detectMimeType(WEBP_HEADER)).toBe('image/webp');
  });

  it('returns null for unknown types', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
    expect(detectMimeType(gif)).toBeNull();
  });

  it('returns null for buffers shorter than 12 bytes', () => {
    expect(detectMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('returns null for empty buffer', () => {
    expect(detectMimeType(new Uint8Array(0))).toBeNull();
  });
});

describe('extensionFor', () => {
  it('maps each mime to its extension', () => {
    expect(extensionFor('image/png')).toBe('png');
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('image/webp')).toBe('webp');
  });
});

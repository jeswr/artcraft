import { describe, expect, it } from 'vitest';
import * as pkg from '../index.js';
import { mintPodMediaAddress, unwrapPodMediaAddress, type PodMediaAddress } from './address.js';
import { asset } from './testing.js';

/** Stand-ins for hosted-only code: every hosted image URL, lightbox source and board item is a string today. */
function hostedImageUrl(_url: string): void {}
function hostedLightbox(_images: { url: string }[]): void {}
interface HostedRefImage {
  url: string;
  mediaToken: string;
}

describe('a pod media address', () => {
  it('is not a URL string: hosted-only code and plain image sources refuse it at compile time', () => {
    const address = mintPodMediaAddress('https://pod.example/lib/2026/06/b1.png');
    // @ts-expect-error not a string, so not a hosted image URL
    hostedImageUrl(address);
    // @ts-expect-error nor a lightbox image
    hostedLightbox([{ url: address }]);
    // @ts-expect-error nor a reference image's url
    const image: HostedRefImage = { url: address, mediaToken: 'x' };
    // @ts-expect-error nor an <img src>
    const props: { src: string } = { src: address };
    expect([image, props]).toHaveLength(2);
  });

  it('is not a pod asset reference and a reference is not an address', () => {
    const item = asset(1);
    // @ts-expect-error the two brands differ
    const wrong: PodMediaAddress = item.ref;
    expect(wrong).toBeDefined();
  });

  it('cannot be forged from a string or a plain object', () => {
    // @ts-expect-error a string is not an address
    const fromString: PodMediaAddress = 'https://pod.example/lib/2026/06/b1.png';
    expect(() => unwrapPodMediaAddress(fromString)).toThrow(TypeError);
    expect(() => unwrapPodMediaAddress({} as PodMediaAddress)).toThrow(TypeError);
  });

  it('carries no URL on its surface, at run time', () => {
    const address = mintPodMediaAddress('https://pod.example/lib/2026/06/b1.png');
    expect(typeof address).toBe('object');
    expect(Object.keys(address)).toEqual([]);
    expect(JSON.stringify(address)).toBe('{}');
    expect(String(address)).not.toContain('pod.example');
  });

  it('is not unwrappable through the package index: no raw-URL accessor is exported there', () => {
    const exported = Object.keys(pkg);
    expect(exported).not.toContain('unwrapPodMediaAddress');
    expect(exported).not.toContain('mintPodMediaAddress');
    expect(exported).not.toContain('podAssetDescriptionUrl');
    // The assets themselves carry only opaque values.
    expect(typeof asset(1).content).toBe('object');
    expect(typeof asset(1).ref).toBe('object');
  });
});

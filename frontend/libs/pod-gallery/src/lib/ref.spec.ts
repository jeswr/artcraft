import { describe, expect, it } from 'vitest';
import { isPodAssetRef, mintPodAssetRef, podAssetDescriptionUrl, type PodAssetRef } from './ref.js';

/** Stand-ins for hosted-only code: today every hosted token, delete id and generation input is a string. */
function hostedOnly(_mediaToken: string): void {}
function hostedDelete(_ids: string[]): void {}
interface HostedRefImage {
  url: string;
  mediaToken: string;
}

describe('a pod asset reference', () => {
  it('is not a hosted token: handing one to hosted-only code does not compile', () => {
    const ref = mintPodAssetRef('https://pod.example/lib/2026/06/abc');
    // @ts-expect-error a pod asset is not a string, so it cannot be a hosted media token
    hostedOnly(ref);
    // @ts-expect-error nor an element of a list of ids to delete
    hostedDelete([ref]);
    // @ts-expect-error nor a reference image's token
    const image: HostedRefImage = { url: 'https://cdn.example/x.png', mediaToken: ref };
    expect(image).toBeDefined();
  });

  it('cannot be forged from a string or a plain object', () => {
    // @ts-expect-error a string is not a pod asset reference
    const fromString: PodAssetRef = 'https://pod.example/lib/2026/06/abc';
    // @ts-expect-error neither is an object that merely looks like one
    const fromObject: PodAssetRef = { descriptionUrl: 'https://pod.example/lib/2026/06/abc' };
    expect(isPodAssetRef(fromString)).toBe(false);
    expect(isPodAssetRef(fromObject)).toBe(false);
    expect(isPodAssetRef(null)).toBe(false);
  });

  it('keeps the address the store returned, and only for references this module made', () => {
    const ref = mintPodAssetRef('https://pod.example/lib/2026/06/abc');
    expect(isPodAssetRef(ref)).toBe(true);
    expect(podAssetDescriptionUrl(ref)).toBe('https://pod.example/lib/2026/06/abc');
    expect(() => podAssetDescriptionUrl({} as PodAssetRef)).toThrow(TypeError);
  });

  it('is not a string at run time either, and carries no URL on its surface', () => {
    const ref = mintPodAssetRef('https://pod.example/lib/2026/06/abc');
    expect(typeof ref).toBe('object');
    expect(Object.keys(ref)).toEqual([]);
    expect(JSON.stringify(ref)).toBe('{}');
  });
});

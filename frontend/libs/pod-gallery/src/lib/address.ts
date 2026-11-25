declare const podMediaBrand: unique symbol;

/**
 * Where a pod item's file or thumbnail lives, as an opaque value. It is not a string, so it
 * cannot be put where a hosted `url: string` is expected (a lightbox image, a reference image, a
 * board item) and it cannot be shown by an `<img src>`. The only consumers are the media hooks in
 * `@storyteller/pod-gallery/media`, which hand the address to the media loader.
 */
export interface PodMediaAddress {
  readonly [podMediaBrand]: true;
}

const urls = new WeakMap<PodMediaAddress, string>();

/** Wraps a URL the store returned. Made by the source adapter (and by tests); never built from parts. */
export function mintPodMediaAddress(url: string): PodMediaAddress {
  const address = Object.freeze({}) as PodMediaAddress;
  urls.set(address, url);
  return address;
}

/** For the media loader only: this is the one place an address becomes a string. */
export function unwrapPodMediaAddress(address: PodMediaAddress): string {
  const url = urls.get(address);
  if (url === undefined) throw new TypeError('not a pod media address');
  return url;
}

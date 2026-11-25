declare const podAssetBrand: unique symbol;

/**
 * An item of the person's pod library. It is an opaque object, never a string: every hosted
 * media token, `RefImage.mediaToken`, delete, drag payload and generation input in the app is a
 * `string`, so handing a pod item to any of them is a compile error. The only way to get a
 * hosted token for a pod item is a future, explicit import step; this type has no such path.
 *
 * Make one with `mintPodAssetRef` (the library source does, from a URL the store returned).
 */
export interface PodAssetRef {
  readonly [podAssetBrand]: true;
}

const descriptionUrls = new WeakMap<PodAssetRef, string>();

/** Wraps the description URL the store returned. Not a place to build a URL from parts. */
export function mintPodAssetRef(descriptionUrl: string): PodAssetRef {
  const ref = Object.freeze({}) as PodAssetRef;
  descriptionUrls.set(ref, descriptionUrl);
  return ref;
}

export function isPodAssetRef(value: unknown): value is PodAssetRef {
  return typeof value === 'object' && value !== null && descriptionUrls.has(value as PodAssetRef);
}

/** The store's own address of the item's description: for `store.get` and as a stable list key. */
export function podAssetDescriptionUrl(ref: PodAssetRef): string {
  const url = descriptionUrls.get(ref);
  if (url === undefined) throw new TypeError('not a pod asset reference');
  return url;
}

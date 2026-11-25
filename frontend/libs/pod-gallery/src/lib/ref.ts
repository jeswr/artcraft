declare const podAssetBrand: unique symbol;

/**
 * An item of the person's pod library. It is an opaque object, never a string: every hosted
 * media token, `RefImage.mediaToken`, delete id, drag payload and generation input in the app is a
 * `string`, so handing a pod item to any of them is a compile error. The only way to get a
 * hosted token for a pod item is a future, explicit import step; this type has no such path.
 *
 * Make one with `mintPodAssetRef` (the library source does, from a URL the store returned).
 */
export interface PodAssetRef {
  readonly [podAssetBrand]: true;
}

const descriptionUrls = new WeakMap<PodAssetRef, string>();
const keys = new Map<string, string>();

/** Wraps the description URL the store returned. Not a place to build a URL from parts. */
export function mintPodAssetRef(descriptionUrl: string): PodAssetRef {
  const ref = Object.freeze({}) as PodAssetRef;
  descriptionUrls.set(ref, descriptionUrl);
  return ref;
}

export function isPodAssetRef(value: unknown): value is PodAssetRef {
  return typeof value === 'object' && value !== null && descriptionUrls.has(value as PodAssetRef);
}

/** The store's own address of the item's description, for `store.get`. Internal to this library. */
export function podAssetDescriptionUrl(ref: PodAssetRef): string {
  const url = descriptionUrls.get(ref);
  if (url === undefined) throw new TypeError('not a pod asset reference');
  return url;
}

/**
 * A stable name for the item that is not its address: for React keys and element ids. The same
 * description gets the same key every time, so a refreshed list keeps its tiles.
 */
export function podAssetKey(ref: PodAssetRef): string {
  const url = podAssetDescriptionUrl(ref);
  let key = keys.get(url);
  if (key === undefined) {
    key = `pod-${keys.size + 1}`;
    keys.set(url, key);
  }
  return key;
}

/**
 * Forget the keys handed out so far. Called when a library is torn down (sign-out, account
 * change): the map holds the previous account's description URLs and must not outlive it.
 */
export function clearPodAssetKeys(): void {
  keys.clear();
}

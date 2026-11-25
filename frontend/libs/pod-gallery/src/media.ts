/**
 * The only way to turn a pod item's media address into something on screen: through a media
 * loader. This entry point is separate from the package index so that the code that can see a
 * raw address (and the loader's React hook) is only imported by the gallery's lazy chunk.
 */
export { mintPodMediaAddress, type PodMediaAddress } from './lib/address.js';
export { usePodMedia, usePodOriginal, type PodOriginal, type PodOriginalStatus } from './lib/useMedia.js';

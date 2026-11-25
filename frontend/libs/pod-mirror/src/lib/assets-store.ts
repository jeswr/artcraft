import {
  type Current,
  type DeleteJournal,
  type ExposureCheck,
  type MediaStore,
  type MediaStoreOptions,
  openMediaStore,
  type SerializedDescription,
} from '@jeswr/pod-media-store';
import {
  type AssetDescription,
  CLASSES,
  documentUrl,
  parseAssetDocumentTtl,
  serializeAssetDocument,
} from '@jeswr/solid-creative-assets';
import type { AssetInput } from './mapping.js';
import type { PodStorePort } from './mirror.js';

/**
 * The creative-assets model plugged into `@jeswr/pod-media-store`: its description parser and
 * builder. All RDF is built and read by `@jeswr/solid-creative-assets`; nothing here touches a
 * triple or a Turtle string.
 */
export type AssetStoreOptions = Pick<
  MediaStoreOptions<AssetDescription, AssetInput>,
  'classes' | 'defaultContainerName' | 'parse' | 'build' | 'locate'
>;

export const LIBRARY_CONTAINER_NAME = 'creative-assets';

export function creativeAssetStoreOptions(): AssetStoreOptions {
  return {
    classes: [CLASSES.image, CLASSES.video, CLASSES.model3d],
    defaultContainerName: LIBRARY_CONTAINER_NAME,
    async parse(url, body, contentType) {
      try {
        return await parseAssetDocumentTtl(url, body, contentType);
      } catch {
        return undefined;
      }
    },
    async build(url, binaryUrl, input, context) {
      const asset = {
        contentUrl: binaryUrl,
        encodingFormat: context.contentType,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.dateCreated !== undefined ? { dateCreated: input.dateCreated } : {}),
        ...(input.kind === 'video' && input.duration !== undefined ? { duration: input.duration } : {}),
      };
      const description = {
        kind: input.kind,
        asset,
        ...(context.thumbnailUrl !== undefined
          ? {
              thumbnail: {
                contentUrl: context.thumbnailUrl,
                ...(input.thumbnailEncodingFormat !== undefined ? { encodingFormat: input.thumbnailEncodingFormat } : {}),
              },
            }
          : {}),
        ...(input.generation !== undefined ? { generation: input.generation } : {}),
      } as AssetDescription;
      return { body: await serializeAssetDocument(documentUrl(url), description), contentType: 'text/turtle' };
    },
    locate: (value) => ({ binaryUrl: value.asset.contentUrl, thumbnailUrl: value.thumbnail?.contentUrl }),
  };
}

/** The edit `attachThumbnail` needs: the same description with its thumbnail linked. */
export function thumbnailMutation(
  encodingFormat?: string,
): (current: Current, thumbnailUrl: string) => Promise<SerializedDescription | undefined> {
  return async (current, thumbnailUrl) => {
    const parsed = await parseAssetDocumentTtl(current.url, current.body, current.contentType);
    if (!parsed) return undefined;
    const next: AssetDescription = {
      ...parsed,
      thumbnail: { contentUrl: thumbnailUrl, ...(encodingFormat !== undefined ? { encodingFormat } : {}) },
    };
    return { body: await serializeAssetDocument(documentUrl(current.url), next), contentType: 'text/turtle' };
  };
}

export type CreativeAssetStore = MediaStore<AssetDescription, AssetInput>;

export interface OpenCreativeAssetStoreDeps {
  storage: MediaStoreOptions<AssetDescription, AssetInput>['storage'];
  features: MediaStoreOptions<AssetDescription, AssetInput>['features'];
  typeIndex: MediaStoreOptions<AssetDescription, AssetInput>['typeIndex'];
  exposure: ExposureCheck;
  /** The durable delete journal for this WebID and storage (`MirrorJournal.deletesFor`). */
  journal: DeleteJournal;
  /** Asked per container when the exposure probe cannot tell; true only for a confirmed one. */
  allowUnknownExposureFor?: (containerUrl: string) => boolean;
  signal?: AbortSignal;
}

/**
 * Opens the library store with the creative-assets model, the durable delete journal and an
 * exposure probe. Writes fail closed unless the probe says `private`.
 */
export function openCreativeAssetStore(deps: OpenCreativeAssetStoreDeps) {
  return openMediaStore<AssetDescription, AssetInput>({
    ...creativeAssetStoreOptions(),
    storage: deps.storage,
    features: deps.features,
    typeIndex: deps.typeIndex,
    exposure: deps.exposure,
    journal: deps.journal,
    ...(deps.allowUnknownExposureFor ? { allowUnknownExposureFor: deps.allowUnknownExposureFor } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
}

/**
 * The mirror's view of an opened store. The exposure target is the library once it exists, and
 * the storage root before that (the store probes the root then). `deletes` is the delete journal the
 * store was opened with, so a pending delete can be withdrawn.
 */
export function asPodStorePort(store: CreativeAssetStore, storageRoot: string, deletes?: DeleteJournal): PodStorePort {
  return {
    put: (input) => store.put(input),
    attachThumbnail: (url, input) => store.attachThumbnail(url, input),
    remove: (url, signal) => store.remove(url, signal),
    withdrawDelete: async (url) => deletes?.delete(url),
    probeLibrary: async (signal) => {
      const listed = await store.list({ limit: 1, ...(signal ? { signal } : {}) });
      if (listed.ok) return 'ok';
      return listed.error.kind === 'not-found' ? 'missing' : 'unknown';
    },
    get: (url, signal) => store.get(url, signal),
    resumePending: (signal) => store.resumePending(signal),
    ensureLibrary: (signal) => store.ensureLibrary(signal ? { signal } : {}),
    exposureTarget: () => store.library ?? storageRoot,
  };
}

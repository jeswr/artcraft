import type { MediaStoreError, PutInput, PutOutcome, Result } from '@jeswr/pod-media-store';
import { BytesError, type FetchPublicBytes } from './bytes.js';
import type { OpenStore, PodStorePort } from './mirror.js';
import type {
  HostedClient,
  HostedMediaFile,
  HostedPage,
  HostedPrompt,
  HostedResult,
  MirrorEventSource,
  MirrorSourceEvent,
  NetworkPort,
  SessionPort,
} from './types.js';

export const WEB_ID = 'https://alice.example/profile/card#me';
export const ACCOUNT = { webId: WEB_ID, username: 'alice_hosted' };
export const HOSTED_TOKEN_PREFIX = 'm_secrettoken';

export function png(seed = 0, size = 32): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < size; i++) bytes[i] = (seed * 31 + i * 7) & 0xff;
  return bytes;
}

export function mp4(seed = 0): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0, 0, 0, 0x20]);
  bytes.set([0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 4);
  for (let i = 12; i < 32; i++) bytes[i] = (seed * 17 + i) & 0xff;
  return bytes;
}

export function wav(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  return bytes;
}

export function hostedFile(n: number, overrides: Partial<HostedMediaFile> = {}): HostedMediaFile {
  const token = `${HOSTED_TOKEN_PREFIX}${n}`;
  return {
    token,
    media_type: 'image',
    media_class: 'image',
    maybe_prompt_token: null,
    maybe_original_filename: null,
    maybe_duration_millis: null,
    maybe_title: null,
    maybe_origin_model_type: null,
    origin: { maybe_model: null },
    media_links: { cdn_url: `https://cdn.example/files/${n}.png`, thumbnail_template: `https://cdn.example/thumbs/${n}/{WIDTH}.png` },
    // Newer items have larger numbers.
    created_at: new Date(Date.UTC(2026, 5, 1, 0, n)).toISOString(),
    ...overrides,
  };
}

export function hostedPrompt(token: string, overrides: Partial<HostedPrompt> = {}): HostedPrompt {
  return {
    token,
    created_at: '2026-06-01T00:00:00.000Z',
    maybe_positive_prompt: 'a red fox at sunset',
    maybe_negative_prompt: null,
    maybe_model_type: 'flux_pro_11',
    maybe_model_class: null,
    maybe_generation_provider: null,
    maybe_generation_mode: null,
    maybe_aspect_ratio: null,
    maybe_resolution: null,
    maybe_duration_seconds: null,
    maybe_strength: null,
    maybe_batch_count: null,
    maybe_generate_audio: null,
    maybe_style_name: null,
    maybe_frame_skip: null,
    maybe_context_images: null,
    ...overrides,
  };
}

export interface FakeHosted extends HostedClient {
  files: Map<string, HostedMediaFile>;
  prompts: Map<string, HostedPrompt>;
  calls: string[];
  /** Tokens whose lookup reports `unavailable`. */
  down: Set<string>;
  listDown: boolean;
  /** Newest first unless a test reorders it. */
  listing: HostedMediaFile[];
}

export function fakeHosted(files: HostedMediaFile[] = []): FakeHosted {
  const hosted: FakeHosted = {
    files: new Map(files.map((f) => [f.token, f])),
    prompts: new Map(),
    calls: [],
    down: new Set(),
    listDown: false,
    listing: [...files].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    async getMediaFile(token) {
      hosted.calls.push(`file:${token}`);
      if (hosted.down.has(token)) return { ok: false, kind: 'unavailable' };
      const file = hosted.files.get(token);
      return file ? { ok: true, value: file } : { ok: false, kind: 'not-found' };
    },
    async getPrompt(token) {
      hosted.calls.push(`prompt:${token}`);
      if (hosted.down.has(token)) return { ok: false, kind: 'unavailable' };
      const prompt = hosted.prompts.get(token);
      return prompt ? { ok: true, value: prompt } : { ok: false, kind: 'not-found' };
    },
    async listUserMediaFiles(pageIndex, pageSize): Promise<HostedResult<HostedPage>> {
      hosted.calls.push(`list:${pageIndex}`);
      if (hosted.listDown) return { ok: false, kind: 'unavailable' };
      const items = hosted.listing.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
      return { ok: true, value: { items, totalPages: Math.max(1, Math.ceil(hosted.listing.length / pageSize)) } };
    },
  };
  return hosted;
}

export interface FakeStore extends PodStorePort {
  puts: PutInput<unknown>[];
  /** Everything handed to the store, serialisable, for leak checks. */
  seen: string[];
  removed: string[];
  attached: { url: string }[];
  exposure: 'private' | 'exposed' | 'unknown' | 'offline';
  /** Failures to hand out for the next puts, in order. */
  putFailures: MediaStoreError[];
  removeFailures: MediaStoreError[];
  attachFails: boolean;
  /** Returned by `put` as `existed`. */
  existed: boolean;
  /** Link the thumbnail on put, as the real store does when it creates the description. */
  linkThumbnail: boolean;
  resumed: number;
  gate: Promise<void> | null;
}

export function fakeStore(): FakeStore {
  let counter = 0;
  const store: FakeStore = {
    puts: [],
    seen: [],
    removed: [],
    attached: [],
    exposure: 'private',
    putFailures: [],
    removeFailures: [],
    attachFails: false,
    existed: false,
    linkThumbnail: true,
    resumed: 0,
    gate: null,
    async put(input) {
      const { bytes, signal: _signal, ...rest } = input as PutInput<unknown> & { bytes: Uint8Array };
      store.puts.push(input as PutInput<unknown>);
      store.seen.push(JSON.stringify({ ...rest, bytesLength: bytes.byteLength }));
      if (store.gate) await store.gate;
      const failure = store.putFailures.shift();
      if (failure) return { ok: false, error: failure };
      counter++;
      const hasThumb = Boolean(input.thumbnail);
      const outcome: PutOutcome = {
        descriptionUrl: `https://pod.example/alice/creative-assets/2026/06/desc${counter}`,
        binaryUrl: `https://pod.example/alice/creative-assets/2026/06/bin${counter}.png`,
        thumbnailUrl: hasThumb && store.linkThumbnail ? `https://pod.example/alice/creative-assets/2026/06/desc${counter}-thumb.webp` : undefined,
        thumbnailMissing: hasThumb && !store.linkThumbnail,
        sha256: 'ab'.repeat(32),
        existed: store.existed,
      };
      return { ok: true, value: outcome };
    },
    async attachThumbnail(url, input) {
      store.seen.push(JSON.stringify({ attach: url }));
      store.attached.push({ url });
      void input;
      if (store.attachFails) return { ok: false, error: { kind: 'failed', reason: 'storage' } };
      return { ok: true, value: undefined };
    },
    async remove(url) {
      store.seen.push(JSON.stringify({ remove: url }));
      const failure = store.removeFailures.shift();
      if (failure) return { ok: false, error: failure };
      store.removed.push(url);
      return { ok: true, value: undefined };
    },
    async resumePending() {
      store.resumed++;
      return { ok: true, value: { completed: 0, failed: 0, rejected: 0 } };
    },
    async checkExposure(): Promise<Result<'private' | 'exposed' | 'unknown'>> {
      if (store.exposure === 'offline') return { ok: false, error: { kind: 'offline', reason: 'storage' } };
      return { ok: true, value: store.exposure };
    },
  };
  return store;
}

export interface FakeSession extends SessionPort {
  connected: boolean;
  set(connected: boolean): void;
}

export function fakeSession(connected = true): FakeSession {
  const listeners = new Set<() => void>();
  const session: FakeSession = {
    connected,
    isConnected: () => session.connected,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      session.connected = next;
      for (const listener of [...listeners]) listener();
    },
  };
  return session;
}

export interface FakeNetwork extends NetworkPort {
  online: boolean;
  set(online: boolean): void;
}

export function fakeNetwork(online = true): FakeNetwork {
  const listeners = new Set<() => void>();
  const network: FakeNetwork = {
    online,
    isOnline: () => network.online,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      network.online = next;
      for (const listener of [...listeners]) listener();
    },
  };
  return network;
}

export interface FakeEvents extends MirrorEventSource {
  emit(event: MirrorSourceEvent): void;
  readonly subscribers: number;
}

export function fakeEvents(): FakeEvents {
  const handlers = new Set<(event: MirrorSourceEvent) => void>();
  return {
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit(event) {
      for (const handler of [...handlers]) handler(event);
    },
    get subscribers() {
      return handlers.size;
    },
  };
}

export interface FakeBytes {
  fetch: FetchPublicBytes;
  urls: string[];
  /** URL to bytes. A missing URL is `unavailable`. */
  bodies: Map<string, Uint8Array | BytesError>;
}

export function fakeBytes(hosted?: FakeHosted): FakeBytes {
  const bodies = new Map<string, Uint8Array | BytesError>();
  const urls: string[] = [];
  const fake: FakeBytes = {
    urls,
    bodies,
    async fetch(url) {
      urls.push(url);
      const body = bodies.get(url);
      if (body instanceof BytesError) throw body;
      if (!body) throw new BytesError('unavailable');
      return body;
    },
  };
  if (hosted) {
    for (const file of hosted.files.values()) {
      const n = Number(file.token.replace(HOSTED_TOKEN_PREFIX, ''));
      bodies.set(file.media_links.cdn_url, png(n));
      bodies.set(`https://cdn.example/thumbs/${n}/512.png`, png(n + 100));
    }
  }
  return fake;
}

export function openFake(store: PodStorePort | (() => PodStorePort)): OpenStore & { calls: number; fail: 'offline' | 'failed' | null } {
  const open = (async () => {
    open.calls++;
    if (open.fail) return { ok: false as const, reason: open.fail };
    return { ok: true as const, store: typeof store === 'function' ? store() : store };
  }) as unknown as OpenStore & { calls: number; fail: 'offline' | 'failed' | null };
  open.calls = 0;
  open.fail = null;
  return open;
}

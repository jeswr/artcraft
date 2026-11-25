import { type ExposureCheck } from '@jeswr/pod-media-store';
import { parseAssetDocumentTtl } from '@jeswr/solid-creative-assets';
import { createTypeIndex } from '@jeswr/pod-type-index';
import { createMemoryStorage } from '@jeswr/storage-client/memory';
import type { StorageClient } from '@jeswr/storage-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openCreativeAssetStore } from './assets-store.js';
import { createMemoryMirrorJournal } from './journal.js';
import { PodMirror } from './mirror.js';
import {
  ACCOUNT,
  HOSTED_TOKEN_PREFIX,
  fakeBytes,
  fakeEvents,
  fakeHosted,
  fakeNetwork,
  fakeSession,
  hostedFile,
  hostedPrompt,
  mp4,
} from './testing.js';

const ROOT = 'https://pod.example/alice/';
const WEB_ID = `${ROOT}profile/card#me`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-10T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());

async function harness(exposure: ExposureCheck = async () => 'private') {
  const storage = createMemoryStorage({ protocol: 'solid', root: ROOT });
  await storage.write(`${ROOT}profile/card`, `<${WEB_ID}> a <http://xmlns.com/foaf/0.1/Person>.`, { contentType: 'text/turtle', ifMatch: '*' });
  const journal = createMemoryMirrorJournal();
  let store: Awaited<ReturnType<typeof openCreativeAssetStore>> | undefined;
  const hosted = fakeHosted([]);
  const bytes = fakeBytes();
  const events = fakeEvents();
  const mirror = new PodMirror({
    account: ACCOUNT,
    journal,
    hosted,
    fetchPublicBytes: bytes.fetch,
    session: fakeSession(),
    network: fakeNetwork(),
    events,
    random: () => 0.5,
    openStore: async (signal) => {
      store = await openCreativeAssetStore({
        storage,
        features: storage.features,
        typeIndex: createTypeIndex({ storage, features: storage.features, profile: WEB_ID }),
        exposure,
        journal: journal.deletes,
        signal,
      });
      return store.ok ? { ok: true, store: store.value } : { ok: false, reason: 'failed' };
    },
  });
  return { storage, journal, hosted, bytes, events, mirror, library: () => (store?.ok ? store.value : undefined) };
}

const settle = async (mirror: PodMirror) => {
  await vi.advanceTimersByTimeAsync(0);
  await mirror.idle();
  await vi.advanceTimersByTimeAsync(0);
  await mirror.idle();
};

async function everythingOnThePod(storage: StorageClient): Promise<string> {
  let text = '';
  const walk = async (container: string): Promise<void> => {
    for await (const entry of storage.listAll(container)) {
      text += `${entry.url}\n`;
      if (entry.url.endsWith('/')) await walk(entry.url);
      else text += `${await (await storage.read(entry.url)).text()}\n`;
    }
  };
  await walk(storage.root);
  return text;
}

describe('the mirror against the real store, model and a memory pod', () => {
  it('writes a parseable description that points at the right bytes and holds no hosted token', async () => {
    const h = await harness();
    const image = hostedFile(1, { maybe_prompt_token: 'prompt_tok_1', maybe_title: 'Sunset fox', origin: { maybe_model: { title: 'Flux Pro' } } });
    h.hosted.files.set(image.token, image);
    h.hosted.prompts.set('prompt_tok_1', hostedPrompt('prompt_tok_1', { maybe_negative_prompt: 'blurry', maybe_aspect_ratio: '16:9' }));
    const video = hostedFile(2, { media_type: 'video', media_class: 'video', maybe_duration_millis: 5500, media_links: { cdn_url: 'https://cdn.example/files/2.mp4', thumbnail_template: 'https://cdn.example/thumbs/2/{WIDTH}.png' } });
    h.hosted.files.set(video.token, video);
    const imageBytes = fakeBytes(h.hosted);
    imageBytes.bodies.set(video.media_links.cdn_url, mp4(2));
    for (const [url, body] of imageBytes.bodies) h.bytes.bodies.set(url, body);

    await h.mirror.start();
    await h.mirror.enqueue(image.token);
    await h.mirror.enqueue(video.token);
    await settle(h.mirror);

    const imageState = h.mirror.stateOf(image.token);
    const videoState = h.mirror.stateOf(video.token);
    expect(imageState).toMatchObject({ kind: 'saved', thumbnail: 'attached' });
    expect(videoState).toMatchObject({ kind: 'saved' });

    const library = h.library();
    expect(library).toBeDefined();
    const listed = await library!.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.items).toHaveLength(2);

    const savedImage = listed.value.items.find((item) => item.value.kind === 'image')!;
    expect(savedImage.value.asset).toMatchObject({ name: 'Sunset fox', encodingFormat: 'image/png' });
    expect(savedImage.value.generation?.prompt).toBe('a red fox at sunset');
    expect(savedImage.value.generation?.model).toMatchObject({ name: 'Flux Pro', identifier: 'flux_pro_11' });
    expect(savedImage.value.generation?.settings?.map((s) => s.propertyID)).toEqual(expect.arrayContaining(['negative_prompt', 'aspect_ratio']));
    expect(savedImage.thumbnailUrl).toBeDefined();

    // The description names the binary it was written for, and the binary is the downloaded bytes.
    const stored = await (await h.storage.read(savedImage.binaryUrl)).bytes();
    expect(Array.from(stored)).toEqual(Array.from(imageBytes.bodies.get(image.media_links.cdn_url) as Uint8Array));
    const described = await (await h.storage.read(savedImage.descriptionUrl)).text();
    const reparsed = await parseAssetDocumentTtl(savedImage.descriptionUrl, described);
    expect(reparsed?.asset.contentUrl).toBe(savedImage.binaryUrl);

    const savedVideo = listed.value.items.find((item) => item.value.kind === 'video')!;
    expect(savedVideo.value.asset).toMatchObject({ encodingFormat: 'video/mp4', duration: 'PT5.5S' });

    // Nothing on the pod, in any resource or URL, names the hosted side.
    const pod = await everythingOnThePod(h.storage);
    expect(pod).not.toContain(HOSTED_TOKEN_PREFIX);
    expect(pod).not.toContain('prompt_tok_1');
    expect(pod).not.toContain('cdn.example');
    expect(pod).not.toContain('alice_hosted');
  });

  it('is idempotent on the pod: the same bytes saved again from another hosted item adopt the verified copy', async () => {
    const h = await harness();
    const a = hostedFile(1);
    const b = hostedFile(1, { token: `${HOSTED_TOKEN_PREFIX}77` });
    h.hosted.files.set(a.token, a);
    h.hosted.files.set(b.token, b);
    h.bytes.bodies.set(a.media_links.cdn_url, fakeBytes(h.hosted).bodies.get(a.media_links.cdn_url)!);
    await h.mirror.start();
    await h.mirror.enqueue(a.token);
    await h.mirror.enqueue(b.token);
    await settle(h.mirror);
    expect(h.mirror.stateOf(a.token)?.kind).toBe('saved');
    expect(h.mirror.stateOf(b.token)?.kind).toBe('saved');
    const listed = await h.library()!.list();
    expect(listed.ok && listed.value.items).toHaveLength(1);
  });

  it('removes the description and both files when the hosted item is deleted', async () => {
    const h = await harness();
    const file = hostedFile(1);
    h.hosted.files.set(file.token, file);
    h.bytes.bodies.set(file.media_links.cdn_url, fakeBytes(h.hosted).bodies.get(file.media_links.cdn_url)!);
    h.bytes.bodies.set('https://cdn.example/thumbs/1/512.png', fakeBytes(h.hosted).bodies.get('https://cdn.example/thumbs/1/512.png')!);
    await h.mirror.start();
    await h.mirror.enqueue(file.token);
    await settle(h.mirror);
    const before = await everythingOnThePod(h.storage);
    expect(before).toContain('.png');
    h.events.emit({ type: 'deleted', token: file.token });
    await settle(h.mirror);
    expect(h.mirror.stateOf(file.token)).toBeUndefined();
    const listed = await h.library()!.list();
    expect(listed.ok && listed.value.items).toHaveLength(0);
    expect(await h.journal.deletes.list()).toEqual([]);
    const after = await everythingOnThePod(h.storage);
    expect(after).not.toMatch(/\.png/);
  });

  it('refuses to write when the real store is told the library is exposed', async () => {
    const h = await harness(async () => 'exposed');
    const file = hostedFile(1);
    h.hosted.files.set(file.token, file);
    h.bytes.bodies.set(file.media_links.cdn_url, fakeBytes(h.hosted).bodies.get(file.media_links.cdn_url)!);
    await h.mirror.start();
    await h.mirror.enqueue(file.token);
    await settle(h.mirror);
    expect(h.mirror.summary().paused).toBe('exposed');
    expect(await everythingOnThePod(h.storage)).not.toMatch(/\.png/);
  });
});

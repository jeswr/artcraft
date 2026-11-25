import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify, durationFromMillis, MAX_NAME, MAX_PROMPT, referenceTokens, thumbnailUrl, toAssetInput } from './mapping.js';
import { HOSTED_TOKEN_PREFIX, hostedFile, hostedPrompt } from './testing.js';
import type { HostedMediaFile } from './types.js';

describe('classify', () => {
  type Verdict = 'image' | 'video' | 'model' | 'audio' | 'scene' | 'unsupported';
  // Every `media_type` the hosted API can send (`MediaFileType` in crates/schema), and what the
  // mirror does with it. `audio`, `image` and `video` are the deprecated coarse values.
  const TYPES: Record<string, Verdict> = {
    audio: 'audio', wav: 'audio', mp3: 'audio', opus: 'audio', ogg: 'audio', aac: 'audio', m4a: 'audio', flac: 'audio',
    image: 'image', jpg: 'image', png: 'image', gif: 'image', webp: 'image',
    video: 'video', mp4: 'video', webm: 'video', mov: 'video',
    fbx: 'model', obj: 'model', glb: 'model', gltf: 'model', pmd: 'model', pmx: 'model', spz: 'model', ply: 'model',
    bvh: 'unsupported', vmd: 'unsupported', csv: 'unsupported',
    scene_ron: 'scene', scene_json: 'scene', mood_json: 'scene', timeline_json: 'scene', editor_json: 'scene', json: 'scene',
  };
  const CLASS_OF: Record<string, string> = { audio: 'audio', image: 'image', video: 'video', model: 'mesh', scene: 'project', unsupported: 'dimensional' };
  const verdict = (file: HostedMediaFile) => {
    const out = classify(file);
    if (!out.copy) return out.reason === 'audio-unsupported' ? 'audio' : out.reason === 'scene' ? 'scene' : 'unsupported';
    return out.expects;
  };

  it.each(Object.entries(TYPES))('classifies media_type %s as %s whatever the class says or omits', (media_type, expected) => {
    for (const media_class of [CLASS_OF[expected], null, 'unknown']) expect(verdict(hostedFile(1, { media_type, media_class }))).toBe(expected);
  });

  it('knows every media_type of the hosted enum', () => {
    const rust = resolve(__dirname, '../../../../../crates/schema/public/enums/src/by_table/media_files/media_file_type.rs');
    if (!existsSync(rust)) return; // outside the full repository
    const source = readFileSync(rust, 'utf8');
    const toStr = source.slice(source.indexOf('pub fn to_str'), source.indexOf('pub fn from_str'));
    const values = [...toStr.matchAll(/=> "([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(30);
    expect(Object.keys(TYPES).sort()).toEqual([...values].sort());
  });

  it.each([
    ['audio', 'audio'], ['image', 'image'], ['video', 'video'], ['mesh', 'model'], ['splat', 'model'], ['project', 'scene'], ['dimensional', 'model'],
  ] as const)('goes by the media class when the type is not one it knows: %s is %s', (media_class, expected) => {
    expect(verdict(hostedFile(1, { media_type: 'future_format', media_class }))).toBe(expected);
  });

  it('lets the sniffer decide for a record it knows nothing about', () => {
    expect(classify(hostedFile(1, { media_type: 'future_format', media_class: null }))).toEqual({ copy: true, expects: 'any' });
    expect(classify(hostedFile(1, { media_type: 'future_format', media_class: 'unknown' }))).toEqual({ copy: true, expects: 'any' });
  });

  it('prefers the class over a stale type, but never copies what either side calls audio or a project', () => {
    expect(verdict(hostedFile(1, { media_type: 'image', media_class: 'video' }))).toBe('video');
    expect(verdict(hostedFile(1, { media_type: 'image', media_class: 'Audio' }))).toBe('audio');
    expect(verdict(hostedFile(1, { media_type: 'wav', media_class: 'image' }))).toBe('audio');
    expect(verdict(hostedFile(1, { media_type: 'png', media_class: 'project' }))).toBe('scene');
  });

  it('skips intermediates', () => {
    expect(classify(hostedFile(1), { isIntermediate: () => true })).toEqual({ copy: false, reason: 'intermediate' });
  });
});

describe('toAssetInput', () => {
  it('maps every stated field', () => {
    const file = hostedFile(3, {
      maybe_title: 'Sunset fox',
      maybe_duration_millis: 5500,
      maybe_origin_model_type: 'file_model',
      origin: { maybe_model: { title: 'Flux Pro' } },
    });
    const prompt = hostedPrompt('p_1', {
      maybe_negative_prompt: 'blurry',
      maybe_generation_provider: 'fal',
      maybe_model_class: 'image',
      maybe_generation_mode: 'text',
      maybe_aspect_ratio: '16:9',
      maybe_resolution: '1k',
      maybe_duration_seconds: 5,
      maybe_strength: 0.5,
      maybe_batch_count: 4,
      maybe_generate_audio: false,
      maybe_style_name: 'noir',
      maybe_frame_skip: 2,
    });
    const input = toAssetInput(file, prompt, { kind: 'video', referencedAssets: ['https://pod/ref#it'] });
    expect(input).toMatchObject({
      kind: 'video',
      name: 'Sunset fox',
      duration: 'PT5.5S',
      dateCreated: new Date(file.created_at),
      generation: {
        prompt: 'a red fox at sunset',
        model: { name: 'Flux Pro', identifier: 'flux_pro_11' },
        usedAssets: ['https://pod/ref#it'],
      },
    });
    const settings = Object.fromEntries((input.generation?.settings ?? []).map((s) => [s.propertyID, s.value]));
    expect(settings).toEqual({
      negative_prompt: 'blurry',
      generation_provider: 'fal',
      model_class: 'image',
      generation_mode: 'text',
      aspect_ratio: '16:9',
      resolution: '1k',
      duration_seconds: '5',
      strength: '0.5',
      batch_count: '4',
      generate_audio: 'false',
      style_name: 'noir',
      frame_skip: '2',
    });
  });

  it('leaves out what the hosted side does not state and invents nothing', () => {
    const input = toAssetInput(hostedFile(1), undefined, { kind: 'image' });
    expect(input).toEqual({ kind: 'image', dateCreated: new Date(hostedFile(1).created_at) });
    expect(input.generation).toBeUndefined();
    expect(input).not.toHaveProperty('duration');
  });

  it('falls back to the original filename for a name and ignores a duration on an image', () => {
    const input = toAssetInput(hostedFile(1, { maybe_original_filename: 'cat.png', maybe_duration_millis: 1000 }), undefined, { kind: 'image' });
    expect(input.name).toBe('cat.png');
    expect(input).not.toHaveProperty('duration');
  });

  it('writes a provider only when the hosted value already is a real IRI', () => {
    const real = toAssetInput(hostedFile(1), hostedPrompt('p', { maybe_generation_provider: 'https://bfl.ai/' }), { kind: 'image' });
    expect(real.generation?.model?.provider).toBe('https://bfl.ai/');
    expect((real.generation?.settings ?? []).map((s) => s.propertyID)).not.toContain('generation_provider');
    for (const provider of ['fal', 'javascript:alert(1)', 'https://user:pw@x.example/', 'https://x.example/#frag', 'HTTPS://X.example']) {
      const input = toAssetInput(hostedFile(1), hostedPrompt('p', { maybe_generation_provider: provider }), { kind: 'image' });
      expect(input.generation?.model?.provider).toBeUndefined();
    }
  });

  it('treats missing, empty and malformed values as absent', () => {
    const file = hostedFile(1, { maybe_title: '   ', created_at: 'not a date', maybe_duration_millis: Number.NaN });
    const prompt = hostedPrompt('p', { maybe_positive_prompt: '', maybe_model_type: null, maybe_strength: Number.POSITIVE_INFINITY });
    const input = toAssetInput(file, prompt, { kind: 'video' });
    expect(input).toEqual({ kind: 'video' });
  });

  it('survives hostile strings: control characters, huge text, markup', () => {
    const hostile = `a\u0000b\u0007c <script>alert(1)</script> "; DROP @prefix ex: <x> .\n`;
    const input = toAssetInput(
      hostedFile(1, { maybe_title: `${'x'.repeat(MAX_NAME * 3)}` }),
      hostedPrompt('p', { maybe_positive_prompt: hostile + 'y'.repeat(MAX_PROMPT * 2), maybe_style_name: '\u0000\u0001' }),
      { kind: 'image' },
    );
    expect(input.name?.length).toBe(MAX_NAME);
    expect(input.generation?.prompt?.length).toBeLessThanOrEqual(MAX_PROMPT);
    // eslint-disable-next-line no-control-regex
    expect(input.generation?.prompt).not.toMatch(/[\u0000-\u0008]/);
    expect(input.generation?.prompt).toContain('<script>');
    expect(input.generation?.settings ?? []).toEqual([]);
  });

  it('never carries a hosted token or a CDN address', () => {
    const file = hostedFile(7, { maybe_prompt_token: 'p_tok', maybe_title: 'x' });
    const prompt = hostedPrompt('p_tok', { maybe_context_images: [{ media_token: `${HOSTED_TOKEN_PREFIX}9`, semantic: 'ref' }] });
    const text = JSON.stringify(toAssetInput(file, prompt, { kind: 'image' }));
    expect(text).not.toContain(HOSTED_TOKEN_PREFIX);
    expect(text).not.toContain('p_tok');
    expect(text).not.toContain('cdn.example');
  });
});

describe('small helpers', () => {
  it('turns milliseconds into an xsd duration and rejects nonsense', () => {
    expect(durationFromMillis(0)).toBe('PT0S');
    expect(durationFromMillis(1234)).toBe('PT1.234S');
    expect(durationFromMillis(-1)).toBeUndefined();
    expect(durationFromMillis(null)).toBeUndefined();
  });

  it('lists reference tokens once, in order, ignoring junk', () => {
    const prompt = hostedPrompt('p', {
      maybe_context_images: [
        { media_token: 'a', semantic: 'x' },
        { media_token: 'b', semantic: 'x' },
        { media_token: 'a', semantic: 'y' },
        { media_token: '', semantic: 'z' },
        null as never,
      ],
    });
    expect(referenceTokens(prompt)).toEqual(['a', 'b']);
    expect(referenceTokens(undefined)).toEqual([]);
  });

  it('builds the 512 pixel thumbnail address only from a template', () => {
    expect(thumbnailUrl('https://c/{WIDTH}.png')).toBe('https://c/512.png');
    expect(thumbnailUrl('https://c/fixed.png')).toBeUndefined();
    expect(thumbnailUrl(null)).toBeUndefined();
  });
});

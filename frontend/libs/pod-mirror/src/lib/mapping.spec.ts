import { describe, expect, it } from 'vitest';
import { classify, durationFromMillis, MAX_NAME, MAX_PROMPT, referenceTokens, thumbnailUrl, toAssetInput } from './mapping.js';
import { HOSTED_TOKEN_PREFIX, hostedFile, hostedPrompt } from './testing.js';

describe('classify', () => {
  it('copies images, videos and glb files', () => {
    for (const media_type of ['image', 'video', 'glb']) expect(classify(hostedFile(1, { media_type }))).toEqual({ copy: true });
  });

  it('skips audio by type or class, with the reason the gallery shows', () => {
    expect(classify(hostedFile(1, { media_type: 'audio', media_class: 'audio' }))).toEqual({ copy: false, reason: 'audio-unsupported' });
    expect(classify(hostedFile(1, { media_type: 'image', media_class: 'Audio' }))).toEqual({ copy: false, reason: 'audio-unsupported' });
  });

  it('skips scenes, intermediates and types the store cannot hold', () => {
    expect(classify(hostedFile(1, { media_type: 'scene_json' }))).toEqual({ copy: false, reason: 'scene' });
    expect(classify(hostedFile(1, { media_type: 'scene' }))).toEqual({ copy: false, reason: 'scene' });
    expect(classify(hostedFile(1, { media_class: 'scene' }))).toEqual({ copy: false, reason: 'scene' });
    expect(classify(hostedFile(1, { media_type: 'fbx' }))).toEqual({ copy: false, reason: 'unsupported-type' });
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

import type { GenerationData, SettingData } from '@jeswr/solid-creative-assets';
import type { HostedMediaFile, HostedPrompt, SkipReason } from './types.js';

export type AssetKind = 'image' | 'video' | 'model3d';

/**
 * What the mirror hands to the store's `build` (through `AssetInput`'s `description`). It
 * holds only what the hosted side states about an item. It never holds the hosted token, a
 * CDN address or a prompt token.
 */
export interface AssetInput {
  kind: AssetKind;
  name?: string;
  dateCreated?: Date;
  /** `xsd:duration`, such as `PT5.5S`. */
  duration?: string;
  generation?: GenerationData;
  /** The sniffed type of the thumbnail bytes, when one is stored. */
  thumbnailEncodingFormat?: string;
}

export const MAX_NAME = 500;
export const MAX_PROMPT = 50_000;
export const MAX_SETTING_VALUE = 1_000;
const MAX_DURATION_SECONDS = 31_536_000_000;

/** The hosted `media_class` values (`MediaFileClass` in crates/schema, `dimensional` is deprecated). */
export const MEDIA_CLASSES = ['unknown', 'audio', 'image', 'video', 'dimensional', 'mesh', 'splat', 'project'] as const;
export type MediaClass = (typeof MEDIA_CLASSES)[number];

/**
 * The hosted `media_type` values and the class each belongs to (`MediaFileType::to_media_class`
 * in crates/schema). `audio`, `image` and `video` are the deprecated coarse types: current
 * records carry the format (`png`, `mp4`, ...), so classification keys on the class first.
 */
export const CLASS_OF_TYPE: Readonly<Record<string, MediaClass>> = {
  audio: 'audio', wav: 'audio', mp3: 'audio', opus: 'audio', ogg: 'audio', aac: 'audio', m4a: 'audio', flac: 'audio',
  image: 'image', jpg: 'image', png: 'image', gif: 'image', webp: 'image',
  video: 'video', mp4: 'video', webm: 'video', mov: 'video',
  fbx: 'mesh', obj: 'mesh', glb: 'mesh', gltf: 'mesh', pmd: 'mesh', pmx: 'mesh',
  spz: 'splat', ply: 'splat',
  bvh: 'dimensional', vmd: 'dimensional', csv: 'dimensional',
  scene_ron: 'project', scene_json: 'project', mood_json: 'project', timeline_json: 'project', editor_json: 'project', json: 'project',
};

/** What family of bytes the hosted record says to expect; `any` lets the sniffer decide. */
export type Expected = 'image' | 'video' | 'model' | 'any';
export type Classification = { copy: true; expects: Expected } | { copy: false; reason: SkipReason };

const lower = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase() : '');

/**
 * Decides from the hosted record whether an item is worth downloading, by media class first and
 * the media type second. The bytes are sniffed after the download, which stays the authority:
 * a record this does not know is downloaded and the sniffer decides.
 */
export function classify(file: HostedMediaFile, options: { isIntermediate?: (file: HostedMediaFile) => boolean } = {}): Classification {
  if (options.isIntermediate?.(file)) return { copy: false, reason: 'intermediate' };
  const klass = lower(file.media_class);
  const byType = CLASS_OF_TYPE[lower(file.media_type)];
  if (klass === 'audio' || byType === 'audio') return { copy: false, reason: 'audio-unsupported' };
  if (klass === 'project' || byType === 'project') return { copy: false, reason: 'scene' };
  const effective = klass === 'image' || klass === 'video' || klass === 'mesh' || klass === 'splat' ? klass : byType;
  if (effective === 'image' || effective === 'video') return { copy: true, expects: effective };
  if (effective === 'mesh' || effective === 'splat') return { copy: true, expects: 'model' };
  // The deprecated `dimensional` class held 3D files before it was split; a format with no
  // 3D meaning (animation, CSV) is not copied.
  if (effective === 'dimensional' || klass === 'dimensional') return klass === 'dimensional' && byType === undefined ? { copy: true, expects: 'model' } : { copy: false, reason: 'unsupported-type' };
  return { copy: true, expects: 'any' };
}

const clean = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  // Control characters are not data; the model strips them again on write.
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return text === '' ? undefined : text.slice(0, max);
};

/** `5500` becomes `PT5.5S`; anything that is not a finite, non-negative number is left out. */
export function durationFromMillis(millis: number | null | undefined): string | undefined {
  if (typeof millis !== 'number' || !Number.isFinite(millis) || millis < 0) return undefined;
  const seconds = Math.round(millis) / 1000;
  // Beyond a thousand years the number prints in exponent form, which the model rejects.
  if (seconds > MAX_DURATION_SECONDS) return undefined;
  return `PT${seconds}S`;
}

export function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** An IRI only when the hosted value already is a normalised http(s) address. */
export function realIri(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.username !== '' || url.password !== '' || url.hash !== '') return undefined;
    return url.href === value ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Hosted generation settings, each only when the hosted side states it. */
export function settingsFrom(prompt: HostedPrompt, providerIsIri: boolean): SettingData[] {
  const entries: [string, unknown][] = [
    ['negative_prompt', prompt.maybe_negative_prompt],
    ['generation_provider', providerIsIri ? undefined : prompt.maybe_generation_provider],
    ['model_class', prompt.maybe_model_class],
    ['generation_mode', prompt.maybe_generation_mode],
    ['aspect_ratio', prompt.maybe_aspect_ratio],
    ['resolution', prompt.maybe_resolution],
    ['duration_seconds', prompt.maybe_duration_seconds],
    ['strength', prompt.maybe_strength],
    ['batch_count', prompt.maybe_batch_count],
    ['generate_audio', prompt.maybe_generate_audio],
    ['style_name', prompt.maybe_style_name],
    ['frame_skip', prompt.maybe_frame_skip],
  ];
  const settings: SettingData[] = [];
  for (const [propertyID, raw] of entries) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'number' && !Number.isFinite(raw)) continue;
    const value = clean(String(raw), MAX_SETTING_VALUE);
    if (value !== undefined) settings.push({ propertyID, value });
  }
  return settings;
}

export interface MappingContext {
  kind: AssetKind;
  /** Asset IRIs (`<description#it>`) of reference images that are already in the journal. */
  referencedAssets?: readonly string[];
}

/** Pure: hosted media file plus its prompt (when it has one) to the description input. */
export function toAssetInput(file: HostedMediaFile, prompt: HostedPrompt | undefined, context: MappingContext): AssetInput {
  const input: AssetInput = { kind: context.kind };
  const name = clean(file.maybe_title, MAX_NAME) ?? clean(file.maybe_original_filename, MAX_NAME);
  if (name !== undefined) input.name = name;
  const dateCreated = parseDate(file.created_at);
  if (dateCreated) input.dateCreated = dateCreated;
  if (context.kind === 'video') {
    const duration = durationFromMillis(file.maybe_duration_millis);
    if (duration) input.duration = duration;
  }

  const generation: GenerationData = {};
  const promptText = clean(prompt?.maybe_positive_prompt, MAX_PROMPT);
  if (promptText !== undefined) generation.prompt = promptText;

  const modelName = clean(file.origin?.maybe_model?.title, MAX_NAME);
  const identifier = clean(prompt?.maybe_model_type, MAX_NAME) ?? clean(file.maybe_origin_model_type, MAX_NAME);
  const provider = realIri(prompt?.maybe_generation_provider);
  if (modelName !== undefined || identifier !== undefined || provider !== undefined) {
    generation.model = {
      ...(modelName !== undefined ? { name: modelName } : {}),
      ...(identifier !== undefined ? { identifier } : {}),
      ...(provider !== undefined ? { provider } : {}),
    };
  }
  if (prompt) {
    const settings = settingsFrom(prompt, provider !== undefined);
    if (settings.length > 0) generation.settings = settings;
  }
  if (context.referencedAssets && context.referencedAssets.length > 0) generation.usedAssets = [...context.referencedAssets];
  if (Object.keys(generation).length > 0) input.generation = generation;
  return input;
}

/** The reference tokens a prompt names, in order and without repeats. */
export function referenceTokens(prompt: HostedPrompt | undefined): string[] {
  const seen = new Set<string>();
  for (const image of prompt?.maybe_context_images ?? []) {
    if (typeof image?.media_token === 'string' && image.media_token !== '') seen.add(image.media_token);
  }
  return [...seen];
}

/** The CDN address of the hosted thumbnail at a width, or undefined without a template. */
export function thumbnailUrl(template: string | null | undefined, width = 512): string | undefined {
  if (typeof template !== 'string' || !template.includes('{WIDTH}')) return undefined;
  return template.replace('{WIDTH}', String(width));
}

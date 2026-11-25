import { usePodGalleryAccess } from './context.js';

export type GallerySource = 'hosted' | 'pod';

export const SOURCE_LABELS: Record<GallerySource, string> = {
  hosted: 'ArtCraft library',
  pod: 'My pod',
};

/**
 * The gallery's source switch. It renders nothing unless a pod is connected, so a window without
 * one has no trace of it.
 */
export function PodSourceSwitch({ source, onChange }: { source: GallerySource; onChange: (next: GallerySource) => void }) {
  const access = usePodGalleryAccess();
  if (!access) return null;
  return (
    <div role="group" aria-label="Library source" className="relative z-[51] flex items-center gap-0.5 rounded-[3px] bg-ui-controls/40 p-0.5">
      {(['hosted', 'pod'] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={source === value}
          onClick={() => onChange(value)}
          className={`rounded-[3px] px-3 py-1 text-sm font-medium transition-colors ${
            source === value ? 'bg-ui-controls text-base-fg' : 'text-base-fg/60 hover:text-base-fg'
          }`}
        >
          {SOURCE_LABELS[value]}
        </button>
      ))}
    </div>
  );
}

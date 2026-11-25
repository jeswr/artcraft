import { useEffect, useRef } from 'react';
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
export function PodSourceSwitch({
  source,
  onChange,
  focusOnMount = false,
}: {
  source: GallerySource;
  onChange: (next: GallerySource) => void;
  /** The switch was re-created by the person choosing a source: put focus back on the chosen button if it was lost. */
  focusOnMount?: boolean;
}) {
  const access = usePodGalleryAccess();
  const group = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusOnMount) return;
    // Only when focus was lost with the switch that was replaced (it is on the page body then): focus
    // the person has since moved somewhere else is left alone.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    group.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
  }, [focusOnMount]);
  if (!access) return null;
  return (
    <div ref={group} role="group" aria-label="Library source" className="relative z-[51] flex items-center gap-0.5 rounded-[3px] bg-ui-controls/40 p-0.5">
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

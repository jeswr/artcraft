// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PodGalleryProvider } from './context.js';
import { PodSourceSwitch } from './PodSourceSwitch.js';

afterEach(cleanup);

describe('the gallery source switch', () => {
  it('is absent when no pod is connected', () => {
    const { container } = render(<PodSourceSwitch source="hosted" onChange={() => undefined} />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByText('My pod')).toBeNull();
  });

  it('offers the two sources when a pod is connected, with the current one pressed', () => {
    const onChange = vi.fn();
    render(
      <PodGalleryProvider access={{ sessionKey: 'k', open: async () => Promise.reject(new Error('unused')) }}>
        <PodSourceSwitch source="hosted" onChange={onChange} />
      </PodGalleryProvider>,
    );
    expect(screen.getByRole('button', { name: 'ArtCraft library' }).getAttribute('aria-pressed')).toBe('true');
    const pod = screen.getByRole('button', { name: 'My pod' });
    expect(pod.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pod);
    expect(onChange).toHaveBeenCalledWith('pod');
  });

  it('puts focus on the chosen button when it was just re-created by choosing a source', () => {
    render(
      <PodGalleryProvider access={{ sessionKey: 'k', open: async () => Promise.reject(new Error('unused')) }}>
        <PodSourceSwitch source="pod" onChange={() => undefined} focusOnMount />
      </PodGalleryProvider>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'My pod' }));
  });

  it('does not take focus when it first appears', () => {
    render(
      <PodGalleryProvider access={{ sessionKey: 'k', open: async () => Promise.reject(new Error('unused')) }}>
        <PodSourceSwitch source="hosted" onChange={() => undefined} />
      </PodGalleryProvider>,
    );
    expect(document.activeElement).toBe(document.body);
  });

  it('leaves focus alone when the person has moved it elsewhere since', () => {
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    render(
      <PodGalleryProvider access={{ sessionKey: 'k', open: async () => Promise.reject(new Error('unused')) }}>
        <PodSourceSwitch source="pod" onChange={() => undefined} focusOnMount />
      </PodGalleryProvider>,
    );
    expect(document.activeElement).toBe(other);
    other.remove();
  });
});

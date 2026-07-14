import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentBadge } from '../CanvasSpawnItems';

describe('AgentBadge contrast', () => {
  afterEach(cleanup);

  it.each([
    ['#000000', '#ffffff'],
    ['#ffffff', '#0a0a0d']
  ])('背景 %s に対してforeground %sを注入する', (background, foreground) => {
    const { container } = render(<AgentBadge label="L" color={background} />);
    const badge = container.querySelector<HTMLElement>('.canvas-role-dot');
    expect(badge?.style.getPropertyValue('--dot-color')).toBe(background);
    expect(badge?.style.getPropertyValue('--dot-foreground')).toBe(foreground);
  });
});

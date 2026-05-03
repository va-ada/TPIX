import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../ThemeContext';

// Consumer component that exposes toggleTheme for testing
function ToggleButton() {
  const { toggleTheme, theme } = useTheme();
  return <button onClick={toggleTheme} data-testid="toggle" data-theme={theme} />;
}

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

function setup(systemPrefersDark = false) {
  vi.stubGlobal('localStorage', localStorageMock);
  localStorageMock.clear();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' ? systemPrefersDark : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  document.documentElement.className = '';
}

describe('ThemeProvider', () => {
  beforeEach(() => setup());

  it('reads system preference on first mount (light)', () => {
    const { getByTestId } = render(
      <ThemeProvider>
        <ToggleButton />
      </ThemeProvider>,
    );
    expect(getByTestId('toggle').dataset.theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('reads system preference on first mount (dark)', () => {
    setup(true);
    const { getByTestId } = render(
      <ThemeProvider>
        <ToggleButton />
      </ThemeProvider>,
    );
    expect(getByTestId('toggle').dataset.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggleTheme twice flips class back to original', async () => {
    const { getByTestId } = render(
      <ThemeProvider>
        <ToggleButton />
      </ThemeProvider>,
    );

    const btn = getByTestId('toggle');

    // Initial: light → no dark class
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    // First toggle: light → dark
    await act(async () => btn.click());
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    // Second toggle: dark → light
    await act(async () => btn.click());
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('persists to localStorage on toggle', async () => {
    const { getByTestId } = render(
      <ThemeProvider>
        <ToggleButton />
      </ThemeProvider>,
    );

    await act(async () => getByTestId('toggle').click());
    expect(localStorage.getItem('theme')).toBe('dark');

    await act(async () => getByTestId('toggle').click());
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('restores stored theme from localStorage on mount', () => {
    localStorage.setItem('theme', 'dark');
    const { getByTestId } = render(
      <ThemeProvider>
        <ToggleButton />
      </ThemeProvider>,
    );
    expect(getByTestId('toggle').dataset.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

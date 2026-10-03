// Signal Forest design system. Source of truth: website/.tastemaker/style-lock.md.
// Every colour is a theme-aware CSS variable (src/index.css) so one class list
// renders Forest (light) and Forest Dark.
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'),
        fg: v('fg'),
        surface: v('surface'),
        panel: v('panel'),
        // Ground behind the collapsed nav rail; the page sits in an inset frame on top of it.
        rail: v('rail'),
        line: v('line'),
        // Primary: forest green in light, lime in dark. Labels on it use on-hot.
        hot: v('hot'),
        'on-hot': v('on-hot'),
        // Live dots and marks only; never text.
        signal: v('signal'),
        // Semantic inks.
        alert: v('alert'),
        amber: v('amber'),
        olive: v('olive'),
        cobalt: v('cobalt'),
        // Brand constants that must not flip with the theme (share cards).
        brand: { forest: '#0F5B3E', lime: '#C8F169', deep: '#0A2A1E' },
      },
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
        wordmark: ['Newsreader', 'Georgia', 'serif'],
      },
      fontSize: {
        // Style-lock scale. `label` is the smallest size in the app.
        label: ['0.625rem', { lineHeight: '0.875rem' }], // 10/14 mono 600 uppercase
        data: ['0.6875rem', { lineHeight: '1rem' }], // 11/16 mono tabular
        code: ['0.75rem', { lineHeight: '1.125rem' }], // 12/18 mono
        small: ['0.8125rem', { lineHeight: '1.25rem' }], // 13/20
        body: ['0.875rem', { lineHeight: '1.375rem' }], // 14/22
        lead: ['1rem', { lineHeight: '1.75rem' }], // 16/28
      },
      letterSpacing: {
        label: '0.16em',
        display: '-0.03em',
      },
      borderRadius: {
        chip: '6px',
        control: '8px',
        cell: '12px',
        card: '16px',
      },
      boxShadow: {
        soft: '0 8px 24px -16px rgb(var(--shadow) / 0.35)',
        'soft-md': '0 16px 40px -20px rgb(var(--shadow) / 0.4)',
        'soft-lg': 'var(--shadow-window)',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.23, 1, 0.32, 1)',
        'in-out': 'cubic-bezier(0.77, 0, 0.175, 1)',
        drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      animation: {
        pulse: 'pulse 1.5s ease-in-out infinite',
      },
      keyframes: {
        pulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
      },
    },
  },
  plugins: [],
};

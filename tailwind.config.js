export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Fixed palette (accents + intentional dark chips).
        cream: { DEFAULT: '#F4F0EA', dark: '#E8E4DE' },
        ink: { DEFAULT: '#111111', light: '#333333', lighter: '#666666' },
        vermilion: { DEFAULT: '#FF4500' },
        cobalt: { DEFAULT: '#2B5CE6' },
        olive: { DEFAULT: '#3A4D39' },
        // Semantic, theme-aware tokens (light/dark via CSS vars).
        bg: 'rgb(var(--bg) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        panel: 'rgb(var(--panel) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
      },
      fontFamily: {
        serif: ['Newsreader', 'serif'],
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      boxShadow: {
        soft: '0 4px 24px rgba(0,0,0,0.06)',
        'soft-md': '0 8px 40px rgba(0,0,0,0.08)',
        'soft-lg': '0 20px 60px rgba(0,0,0,0.08)',
        // Brutal shadow color follows the theme (ink on light, cream on dark).
        brutal: '4px 4px 0px 0px rgb(var(--brutal) / 1)',
        'brutal-lg': '8px 8px 0px 0px rgb(var(--brutal) / 1)',
        'brutal-sm': '2px 2px 0px 0px rgb(var(--brutal) / 1)',
        'brutal-vermilion': '4px 4px 0px 0px rgba(255,69,0,1)',
        'brutal-vermilion-lg': '8px 8px 0px 0px rgba(255,69,0,1)',
      },
      borderWidth: { 3: '3px' },
      animation: {
        marquee: 'marquee 20s linear infinite',
        pulse: 'pulse 1.5s ease-in-out infinite',
      },
      keyframes: {
        marquee: {
          '0%': { transform: 'translateX(0%)' },
          '100%': { transform: 'translateX(-100%)' },
        },
        pulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
      },
    },
  },
  plugins: [],
};

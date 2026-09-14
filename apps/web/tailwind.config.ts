import type { Config } from 'tailwindcss';
export default {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--bg) / <alpha-value>)', surface: 'rgb(var(--surface) / <alpha-value>)', 'surface-2': 'rgb(var(--surface-2) / <alpha-value>)', border: 'rgb(var(--border) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)', muted: 'rgb(var(--muted) / <alpha-value>)', brand: { DEFAULT: 'rgb(var(--brand) / <alpha-value>)', fg: 'rgb(var(--brand-fg) / <alpha-value>)', soft: 'rgb(var(--brand-soft) / <alpha-value>)' },
        success: 'rgb(var(--success) / <alpha-value>)', warning: 'rgb(var(--warning) / <alpha-value>)', danger: 'rgb(var(--danger) / <alpha-value>)', info: 'rgb(var(--info) / <alpha-value>)',
      },
      borderRadius: { xl: '0.9rem', '2xl': '1.25rem' },
      boxShadow: { card: '0 1px 2px rgb(15 23 42 / 0.04), 0 1px 3px rgb(15 23 42 / 0.06)', pop: '0 10px 40px -10px rgb(15 23 42 / 0.25)' },
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'Noto Sans Arabic', 'sans-serif'] },
    },
  },
  plugins: [],
} satisfies Config;

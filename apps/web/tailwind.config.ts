import type { Config } from 'tailwindcss';
export default {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--bg) / <alpha-value>)', surface: 'rgb(var(--surface) / <alpha-value>)', 'surface-2': 'rgb(var(--surface-2) / <alpha-value>)', border: 'rgb(var(--border) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)', muted: 'rgb(var(--muted) / <alpha-value>)',
        brand: { DEFAULT: 'rgb(var(--brand) / <alpha-value>)', fg: 'rgb(var(--brand-fg) / <alpha-value>)', soft: 'rgb(var(--brand-soft) / <alpha-value>)', deep: 'rgb(var(--brand-deep) / <alpha-value>)' },
        accent: { DEFAULT: 'rgb(var(--accent) / <alpha-value>)', soft: 'rgb(var(--accent-soft) / <alpha-value>)' },
        success: 'rgb(var(--success) / <alpha-value>)', warning: 'rgb(var(--warning) / <alpha-value>)', danger: 'rgb(var(--danger) / <alpha-value>)', info: 'rgb(var(--info) / <alpha-value>)',
        side: { DEFAULT: 'rgb(var(--side) / <alpha-value>)', fg: 'rgb(var(--side-fg) / <alpha-value>)', muted: 'rgb(var(--side-muted) / <alpha-value>)' },
      },
      borderRadius: { xl: '0.9rem', '2xl': '1.25rem', '3xl': '1.75rem' },
      boxShadow: {
        card: '0 1px 0 rgb(15 34 64 / 0.04), 0 10px 30px -18px rgb(15 34 64 / 0.18)',
        lift: '0 2px 0 rgb(15 34 64 / 0.04), 0 18px 40px -16px rgb(15 34 64 / 0.28)',
        pop: '0 24px 70px -20px rgb(15 34 64 / 0.45)',
        glow: '0 0 0 4px rgb(var(--brand) / 0.12)',
      },
      fontFamily: { sans: ['"Plus Jakarta Sans"', 'Inter', '"IBM Plex Sans Arabic"', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'sans-serif'] },
      backgroundImage: { hero: 'linear-gradient(135deg, rgb(var(--brand-deep)) 0%, rgb(var(--brand)) 55%, rgb(var(--brand-deep)) 100%)' },
    },
  },
  plugins: [],
} satisfies Config;

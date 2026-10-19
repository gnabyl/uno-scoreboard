import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,jsx,ts,tsx}', './index.html'],
  theme: {
    extend: {
      colors: {
        ink: '#0b0f18',
        panel: '#151b28',
        raised: '#1b2230',
        deep: '#0f1521',
        edge: '#2c3444',
        'edge-soft': '#202738',
        fg: '#e7ecf5',
        muted: '#9aa4b8',
        faint: '#5b6478',
        accent: '#4c9aff',
        brand: {
          red: '#e63946',
          orange: '#f4a261',
          teal: '#2a9d8f',
          blue: '#4c9aff',
          violet: '#7c5cff',
        },
      },
      boxShadow: {
        accent: '0 6px 16px rgba(76, 154, 255, 0.3)',
        panel: '0 18px 40px rgba(0, 0, 0, 0.35)',
        modal: '0 24px 60px rgba(0, 0, 0, 0.5)',
      },
      fontFamily: {
        mono: ['"SF Mono"', 'Consolas', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;

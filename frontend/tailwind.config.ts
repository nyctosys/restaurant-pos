/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Legacy soot palette (tailwind v3 config; v4 uses @theme in index.css)
        soot: {
          900: '#1a1a1a', // Deep charcoal / near black focus
          800: '#2d2d2d', // Medium charcoal
          700: '#404040', // Light charcoal
          100: '#f5f5f5', // Canvas white
          50: '#ffffff',  // Pure white
          // Accent colors based on standard premium luxury vibe
          accent: '#c8a97e', // Subtle gold/bronze accent
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'], // Premium clean sans
      }
    },
  },
  plugins: [],
}

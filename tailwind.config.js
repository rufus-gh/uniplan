/** Build: npm run css  (compiles uniplan/web/styles.css -> uniplan/web/static/app.css) */
module.exports = {
  content: ['./uniplan/web/templates/**/*.html', './uniplan/web/*.py'],
  // classes assembled at render time, e.g. badge-{{ tone }}
  safelist: [{ pattern: /^(badge|callout|notice)-(zinc|brand|sky|green|amber|red)$/ }],

    darkMode: 'class',
    theme: { extend: {
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'], mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'] },
      colors: {
        // neutrals: deep navy (surfaces, hairlines, muted text)
        zinc: { 50: '#f6f7fb', 100: '#eceef6', 200: '#d6d9e7', 300: '#b4b9d0', 400: '#8b91ae', 500: '#666c8b', 600: '#494e6b',
                700: '#2c304c', 800: '#1b1e38', 900: '#0e1129', 950: '#05071c' },
        // solid surfaces (no transparency, so nothing behind can band or smear)
        surface: { DEFAULT: '#0a0d24', raised: '#0d1028', sunken: '#080b22' },
        // personal brand: academic gold
        brand: { 50: '#fff9eb', 100: '#ffefc6', 200: '#ffde88', 300: '#ffc94a', 400: '#ffb21f', 500: '#f99207', 600: '#dd6c02',
                 700: '#b74a06', 800: '#94390c', 900: '#7a2f0d' },
      },
    } },
};

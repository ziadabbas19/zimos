'use strict';

/**
 * The fonts a merchant can pick for their store (Store settings → Fonts, the
 * website and funnel editors, the product page). Every family is a Google
 * Fonts family, checked against Google's own metadata when this list was
 * written: a font in the Arabic list has the `arabic` subset, every font has
 * `latin`, the weights are the family's non-italic styles and `variable` is
 * the range of its `wght` axis (absent: the family has fixed weights only).
 *
 * This is the one list. The API refuses any font id that is not here
 * (fontValidation.js), and the dashboard and the storefront read it from
 * GET /api/v1/fonts — no other place names a family. A merchant never sends a
 * family name or any CSS: only an id, looked up here.
 *
 *   id        what is stored (themeSettings.fonts, a page tree, a product)
 *   family    the Google Fonts family name
 *   script    'ar' an Arabic face; 'latin' a Latin face; 'both' a face
 *             designed for Arabic and Latin text alike — offered for either
 *   category  sans | serif | display | handwriting | mono | kufi | naskh | ruqaa
 *   weights   the static weights the family has
 *   variable  [min, max] of its weight axis, when it has one
 *
 * Adding a font: append it with its real subsets and weights. Removing one is a
 * breaking change for any store that saved it — the storefront then draws
 * that part in the store default — so retire fonts rather than delete them.
 */

const FONT_SCRIPTS = Object.freeze(['ar', 'latin', 'both']);
const FONT_CATEGORIES = Object.freeze(['sans', 'serif', 'display', 'handwriting', 'mono', 'kufi', 'naskh', 'ruqaa']);

/** What the pickers write in a font's own face, by script. */
const PREVIEW_TEXT = Object.freeze({
  ar: 'متجرك بخط يليق به ١٢٣',
  latin: 'Your store, beautifully set 123',
  both: 'متجرك Your store 123',
});

const ENTRIES = [
  { id: 'cairo', family: 'Cairo', script: 'both', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [200, 1000] },
  { id: 'tajawal', family: 'Tajawal', script: 'both', category: 'sans', weights: [200, 300, 400, 500, 700, 800, 900] },
  { id: 'almarai', family: 'Almarai', script: 'ar', category: 'sans', weights: [300, 400, 700, 800] },
  { id: 'noto-kufi-arabic', family: 'Noto Kufi Arabic', script: 'both', category: 'kufi', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 900] },
  { id: 'noto-naskh-arabic', family: 'Noto Naskh Arabic', script: 'ar', category: 'naskh', weights: [400, 500, 600, 700], variable: [400, 700] },
  { id: 'noto-sans-arabic', family: 'Noto Sans Arabic', script: 'both', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 900] },
  { id: 'ibm-plex-sans-arabic', family: 'IBM Plex Sans Arabic', script: 'both', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700] },
  { id: 'readex-pro', family: 'Readex Pro', script: 'both', category: 'sans', weights: [200, 300, 400, 500, 600, 700], variable: [160, 700] },
  { id: 'changa', family: 'Changa', script: 'both', category: 'display', weights: [200, 300, 400, 500, 600, 700, 800], variable: [200, 800] },
  { id: 'el-messiri', family: 'El Messiri', script: 'both', category: 'display', weights: [400, 500, 600, 700], variable: [400, 700] },
  { id: 'amiri', family: 'Amiri', script: 'ar', category: 'naskh', weights: [400, 700] },
  { id: 'reem-kufi', family: 'Reem Kufi', script: 'ar', category: 'kufi', weights: [400, 500, 600, 700], variable: [400, 700] },
  { id: 'lalezar', family: 'Lalezar', script: 'ar', category: 'display', weights: [400] },
  { id: 'markazi-text', family: 'Markazi Text', script: 'ar', category: 'naskh', weights: [400, 500, 600, 700], variable: [400, 700] },
  { id: 'mada', family: 'Mada', script: 'ar', category: 'sans', weights: [200, 300, 400, 500, 600, 700, 800, 900], variable: [200, 900] },
  { id: 'vazirmatn', family: 'Vazirmatn', script: 'both', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 900] },
  { id: 'aref-ruqaa', family: 'Aref Ruqaa', script: 'ar', category: 'ruqaa', weights: [400, 700] },
  { id: 'rakkas', family: 'Rakkas', script: 'ar', category: 'display', weights: [400] },
  { id: 'lemonada', family: 'Lemonada', script: 'both', category: 'display', weights: [300, 400, 500, 600, 700], variable: [300, 700] },
  { id: 'harmattan', family: 'Harmattan', script: 'ar', category: 'sans', weights: [400, 500, 600, 700] },
  { id: 'scheherazade-new', family: 'Scheherazade New', script: 'ar', category: 'naskh', weights: [400, 500, 600, 700] },
  { id: 'baloo-bhaijaan-2', family: 'Baloo Bhaijaan 2', script: 'both', category: 'display', weights: [400, 500, 600, 700, 800], variable: [400, 800] },
  { id: 'kufam', family: 'Kufam', script: 'both', category: 'kufi', weights: [400, 500, 600, 700, 800, 900], variable: [400, 900] },
  { id: 'rubik', family: 'Rubik', script: 'both', category: 'sans', weights: [300, 400, 500, 600, 700, 800, 900], variable: [300, 900] },
  { id: 'alexandria', family: 'Alexandria', script: 'both', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 900] },
  { id: 'fustat', family: 'Fustat', script: 'both', category: 'sans', weights: [200, 300, 400, 500, 600, 700, 800], variable: [200, 800] },
  { id: 'zain', family: 'Zain', script: 'ar', category: 'sans', weights: [200, 300, 400, 700, 800, 900] },
  { id: 'lateef', family: 'Lateef', script: 'ar', category: 'naskh', weights: [200, 300, 400, 500, 600, 700, 800] },
  { id: 'qahiri', family: 'Qahiri', script: 'ar', category: 'kufi', weights: [400] },
  { id: 'beiruti', family: 'Beiruti', script: 'both', category: 'sans', weights: [200, 300, 400, 500, 600, 700, 800, 900], variable: [200, 900] },
  { id: 'ruwudu', family: 'Ruwudu', script: 'ar', category: 'display', weights: [400, 500, 600, 700] },
  { id: 'badeen-display', family: 'Badeen Display', script: 'ar', category: 'display', weights: [400] },
  { id: 'gulzar', family: 'Gulzar', script: 'ar', category: 'display', weights: [400] },
  { id: 'playpen-sans-arabic', family: 'Playpen Sans Arabic', script: 'both', category: 'handwriting', weights: [100, 200, 300, 400, 500, 600, 700, 800], variable: [100, 800] },
  { id: 'jomhuria', family: 'Jomhuria', script: 'ar', category: 'display', weights: [400] },
  { id: 'alkalami', family: 'Alkalami', script: 'ar', category: 'serif', weights: [400] },
  { id: 'alan-sans', family: 'Alan Sans', script: 'both', category: 'sans', weights: [300, 400, 500, 600, 700, 800, 900], variable: [300, 900] },
  { id: 'mirza', family: 'Mirza', script: 'ar', category: 'naskh', weights: [400, 500, 600, 700] },
  { id: 'alyamama', family: 'Alyamama', script: 'ar', category: 'serif', weights: [300, 400, 500, 600, 700, 800, 900], variable: [300, 900] },
  { id: 'marhey', family: 'Marhey', script: 'both', category: 'display', weights: [300, 400, 500, 600, 700], variable: [300, 700] },
  { id: 'katibeh', family: 'Katibeh', script: 'ar', category: 'display', weights: [400] },
  { id: 'estedad', family: 'Estedad', script: 'both', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 900] },
  { id: 'vibes', family: 'Vibes', script: 'ar', category: 'display', weights: [400] },
  { id: 'blaka', family: 'Blaka', script: 'ar', category: 'display', weights: [400] },
  { id: 'parastoo', family: 'Parastoo', script: 'ar', category: 'serif', weights: [400, 500, 600, 700], variable: [400, 700] },
  { id: 'firjar', family: 'Firjar', script: 'ar', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800], variable: [100, 800] },
  { id: 'inter', family: 'Inter', script: 'latin', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 900] },
  { id: 'poppins', family: 'Poppins', script: 'latin', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { id: 'montserrat', family: 'Montserrat', script: 'latin', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 900] },
  { id: 'playfair-display', family: 'Playfair Display', script: 'latin', category: 'serif', weights: [400, 500, 600, 700, 800, 900], variable: [400, 900] },
  { id: 'lora', family: 'Lora', script: 'latin', category: 'serif', weights: [400, 500, 600, 700], variable: [400, 700] },
  { id: 'dm-sans', family: 'DM Sans', script: 'latin', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 1000] },
  { id: 'manrope', family: 'Manrope', script: 'latin', category: 'sans', weights: [200, 300, 400, 500, 600, 700, 800], variable: [200, 800] },
  { id: 'space-grotesk', family: 'Space Grotesk', script: 'latin', category: 'sans', weights: [300, 400, 500, 600, 700], variable: [300, 700] },
  { id: 'raleway', family: 'Raleway', script: 'latin', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 900] },
  { id: 'oswald', family: 'Oswald', script: 'latin', category: 'sans', weights: [200, 300, 400, 500, 600, 700], variable: [200, 700] },
  { id: 'bebas-neue', family: 'Bebas Neue', script: 'latin', category: 'sans', weights: [400] },
  { id: 'merriweather', family: 'Merriweather', script: 'latin', category: 'serif', weights: [300, 400, 500, 600, 700, 800, 900], variable: [300, 900] },
  { id: 'roboto', family: 'Roboto', script: 'latin', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 900] },
  { id: 'open-sans', family: 'Open Sans', script: 'latin', category: 'sans', weights: [300, 400, 500, 600, 700, 800], variable: [300, 800] },
  { id: 'lato', family: 'Lato', script: 'latin', category: 'sans', weights: [100, 300, 400, 700, 900] },
  { id: 'nunito', family: 'Nunito', script: 'latin', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [200, 1000] },
  { id: 'nunito-sans', family: 'Nunito Sans', script: 'latin', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [200, 1000] },
  { id: 'work-sans', family: 'Work Sans', script: 'latin', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 900] },
  { id: 'outfit', family: 'Outfit', script: 'latin', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 900] },
  { id: 'plus-jakarta-sans', family: 'Plus Jakarta Sans', script: 'latin', category: 'sans', weights: [200, 300, 400, 500, 600, 700, 800], variable: [200, 800] },
  { id: 'sora', family: 'Sora', script: 'latin', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800], variable: [100, 800] },
  { id: 'urbanist', family: 'Urbanist', script: 'latin', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 900] },
  { id: 'lexend', family: 'Lexend', script: 'latin', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 900] },
  { id: 'figtree', family: 'Figtree', script: 'latin', category: 'sans', weights: [300, 400, 500, 600, 700, 800, 900], variable: [300, 900] },
  { id: 'jost', family: 'Jost', script: 'latin', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 900] },
  { id: 'archivo', family: 'Archivo', script: 'latin', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 900] },
  { id: 'source-sans-3', family: 'Source Sans 3', script: 'latin', category: 'sans', weights: [200, 300, 400, 500, 600, 700, 800, 900], variable: [200, 900] },
  { id: 'libre-baskerville', family: 'Libre Baskerville', script: 'latin', category: 'serif', weights: [400, 500, 600, 700], variable: [400, 700] },
  { id: 'cormorant-garamond', family: 'Cormorant Garamond', script: 'latin', category: 'serif', weights: [300, 400, 500, 600, 700], variable: [300, 700] },
  { id: 'eb-garamond', family: 'EB Garamond', script: 'latin', category: 'serif', weights: [400, 500, 600, 700, 800], variable: [400, 800] },
  { id: 'dm-serif-display', family: 'DM Serif Display', script: 'latin', category: 'serif', weights: [400] },
  { id: 'fraunces', family: 'Fraunces', script: 'latin', category: 'serif', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 900] },
  { id: 'bodoni-moda', family: 'Bodoni Moda', script: 'latin', category: 'serif', weights: [400, 500, 600, 700, 800, 900], variable: [400, 900] },
  { id: 'abril-fatface', family: 'Abril Fatface', script: 'latin', category: 'display', weights: [400] },
  { id: 'anton', family: 'Anton', script: 'latin', category: 'sans', weights: [400] },
  { id: 'archivo-black', family: 'Archivo Black', script: 'latin', category: 'sans', weights: [400] },
  { id: 'righteous', family: 'Righteous', script: 'latin', category: 'display', weights: [400] },
  { id: 'pacifico', family: 'Pacifico', script: 'latin', category: 'handwriting', weights: [400] },
  { id: 'dancing-script', family: 'Dancing Script', script: 'latin', category: 'handwriting', weights: [400, 500, 600, 700], variable: [400, 700] },
  { id: 'caveat', family: 'Caveat', script: 'latin', category: 'handwriting', weights: [400, 500, 600, 700], variable: [400, 700] },
  { id: 'great-vibes', family: 'Great Vibes', script: 'latin', category: 'handwriting', weights: [400] },
  { id: 'lobster', family: 'Lobster', script: 'latin', category: 'display', weights: [400] },
  { id: 'space-mono', family: 'Space Mono', script: 'latin', category: 'mono', weights: [400, 700] },
  { id: 'jetbrains-mono', family: 'JetBrains Mono', script: 'latin', category: 'mono', weights: [100, 200, 300, 400, 500, 600, 700, 800], variable: [100, 800] },
  { id: 'ibm-plex-sans', family: 'IBM Plex Sans', script: 'latin', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700], variable: [100, 700] },
  { id: 'josefin-sans', family: 'Josefin Sans', script: 'latin', category: 'sans', weights: [100, 200, 300, 400, 500, 600, 700], variable: [100, 700] },
  { id: 'quicksand', family: 'Quicksand', script: 'latin', category: 'sans', weights: [300, 400, 500, 600, 700], variable: [300, 700] },
  { id: 'comfortaa', family: 'Comfortaa', script: 'latin', category: 'display', weights: [300, 400, 500, 600, 700], variable: [300, 700] },
  { id: 'pt-serif', family: 'PT Serif', script: 'latin', category: 'serif', weights: [400, 700] },
  { id: 'syne', family: 'Syne', script: 'latin', category: 'sans', weights: [400, 500, 600, 700, 800], variable: [400, 800] },
  { id: 'marcellus', family: 'Marcellus', script: 'latin', category: 'serif', weights: [400] },
  { id: 'cinzel', family: 'Cinzel', script: 'latin', category: 'serif', weights: [400, 500, 600, 700, 800, 900], variable: [400, 900] },
  { id: 'prata', family: 'Prata', script: 'latin', category: 'serif', weights: [400] },
  { id: 'unbounded', family: 'Unbounded', script: 'latin', category: 'sans', weights: [200, 300, 400, 500, 600, 700, 800, 900], variable: [200, 900] },
  { id: 'instrument-serif', family: 'Instrument Serif', script: 'latin', category: 'serif', weights: [400] },
  { id: 'bricolage-grotesque', family: 'Bricolage Grotesque', script: 'latin', category: 'sans', weights: [200, 300, 400, 500, 600, 700, 800], variable: [200, 800] },
];

const FONT_CATALOG = Object.freeze(
  ENTRIES.map((entry) =>
    Object.freeze({
      ...entry,
      weights: Object.freeze([...entry.weights]),
      ...(entry.variable ? { variable: Object.freeze([...entry.variable]) } : {}),
      preview: PREVIEW_TEXT[entry.script],
    })
  )
);

const FONTS_BY_ID = new Map(FONT_CATALOG.map((font) => [font.id, font]));

/** The font with this id, or null. */
function fontById(id) {
  return typeof id === 'string' ? FONTS_BY_ID.get(id) || null : null;
}

/** Whether `id` names a font the merchant may use for text in `script` ('ar' or 'latin'; absent: either). */
function isFontId(id, script) {
  const font = fontById(id);
  if (!font) return false;
  if (!script) return true;
  return font.script === 'both' || font.script === script;
}

/** Changes whenever the list does, so a client that caches the catalog can tell. */
const CATALOG_VERSION = require('crypto').createHash('sha1').update(JSON.stringify(FONT_CATALOG)).digest('hex').slice(0, 12);

/** The catalog as GET /api/v1/fonts answers it. */
function publicCatalog() {
  return { version: CATALOG_VERSION, scripts: FONT_SCRIPTS, categories: FONT_CATEGORIES, fonts: FONT_CATALOG };
}

module.exports = { FONT_CATALOG, FONT_SCRIPTS, FONT_CATEGORIES, fontById, isFontId, publicCatalog, CATALOG_VERSION };

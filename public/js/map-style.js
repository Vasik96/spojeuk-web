// Styl podkladové mapy. Stejný jako v Android appce: CARTO Voyager (světlý) a Dark Matter (tmavý),
// tmavý se jako v MapScreen.kt (softenDark) zesvětlí, aby nebyl úplně černý.
// Adresy stylů dodává server (/api/map-config), takže API klíč CARTO není v kódu ani v gitu.

/** @returns {Promise<{provider:string, light:string, dark:string}|null>} */
export async function loadMapConfig(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch { return null; }
}

const has = (id, s) => String(id).includes(s);

/**
 * Port softenDark() z MapScreen.kt (pozadí #2a2f3a, voda #1d3144, plochy #323845, budovy #3a4150, silnice #5b6475).
 * U záložního stylu (OpenFreeMap Positron) se navíc přebarví popisky a okraje, protože ten je světlý.
 */
export function softenDark(style, { recolorLabels = false } = {}) {
  for (const l of style.layers || []) {
    l.paint ||= {};
    const id = l.id || '';
    if (l.type === 'background') l.paint['background-color'] = '#2a2f3a';
    else if (l.type === 'fill' && has(id, 'water')) l.paint['fill-color'] = '#1d3144';
    else if (l.type === 'fill' && (has(id, 'landcover') || has(id, 'landuse') || has(id, 'park') || has(id, 'wood') || has(id, 'grass'))) l.paint['fill-color'] = '#323845';
    else if (l.type === 'fill' && has(id, 'building')) l.paint['fill-color'] = '#3a4150';
    else if (l.type === 'line' && has(id, 'road') && !has(id, 'casing')) l.paint['line-color'] = '#5b6475';
    else if (recolorLabels && l.type === 'line' && (has(id, 'casing') || has(id, 'bridge') || has(id, 'tunnel') || has(id, 'rail') || has(id, 'path') || has(id, 'aeroway'))) l.paint['line-color'] = '#454c5b';
    else if (recolorLabels && l.type === 'line' && (has(id, 'boundary') || has(id, 'admin'))) l.paint['line-color'] = '#6b7385';
    else if (recolorLabels && l.type === 'fill' && (has(id, 'aeroway') || has(id, 'pier') || has(id, 'residential'))) l.paint['fill-color'] = '#2f3541';
    if (recolorLabels && l.type === 'symbol') { l.paint['text-color'] = '#c9d1e0'; l.paint['text-halo-color'] = '#2a2f3a'; }
  }
  return style;
}

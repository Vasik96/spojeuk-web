// Frontend i API běží na stejném serveru.
const API = '';

export const CONFIG = {
  API_BASE: API,
  TIMETABLE_URL: `${API}/data/timetable.json`,
  SHAPES_URL: `${API}/data/shapes.bin`,    // přesné trasy spojů (bez něj se kreslí přímky mezi zastávkami)
  POLL_MS: 8000,
  // Podkladová mapa: MapLibre se stylem z /api/map-config (CARTO Voyager / Dark Matter jako v Android appce; klíč drží server)
  MAP_CONFIG_URL: `${API}/api/map-config`,
  MAP_CENTER: [50.66, 14.04], // Ústí nad Labem
  LATE_MIN: 3,                // od kolika minut se zpoždění zobrazuje červeně
};

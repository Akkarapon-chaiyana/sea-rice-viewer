export const CELL_DEG = 0.5; // 0.5° ≈ 50 km at equator

/** Stable string ID for a grid cell from its SW corner */
export function cellId(lon, lat) {
  const f = (n, d) => Math.abs(n).toFixed(1).padStart(d, '0');
  return `${lon >= 0 ? 'E' : 'W'}${f(lon, 5)}${lat >= 0 ? 'N' : 'S'}${f(lat, 4)}`;
}

/** [west, south, east, north] bbox for a cell */
export function cellBbox(lon, lat) {
  return [
    parseFloat(lon.toFixed(2)),
    parseFloat(lat.toFixed(2)),
    parseFloat((lon + CELL_DEG).toFixed(2)),
    parseFloat((lat + CELL_DEG).toFixed(2)),
  ];
}

/**
 * Generate GeoJSON features for grid cells covering the map viewport.
 * Only runs when zoom >= 5; caps at 2500 cells to stay performant.
 */
export function generateVisibleGrid(map, selectedIds) {
  const zoom = map.getZoom();
  if (zoom < 5) return [];

  const b = map.getBounds();
  const west  = Math.floor(b.getWest() / CELL_DEG) * CELL_DEG;
  const south = Math.floor(Math.max(b.getSouth(), -85) / CELL_DEG) * CELL_DEG;
  const east  = Math.ceil(Math.min(b.getEast(),  180) / CELL_DEG) * CELL_DEG;
  const north = Math.ceil(Math.min(b.getNorth(),  85) / CELL_DEG) * CELL_DEG;

  const features = [];
  const MAX_CELLS = 2500;

  outer:
  for (let lon = west; lon < east; lon = round(lon + CELL_DEG)) {
    for (let lat = south; lat < north; lat = round(lat + CELL_DEG)) {
      if (features.length >= MAX_CELLS) break outer;
      const id = cellId(lon, lat);
      features.push({
        type: 'Feature',
        properties: { id, lon, lat, selected: selectedIds.has(id) },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [lon, lat],
            [round(lon + CELL_DEG), lat],
            [round(lon + CELL_DEG), round(lat + CELL_DEG)],
            [lon, round(lat + CELL_DEG)],
            [lon, lat],
          ]],
        },
      });
    }
  }
  return features;
}

function round(n) { return parseFloat(n.toFixed(2)); }

/**
 * Generate all grid cells covering a WGS84 bbox [minLon, minLat, maxLon, maxLat].
 * Returns array of { id, bbox } objects. Capped at MAX_CELLS.
 */
export function generateCellsForBbox(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const west  = Math.floor(Math.max(minLon, -180) / CELL_DEG) * CELL_DEG;
  const south = Math.floor(Math.max(minLat,  -85) / CELL_DEG) * CELL_DEG;
  const east  = Math.ceil(Math.min(maxLon,  180) / CELL_DEG) * CELL_DEG;
  const north = Math.ceil(Math.min(maxLat,   85) / CELL_DEG) * CELL_DEG;

  const cells = [];
  for (let lon = west; lon < east; lon = round(lon + CELL_DEG)) {
    for (let lat = south; lat < north; lat = round(lat + CELL_DEG)) {
      cells.push({ id: cellId(lon, lat), bbox: cellBbox(lon, lat) });
    }
  }
  return cells;
}

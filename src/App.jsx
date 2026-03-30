import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import './App.css';
import ExportModal from './ExportModal';
import { generateVisibleGrid, cellBbox, generateCellsForBbox } from './utils/gridTiles';

// ── Constants ────────────────────────────────────────────────────────────────
const ASSET_PREFIX = 'projects/tony-1122/assets/NIE/rice/';
const GEE_API      = 'https://earthengine.googleapis.com/v1';
const GRID_STEP    = 0.5;  // 0.5° ≈ 55 km, matches gridTiles.js CELL_DEG
// Bounding box covering all SEA countries
const SEA_BBOX     = [92.1, -11.0, 141.0, 28.5];

const COUNTRIES = [
  { label: 'Thailand',    slug: 'thailand',    iso: 'THA', gaul: 'Thailand',                         center: [100.5,  13.5], zoom: 5,  bbox: [ 97.3,  5.5, 105.7, 20.5] },
  { label: 'Myanmar',     slug: 'myanmar',     iso: 'MMR', gaul: 'Myanmar',                          center: [ 96.0,  19.0], zoom: 5,  bbox: [ 92.1,  9.6, 101.2, 28.5] },
  { label: 'Vietnam',     slug: 'vietnam',     iso: 'VNM', gaul: 'Viet Nam',                         center: [106.0,  16.0], zoom: 5,  bbox: [102.1,  8.3, 109.5, 23.4] },
  { label: 'Laos',        slug: 'laos',        iso: 'LAO', gaul: "Lao People's Democratic Republic", center: [103.0,  18.0], zoom: 6,  bbox: [100.1, 13.9, 107.7, 22.5] },
  { label: 'Cambodia',    slug: 'cambodia',    iso: 'KHM', gaul: 'Cambodia',                         center: [105.0,  12.5], zoom: 6,  bbox: [102.3,  9.9, 107.7, 14.7] },
  { label: 'Philippines', slug: 'philippines', iso: 'PHL', gaul: 'Philippines',                      center: [122.0,  12.0], zoom: 5,  bbox: [116.9,  4.6, 126.6, 20.5] },
  { label: 'Malaysia',    slug: 'malaysia',    iso: 'MYS', gaul: 'Malaysia',                         center: [109.0,   3.5], zoom: 5,  bbox: [ 99.6,  0.8, 119.3,  7.4] },
  { label: 'Indonesia',   slug: 'indonesia',   iso: 'IDN', gaul: 'Indonesia',                        center: [113.0,  -1.0], zoom: 5,  bbox: [ 95.0,-11.0, 141.0,  5.9] },
  { label: 'Brunei',      slug: 'brunei',      iso: 'BRN', gaul: 'Brunei Darussalam',                center: [114.7,   4.5], zoom: 8,  bbox: [114.1,  4.0, 115.4,  5.1] },
  { label: 'Timor-Leste', slug: 'timor',       iso: 'TLS', gaul: 'Timor-Leste',                      center: [125.5,  -8.8], zoom: 8,  bbox: [124.0, -9.5, 127.4, -8.1] },
  { label: 'Singapore',   slug: 'singapore',   iso: 'SGP', gaul: 'Singapore',                        center: [103.8,   1.35], zoom: 10, bbox: [103.6,  1.1, 104.1,  1.5] },
];

// ── SEA-wide 50 km grid (line overlay) ───────────────────────────────────────
function generateSEAGrid() {
  const [west, south, east, north] = SEA_BBOX;
  const s = GRID_STEP;
  const features = [];
  for (let lon = Math.floor(west/s)*s; lon <= east;  lon = +(lon+s).toFixed(6))
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[lon, south], [lon, north]] } });
  for (let lat = Math.floor(south/s)*s; lat <= north; lat = +(lat+s).toFixed(6))
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[west, lat], [east, lat]] } });
  return { type: 'FeatureCollection', features };
}

const SEA_GAUL_NAMES = COUNTRIES.map(c => c.gaul);

const YEARS = ['2019', '2020', '2021', '2022', '2023'];

const LAYER_TYPES = [
  {
    id: 'Mean', label: '5-Fold Ensemble Probability', color: '#e06c75',
    vis: { ranges: [{ min: 0, max: 100 }], paletteColors: ['ffffff','ffff00','ffa500','ff0000','800080'] },
    assetFn: (slug, year) => `${ASSET_PREFIX}SEA_Avg_${slug}_${year}`,
    isBinary: false,
    legendType: 'gradient', legendLabel: 'Probability (%)', legendMin: 0, legendMax: 100,
    legendPalette: ['#ffffff','#ffff00','#ffa500','#ff0000','#800080'],
  },
  {
    id: 'Std', label: 'Standard Deviation', color: '#e5c07b',
    vis: { ranges: [{ min: 0, max: 45 }], paletteColors: ['ffffff','ffff00','ffa500','ff0000','800080'] },
    assetFn: (slug, year) => `${ASSET_PREFIX}SEA_Std_${slug}_${year}`,
    isBinary: false,
    legendType: 'gradient', legendLabel: 'Std Dev', legendMin: 0, legendMax: 45,
    legendPalette: ['#ffffff','#ffff00','#ffa500','#ff0000','#800080'],
  },
  {
    id: 'Binary', label: 'Binary (prob ≥ 50%)', color: '#61afef',
    vis: { ranges: [{ min: 0, max: 1 }], paletteColors: ['000000','00ff00'] },
    assetFn: (slug, year) => `${ASSET_PREFIX}SEA_Avg_${slug}_${year}`,
    isBinary: true,
    legendType: 'swatch',
    legendSwatches: [
      { color: '#000000', label: 'Masked / Non-rice' },
      { color: '#00ff00', label: 'Rice (prob ≥ 50%)' },
    ],
  },
  {
    id: 'Pseudo', label: 'Pseudo-Labeling', color: '#98c379',
    vis: { ranges: [{ min: 0, max: 2 }], paletteColors: ['000000','008000','ff0000'] },
    assetFn: (slug, year) => `${ASSET_PREFIX}SEA_Pseu_${slug}_${year}`,
    isBinary: false,
    legendType: 'swatch',
    legendSwatches: [
      { color: '#000000', label: '0 — Non-rice' },
      { color: '#008000', label: '1 — Rice' },
      { color: '#ff0000', label: '255 — Masked' },
    ],
  },
];

const BASEMAPS = [
  {
    id: 'satellite', label: 'Satellite',
    style: {
      version: 8,
      sources: {
        'esri-sat': {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256, maxzoom: 19, attribution: '© Esri',
        },
      },
      layers: [{ id: 'satellite-bg', type: 'raster', source: 'esri-sat' }],
    },
  },
  { id: 'dark',    label: 'Dark',    url: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json' },
  { id: 'streets', label: 'Streets', url: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json' },
  { id: 'light',   label: 'Light',   url: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json' },
];

// ── GEE expression helpers ───────────────────────────────────────────────────
function buildGAULTable() {
  return {
    functionInvocationValue: {
      functionName: 'Collection.loadTable',
      arguments: { tableId: { constantValue: 'FAO/GAUL/2015/level0' } },
    },
  };
}

function buildCountryFilter(gaulName) {
  return {
    functionInvocationValue: {
      functionName: 'Collection.filter',
      arguments: {
        collection: buildGAULTable(),
        filter: {
          functionInvocationValue: {
            functionName: 'Filter.eq',
            arguments: {
              leftField:  { constantValue: 'ADM0_NAME' },
              rightValue: { constantValue: gaulName },
            },
          },
        },
      },
    },
  };
}

function buildSEAFilter() {
  // Filter.or with individual Filter.eq per country — avoids Filter.inList uncertainty
  return {
    functionInvocationValue: {
      functionName: 'Collection.filter',
      arguments: {
        collection: buildGAULTable(),
        filter: {
          functionInvocationValue: {
            functionName: 'Filter.or',
            arguments: {
              filters: {
                arrayValue: {
                  values: SEA_GAUL_NAMES.map(name => ({
                    functionInvocationValue: {
                      functionName: 'Filter.eq',
                      arguments: {
                        leftField:  { constantValue: 'ADM0_NAME' },
                        rightValue: { constantValue: name },
                      },
                    },
                  })),
                },
              },
            },
          },
        },
      },
    },
  };
}

// Outline-only boundary: paint width=N pixels on an empty image, then selfMask
// so interior pixels (value 0) are transparent and only the outline (value 1) renders.
function buildBoundaryExpression(collectionExpr, lineWidth = 2) {
  return {
    result: '0',
    values: {
      '0': {
        functionInvocationValue: {
          functionName: 'Image.selfMask',
          arguments: {
            image: {
              functionInvocationValue: {
                functionName: 'Image.paint',
                arguments: {
                  image: {
                    functionInvocationValue: {
                      functionName: 'Image.constant',
                      arguments: { value: { constantValue: 0 } },
                    },
                  },
                  featureCollection: collectionExpr,
                  color: { constantValue: 1 },
                  width: { constantValue: lineWidth },
                },
              },
            },
          },
        },
      },
    },
  };
}

function buildExpression(assetPath, gaulName, isBinary) {
  const loadExpr = {
    functionInvocationValue: {
      functionName: 'Image.load',
      arguments: { id: { constantValue: assetPath } },
    },
  };

  const imgExpr = isBinary
    ? {
        functionInvocationValue: {
          functionName: 'Image.selfMask',
          arguments: {
            image: {
              functionInvocationValue: {
                functionName: 'Image.gte',
                arguments: {
                  image1: loadExpr,
                  image2: {
                    functionInvocationValue: {
                      functionName: 'Image.constant',
                      arguments: { value: { constantValue: 50 } },
                    },
                  },
                },
              },
            },
          },
        },
      }
    : loadExpr;

  return {
    result: '0',
    values: {
      '0': {
        functionInvocationValue: {
          functionName: 'Image.clip',
          arguments: {
            input:    imgExpr,
            geometry: buildCountryFilter(gaulName),
          },
        },
      },
    },
  };
}

// ── Initial layer state ──────────────────────────────────────────────────────
function initLayers() {
  const s = {};
  LAYER_TYPES.forEach(lt => {
    s[lt.id] = { enabled: false, opacity: 0.85, loading: false, error: null, mapName: null, tileUrl: null };
  });
  return s;
}

// ── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const mapEl      = useRef(null);
  const mapRef     = useRef(null);
  const tokenRef   = useRef('');
  const projectRef = useRef('');
  const layersRef  = useRef(initLayers());
  const seaOnRef   = useRef(false);
  const gridOnRef  = useRef(false);
  const countryRef = useRef('Thailand');
  // Store boundary tile URLs so they can be restored after basemap switch
  const boundaryTilesRef  = useRef({ country: null, sea: null });
  // Request counter — ensures only the latest country boundary request is applied
  const boundaryReqRef    = useRef(0);

  const [country,     setCountry]     = useState('Thailand');
  const [year,        setYear]        = useState('2021');
  const [basemap,     setBasemap]     = useState('satellite');
  const [projectId,   setProjectId]   = useState('');
  const [tokenStatus, setTokenStatus] = useState(null);
  const [layers,      setLayers]      = useState(initLayers);
  const [seaOn,       setSeaOn]       = useState(false);
  const [gridOn,      setGridOn]      = useState(false);
  const [exportOpen,  setExportOpen]  = useState(false);

  // ── Tile-selection state (for export) ─────────────────────────────────────
  // selectedTiles: Map<id, { id, bbox:[w,s,e,n] }> — viewport-wide, SEA grid
  const tileSelectRef       = useRef(false);
  const selectedTilesRef    = useRef(new Map());
  const updateTileGridRef   = useRef(null);   // accessible from style.load closure
  const tileClickHandlerRef = useRef(null);
  const tileMoveHandlerRef  = useRef(null);
  const tileEnterHandlerRef = useRef(null);
  const tileLeaveHandlerRef = useRef(null);
  const [tileSelectActive, setTileSelectActive] = useState(false);
  const [selectedTiles,    setSelectedTiles]    = useState(() => new Map());

  // ── Fetch a GEE map tile URL from an expression ──────────────────────────
  const fetchGEETileUrl = useCallback(async (expression, visOptions) => {
    const body = { expression, fileFormat: 'PNG' };
    if (visOptions) body.visualizationOptions = visOptions;
    const res = await fetch(`${GEE_API}/projects/${projectRef.current}/maps`, {
      method: 'POST',
      headers: {
        Authorization:      `Bearer ${tokenRef.current}`,
        'x-goog-user-project': projectRef.current,
        'Content-Type':     'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message || `HTTP ${res.status}`);
    const { name } = await res.json();
    return `${GEE_API}/${name}/tiles/{z}/{x}/{y}`;
  }, []);

  // ── Add a raster tile layer to the map ───────────────────────────────────
  const addRasterLayer = useCallback((map, sourceId, layerId, tileUrl, opacity = 1) => {
    if (map.getLayer(layerId))   map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
    map.addSource(sourceId, { type: 'raster', tiles: [tileUrl], tileSize: 256 });
    map.addLayer({ id: layerId, type: 'raster', source: sourceId,
      paint: { 'raster-opacity': opacity } });
  }, []);

  // ── Load country boundary from FAO GAUL (outline only, purple) ───────────
  const loadCountryBoundary = useCallback(async (gaulName) => {
    const map = mapRef.current;
    if (!map || !tokenRef.current || !projectRef.current) return;
    const reqId = ++boundaryReqRef.current;   // stamp this request
    try {
      const tileUrl = await fetchGEETileUrl(
        buildBoundaryExpression(buildCountryFilter(gaulName), 2),
        { ranges: [{ min: 1, max: 1 }], paletteColors: ['bf40ff'] }
      );
      if (reqId !== boundaryReqRef.current) return;  // a newer request won — discard
      boundaryTilesRef.current.country = tileUrl;
      addRasterLayer(map, 'boundary-country', 'boundary-layer-country', tileUrl);
      // Always move to absolute top after adding
      if (map.getLayer('boundary-layer-country')) map.moveLayer('boundary-layer-country');
    } catch (e) { console.error('Country boundary error:', e.message); }
  }, [fetchGEETileUrl, addRasterLayer]);

  // ── Load SEA boundaries from FAO GAUL (outline only, cyan) ───────────────
  const loadSEABoundary = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !tokenRef.current || !projectRef.current) return;
    try {
      const tileUrl = await fetchGEETileUrl(
        buildBoundaryExpression(buildSEAFilter(), 1),
        { ranges: [{ min: 1, max: 1 }], paletteColors: ['00ffff'] }
      );
      boundaryTilesRef.current.sea = tileUrl;
      addRasterLayer(map, 'boundary-sea', 'boundary-layer-sea', tileUrl);
      // Keep country boundary on top of SEA boundary
      if (map.getLayer('boundary-layer-country')) map.moveLayer('boundary-layer-country');
    } catch (e) { console.error('SEA boundary error:', e.message); }
  }, [fetchGEETileUrl, addRasterLayer]);

  // ── Map init ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const bm  = BASEMAPS.find(b => b.id === 'satellite');
    const map = new maplibregl.Map({
      container: mapEl.current,
      style: bm.style,
      center: [105, 10],
      zoom: 4,
      attributionControl: false,
      transformRequest: (url) => {
        if (url.startsWith(GEE_API) && tokenRef.current) {
          return {
            url,
            headers: {
              Authorization:         `Bearer ${tokenRef.current}`,
              'x-goog-user-project': projectRef.current,
            },
          };
        }
      },
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    mapRef.current = map;

    // Restore all layers + boundaries after basemap style reload
    map.on('style.load', () => {
      const current = layersRef.current;
      LAYER_TYPES.forEach(lt => {
        const s = current[lt.id];
        if (s.tileUrl) {
          map.addSource(`gee-${lt.id}`, { type: 'raster', tiles: [s.tileUrl], tileSize: 256 });
          map.addLayer({ id: `gee-layer-${lt.id}`, type: 'raster', source: `gee-${lt.id}`,
            paint: { 'raster-opacity': s.enabled ? s.opacity : 0 } });
        }
      });
      // Restore SEA-wide 50km grid
      if (gridOnRef.current) applyGrid(map);
      // Restore boundaries
      const { country: cUrl, sea: sUrl } = boundaryTilesRef.current;
      if (sUrl && seaOnRef.current) {
        map.addSource('boundary-sea', { type: 'raster', tiles: [sUrl], tileSize: 256 });
        map.addLayer({ id: 'boundary-layer-sea', type: 'raster', source: 'boundary-sea',
          paint: { 'raster-opacity': 1 } });
      }
      if (cUrl) {
        map.addSource('boundary-country', { type: 'raster', tiles: [cUrl], tileSize: 256 });
        map.addLayer({ id: 'boundary-layer-country', type: 'raster', source: 'boundary-country',
          paint: { 'raster-opacity': 1 } });
      }
      // Restore tile-selection grid layers
      if (tileSelectRef.current) {
        map.addSource('tile-select-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({ id: 'tile-select-fill', type: 'fill', source: 'tile-select-src',
          paint: { 'fill-color': ['case', ['get', 'selected'], '#7b8cde', '#8899cc'], 'fill-opacity': ['case', ['get', 'selected'], 0.40, 0.07] } });
        map.addLayer({ id: 'tile-select-line', type: 'line', source: 'tile-select-src',
          paint: { 'line-color': '#ff8c00', 'line-width': 1.0, 'line-opacity': 0.60 } });
        setTimeout(() => { if (updateTileGridRef.current) updateTileGridRef.current(); }, 50);
      }
    });

    return () => map.remove();
  }, []);

  // ── OAuth sign-in ─────────────────────────────────────────────────────────
  const handleSignIn = useCallback(() => {
    const clientId = import.meta.env.VITE_GEE_OAUTH_CLIENT_ID;
    if (!clientId || !window.google?.accounts?.oauth2) { setTokenStatus('error'); return; }
    setTokenStatus('fetching');
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/earthengine',
      callback: (resp) => {
        if (resp.access_token) {
          tokenRef.current = resp.access_token;
          setTokenStatus('ok');
          // Load country boundary after sign-in
          const co = COUNTRIES.find(c => c.label === countryRef.current);
          if (co) loadCountryBoundary(co.gaul);
        } else {
          setTokenStatus('error');
        }
      },
    });
    client.requestAccessToken();
  }, [loadCountryBoundary]);

  // ── Load a single GEE layer ───────────────────────────────────────────────
  const loadLayer = useCallback(async (typeId, countryVal, yearVal) => {
    const map = mapRef.current;
    if (!map || !tokenRef.current || !projectRef.current) return;

    const lt         = LAYER_TYPES.find(l => l.id === typeId);
    const countryObj = COUNTRIES.find(c => c.label === countryVal);
    if (!lt || !countryObj) return;

    const assetPath = lt.assetFn(countryObj.slug, yearVal);
    setLayers(prev => ({ ...prev, [typeId]: { ...prev[typeId], loading: true, error: null } }));

    try {
      const tileUrl  = await fetchGEETileUrl(buildExpression(assetPath, countryObj.gaul, lt.isBinary), lt.vis);
      const sourceId = `gee-${typeId}`;
      const layerId  = `gee-layer-${typeId}`;

      addRasterLayer(map, sourceId, layerId, tileUrl, layersRef.current[typeId].opacity);

      // Always push boundaries to absolute top after adding any data layer
      ['boundary-layer-sea', 'boundary-layer-country'].forEach(id => {
        if (map.getLayer(id)) map.moveLayer(id);
      });

      const next = { enabled: true, opacity: layersRef.current[typeId].opacity,
        loading: false, error: null, mapName: null, tileUrl };
      layersRef.current = { ...layersRef.current, [typeId]: next };
      setLayers(prev => ({ ...prev, [typeId]: next }));
    } catch (err) {
      const next = { ...layersRef.current[typeId], loading: false, error: err.message };
      layersRef.current = { ...layersRef.current, [typeId]: next };
      setLayers(prev => ({ ...prev, [typeId]: next }));
    }
  }, [fetchGEETileUrl, addRasterLayer]);

  // ── Remove a layer from map ───────────────────────────────────────────────
  const removeLayerFromMap = useCallback((typeId) => {
    const map = mapRef.current;
    if (!map) return;
    if (map.getLayer(`gee-layer-${typeId}`)) map.removeLayer(`gee-layer-${typeId}`);
    if (map.getSource(`gee-${typeId}`))      map.removeSource(`gee-${typeId}`);
  }, []);

  // ── Toggle checkbox ───────────────────────────────────────────────────────
  const handleLayerToggle = useCallback((typeId, checked) => {
    if (checked) {
      layersRef.current = { ...layersRef.current, [typeId]: { ...layersRef.current[typeId], enabled: true } };
      setLayers(prev => ({ ...prev, [typeId]: { ...prev[typeId], enabled: true } }));
      loadLayer(typeId, country, year);
    } else {
      removeLayerFromMap(typeId);
      const next = { ...layersRef.current[typeId], enabled: false, mapName: null, tileUrl: null, error: null };
      layersRef.current = { ...layersRef.current, [typeId]: next };
      setLayers(prev => ({ ...prev, [typeId]: next }));
    }
  }, [country, year, loadLayer, removeLayerFromMap]);

  // ── Opacity change ────────────────────────────────────────────────────────
  const handleOpacity = useCallback((typeId, value) => {
    const map     = mapRef.current;
    const layerId = `gee-layer-${typeId}`;
    if (map?.getLayer(layerId)) map.setPaintProperty(layerId, 'raster-opacity', value);
    const next = { ...layersRef.current[typeId], opacity: value };
    layersRef.current = { ...layersRef.current, [typeId]: next };
    setLayers(prev => ({ ...prev, [typeId]: next }));
  }, []);

  // ── Reset all layers ──────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    LAYER_TYPES.forEach(lt => removeLayerFromMap(lt.id));
    const fresh = initLayers();
    layersRef.current = fresh;
    setLayers(fresh);
  }, [removeLayerFromMap]);

  // ── Refresh active layers when country/year changes ───────────────────────
  const refreshActive = useCallback((newCountry, newYear) => {
    LAYER_TYPES.forEach(lt => {
      if (layersRef.current[lt.id].enabled) {
        removeLayerFromMap(lt.id);
        layersRef.current = { ...layersRef.current, [lt.id]: { ...layersRef.current[lt.id], mapName: null, tileUrl: null } };
        loadLayer(lt.id, newCountry, newYear);
      }
    });
  }, [loadLayer, removeLayerFromMap]);

  // ── Grid helpers — SEA-wide line overlay ─────────────────────────────────
  const applyGrid = useCallback((map) => {
    if (map.getLayer('grid-layer')) map.removeLayer('grid-layer');
    if (map.getSource('grid-src'))  map.removeSource('grid-src');
    map.addSource('grid-src', { type: 'geojson', data: generateSEAGrid() });
    map.addLayer({ id: 'grid-layer', type: 'line', source: 'grid-src',
      paint: { 'line-color': '#ffffff', 'line-width': 0.5, 'line-opacity': 0.4 } });
  }, []);

  const handleGrid = useCallback((checked) => {
    setGridOn(checked);
    gridOnRef.current = checked;
    const map = mapRef.current;
    if (!map) return;
    if (checked) {
      applyGrid(map);
    } else {
      if (map.getLayer('grid-layer')) map.removeLayer('grid-layer');
      if (map.getSource('grid-src'))  map.removeSource('grid-src');
    }
  }, [applyGrid]);

  // ── Country change ────────────────────────────────────────────────────────
  const handleCountry = useCallback((e) => {
    const val = e.target.value;
    setCountry(val);
    countryRef.current = val;
    const co = COUNTRIES.find(c => c.label === val);
    if (co && mapRef.current) mapRef.current.flyTo({ center: co.center, zoom: co.zoom, duration: 1200 });
    // Remove old country boundary immediately so stale boundary is not shown
    const map = mapRef.current;
    if (map) {
      if (map.getLayer('boundary-layer-country')) map.removeLayer('boundary-layer-country');
      if (map.getSource('boundary-country'))      map.removeSource('boundary-country');
      boundaryTilesRef.current.country = null;
    }
    if (co && tokenRef.current) loadCountryBoundary(co.gaul);
    refreshActive(val, year);
  }, [year, refreshActive, loadCountryBoundary]);

  // ── Year change ───────────────────────────────────────────────────────────
  const handleYear = useCallback((e) => {
    const val = e.target.value;
    setYear(val);
    refreshActive(country, val);
  }, [country, refreshActive]);

  // ── Project ID ────────────────────────────────────────────────────────────
  const handleProjectChange = useCallback((e) => {
    const val = e.target.value;
    setProjectId(val);
    projectRef.current = val;
  }, []);

  // ── Tile grid: refresh visible cells (reads from selectedTilesRef) ─────────
  const updateTileGrid = useCallback(() => {
    const map = mapRef.current;
    if (!map?.getSource('tile-select-src')) return;
    const selIds    = new Set(selectedTilesRef.current.keys());
    const features  = generateVisibleGrid(map, selIds);
    map.getSource('tile-select-src').setData({ type: 'FeatureCollection', features });
  }, []);

  // Keep updateTileGridRef in sync so style.load can call it
  useEffect(() => { updateTileGridRef.current = updateTileGrid; }, [updateTileGrid]);

  // Sync selectedTilesRef and re-render grid when selection changes
  useEffect(() => {
    selectedTilesRef.current = selectedTiles;
    if (tileSelectActive) updateTileGrid();
  }, [selectedTiles, tileSelectActive, updateTileGrid]);

  // ── Tile selection: enable / disable map interaction ──────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    tileSelectRef.current = tileSelectActive;

    // Clean up previous handlers
    const cleanup = () => {
      if (tileClickHandlerRef.current) { map.off('click', 'tile-select-fill', tileClickHandlerRef.current); tileClickHandlerRef.current = null; }
      if (tileMoveHandlerRef.current)  { map.off('moveend', tileMoveHandlerRef.current); map.off('zoomend', tileMoveHandlerRef.current); tileMoveHandlerRef.current = null; }
      if (tileEnterHandlerRef.current) { map.off('mouseenter', 'tile-select-fill', tileEnterHandlerRef.current); tileEnterHandlerRef.current = null; }
      if (tileLeaveHandlerRef.current) { map.off('mouseleave', 'tile-select-fill', tileLeaveHandlerRef.current); tileLeaveHandlerRef.current = null; }
    };
    cleanup();

    if (tileSelectActive) {
      // Add source + layers if needed
      if (!map.getSource('tile-select-src')) {
        map.addSource('tile-select-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({ id: 'tile-select-fill', type: 'fill', source: 'tile-select-src',
          paint: {
            'fill-color':   ['case', ['get', 'selected'], '#ff8c00', '#ffcc88'],
            'fill-opacity': ['case', ['get', 'selected'], 0.50,       0.08],
          } });
        map.addLayer({ id: 'tile-select-line', type: 'line', source: 'tile-select-src',
          paint: { 'line-color': '#ff8c00', 'line-width': 1.0, 'line-opacity': 0.60 } });
      }

      // Viewport update on pan/zoom
      const moveHandler = () => updateTileGrid();
      tileMoveHandlerRef.current = moveHandler;
      map.on('moveend', moveHandler);
      map.on('zoomend', moveHandler);

      // Click a cell → toggle selection
      const clickHandler = (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const { id, lon, lat } = f.properties;
        const bbox = cellBbox(Number(lon), Number(lat));
        setSelectedTiles(prev => {
          const next = new Map(prev);
          if (next.has(id)) next.delete(id); else next.set(id, { id, bbox });
          selectedTilesRef.current = next;
          // Re-render immediately (don't wait for state cycle)
          if (mapRef.current?.getSource('tile-select-src')) {
            const selIds   = new Set(next.keys());
            const features = generateVisibleGrid(mapRef.current, selIds);
            mapRef.current.getSource('tile-select-src').setData({ type: 'FeatureCollection', features });
          }
          return next;
        });
      };
      tileClickHandlerRef.current = clickHandler;
      map.on('click', 'tile-select-fill', clickHandler);

      // Hover cursor
      const enterH = () => { map.getCanvas().style.cursor = 'pointer'; };
      const leaveH = () => { map.getCanvas().style.cursor = '';        };
      tileEnterHandlerRef.current = enterH;
      tileLeaveHandlerRef.current = leaveH;
      map.on('mouseenter', 'tile-select-fill', enterH);
      map.on('mouseleave', 'tile-select-fill', leaveH);

      // Initial render
      updateTileGrid();
    } else {
      map.getCanvas().style.cursor = '';
      ['tile-select-fill', 'tile-select-line'].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource('tile-select-src')) map.removeSource('tile-select-src');
    }
    return cleanup;
  }, [tileSelectActive, updateTileGrid]);

  // ── Basemap switch ────────────────────────────────────────────────────────
  const handleBasemap = useCallback((e) => {
    const id  = e.target.value;
    setBasemap(id);
    const map = mapRef.current;
    if (!map) return;
    const bm  = BASEMAPS.find(b => b.id === id);
    if (bm.style) map.setStyle(bm.style);
    else          map.setStyle(bm.url);
  }, []);

  // ── SEA boundary toggle ───────────────────────────────────────────────────
  const handleSea = useCallback((checked) => {
    setSeaOn(checked);
    seaOnRef.current = checked;
    const map = mapRef.current;
    if (!map) return;

    if (checked) {
      if (boundaryTilesRef.current.sea) {
        // Already loaded — just re-add if removed
        addRasterLayer(map, 'boundary-sea', 'boundary-layer-sea', boundaryTilesRef.current.sea);
        if (map.getLayer('boundary-layer-country')) map.moveLayer('boundary-layer-country');
      } else {
        loadSEABoundary();
      }
    } else {
      if (map.getLayer('boundary-layer-sea')) map.removeLayer('boundary-layer-sea');
      if (map.getSource('boundary-sea'))      map.removeSource('boundary-sea');
    }
  }, [loadSEABoundary, addRasterLayer]);

  const anyActive = LAYER_TYPES.some(lt => layers[lt.id].enabled);
  const canLoad   = tokenStatus === 'ok' && projectId.trim();

  return (
    <div className="app">
      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-title">SEA Rice Viewer</div>
          <div className="sidebar-subtitle">Southeast Asia · Rice Mapping</div>
        </div>

        <div className="sidebar-body">

          {/* Authentication */}
          <div className="section">
            <div className="section-label">Authentication</div>
            <input className="input" value={projectId} onChange={handleProjectChange}
              placeholder="your-gcp-project-id" style={{ marginBottom: 5 }} />
            <button className={`btn btn-sign-in ${tokenStatus === 'ok' ? 'signed-in' : ''}`}
              onClick={handleSignIn} disabled={tokenStatus === 'fetching'}>
              {tokenStatus === 'fetching' && <span className="spin">⟳</span>}
              {tokenStatus === 'ok' ? '✓ Signed In' : 'Sign In with Google'}
            </button>
            {tokenStatus === 'ok'    && <div className="auth-status ok">Authentication successful</div>}
            {tokenStatus === 'error' && <div className="auth-status error">Sign-in failed — check GEE access</div>}
            {!tokenStatus            && <div className="auth-status hint">Enter project ID then sign in.</div>}
          </div>

          {/* Basemap */}
          <div className="section">
            <div className="section-label">Basemap</div>
            <select className="select" value={basemap} onChange={handleBasemap}>
              {BASEMAPS.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
          </div>

          {/* Country */}
          <div className="section">
            <div className="section-label">Country</div>
            <select className="select" value={country} onChange={handleCountry}>
              {COUNTRIES.map(c => <option key={c.iso} value={c.label}>{c.label}</option>)}
            </select>
          </div>

          {/* Year */}
          <div className="section">
            <div className="section-label">Year</div>
            <select className="select" value={year} onChange={handleYear}>
              {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          {/* Map Layers */}
          <div className="section">
            <div className="section-label">Map Layers</div>
            {!canLoad && (
              <div className="auth-status hint" style={{ marginBottom: 6 }}>
                Sign in and enter Project ID to enable layers.
              </div>
            )}
            {LAYER_TYPES.map(lt => {
              const s = layers[lt.id];
              return (
                <div key={lt.id}>
                  <label className={`checkbox-row ${s.loading ? 'loading' : ''} ${s.error ? 'error' : ''}`}>
                    <input type="checkbox" checked={s.enabled}
                      disabled={!canLoad || s.loading}
                      onChange={e => handleLayerToggle(lt.id, e.target.checked)} />
                    <span className="layer-dot" style={{ background: lt.color }} />
                    <span className="checkbox-label">
                      {s.loading ? `Loading ${lt.id}…` : lt.label}
                    </span>
                  </label>
                  {s.error && <div className="error-box">{s.error}</div>}
                  {s.enabled && !s.loading && (
                    <div className="opacity-row">
                      <input type="range" min={0} max={1} step={0.05} value={s.opacity}
                        onChange={e => handleOpacity(lt.id, Number(e.target.value))} />
                      <span className="opacity-val">{Math.round(s.opacity * 100)}%</span>
                    </div>
                  )}
                </div>
              );
            })}
            <button className="btn btn-reset" style={{ marginTop: 8 }} onClick={handleReset}>
              Reset All Layers
            </button>
          </div>

          {/* Overlay */}
          <div className="section">
            <div className="section-label">Overlay</div>
            <label className="checkbox-row">
              <input type="checkbox" checked={seaOn}
                disabled={!canLoad}
                onChange={e => handleSea(e.target.checked)} />
              <span className="checkbox-label">SEA country boundaries</span>
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={gridOn}
                onChange={e => handleGrid(e.target.checked)} />
              <span className="checkbox-label">50 km × 50 km grid</span>
            </label>
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 20, height: 2, background: '#bf40ff', display: 'inline-block', borderRadius: 1 }} />
              <span className="legend-swatch-label">Selected country</span>
            </div>
            {seaOn && (
              <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 20, height: 2, background: '#00ffff', display: 'inline-block', borderRadius: 1 }} />
                <span className="legend-swatch-label">SEA boundaries</span>
              </div>
            )}
          </div>

          {/* Legend */}
          <div className="section">
            <div className="section-label">Legend</div>
            {!anyActive && <div className="auth-status hint">No layers active.</div>}
            {LAYER_TYPES.filter(lt => layers[lt.id].enabled && !layers[lt.id].loading).map(lt => (
              <div key={lt.id} className="legend-item">
                <div className="legend-type-label" style={{ color: lt.color }}>{lt.label}</div>
                {lt.legendType === 'gradient' && (
                  <>
                    <div className="legend-gradient">
                      {lt.legendPalette.map((c, i) => (
                        <div key={i} className="legend-gradient-seg" style={{ background: c }} />
                      ))}
                    </div>
                    <div className="legend-ticks">
                      <span>{lt.legendMin}</span>
                      <span style={{ color: '#aaaacc', fontSize: 9 }}>{lt.legendLabel}</span>
                      <span>{lt.legendMax}</span>
                    </div>
                  </>
                )}
                {lt.legendType === 'swatch' && lt.legendSwatches.map((sw, i) => (
                  <div key={i} className="legend-swatch-row">
                    <div className="legend-swatch" style={{ background: sw.color }} />
                    <span className="legend-swatch-label">{sw.label}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Export */}
          <div className="section">
            <div className="section-label">Export</div>
            <button className="btn btn-export" onClick={() => setExportOpen(true)}>
              ↓ Export GeoTIFF (Python)
            </button>
          </div>

        </div>
      </aside>

      {/* Map */}
      <div className="map-container" ref={mapEl} />

      {/* Floating tile-select bar — shown over map when selecting tiles */}
      {tileSelectActive && (
        <div className="tile-select-bar">
          <span className="tile-select-bar-count">
            🟠 <strong>{selectedTiles.size}</strong> tiles selected
          </span>
          <button className="tile-select-bar-btn"
            onClick={() => {
              const co = COUNTRIES.find(c => c.label === country);
              const cells = co ? generateCellsForBbox(co.bbox) : [];
              setSelectedTiles(new Map(cells.map(c => [c.id, c])));
            }}>All ({country})</button>
          <button className="tile-select-bar-btn"
            onClick={() => setSelectedTiles(new Map())}>Clear</button>
          <button className="tile-select-bar-done"
            onClick={() => setTileSelectActive(false)}>✓ Done</button>
        </div>
      )}

      {/* Export modal */}
      {exportOpen && (
        <ExportModal
          country={country}
          gaulName={COUNTRIES.find(c => c.label === country)?.gaul ?? country}
          year={year}
          projectId={projectId}
          selectedTiles={selectedTiles}
          tileSelectActive={tileSelectActive}
          onTileSelectToggle={setTileSelectActive}
          onSelectAllTiles={() => {
            const co    = COUNTRIES.find(c => c.label === country);
            const cells = co ? generateCellsForBbox(co.bbox) : [];
            setSelectedTiles(new Map(cells.map(c => [c.id, c])));
          }}
          onSelectNoTiles={() => setSelectedTiles(new Map())}
          onClose={() => { setTileSelectActive(false); setExportOpen(false); }}
        />
      )}
    </div>
  );
}

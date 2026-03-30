import { useState, useEffect, useRef, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import './App.css';

// ── Constants ────────────────────────────────────────────────────────────────
const ASSET_PREFIX = 'projects/tony-1122/assets/NIE/rice/';
const GEE_API      = 'https://earthengine.googleapis.com/v1';
const SEA_ISO      = new Set(['THA','MMR','VNM','LAO','KHM','PHL','MYS','IDN','BRN','TLS','SGP']);

// World 110m countries GeoJSON (Natural Earth, ~1 MB)
const BOUNDARIES_URL =
  'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/cultural/ne_110m_admin_0_countries.json';

const COUNTRIES = [
  { label: 'Thailand',    slug: 'thailand',    iso: 'THA', center: [100.5,  13.5], zoom: 5 },
  { label: 'Myanmar',     slug: 'myanmar',     iso: 'MMR', center: [ 96.0,  19.0], zoom: 5 },
  { label: 'Vietnam',     slug: 'vietnam',     iso: 'VNM', center: [106.0,  16.0], zoom: 5 },
  { label: 'Laos',        slug: 'laos',        iso: 'LAO', center: [103.0,  18.0], zoom: 6 },
  { label: 'Cambodia',    slug: 'cambodia',    iso: 'KHM', center: [105.0,  12.5], zoom: 6 },
  { label: 'Philippines', slug: 'philippines', iso: 'PHL', center: [122.0,  12.0], zoom: 5 },
  { label: 'Malaysia',    slug: 'malaysia',    iso: 'MYS', center: [109.0,   3.5], zoom: 5 },
  { label: 'Indonesia',   slug: 'indonesia',   iso: 'IDN', center: [113.0,  -1.0], zoom: 5 },
  { label: 'Brunei',      slug: 'brunei',      iso: 'BRN', center: [114.7,   4.5], zoom: 8 },
  { label: 'Timor-Leste', slug: 'timor',       iso: 'TLS', center: [125.5,  -8.8], zoom: 8 },
  { label: 'Singapore',   slug: 'singapore',   iso: 'SGP', center: [103.8,   1.35], zoom: 10 },
];

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

// ── GEE expression builders ──────────────────────────────────────────────────
// Build a GEE expression that:
//  - Loads the image
//  - Applies gte(50) + selfMask for Binary
//  - Clips to country geometry (passed as GeoJSON constantValue)
function buildExpression(assetPath, clipGeometry, isBinary) {
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
            geometry: { constantValue: clipGeometry },
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
  const geoRef     = useRef(null);   // cached world GeoJSON features: Map<iso -> feature>
  const seaOnRef   = useRef(false);
  const countryRef = useRef('Thailand');

  const [country,     setCountry]     = useState('Thailand');
  const [year,        setYear]        = useState('2021');
  const [basemap,     setBasemap]     = useState('satellite');
  const [projectId,   setProjectId]   = useState('');
  const [tokenStatus, setTokenStatus] = useState(null);
  const [layers,      setLayers]      = useState(initLayers);
  const [seaOn,       setSeaOn]       = useState(false);
  const [geoReady,    setGeoReady]    = useState(false);

  // ── Fetch world GeoJSON once on mount ────────────────────────────────────
  useEffect(() => {
    fetch(BOUNDARIES_URL)
      .then(r => r.json())
      .then(data => {
        const map = new Map();
        data.features.forEach(f => {
          const iso = f.properties?.ISO_A3;
          if (iso) map.set(iso, f);
        });
        geoRef.current = map;
        setGeoReady(true);
      })
      .catch(() => setGeoReady(false));
  }, []);

  // ── Helper: add boundary layers to map ──────────────────────────────────
  const addBoundaryLayers = useCallback((map, isoSelected, showSea) => {
    if (!geoRef.current) return;

    // SEA boundaries (all 11 countries)
    if (showSea) {
      const seaFeatures = [...geoRef.current.values()].filter(f => SEA_ISO.has(f.properties?.ISO_A3));
      if (!map.getSource('sea-boundary')) {
        map.addSource('sea-boundary', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: seaFeatures },
        });
        map.addLayer({
          id: 'sea-boundary-line', type: 'line', source: 'sea-boundary',
          paint: { 'line-color': '#00ffff', 'line-width': 1.2, 'line-opacity': 0.8 },
        });
      }
    }

    // Selected country boundary (always shown when a country is active)
    const countryObj = COUNTRIES.find(c => c.label === isoSelected);
    const feature    = countryObj ? geoRef.current.get(countryObj.iso) : null;
    if (feature && !map.getSource('country-boundary')) {
      map.addSource('country-boundary', {
        type: 'geojson',
        data: feature,
      });
      map.addLayer({
        id: 'country-boundary-line', type: 'line', source: 'country-boundary',
        paint: { 'line-color': '#bf40ff', 'line-width': 2, 'line-opacity': 1 },
      });
    }
  }, []);

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
              Authorization: `Bearer ${tokenRef.current}`,
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
        if (s.tileUrl && !map.getSource(`gee-${lt.id}`)) {
          map.addSource(`gee-${lt.id}`, { type: 'raster', tiles: [s.tileUrl], tileSize: 256 });
          map.addLayer({ id: `gee-layer-${lt.id}`, type: 'raster', source: `gee-${lt.id}`,
            paint: { 'raster-opacity': s.enabled ? s.opacity : 0 } });
        }
      });
      addBoundaryLayers(map, countryRef.current, seaOnRef.current);
    });

    return () => map.remove();
  }, [addBoundaryLayers]);

  // ── Update country boundary on the map ───────────────────────────────────
  const updateCountryBoundary = useCallback((countryLabel) => {
    const map = mapRef.current;
    if (!map || !geoRef.current) return;
    if (map.getLayer('country-boundary-line')) map.removeLayer('country-boundary-line');
    if (map.getSource('country-boundary'))     map.removeSource('country-boundary');
    const countryObj = COUNTRIES.find(c => c.label === countryLabel);
    const feature    = countryObj ? geoRef.current.get(countryObj.iso) : null;
    if (feature) {
      map.addSource('country-boundary', { type: 'geojson', data: feature });
      map.addLayer({
        id: 'country-boundary-line', type: 'line', source: 'country-boundary',
        paint: { 'line-color': '#bf40ff', 'line-width': 2, 'line-opacity': 1 },
      });
    }
  }, []);

  // Show country boundary once GeoJSON is ready
  useEffect(() => {
    if (geoReady && mapRef.current) {
      const map = mapRef.current;
      // Wait for map to be loaded before adding layers
      if (map.isStyleLoaded()) {
        updateCountryBoundary(country);
      } else {
        map.once('style.load', () => updateCountryBoundary(country));
      }
    }
  }, [geoReady, country, updateCountryBoundary]);

  // ── OAuth sign-in ─────────────────────────────────────────────────────────
  const handleSignIn = useCallback(() => {
    const clientId = import.meta.env.VITE_GEE_OAUTH_CLIENT_ID;
    if (!clientId || !window.google?.accounts?.oauth2) { setTokenStatus('error'); return; }
    setTokenStatus('fetching');
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/earthengine',
      callback: (resp) => {
        if (resp.access_token) { tokenRef.current = resp.access_token; setTokenStatus('ok'); }
        else setTokenStatus('error');
      },
    });
    client.requestAccessToken();
  }, []);

  // ── Load a single GEE layer ───────────────────────────────────────────────
  const loadLayer = useCallback(async (typeId, countryVal, yearVal) => {
    const map = mapRef.current;
    if (!map || !tokenRef.current || !projectRef.current) return;

    const lt         = LAYER_TYPES.find(l => l.id === typeId);
    const countryObj = COUNTRIES.find(c => c.label === countryVal);
    if (!lt || !countryObj) return;

    // Get country geometry from cached GeoJSON for clip
    const feature     = geoRef.current?.get(countryObj.iso);
    const clipGeometry = feature?.geometry ?? null;

    const assetPath = lt.assetFn(countryObj.slug, yearVal);
    setLayers(prev => ({ ...prev, [typeId]: { ...prev[typeId], loading: true, error: null } }));

    try {
      const res = await fetch(`${GEE_API}/projects/${projectRef.current}/maps`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenRef.current}`,
          'x-goog-user-project': projectRef.current,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expression:          buildExpression(assetPath, clipGeometry, lt.isBinary),
          visualizationOptions: lt.vis,
          fileFormat:          'PNG',
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message || `HTTP ${res.status}`);
      }

      const { name }  = await res.json();
      const tileUrl   = `${GEE_API}/${name}/tiles/{z}/{x}/{y}`;
      const sourceId  = `gee-${typeId}`;
      const layerId   = `gee-layer-${typeId}`;

      if (map.getSource(sourceId)) { map.removeLayer(layerId); map.removeSource(sourceId); }
      map.addSource(sourceId, { type: 'raster', tiles: [tileUrl], tileSize: 256 });
      map.addLayer({ id: layerId, type: 'raster', source: sourceId,
        paint: { 'raster-opacity': layersRef.current[typeId].opacity } });

      // Keep boundary lines on top
      if (map.getLayer('sea-boundary-line'))     map.moveLayer('sea-boundary-line');
      if (map.getLayer('country-boundary-line')) map.moveLayer('country-boundary-line');

      const next = { enabled: true, opacity: layersRef.current[typeId].opacity,
        loading: false, error: null, mapName: name, tileUrl };
      layersRef.current = { ...layersRef.current, [typeId]: next };
      setLayers(prev => ({ ...prev, [typeId]: next }));
    } catch (err) {
      const next = { ...layersRef.current[typeId], loading: false, error: err.message };
      layersRef.current = { ...layersRef.current, [typeId]: next };
      setLayers(prev => ({ ...prev, [typeId]: next }));
    }
  }, []);

  // ── Remove a layer from map ───────────────────────────────────────────────
  const removeLayerFromMap = useCallback((typeId) => {
    const map = mapRef.current;
    if (!map) return;
    if (map.getSource(`gee-${typeId}`)) {
      map.removeLayer(`gee-layer-${typeId}`);
      map.removeSource(`gee-${typeId}`);
    }
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

  // ── Country change ────────────────────────────────────────────────────────
  const handleCountry = useCallback((e) => {
    const val = e.target.value;
    setCountry(val);
    countryRef.current = val;
    const co = COUNTRIES.find(c => c.label === val);
    if (co && mapRef.current) mapRef.current.flyTo({ center: co.center, zoom: co.zoom, duration: 1200 });
    updateCountryBoundary(val);
    refreshActive(val, year);
  }, [year, refreshActive, updateCountryBoundary]);

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
    if (!map || !geoRef.current) return;

    if (checked) {
      if (!map.getSource('sea-boundary')) {
        const seaFeatures = [...geoRef.current.values()].filter(f => SEA_ISO.has(f.properties?.ISO_A3));
        map.addSource('sea-boundary', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: seaFeatures },
        });
        map.addLayer({
          id: 'sea-boundary-line', type: 'line', source: 'sea-boundary',
          paint: { 'line-color': '#00ffff', 'line-width': 1.2, 'line-opacity': 0.8 },
        });
        // Keep country boundary on top
        if (map.getLayer('country-boundary-line')) map.moveLayer('country-boundary-line');
      }
    } else {
      if (map.getLayer('sea-boundary-line')) map.removeLayer('sea-boundary-line');
      if (map.getSource('sea-boundary'))     map.removeSource('sea-boundary');
    }
  }, []);

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
                disabled={!geoReady}
                onChange={e => handleSea(e.target.checked)} />
              <span className="checkbox-label">
                {geoReady ? 'SEA country boundaries' : 'Loading boundaries…'}
              </span>
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

        </div>
      </aside>

      {/* Map */}
      <div className="map-container" ref={mapEl} />
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import './App.css';

// ── Constants ────────────────────────────────────────────────────────────────
const ASSET_PREFIX = 'projects/tony-1122/assets/NIE/rice/';
const GEE_API = 'https://earthengine.googleapis.com/v1';

const COUNTRIES = [
  { label: 'Thailand',    slug: 'thailand',    gaul: 'Thailand',                              center: [100.5,  13.5], zoom: 5 },
  { label: 'Myanmar',     slug: 'myanmar',     gaul: 'Myanmar',                               center: [ 96.0,  19.0], zoom: 5 },
  { label: 'Vietnam',     slug: 'vietnam',     gaul: 'Viet Nam',                              center: [106.0,  16.0], zoom: 5 },
  { label: 'Laos',        slug: 'laos',        gaul: "Lao People's Democratic Republic",      center: [103.0,  18.0], zoom: 6 },
  { label: 'Cambodia',    slug: 'cambodia',    gaul: 'Cambodia',                              center: [105.0,  12.5], zoom: 6 },
  { label: 'Philippines', slug: 'philippines', gaul: 'Philippines',                           center: [122.0,  12.0], zoom: 5 },
  { label: 'Malaysia',    slug: 'malaysia',    gaul: 'Malaysia',                              center: [109.0,   3.5], zoom: 5 },
  { label: 'Indonesia',   slug: 'indonesia',   gaul: 'Indonesia',                             center: [113.0,  -1.0], zoom: 5 },
  { label: 'Brunei',      slug: 'brunei',      gaul: 'Brunei Darussalam',                     center: [114.7,   4.5], zoom: 8 },
  { label: 'Timor-Leste', slug: 'timor',       gaul: 'Timor-Leste',                           center: [125.5,  -8.8], zoom: 8 },
  { label: 'Singapore',   slug: 'singapore',   gaul: 'Singapore',                             center: [103.8,   1.35], zoom: 10 },
];

const YEARS = ['2019', '2020', '2021', '2022', '2023'];

const LAYER_TYPES = [
  {
    id: 'Mean',
    label: '5-Fold Ensemble Probability',
    color: '#e06c75',
    vis: { ranges: [{ min: 0, max: 100 }], paletteColors: ['ffffff', 'ffff00', 'ffa500', 'ff0000', '800080'] },
    assetFn: (slug, year) => `${ASSET_PREFIX}SEA_Avg_${slug}_${year}`,
    expressionType: 'plain',
    legendType: 'gradient',
    legendLabel: 'Probability (%)',
    legendMin: 0,
    legendMax: 100,
    legendPalette: ['#ffffff', '#ffff00', '#ffa500', '#ff0000', '#800080'],
  },
  {
    id: 'Std',
    label: 'Standard Deviation',
    color: '#e5c07b',
    vis: { ranges: [{ min: 0, max: 45 }], paletteColors: ['ffffff', 'ffff00', 'ffa500', 'ff0000', '800080'] },
    assetFn: (slug, year) => `${ASSET_PREFIX}SEA_Std_${slug}_${year}`,
    expressionType: 'plain',
    legendType: 'gradient',
    legendLabel: 'Std Dev',
    legendMin: 0,
    legendMax: 45,
    legendPalette: ['#ffffff', '#ffff00', '#ffa500', '#ff0000', '#800080'],
  },
  {
    id: 'Binary',
    label: 'Binary (prob ≥ 50%)',
    color: '#61afef',
    vis: { ranges: [{ min: 50, max: 100 }], paletteColors: ['000000', '00ff00'] },
    assetFn: (slug, year) => `${ASSET_PREFIX}SEA_Avg_${slug}_${year}`,
    expressionType: 'plain',
    legendType: 'swatch',
    legendSwatches: [{ color: '#000000', label: 'Non-rice / Low prob' }, { color: '#00ff00', label: 'Rice (prob ≥ 50%)' }],
  },
  {
    id: 'Pseudo',
    label: 'Pseudo-Labeling',
    color: '#98c379',
    vis: { ranges: [{ min: 0, max: 2 }], paletteColors: ['000000', '008000', 'ff0000'] },
    assetFn: (slug, year) => `${ASSET_PREFIX}SEA_Pseu_${slug}_${year}`,
    expressionType: 'plain',
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
    id: 'satellite',
    label: 'Satellite',
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

// ── GEE expression builder ──────────────────────────────────────────────────
function buildExpression(assetPath) {
  return {
    result: '0',
    values: {
      '0': {
        functionInvocationValue: {
          functionName: 'Image.load',
          arguments: { id: { constantValue: assetPath } },
        },
      },
    },
  };
}

// ── Initial layer state ─────────────────────────────────────────────────────
function initLayers() {
  const s = {};
  LAYER_TYPES.forEach(lt => {
    s[lt.id] = { enabled: false, opacity: 0.85, loading: false, error: null, mapName: null, tileUrl: null };
  });
  return s;
}

// ── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const mapEl       = useRef(null);
  const mapRef      = useRef(null);
  const tokenRef    = useRef('');
  const projectRef  = useRef('');
  const layersRef   = useRef(initLayers()); // for transformRequest & style reload

  const [country,     setCountry]     = useState('Thailand');
  const [year,        setYear]        = useState('2021');
  const [basemap,     setBasemap]     = useState('satellite');
  const [projectId,   setProjectId]   = useState('');
  const [tokenStatus, setTokenStatus] = useState(null); // null | 'fetching' | 'ok' | 'error'
  const [layers,      setLayers]      = useState(initLayers);
  const [seaOn,       setSeaOn]       = useState(false);

  // ── Map init ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const bm = BASEMAPS.find(b => b.id === 'satellite');
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

    // Re-add active layers after basemap style reload
    const restoreLayers = () => {
      const current = layersRef.current;
      LAYER_TYPES.forEach(lt => {
        const s = current[lt.id];
        if (s.tileUrl && !map.getSource(`gee-${lt.id}`)) {
          map.addSource(`gee-${lt.id}`, { type: 'raster', tiles: [s.tileUrl], tileSize: 256 });
          map.addLayer({ id: `gee-layer-${lt.id}`, type: 'raster', source: `gee-${lt.id}`,
            paint: { 'raster-opacity': s.enabled ? s.opacity : 0 } });
        }
      });
    };
    map.on('style.load', restoreLayers);

    return () => map.remove();
  }, []);

  // ── OAuth sign-in ─────────────────────────────────────────────────────────
  const handleSignIn = useCallback(() => {
    const clientId = import.meta.env.VITE_GEE_OAUTH_CLIENT_ID;
    if (!clientId || !window.google?.accounts?.oauth2) {
      setTokenStatus('error');
      return;
    }
    setTokenStatus('fetching');
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/earthengine',
      callback: (resp) => {
        if (resp.access_token) {
          tokenRef.current = resp.access_token;
          setTokenStatus('ok');
        } else {
          setTokenStatus('error');
        }
      },
    });
    client.requestAccessToken();
  }, []);

  // ── Load a single layer ───────────────────────────────────────────────────
  const loadLayer = useCallback(async (typeId, countryVal, yearVal) => {
    const map = mapRef.current;
    if (!map || !tokenRef.current || !projectRef.current) return;

    const lt = LAYER_TYPES.find(l => l.id === typeId);
    const countryObj = COUNTRIES.find(c => c.label === countryVal);
    if (!lt || !countryObj) return;

    const assetPath = lt.assetFn(countryObj.slug, yearVal);

    // Mark as loading
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
          expression: buildExpression(assetPath),
          visualizationOptions: lt.vis,
          fileFormat: 'PNG',
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message || `HTTP ${res.status}`);
      }

      const { name } = await res.json();
      const tileUrl = `${GEE_API}/${name}/tiles/{z}/{x}/{y}`;

      // Update map source
      const sourceId = `gee-${typeId}`;
      const layerId  = `gee-layer-${typeId}`;
      if (map.getSource(sourceId)) {
        map.removeLayer(layerId);
        map.removeSource(sourceId);
      }
      map.addSource(sourceId, { type: 'raster', tiles: [tileUrl], tileSize: 256 });
      map.addLayer({ id: layerId, type: 'raster', source: sourceId,
        paint: { 'raster-opacity': layersRef.current[typeId].opacity } });

      // Update state + ref
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
    const sourceId = `gee-${typeId}`;
    const layerId  = `gee-layer-${typeId}`;
    if (map.getSource(sourceId)) {
      map.removeLayer(layerId);
      map.removeSource(sourceId);
    }
  }, []);

  // ── Toggle checkbox ───────────────────────────────────────────────────────
  const handleLayerToggle = useCallback((typeId, checked) => {
    if (checked) {
      // Load fresh
      const snap = layersRef.current[typeId];
      layersRef.current = { ...layersRef.current, [typeId]: { ...snap, enabled: true } };
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
    const map = mapRef.current;
    const layerId = `gee-layer-${typeId}`;
    if (map && map.getLayer(layerId)) {
      map.setPaintProperty(layerId, 'raster-opacity', value);
    }
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
        const next = { ...layersRef.current[lt.id], mapName: null, tileUrl: null, error: null };
        layersRef.current = { ...layersRef.current, [lt.id]: next };
        loadLayer(lt.id, newCountry, newYear);
      }
    });
  }, [loadLayer, removeLayerFromMap]);

  // ── Country change ────────────────────────────────────────────────────────
  const handleCountry = useCallback((e) => {
    const val = e.target.value;
    setCountry(val);
    const co = COUNTRIES.find(c => c.label === val);
    if (co && mapRef.current) {
      mapRef.current.flyTo({ center: co.center, zoom: co.zoom, duration: 1200 });
    }
    refreshActive(val, year);
  }, [year, refreshActive]);

  // ── Year change ───────────────────────────────────────────────────────────
  const handleYear = useCallback((e) => {
    const val = e.target.value;
    setYear(val);
    refreshActive(country, val);
  }, [country, refreshActive]);

  // ── Project ID change ─────────────────────────────────────────────────────
  const handleProjectChange = useCallback((e) => {
    const val = e.target.value;
    setProjectId(val);
    projectRef.current = val;
  }, []);

  // ── Basemap switch ────────────────────────────────────────────────────────
  const handleBasemap = useCallback((e) => {
    const id = e.target.value;
    setBasemap(id);
    const map = mapRef.current;
    if (!map) return;
    const bm = BASEMAPS.find(b => b.id === id);
    if (bm.style) map.setStyle(bm.style);
    else          map.setStyle(bm.url);
  }, []);

  // ── SEA boundary toggle ───────────────────────────────────────────────────
  const handleSea = useCallback((checked) => {
    setSeaOn(checked);
    const map = mapRef.current;
    if (!map) return;
    if (checked) {
      if (!map.getSource('sea-boundary')) {
        // Use a simplified SEA bbox outline via a GeoJSON bounding polygon
        // For real boundaries we'd need a GeoJSON file; use map overlay hint
        fetch('https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson')
          .then(r => r.json())
          .then(data => {
            const SEA_NAMES = ['Thailand','Cambodia','Laos','Vietnam','Philippines','Malaysia',
              'Brunei','Timor-Leste','Myanmar','Indonesia','Singapore'];
            const features = data.features.filter(f =>
              SEA_NAMES.includes(f.properties.ADMIN));
            if (!map.getSource('sea-boundary')) {
              map.addSource('sea-boundary', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features },
              });
              map.addLayer({
                id: 'sea-boundary-line', type: 'line',
                source: 'sea-boundary',
                paint: { 'line-color': '#00ffff', 'line-width': 1.5, 'line-opacity': 0.8 },
              });
            }
          })
          .catch(() => {});
      }
    } else {
      if (map.getLayer('sea-boundary-line')) map.removeLayer('sea-boundary-line');
      if (map.getSource('sea-boundary'))     map.removeSource('sea-boundary');
    }
  }, []);

  // ── Derived: any layer has an active tile ────────────────────────────────
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

          {/* ── Authentication ─────────────────────────────────────────── */}
          <div className="section">
            <div className="section-label">Authentication</div>
            <input
              className="input"
              value={projectId}
              onChange={handleProjectChange}
              placeholder="your-gcp-project-id"
              style={{ marginBottom: 5 }}
            />
            <button
              className={`btn btn-sign-in ${tokenStatus === 'ok' ? 'signed-in' : ''}`}
              onClick={handleSignIn}
              disabled={tokenStatus === 'fetching'}
            >
              {tokenStatus === 'fetching' ? <span className="spin">⟳</span> : null}
              {tokenStatus === 'ok' ? '✓ Signed In' : 'Sign In with Google'}
            </button>
            {tokenStatus === 'ok' && (
              <div className="auth-status ok">Authentication successful</div>
            )}
            {tokenStatus === 'error' && (
              <div className="auth-status error">
                Sign-in failed. Check your GEE access at{' '}
                <a href="https://earthengine.google.com/signup" target="_blank" rel="noreferrer"
                  style={{ color: '#f87171' }}>earthengine.google.com</a>
              </div>
            )}
            {!tokenStatus && (
              <div className="auth-status hint">Enter project ID, then sign in to load layers.</div>
            )}
          </div>

          {/* ── Basemap ────────────────────────────────────────────────── */}
          <div className="section">
            <div className="section-label">Basemap</div>
            <select className="select" value={basemap} onChange={handleBasemap}>
              {BASEMAPS.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
          </div>

          {/* ── Country ────────────────────────────────────────────────── */}
          <div className="section">
            <div className="section-label">Country</div>
            <select className="select" value={country} onChange={handleCountry}>
              {COUNTRIES.map(c => <option key={c.slug} value={c.label}>{c.label}</option>)}
            </select>
          </div>

          {/* ── Year ───────────────────────────────────────────────────── */}
          <div className="section">
            <div className="section-label">Year</div>
            <select className="select" value={year} onChange={handleYear}>
              {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          {/* ── Map Layers ─────────────────────────────────────────────── */}
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
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      disabled={!canLoad || s.loading}
                      onChange={e => handleLayerToggle(lt.id, e.target.checked)}
                    />
                    <span className="layer-dot" style={{ background: lt.color }} />
                    <span className="checkbox-label">
                      {s.loading ? `Loading ${lt.id}…` : lt.label}
                    </span>
                  </label>
                  {s.error && <div className="error-box">{s.error}</div>}
                  {s.enabled && !s.loading && (
                    <div className="opacity-row">
                      <input
                        type="range" min={0} max={1} step={0.05}
                        value={s.opacity}
                        onChange={e => handleOpacity(lt.id, Number(e.target.value))}
                      />
                      <span className="opacity-val">{Math.round(s.opacity * 100)}%</span>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Reset */}
            <button className="btn btn-reset" style={{ marginTop: 8 }} onClick={handleReset}>
              Reset All Layers
            </button>
          </div>

          {/* ── Overlay ────────────────────────────────────────────────── */}
          <div className="section">
            <div className="section-label">Overlay</div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={seaOn}
                onChange={e => handleSea(e.target.checked)}
              />
              <span className="checkbox-label">SEA country boundaries</span>
            </label>
          </div>

          {/* ── Legend ─────────────────────────────────────────────────── */}
          <div className="section">
            <div className="section-label">Legend</div>
            {!anyActive && (
              <div className="auth-status hint">No layers active.</div>
            )}
            {LAYER_TYPES.filter(lt => layers[lt.id].enabled && !layers[lt.id].loading).map(lt => (
              <div key={lt.id} className="legend-item">
                <div className="legend-type-label" style={{ color: lt.color }}>
                  {lt.label}
                </div>
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

      {/* ── Map ──────────────────────────────────────────────────────────── */}
      <div className="map-container" ref={mapEl} />
    </div>
  );
}

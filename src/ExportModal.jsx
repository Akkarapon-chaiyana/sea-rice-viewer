import { useState, useCallback, useMemo } from 'react';

const LAYER_OPTIONS = [
  { id: 'Mean',   label: '5-Fold Mean Probability', suffix: 'SEA_Avg',  extra: '' },
  { id: 'Std',    label: 'Standard Deviation',       suffix: 'SEA_Std',  extra: '' },
  { id: 'Binary', label: 'Binary (prob ≥ 50%)',       suffix: 'SEA_Avg',  extra: 'binary' },
  { id: 'Pseudo', label: 'Pseudo-Labeling',           suffix: 'SEA_Pseu', extra: '' },
];

const SCALES = [10, 30, 100, 250, 1000];

// ── Tile helpers ──────────────────────────────────────────────────────────────
function getTileStep(bbox) {
  const [west, south, east, north] = bbox;
  const w = east - west, h = north - south;
  for (const step of [0.5, 1, 2, 3, 5, 10]) {
    if (Math.ceil(w / step) * Math.ceil(h / step) <= 200) return step;
  }
  return 10;
}

function computeTiles(bbox) {
  if (!bbox) return [];
  const [west, south, east, north] = bbox;
  const step = getTileStep(bbox);
  const tiles = [];
  // North → South for display (row 0 = northernmost)
  const latStart = +(Math.ceil(north / step) * step).toFixed(4);
  const lonStart = +(Math.floor(west  / step) * step).toFixed(4);
  let row = 0;
  for (let lat = latStart; lat - step >= south - 0.0001; lat = +(lat - step).toFixed(4)) {
    let col = 0;
    for (let lon = lonStart; lon < east; lon = +(lon + step).toFixed(4)) {
      tiles.push({
        id:    `r${row}c${col}`,
        west:  lon,
        south: +(lat - step).toFixed(4),
        east:  +(lon + step).toFixed(4),
        north: lat,
        row, col,
      });
      col++;
    }
    row++;
  }
  return tiles;
}

function getGridCols(tiles) {
  if (!tiles.length) return 1;
  return Math.max(...tiles.map(t => t.col)) + 1;
}

// ── Script generators ─────────────────────────────────────────────────────────
function layerExportBlock(l, regionVar, descSuffix = '') {
  const mask = l.extra === 'binary' ? '.gte(50).selfMask()' : '';
  return (
    `# ── ${l.label}\n` +
    `asset = f'{ASSET_PREFIX}/${l.suffix}_' + COUNTRY.lower() + f'_{YEAR}'\n` +
    `img   = ee.Image(asset)${mask}.clip(${regionVar})\n` +
    `desc  = f'${l.suffix}_{"{COUNTRY.lower()}"}_{"{YEAR}"}${descSuffix}'`
  );
}

function driveTaskBlock(l, regionVar, descSuffix = '') {
  return (
    layerExportBlock(l, regionVar, descSuffix) + '\n' +
    `task  = ee.batch.Export.image.toDrive(\n` +
    `    image          = img,\n` +
    `    description    = desc,\n` +
    `    folder         = OUTPUT_FOLDER,\n` +
    `    fileNamePrefix = desc,\n` +
    `    region         = ${regionVar},\n` +
    `    scale          = SCALE,\n` +
    `    crs            = 'EPSG:4326',\n` +
    `    maxPixels      = 1e13,\n` +
    `    fileFormat     = 'GeoTIFF',\n` +
    `)\n` +
    `task.start()\n` +
    `print(f'  Started: {desc}  [{task.id}]')`
  );
}

function genDriveCountry({ country, gaulName, year, scale, folder, selectedLayers, projectId }) {
  const header = scriptHeader('Google Drive — Whole Country', country, year, scale, projectId);
  const body = [
    `COUNTRY       = '${country}'`,
    `GAUL_NAME     = '${gaulName}'`,
    `YEAR          = ${year}`,
    `SCALE         = ${scale}`,
    `OUTPUT_FOLDER = '${folder}'`,
    `ASSET_PREFIX  = 'projects/tony-1122/assets/NIE/rice'`,
    ``,
    `fc       = (ee.FeatureCollection('FAO/GAUL/2015/level0')`,
    `              .filter(ee.Filter.eq('ADM0_NAME', GAUL_NAME)))`,
    `geometry = fc.geometry()`,
    ``,
    `print(f'Exporting {COUNTRY} ({YEAR}) at {SCALE} m ...')`,
    ``,
    ...selectedLayers.map(l => driveTaskBlock(l, 'geometry') + '\n'),
    `print(f'\\nAll tasks submitted. Monitor at:')`,
    `print('  https://code.earthengine.google.com/tasks')`,
  ].join('\n');
  return header + body;
}

function genDriveTiles({ country, year, scale, folder, selectedLayers, projectId, activeTiles }) {
  const header = scriptHeader(`Google Drive — ${activeTiles.length} Tiles`, country, year, scale, projectId);
  const tilesStr = `[\n` + activeTiles.map(t =>
    `    [${t.west}, ${t.south}, ${t.east}, ${t.north}],`
  ).join('\n') + `\n]`;

  const body = [
    `COUNTRY       = '${country}'`,
    `YEAR          = ${year}`,
    `SCALE         = ${scale}`,
    `OUTPUT_FOLDER = '${folder}'`,
    `ASSET_PREFIX  = 'projects/tony-1122/assets/NIE/rice'`,
    ``,
    `TILES = ${tilesStr}`,
    ``,
    `print(f'Submitting {len(TILES)} tile exports for {COUNTRY} ({YEAR}) at {SCALE} m ...')`,
    ``,
    ...selectedLayers.map(l =>
      `# ── ${l.label}\n` +
      `for i, (w, s, e, n) in enumerate(TILES):\n` +
      `    region = ee.Geometry.Rectangle([w, s, e, n])\n` +
      `    asset  = f'{ASSET_PREFIX}/${l.suffix}_' + COUNTRY.lower() + f'_{YEAR}'\n` +
      (l.extra === 'binary'
        ? `    img    = ee.Image(asset).gte(50).selfMask().clip(region)\n`
        : `    img    = ee.Image(asset).clip(region)\n`) +
      `    desc   = f'${l.suffix}_{"{COUNTRY.lower()}"}_{"{YEAR}"}_t{"{i:03d}"}_[{"{w}"},{"{s}"}]'\n` +
      `    task   = ee.batch.Export.image.toDrive(\n` +
      `        image=img, description=desc, folder=OUTPUT_FOLDER,\n` +
      `        fileNamePrefix=desc, region=region, scale=SCALE,\n` +
      `        crs='EPSG:4326', maxPixels=1e13, fileFormat='GeoTIFF',\n` +
      `    )\n` +
      `    task.start()\n` +
      `    print(f'  [{"{i+1}"}/{"{len(TILES)}"}] {desc}  [{"{task.id}"}]')\n`
    ),
    `print(f'\\nAll tasks submitted. Monitor at:')`,
    `print('  https://code.earthengine.google.com/tasks')`,
  ].join('\n');
  return header + body;
}

function genLocalCountry({ country, gaulName, year, scale, selectedLayers, projectId, outputDir }) {
  const header = scriptHeader('Local Download — Whole Country', country, year, scale, projectId);
  const dir = outputDir || './sea_rice_output';
  const body = [
    `import requests, zipfile, io, os`,
    ``,
    `COUNTRY      = '${country}'`,
    `GAUL_NAME    = '${gaulName}'`,
    `YEAR         = ${year}`,
    `SCALE        = ${scale}`,
    `OUTPUT_DIR   = '${dir}'`,
    `ASSET_PREFIX = 'projects/tony-1122/assets/NIE/rice'`,
    ``,
    `os.makedirs(OUTPUT_DIR, exist_ok=True)`,
    ``,
    `fc       = (ee.FeatureCollection('FAO/GAUL/2015/level0')`,
    `              .filter(ee.Filter.eq('ADM0_NAME', GAUL_NAME)))`,
    `geometry = fc.geometry()`,
    ``,
    `def download_image(img, desc, region):`,
    `    url = img.getDownloadURL({'scale': SCALE, 'crs': 'EPSG:4326',`,
    `                              'region': region, 'format': 'GeoTIFF'})`,
    `    print(f'  Downloading {desc} ...', end=' ', flush=True)`,
    `    resp = requests.get(url, stream=True)`,
    `    resp.raise_for_status()`,
    `    with zipfile.ZipFile(io.BytesIO(resp.content)) as z:`,
    `        z.extractall(OUTPUT_DIR)`,
    `    print('done')`,
    ``,
    `print(f'Downloading {COUNTRY} ({YEAR}) at {SCALE} m ...')`,
    ``,
    ...selectedLayers.map(l =>
      `# ── ${l.label}\n` +
      `asset = f'{ASSET_PREFIX}/${l.suffix}_' + COUNTRY.lower() + f'_{YEAR}'\n` +
      `img   = ee.Image(asset)${l.extra === 'binary' ? '.gte(50).selfMask()' : ''}.clip(geometry)\n` +
      `download_image(img, f'${l.suffix}_{"{COUNTRY.lower()}"}_{"{YEAR}"}', geometry)\n`
    ),
    `print(f'\\nDone. Files saved to: {OUTPUT_DIR}/')`,
  ].join('\n');
  return header.replace('import ee\n', 'import ee\n') + body;
}

function genLocalTiles({ country, year, scale, selectedLayers, projectId, outputDir, activeTiles }) {
  const header = scriptHeader(`Local Download — ${activeTiles.length} Tiles`, country, year, scale, projectId);
  const dir = outputDir || './sea_rice_output';
  const tilesStr = `[\n` + activeTiles.map(t =>
    `    [${t.west}, ${t.south}, ${t.east}, ${t.north}],`
  ).join('\n') + `\n]`;

  const body = [
    `import requests, zipfile, io, os`,
    ``,
    `COUNTRY      = '${country}'`,
    `YEAR         = ${year}`,
    `SCALE        = ${scale}`,
    `OUTPUT_DIR   = '${dir}'`,
    `ASSET_PREFIX = 'projects/tony-1122/assets/NIE/rice'`,
    ``,
    `os.makedirs(OUTPUT_DIR, exist_ok=True)`,
    ``,
    `TILES = ${tilesStr}`,
    ``,
    `def download_image(img, desc, region):`,
    `    url = img.getDownloadURL({'scale': SCALE, 'crs': 'EPSG:4326',`,
    `                              'region': region, 'format': 'GeoTIFF'})`,
    `    print(f'  Downloading {desc} ...', end=' ', flush=True)`,
    `    resp = requests.get(url, stream=True)`,
    `    resp.raise_for_status()`,
    `    with zipfile.ZipFile(io.BytesIO(resp.content)) as z:`,
    `        z.extractall(OUTPUT_DIR)`,
    `    print('done')`,
    ``,
    `print(f'Downloading {activeTiles.length} tiles for {"{COUNTRY}"} ({"{YEAR}"}) at {scale} m ...')`,
    ``,
    ...selectedLayers.map(l =>
      `# ── ${l.label}\n` +
      `for i, (w, s, e, n) in enumerate(TILES):\n` +
      `    region = ee.Geometry.Rectangle([w, s, e, n])\n` +
      `    print(f'  Tile [{"{i+1}"}/{activeTiles.length}]: [{"{w}"},{"{s}"} → {"{e}"},{"{n}"}]')\n` +
      `    asset  = f'{ASSET_PREFIX}/${l.suffix}_' + COUNTRY.lower() + f'_{YEAR}'\n` +
      (l.extra === 'binary'
        ? `    img    = ee.Image(asset).gte(50).selfMask().clip(region)\n`
        : `    img    = ee.Image(asset).clip(region)\n`) +
      `    download_image(img, f'${l.suffix}_{"{COUNTRY.lower()}"}_{"{YEAR}"}_t{"{i:03d}"}', region)\n`
    ),
    `print(f'\\nDone. Files saved to: {OUTPUT_DIR}/')`,
  ].join('\n');
  return header + body;
}

function scriptHeader(mode, country, year, scale, projectId) {
  return (
    `#!/usr/bin/env python3\n` +
    `"""\nSEA Rice Viewer — Export Script\n` +
    `Mode    : ${mode}\n` +
    `Country : ${country}\n` +
    `Year    : ${year}\n` +
    `Scale   : ${scale} m\n"""\n` +
    `import ee\n\n` +
    `ee.Authenticate()\n` +
    `ee.Initialize(project='${projectId || 'YOUR_GCP_PROJECT_ID'}')\n\n`
  );
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function ExportModal({ country, gaulName, year, projectId, bbox, onClose }) {
  const [selected,     setSelected]     = useState({ Mean: true, Std: false, Binary: false, Pseudo: false });
  const [scale,        setScale]        = useState(30);
  const [exportTarget, setExportTarget] = useState('country'); // 'country' | 'tiles'
  const [exportDest,   setExportDest]   = useState('drive');   // 'drive' | 'local'
  const [folder,       setFolder]       = useState('sea_rice_export');
  const [outputDir,    setOutputDir]    = useState('./sea_rice_output');
  const [copied,       setCopied]       = useState(false);

  // Compute tile grid from bbox
  const tiles      = useMemo(() => computeTiles(bbox), [bbox]);
  const gridCols   = useMemo(() => getGridCols(tiles), [tiles]);
  const tileStep   = useMemo(() => bbox ? getTileStep(bbox) : 1, [bbox]);

  const [selectedTiles, setSelectedTiles] = useState(() => new Set(tiles.map(t => t.id)));

  const toggleTile = useCallback((id) => {
    setSelectedTiles(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectAll  = useCallback(() => setSelectedTiles(new Set(tiles.map(t => t.id))), [tiles]);
  const selectNone = useCallback(() => setSelectedTiles(new Set()), []);

  const selectedLayers = LAYER_OPTIONS.filter(l => selected[l.id]);
  const activeTiles    = tiles.filter(t => selectedTiles.has(t.id));

  const script = useMemo(() => {
    const args = { country, gaulName, year, scale, folder, selectedLayers, projectId, outputDir, activeTiles };
    if (exportTarget === 'country') {
      return exportDest === 'drive' ? genDriveCountry(args) : genLocalCountry(args);
    } else {
      return exportDest === 'drive' ? genDriveTiles(args) : genLocalTiles(args);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, gaulName, year, scale, folder, projectId, outputDir, exportTarget, exportDest,
      JSON.stringify(selectedLayers), activeTiles.length, JSON.stringify(activeTiles.map(t => t.id))]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(script).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [script]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([script], { type: 'text/x-python' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `sea_rice_export_${country.toLowerCase()}_${year}.py`;
    a.click();
    URL.revokeObjectURL(url);
  }, [script, country, year]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>

        {/* Title bar */}
        <div className="modal-titlebar">
          <div className="modal-traffic">
            <span className="modal-dot red"   onClick={onClose} />
            <span className="modal-dot yellow" />
            <span className="modal-dot green"  />
          </div>
          <span className="modal-title">Export — {country} {year}</span>
        </div>

        <div className="modal-body">

          {/* Layers */}
          <div className="modal-section">
            <div className="modal-label">Layers to export</div>
            <div className="modal-grid2">
              {LAYER_OPTIONS.map(l => (
                <label key={l.id} className="checkbox-row">
                  <input type="checkbox" checked={!!selected[l.id]}
                    onChange={e => setSelected(s => ({ ...s, [l.id]: e.target.checked }))} />
                  <span className="checkbox-label">{l.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Scale */}
          <div className="modal-section">
            <div className="modal-label">Resolution (m/px)</div>
            <div className="modal-scale-row">
              {SCALES.map(s => (
                <button key={s}
                  className={`scale-btn ${scale === s ? 'active' : ''}`}
                  onClick={() => setScale(s)}>
                  {s} m
                </button>
              ))}
            </div>
          </div>

          {/* Export target */}
          <div className="modal-section">
            <div className="modal-label">Export area</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              {[['country', 'Whole Country'], ['tiles', 'Grid Tiles']].map(([val, lbl]) => (
                <button key={val}
                  className={`scale-btn ${exportTarget === val ? 'active' : ''}`}
                  onClick={() => setExportTarget(val)}>
                  {lbl}
                </button>
              ))}
            </div>

            {exportTarget === 'tiles' && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                  <span style={{ fontSize: 10, color: '#888899' }}>
                    Tile size: {tileStep}° × {tileStep}° · {activeTiles.length}/{tiles.length} selected
                  </span>
                  <div style={{ display: 'flex', gap: 5 }}>
                    <button className="scale-btn" style={{ padding: '2px 8px', fontSize: 10 }} onClick={selectAll}>All</button>
                    <button className="scale-btn" style={{ padding: '2px 8px', fontSize: 10 }} onClick={selectNone}>None</button>
                  </div>
                </div>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
                  gap: 2,
                  maxHeight: 130,
                  overflowY: 'auto',
                  padding: 4,
                  background: '#0d0d1f',
                  borderRadius: 5,
                  border: '1px solid #2a2a4a',
                }}>
                  {tiles.map(tile => (
                    <div
                      key={tile.id}
                      title={`${tile.west.toFixed(1)}–${tile.east.toFixed(1)}°E, ${tile.south.toFixed(1)}–${tile.north.toFixed(1)}°N`}
                      onClick={() => toggleTile(tile.id)}
                      style={{
                        height: 14,
                        background: selectedTiles.has(tile.id) ? '#7b8cde' : '#2a2a4a',
                        border: '1px solid #1a1a3a',
                        cursor: 'pointer',
                        borderRadius: 2,
                        transition: 'background 0.1s',
                      }}
                    />
                  ))}
                </div>
                {activeTiles.length === 0 && (
                  <div className="auth-status error" style={{ marginTop: 5 }}>Select at least one tile.</div>
                )}
              </div>
            )}
          </div>

          {/* Export destination */}
          <div className="modal-section">
            <div className="modal-label">Export destination</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              {[['drive', 'Google Drive'], ['local', 'Local Download']].map(([val, lbl]) => (
                <button key={val}
                  className={`scale-btn ${exportDest === val ? 'active' : ''}`}
                  onClick={() => setExportDest(val)}>
                  {lbl}
                </button>
              ))}
            </div>
            {exportDest === 'drive' && (
              <input className="input" value={folder}
                onChange={e => setFolder(e.target.value)}
                placeholder="sea_rice_export"
                style={{ marginTop: 2 }} />
            )}
            {exportDest === 'local' && (
              <>
                <input className="input" value={outputDir}
                  onChange={e => setOutputDir(e.target.value)}
                  placeholder="./sea_rice_output"
                  style={{ marginTop: 2 }} />
                <div style={{ fontSize: 10, color: '#7b8cde', marginTop: 4, lineHeight: 1.4 }}>
                  Uses <code style={{ background: '#1a1a32', padding: '1px 4px', borderRadius: 3 }}>getDownloadURL()</code> — works for tiles up to ~100 MB each. For large areas use Google Drive.
                </div>
              </>
            )}
          </div>

          {/* Script preview */}
          <div className="modal-section">
            <div className="modal-label">Generated Python script</div>
            <pre className="code-block">{script}</pre>
          </div>

        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn btn-copy" onClick={handleCopy}>
            {copied ? '✓ Copied!' : 'Copy Script'}
          </button>
          <button className="btn btn-download-py" onClick={handleDownload}>
            ↓ Download .py
          </button>
        </div>

      </div>
    </div>
  );
}

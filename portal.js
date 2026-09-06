// Client Data Viewer - a read-only "showcase" of one survey's results, built for handing a Site's
// review outcomes to a client without giving them any access to the internal review/QA/analysis
// tooling. Clara, 2026-09-07: "i want a client data review page - they cannot access analysis or
// any internal workflows - just a showcase of: 1. Roost register 2. QA (list of images, species
// assigned, open window to play video) 3. Sound analysis results."
//
// Deliberately a separate, standalone app (not a mode inside SurveyReview) so a future change to
// the internal app can never accidentally leak an edit affordance into what a client sees - the
// only code that runs here is what's written in this file, plus the pure data/logic modules
// (models.js/files.js/map.js) reused verbatim from SurveyReview, which contain no UI at all.
//
// Data handover model (Clara's own words: "the client will need to download that folder... and
// then go into the client data viewing portal and load into results") - a static, point-in-time
// snapshot, not a live connection:
//   1. Clara exports the Site from SurveyReview ("Export" on the Sites list - already produces
//      exactly the JSON this page loads, no new export feature needed) into the folder she's
//      sharing with the client, alongside the WIS stills, videos, and any exported clips/reports.
//   2. The client downloads that whole folder, opens this page, loads the JSON, then links that
//      SAME folder here (one picker, not per-Location like the internal app - see indexHandoverFolder).
// Nothing here ever writes back anywhere - there is no Firebase, no sign-in, no save.
const { useState, useEffect, useRef, useMemo } = React;
const h = React.createElement;
const M = window.SR.Models;
const F = window.SR.Files;
const Wav = window.SR.Wav;
const Dsp = window.SR.Dsp;

function Modal({ title, onClose, wide, children }) {
  return h('div', { className: 'modal-overlay', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
    h('div', { className: 'modal' + (wide ? ' modal-wide' : '') },
      h('div', { className: 'modal-title' }, title),
      children
    )
  );
}

const SUMMARY_TH_STYLE = { textAlign: 'left', padding: '4px 10px 4px 0', color: 'var(--text-faint)', fontSize: 10, textTransform: 'uppercase', whiteSpace: 'nowrap' };
const SUMMARY_TD_STYLE = { padding: '4px 10px 4px 0', borderTop: '1px solid var(--border)', whiteSpace: 'nowrap' };

function formatEmergenceTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatOffset(seconds) {
  if (seconds == null) return '';
  const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}
function formatClipTime(seconds) {
  const m = Math.floor(seconds / 60), s = (seconds % 60).toFixed(1);
  return `${m}m ${s}s`;
}

const SPECIES_PILL_COLORS = ['#4fb8a8', '#e8833a', '#7c9fe8', '#e85a6a', '#c98fe8', '#9fd15a', '#e8c93a', '#5ad1c9'];
function speciesPillColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return SPECIES_PILL_COLORS[hash % SPECIES_PILL_COLORS.length];
}
const ROOST_SHAPE_COLORS = ['#e8833a', '#4fa8d8', '#7cb342', '#ab47bc', '#ef5350', '#26a69a', '#ffca28', '#5c6bc0'];
function colorForRoost(roostId) {
  if (!roostId) return ROOST_SHAPE_COLORS[0];
  let hash = 0;
  for (let i = 0; i < roostId.length; i++) hash = (hash * 31 + roostId.charCodeAt(i)) >>> 0;
  return ROOST_SHAPE_COLORS[hash % ROOST_SHAPE_COLORS.length];
}

function recordingSpeciesLabel(analysis) {
  if (!analysis) return '';
  if (analysis.finalSpecies) return analysis.finalSpecies;
  return (analysis.additionalTaxa || []).join(' + ');
}
function matchedRecordingSpecies(img, matched) {
  if (!matched) return '';
  return (img && img.matchedSpeciesPick) || recordingSpeciesLabel(matched.recording.analysis);
}

// Same walk computeRoostStats already runs internally in SurveyReview, copied verbatim (it's a
// pure function of `site`, no edit path) so the client sees identical peak counts/species/windows.
function computeRoostStats(site) {
  const stats = {};
  (site.roostEntrances || []).forEach((r) => { stats[r.id] = { peakCount: 0, peakSurveyDate: null, surveyDates: new Set(), species: new Set(), references: [], bySurvey: [] }; });
  (site.surveys || []).forEach((survey) => {
    const surveyTotals = {};
    const surveySpecies = {};
    const surveyLocations = {};
    const surveyTimes = {};
    (survey.locations || []).forEach((loc) => {
      (loc.images || []).forEach((img) => {
        (img.emergingRoosts || []).forEach((entry) => {
          const s = stats[entry.roostEntranceId];
          if (!s) return;
          const counts = entry.countsToward !== false;
          s.surveyDates.add(survey.surveyDate || '(no date)');
          if (counts) surveyTotals[entry.roostEntranceId] = (surveyTotals[entry.roostEntranceId] || 0) + entry.count;
          const matched = M.matchedRecordingFor(survey, img);
          const soundSpecies = matchedRecordingSpecies(img, matched);
          const species = soundSpecies || img.visualSpecies;
          if (species) {
            s.species.add(species);
            (surveySpecies[entry.roostEntranceId] = surveySpecies[entry.roostEntranceId] || new Set()).add(species);
          }
          (surveyLocations[entry.roostEntranceId] = surveyLocations[entry.roostEntranceId] || new Set()).add(loc.name || '(unnamed location)');
          const iso = (counts && entry.count > 0) ? F.imageDateTimeIso(img) : null;
          if (iso) {
            const t = surveyTimes[entry.roostEntranceId];
            if (!t) surveyTimes[entry.roostEntranceId] = { start: iso, end: iso };
            else { if (iso < t.start) t.start = iso; if (iso > t.end) t.end = iso; }
          }
          s.references.push({
            surveyId: survey.id, surveyDate: survey.surveyDate, locationId: loc.id, locationName: loc.name,
            imageId: img.id, fileName: img.fileName, count: entry.count, countsToward: counts,
            visualSpecies: img.visualSpecies, matchedSpecies: matchedRecordingSpecies(img, M.matchedRecordingFor(survey, img)),
          });
        });
      });
    });
    Object.keys(surveyTotals).forEach((roostEntranceId) => {
      const s = stats[roostEntranceId];
      if (!s) return;
      const t = surveyTimes[roostEntranceId];
      s.bySurvey.push({
        surveyId: survey.id, surveyDate: survey.surveyDate || '(no date)', count: surveyTotals[roostEntranceId],
        species: Array.from(surveySpecies[roostEntranceId] || []), locations: Array.from(surveyLocations[roostEntranceId] || []),
        emergenceStart: t ? t.start : null, emergenceEnd: t ? t.end : null,
      });
      if (surveyTotals[roostEntranceId] > s.peakCount) { s.peakCount = surveyTotals[roostEntranceId]; s.peakSurveyDate = survey.surveyDate || '(no date)'; }
    });
  });
  Object.values(stats).forEach((s) => s.bySurvey.sort((a, b) => (a.surveyDate || '').localeCompare(b.surveyDate || '')));
  return stats;
}

// Aggregates entrance-level stats up to the Roost (group) level - copied verbatim from
// SurveyReview's own computeRoostGroupStats, a pure function of `site`.
function computeRoostGroupStats(site) {
  const entranceStats = computeRoostStats(site);
  const groupStats = {};
  const bySurveyAgg = {};
  (site.roosts || []).forEach((g) => {
    groupStats[g.id] = { peakCount: 0, peakSurveyDate: null, species: new Set(), references: [], bySurvey: [] };
    bySurveyAgg[g.id] = {};
  });
  (site.roostEntrances || []).forEach((entrance) => {
    const g = entrance.roostId && groupStats[entrance.roostId];
    if (!g) return;
    const es = entranceStats[entrance.id];
    if (!es) return;
    es.species.forEach((sp) => g.species.add(sp));
    g.references.push(...es.references);
    es.bySurvey.forEach((b) => {
      const agg = bySurveyAgg[entrance.roostId];
      if (!agg[b.surveyId]) {
        agg[b.surveyId] = { surveyId: b.surveyId, surveyDate: b.surveyDate, count: 0, species: new Set(), locations: new Set(), emergenceStart: null, emergenceEnd: null };
      }
      const a = agg[b.surveyId];
      a.count += b.count;
      b.species.forEach((sp) => a.species.add(sp));
      b.locations.forEach((l) => a.locations.add(l));
      if (b.emergenceStart) {
        if (!a.emergenceStart || b.emergenceStart < a.emergenceStart) a.emergenceStart = b.emergenceStart;
        if (!a.emergenceEnd || b.emergenceEnd > a.emergenceEnd) a.emergenceEnd = b.emergenceEnd;
      }
    });
  });
  Object.keys(groupStats).forEach((roostId) => {
    const g = groupStats[roostId];
    Object.values(bySurveyAgg[roostId]).forEach((a) => {
      g.bySurvey.push({ surveyId: a.surveyId, surveyDate: a.surveyDate, count: a.count, species: Array.from(a.species), locations: Array.from(a.locations), emergenceStart: a.emergenceStart, emergenceEnd: a.emergenceEnd });
      if (a.count > g.peakCount) { g.peakCount = a.count; g.peakSurveyDate = a.surveyDate; }
    });
    g.bySurvey.sort((x, y) => (x.surveyDate || '').localeCompare(y.surveyDate || ''));
  });
  return groupStats;
}

function computeSoundStats(surveys) {
  const bySpecies = {};
  const detectorEntries = [];
  let totalRecordings = 0, totalAnalysed = 0, allDetectorCount = 0;
  (surveys || []).forEach((survey) => {
    (survey.soundDetectors || []).forEach((det) => {
      allDetectorCount++;
      const progress = M.soundProgress(det);
      totalRecordings += progress.total;
      totalAnalysed += progress.analysed;
      if ((det.recordings || []).length > 0) detectorEntries.push({ detector: det, survey });
      const summary = M.soundSummary(det);
      summary.speciesList.forEach((s) => {
        if (!bySpecies[s.species]) bySpecies[s.species] = { species: s.species, totalBouts: 0, totalPasses: 0, references: [] };
        bySpecies[s.species].totalBouts += s.boutCount;
        bySpecies[s.species].totalPasses += s.passCount;
        bySpecies[s.species].references.push({
          surveyId: survey.id, surveyDate: survey.surveyDate || '(no date)', detectorId: det.id,
          detectorName: det.name || '(unnamed detector)', boutCount: s.boutCount, passCount: s.passCount,
        });
      });
    });
  });
  Object.values(bySpecies).forEach((s) => s.references.sort((a, b) => (a.surveyDate || '').localeCompare(b.surveyDate || '') || a.detectorName.localeCompare(b.detectorName)));
  const speciesList = Object.values(bySpecies).sort((a, b) => b.totalPasses - a.totalPasses);
  detectorEntries.sort((a, b) => (a.survey.surveyDate || '').localeCompare(b.survey.surveyDate || '') || (a.detector.name || '').localeCompare(b.detector.name || ''));
  return { speciesList, detectorEntries, totalRecordings, totalAnalysed, detectorCount: allDetectorCount };
}

function SoundSummaryCard({ detector, progress }) {
  const summary = M.soundSummary(detector);
  const complete = !progress || progress.pct === 100;
  return h('div', { className: 'card', style: { marginBottom: 16, borderColor: 'var(--teal)' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 } },
      h('div', { style: { color: 'var(--teal)', fontWeight: 700, fontSize: 13 } },
        complete ? '✓ Fully analysed - summary' : `${progress.pct}% analysed so far - summary`),
      summary.spanHours != null && h('div', { className: 'card-sub' }, `Monitored ${summary.spanHours.toFixed(1)}h, first to last recording`)
    ),
    summary.speciesList.length === 0
      ? h('div', { className: 'card-sub' }, 'No bat passes identified (every recording was Noise / No ID).')
      : h('div', { style: { overflowX: 'auto' } },
          h('table', { style: { borderCollapse: 'collapse', fontSize: 12 } },
            h('thead', null, h('tr', null,
              h('th', { style: SUMMARY_TH_STYLE }, 'Species'), h('th', { style: SUMMARY_TH_STYLE }, 'Passes'),
              h('th', { style: SUMMARY_TH_STYLE }, 'Passes/hour'), h('th', { style: SUMMARY_TH_STYLE }, 'Bouts'),
              h('th', { style: SUMMARY_TH_STYLE }, 'Bouts/hour')
            )),
            h('tbody', null, summary.speciesList.map((s) => h('tr', { key: s.species },
              h('td', { style: SUMMARY_TD_STYLE }, s.species), h('td', { style: SUMMARY_TD_STYLE }, s.passCount),
              h('td', { style: SUMMARY_TD_STYLE }, summary.spanHours ? (s.passCount / summary.spanHours).toFixed(2) : '—'),
              h('td', { style: SUMMARY_TD_STYLE }, s.boutCount),
              h('td', { style: SUMMARY_TD_STYLE }, summary.spanHours ? (s.boutCount / summary.spanHours).toFixed(2) : '—')
            )))
          )
        ),
    h('div', { className: 'card-sub', style: { marginTop: 10 } },
      `${summary.totalPasses} pass(es), ${summary.totalBouts} bout(s) total`
      + (summary.passesPerHourOverall != null ? ` · ${summary.passesPerHourOverall.toFixed(2)} passes/hour overall` : '')
      + (summary.boutsPerHourOverall != null ? ` · ${summary.boutsPerHourOverall.toFixed(2)} bouts/hour overall` : '')
      + ` · consecutive same-species calls under ${summary.boutGapMinutes} min apart count as one bout.`)
  );
}

// ---------------- Handover folder indexing ----------------
// One flat recursive index by filename, unlike SurveyReview's own per-Location/per-Detector folder
// links - a client's handover folder isn't maintained as an ongoing per-camera structure the way
// Clara's own survey is, it's a one-off drop of everything together. Matching purely by filename
// (same convention the internal app already relies on for WIS/video pairing) works regardless of
// whatever subfolder layout the handover actually used.
const IMAGE_EXT = /\.(jpe?g|png)$/i;
const VIDEO_EXT = /\.(mp4|mov|avi|mkv)$/i;
async function indexHandoverFolder(rootHandle, maxDepth) {
  const index = new Map(); // lowercased filename -> FileSystemFileHandle
  async function walk(dirHandle, depth) {
    const subdirs = [];
    for await (const [name, entry] of dirHandle.entries()) {
      if (entry.kind === 'file') {
        const key = name.toLowerCase();
        if (!index.has(key)) index.set(key, entry);
      } else if (entry.kind === 'directory') {
        subdirs.push(entry);
      }
    }
    if (depth <= 0) return;
    for (const sub of subdirs) await walk(sub, depth - 1);
  }
  await walk(rootHandle, maxDepth);
  return index;
}

// ---------------- Zoomable WIS still (copied from SurveyReview's QA review - identical mechanics,
// see that file's own comment) ----------------
function ZoomableImage({ src, alt }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStateRef = useRef(null);
  function onWheelZoom(e) { e.preventDefault(); setZoom((z) => Math.min(6, Math.max(1, z - e.deltaY * 0.0015))); }
  function onPanStart(e) { if (zoom <= 1) return; panStateRef.current = { startX: e.clientX, startY: e.clientY, startPan: pan }; setIsPanning(true); }
  function onPanMove(e) { if (!panStateRef.current) return; setPan({ x: panStateRef.current.startPan.x + (e.clientX - panStateRef.current.startX), y: panStateRef.current.startPan.y + (e.clientY - panStateRef.current.startY) }); }
  function onPanEnd() { panStateRef.current = null; setIsPanning(false); }
  function resetZoom() { setZoom(1); setPan({ x: 0, y: 0 }); }
  return h('div', { style: { position: 'relative', height: '48vh', background: '#0a0c0e', overflow: 'hidden', borderRadius: 'var(--radius)' } },
    h('div', {
      className: 'review-stage-inner' + (isPanning ? ' panning' : ''),
      onWheel: onWheelZoom, onMouseDown: onPanStart, onMouseMove: onPanMove, onMouseUp: onPanEnd, onMouseLeave: onPanEnd,
    },
      src ? h('img', { src, alt, style: { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center center' } })
        : h('div', { className: 'empty-text' }, 'No matching image found in the linked folder.')
    ),
    h('div', { className: 'review-stage-zoom' },
      h('button', { className: 'btn btn-secondary btn-small', onClick: () => setZoom((z) => Math.max(1, z - 0.5)) }, '−'),
      h('span', { style: { fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center', fontFamily: 'var(--font-mono)' } }, Math.round(zoom * 100) + '%'),
      h('button', { className: 'btn btn-secondary btn-small', onClick: () => setZoom((z) => Math.min(6, z + 0.5)) }, '+'),
      zoom !== 1 && h('button', { className: 'btn btn-secondary btn-small', onClick: resetZoom }, 'Reset')
    )
  );
}

// ---------------- Video popup (same two playback modes as SurveyReview's QA review) ----------------
const VIDEO_SPEEDS = [0.1, 0.25, 0.33, 0.5, 0.75, 0.9, 1, 1.5, 2];
const APPROX_FRAME_SECONDS = 1 / 25;
function VideoPopup({ image, videoHandle, onClose }) {
  const videoRef = useRef(null);
  const [rate, setRate] = useState(1);
  const [videoUrl, setVideoUrl] = useState(null);
  const stopAtRef = useRef(null);
  const loopRef = useRef(null);
  const [activeMode, setActiveMode] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!videoHandle) return;
    (async () => {
      const url = await F.getFileBlobUrl(videoHandle);
      if (!cancelled) setVideoUrl(url); else URL.revokeObjectURL(url);
    })();
    return () => { cancelled = true; };
  }, [videoHandle]);
  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);

  function setSpeed(r) { setRate(r); if (videoRef.current) videoRef.current.playbackRate = r; }
  function stepFrame(deltaFrames) {
    const v = videoRef.current; if (!v) return;
    v.pause(); stopAtRef.current = null; loopRef.current = null; setActiveMode(null);
    v.currentTime = Math.max(0, v.currentTime + deltaFrames * APPROX_FRAME_SECONDS);
  }
  function playThirtySeconds() {
    const v = videoRef.current; if (!v) return;
    const start = image.offsetSeconds || 0;
    loopRef.current = null; stopAtRef.current = start + 30; setActiveMode('thirty');
    v.currentTime = start; v.play();
  }
  function playRangeLoop(range) {
    const v = videoRef.current; if (!v) return;
    stopAtRef.current = null; loopRef.current = { start: range.startSeconds, end: range.endSeconds }; setActiveMode(range.id);
    v.currentTime = range.startSeconds; v.play();
  }
  function onTimeUpdate() {
    const v = videoRef.current; if (!v) return;
    if (loopRef.current && v.currentTime >= loopRef.current.end) { v.currentTime = loopRef.current.start; v.play(); }
    else if (stopAtRef.current != null && v.currentTime >= stopAtRef.current) { v.pause(); stopAtRef.current = null; setActiveMode(null); }
  }

  const ranges = image.clipRanges || [];
  return h(Modal, { title: `Video — ${image.fileName}`, onClose, wide: true },
    !videoHandle && h('div', { className: 'warning-banner' }, 'No matching video found in the linked folder.'),
    videoUrl && h('video', {
      ref: videoRef, src: videoUrl, controls: true, onTimeUpdate,
      style: { width: '100%', maxHeight: '55vh', background: '#000', display: 'block' },
    }),
    videoUrl && h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 } },
      h('div', { className: 'video-controls-row' },
        h('button', { className: 'btn btn-secondary btn-small' + (activeMode === 'thirty' ? ' speed-btn-active' : ''), onClick: playThirtySeconds },
          `▶ Play 30s from ${formatOffset(image.offsetSeconds || 0)}`)
      ),
      ranges.length > 0 && h('div', { className: 'video-controls-row' },
        ranges.map((r, i) => h('button', {
          key: r.id, className: 'btn btn-secondary btn-small' + (activeMode === r.id ? ' speed-btn-active' : ''),
          onClick: () => playRangeLoop(r),
        }, `🔁 Loop clip ${i + 1} (${formatClipTime(r.startSeconds)}–${formatClipTime(r.endSeconds)})`))
      ),
      h('div', { className: 'video-controls-row' },
        h('span', { className: 'card-sub', style: { marginRight: 4 } }, 'Speed:'),
        VIDEO_SPEEDS.map((s) => h('button', { key: s, className: 'btn btn-secondary btn-tiny' + (rate === s ? ' speed-btn-active' : ''), onClick: () => setSpeed(s) }, s + 'x'))
      ),
      h('div', { className: 'video-controls-row' },
        h('span', { className: 'card-sub', style: { marginRight: 4 } }, 'Frame step:'),
        h('button', { className: 'btn btn-secondary btn-tiny', onClick: () => stepFrame(-1) }, '◀ Frame'),
        h('button', { className: 'btn btn-secondary btn-tiny', onClick: () => stepFrame(1) }, 'Frame ▶')
      )
    ),
    h('div', { className: 'modal-actions' }, h('button', { className: 'btn btn-secondary', onClick: onClose }, 'Close'))
  );
}

// ---------------- Site map: roost entrances/groups, plus optional Locations/Detectors layers,
// scoped to a chosen survey visit - same "survey visit" + "Locations/Detectors/Roosts" layer
// toggles as SurveyReview's own SurveyMapPanel, rebuilt here at client-appropriate simplicity
// (no FOV wedges/bearing icons - just presence markers) since it's not worth pulling the internal
// component's full editing-adjacent complexity across for a read-only view. Clara, 2026-09-07/08:
// "they can... toggle on and off cameras and sound detectors" and "check survey date they want to
// check." ----------------
function SiteMap({ site, surveyId, layers }) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  useEffect(() => {
    const map = L.map(elRef.current, { zoomControl: true }).setView([52.2, -2.22], 6);
    SR.Map.makeTileLayer(SR.Map.DEFAULT_BASE_LAYER).addTo(map);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 50);
    return () => { try { map.remove(); } catch (e) {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (layerRef.current) { try { map.removeLayer(layerRef.current); } catch (e) {} }
    const group = L.layerGroup();
    const bounds = [];
    const surveys = (site.surveys || []).filter((sv) => surveyId === 'all' || sv.id === surveyId);

    if (layers.locations) {
      surveys.forEach((sv) => (sv.locations || []).forEach((loc) => {
        if (typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') return;
        L.marker([loc.latitude, loc.longitude], { icon: SR.Map.iconFor('location') }).bindTooltip(loc.name || '(unnamed location)').addTo(group);
        bounds.push([loc.latitude, loc.longitude]);
      }));
    }
    if (layers.detectors) {
      surveys.forEach((sv) => (sv.soundDetectors || []).forEach((det) => {
        if (typeof det.latitude !== 'number' || typeof det.longitude !== 'number') return;
        L.marker([det.latitude, det.longitude], { icon: SR.Map.iconFor('detector') }).bindTooltip(det.name || '(unnamed detector)').addTo(group);
        bounds.push([det.latitude, det.longitude]);
      }));
    }
    if (layers.roosts) {
      (site.roostEntrances || []).forEach((r) => {
        if (typeof r.latitude !== 'number' || typeof r.longitude !== 'number') return;
        L.marker([r.latitude, r.longitude], { icon: SR.Map.iconFor('roost') }).bindTooltip(`${r.code}${r.description ? ' — ' + r.description : ''}`).addTo(group);
        bounds.push([r.latitude, r.longitude]);
      });
      (site.roosts || []).forEach((g) => {
        if (!g.geometry) return;
        try { L.geoJSON(g.geometry, { style: { color: colorForRoost(g.id), weight: 3 } }).addTo(group); }
        catch (e) { console.error('SiteMap: skipping unrenderable roost shape', e); }
      });
    }
    group.addTo(map);
    layerRef.current = group;
    if (bounds.length > 0) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
  }, [site, surveyId, layers.locations, layers.detectors, layers.roosts]);

  return h('div', { ref: elRef, className: 'map-picker', style: { height: 400 } });
}

// ---------------- Step 1: load the site data export ----------------
function LoadSiteScreen({ onLoaded }) {
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      const site = M.migrateSite(JSON.parse(text));
      onLoaded(site);
    } catch (err) {
      setError('Couldn\'t read that file - make sure it\'s the .json site data file from your handover folder. (' + (err && err.message || String(err)) + ')');
    }
  }
  return h('div', { className: 'empty-state', style: { height: '100%', justifyContent: 'center' } },
    h('div', { style: { fontSize: 40, marginBottom: 12 } }, '🦇'),
    h('div', { className: 'empty-title' }, 'Load your survey data'),
    h('div', { className: 'empty-text' }, 'Open the site data file (ending in .json) from the folder your ecologist shared with you.'),
    h('input', { ref: inputRef, type: 'file', accept: '.json,application/json', style: { display: 'none' }, onChange: onFile }),
    h('button', { className: 'btn btn-primary btn-big', style: { marginTop: 16 }, onClick: () => inputRef.current.click() }, 'Choose file…'),
    error && h('div', { className: 'warning-banner', style: { marginTop: 16, maxWidth: 420 } }, error)
  );
}

// ---------------- Step 2: link the same handover folder for media ----------------
function LinkMediaScreen({ onLinked, onSkip }) {
  const [status, setStatus] = useState('idle'); // idle | linking | error
  const [error, setError] = useState(null);
  async function pickFolder() {
    setStatus('linking'); setError(null);
    try {
      const root = await window.showDirectoryPicker({ mode: 'read' });
      const index = await indexHandoverFolder(root, 8);
      onLinked(index);
    } catch (e) {
      if (e && e.name === 'AbortError') { setStatus('idle'); return; }
      setError(e && e.message || String(e));
      setStatus('error');
    }
  }
  return h('div', { className: 'empty-state', style: { height: '100%', justifyContent: 'center' } },
    h('div', { style: { fontSize: 40, marginBottom: 12 } }, '📁' ),
    h('div', { className: 'empty-title' }, 'Link your media folder'),
    h('div', { className: 'empty-text' },
      'Data loaded. Now select the same handover folder (or its parent) so images, video and any exported clips can be shown - nothing is uploaded, it stays on this device.'),
    !F.supportsFolderPicker && h('div', { className: 'warning-banner', style: { marginTop: 16, maxWidth: 420 } },
      'This browser doesn\'t support linking a folder this way - please open this page in Chrome or Edge to see images and video. You can still view the written results below.'),
    F.supportsFolderPicker && h('button', { className: 'btn btn-primary btn-big', style: { marginTop: 16 }, onClick: pickFolder, disabled: status === 'linking' },
      status === 'linking' ? 'Linking…' : 'Choose folder…'),
    h('button', { className: 'btn btn-secondary', style: { marginTop: 10 }, onClick: onSkip }, 'Skip for now'),
    error && h('div', { className: 'warning-banner', style: { marginTop: 16, maxWidth: 420 } }, error)
  );
}

// ---------------- Roost register (view-only, same grouping/symbology as the internal register) ----------------
// One card per emergenceStats-bearing thing (roost group or entrance): peak count, species, and a
// per-visit table showing count AND the emergence window (first to last confirmed emergence that
// visit) - Clara, 2026-09-08: "i need the peak count and the time between first emergene and last
// emergence." The per-visit table only appears once there's more than one visit to compare, same
// as the internal register's own convention (a single-visit entrance would just repeat the summary
// line above it).
function emergenceCard(code, description, roostColor, s) {
  return h('div', { key: code, className: 'card', style: { marginBottom: 12, ...(roostColor ? { borderLeft: `4px solid ${roostColor}` } : {}) } },
    h('div', { className: 'card-title', style: { display: 'flex', alignItems: 'center', gap: 8 } },
      roostColor && h('span', { style: { display: 'inline-block', width: 11, height: 11, borderRadius: '50%', background: roostColor, flexShrink: 0 } }),
      code
    ),
    description && h('div', { className: 'card-sub', style: { marginTop: 2 } }, description),
    h('div', { style: { marginTop: 8 } },
      h('strong', null, s.peakCount), ' peak count',
      s.peakSurveyDate && h('span', { className: 'card-sub' }, ` (${s.peakSurveyDate})`)
    ),
    h('div', { style: { marginTop: 4 } }, s.species.size > 0 ? Array.from(s.species).join(', ') : 'No species confirmed'),
    s.bySurvey.length > 1 && h('div', { style: { overflowX: 'auto', marginTop: 10 } },
      h('table', { style: { borderCollapse: 'collapse', fontSize: 12 } },
        h('thead', null, h('tr', null,
          h('th', { style: SUMMARY_TH_STYLE }, 'Survey'), h('th', { style: SUMMARY_TH_STYLE }, 'Count'), h('th', { style: SUMMARY_TH_STYLE }, 'Emergence window')
        )),
        h('tbody', null, s.bySurvey.map((row) => h('tr', { key: row.surveyId },
          h('td', { style: SUMMARY_TD_STYLE }, row.surveyDate),
          h('td', { style: { ...SUMMARY_TD_STYLE, fontWeight: row.count === s.peakCount ? 700 : 400 } }, row.count + (row.count === s.peakCount ? ' (peak)' : '')),
          h('td', { style: SUMMARY_TD_STYLE }, row.emergenceStart ? `${formatEmergenceTime(row.emergenceStart)} – ${formatEmergenceTime(row.emergenceEnd)}` : '—')
        )))
      )
    )
  );
}

function RoostRegisterView({ site }) {
  const stats = useMemo(() => computeRoostStats(site), [site]);
  const groupStats = useMemo(() => computeRoostGroupStats(site), [site]);
  const [expandedId, setExpandedId] = useState(null);
  const [surveyId, setSurveyId] = useState('all');
  const [layers, setLayers] = useState({ locations: true, detectors: true, roosts: true });
  function toggleLayer(k) { setLayers((l) => ({ ...l, [k]: !l[k] })); }

  const roosts = site.roosts || [];
  const entrances = site.roostEntrances || [];
  const ungrouped = entrances.filter((r) => !r.roostId || !roosts.some((g) => g.id === r.roostId));

  function entranceCardWithImages(r, roostColor) {
    const s = stats[r.id] || { peakCount: 0, peakSurveyDate: null, species: new Set(), bySurvey: [], references: [] };
    return h('div', { key: r.id },
      emergenceCard(r.code, r.description, roostColor, s),
      h('button', {
        className: 'btn btn-secondary btn-small', style: { margin: '-6px 0 12px' },
        onClick: () => setExpandedId(expandedId === r.id ? null : r.id),
      }, `${expandedId === r.id ? 'Hide' : 'Show'} ${s.references.length} image(s)`),
      expandedId === r.id && h('div', { style: { margin: '-6px 0 12px', display: 'flex', flexDirection: 'column', gap: 4 } },
        s.references.map((ref, i) => h('div', { key: i, className: 'card-sub' },
          `${ref.surveyDate || '(no date)'} · ${ref.locationName} · ${ref.fileName} · count ${ref.count}${ref.matchedSpecies || ref.visualSpecies ? ' · ' + (ref.matchedSpecies || ref.visualSpecies) : ''}`))
      )
    );
  }

  return h('div', { className: 'main' },
    h('div', { className: 'main-header' },
      h('div', null,
        h('div', { className: 'main-title' }, '🦇 Roost register'),
        h('div', { className: 'main-subtitle' }, `${roosts.length} roost(s) · ${entrances.length} entrance(s) registered at this site`)
      )
    ),
    h('div', { className: 'content' },
      entrances.length === 0
        ? h('div', { className: 'empty-state' }, h('div', { className: 'empty-title' }, 'No roost entrances recorded'))
        : h('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap' } },
            h('div', { style: { flex: 2, minWidth: 320 } },
              roosts.map((g) => {
                const gs = groupStats[g.id] || { peakCount: 0, peakSurveyDate: null, species: new Set(), bySurvey: [] };
                const members = entrances.filter((e) => e.roostId === g.id);
                const roostColor = colorForRoost(g.id);
                return h('div', { key: g.id, style: { marginBottom: 16 } },
                  emergenceCard(g.code, g.description, roostColor, gs),
                  h('div', { style: { marginTop: -6, paddingLeft: 14, borderLeft: '2px solid var(--border)' } },
                    members.map((r) => entranceCardWithImages(r, roostColor))
                  )
                );
              }),
              ungrouped.map((r) => entranceCardWithImages(r, null))
            ),
            h('div', { style: { flex: 1, minWidth: 320 } },
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 } },
                (site.surveys || []).length > 1 && h('div', null,
                  h('label', { style: { fontSize: 12, fontWeight: 600, marginRight: 6 } }, 'Survey visit:'),
                  h('select', { value: surveyId, onChange: (e) => setSurveyId(e.target.value) },
                    h('option', { value: 'all' }, 'All surveys'),
                    (site.surveys || []).map((sv) => h('option', { key: sv.id, value: sv.id }, sv.surveyDate || '(no date)'))
                  )
                ),
                h('div', { style: { display: 'flex', gap: 12, fontSize: 12, flexWrap: 'wrap' } },
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
                    h('input', { type: 'checkbox', checked: layers.locations, onChange: () => toggleLayer('locations') }), '📷 Cameras'),
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
                    h('input', { type: 'checkbox', checked: layers.detectors, onChange: () => toggleLayer('detectors') }), '🎤 Sound detectors'),
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
                    h('input', { type: 'checkbox', checked: layers.roosts, onChange: () => toggleLayer('roosts') }), '🦇 Roosts')
                )
              ),
              h(SiteMap, { site, surveyId, layers })
            )
          )
    )
  );
}

// ---------------- Observations (species + video popup only, no editing) ----------------
// Opens the same zoom/pan viewer QA review uses for a WIS still, resolved by exact filename from
// the linked handover folder - Clara, 2026-09-08: "with the WIS image - similar behaviour - you
// click it and it opens a viewer (nice zoom and move behaviours)."
function WisImagePopup({ image, imageHandle, onClose }) {
  const [imgUrl, setImgUrl] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | missing
  useEffect(() => {
    let cancelled = false;
    if (!imageHandle) { setStatus('missing'); return; }
    (async () => {
      const url = await F.getFileBlobUrl(imageHandle);
      if (!cancelled) { setImgUrl(url); setStatus('ready'); } else URL.revokeObjectURL(url);
    })();
    return () => { cancelled = true; };
  }, [imageHandle]);
  useEffect(() => () => { if (imgUrl) URL.revokeObjectURL(imgUrl); }, [imgUrl]);

  return h(Modal, { title: `WIS still — ${image.fileName}`, onClose, wide: true },
    status === 'missing' && h('div', { className: 'warning-banner' }, 'No matching image found in the linked folder.'),
    status === 'ready' && h(ZoomableImage, { src: imgUrl, alt: image.fileName }),
    h('div', { className: 'modal-actions' }, h('button', { className: 'btn btn-secondary', onClick: onClose }, 'Close'))
  );
}

function ObservationsView({ site, mediaIndex }) {
  const [openVideoFor, setOpenVideoFor] = useState(null); // image | null
  const [openImageFor, setOpenImageFor] = useState(null); // image | null
  const [sonogramFor, setSonogramFor] = useState(null); // SoundRecording | null
  const rows = useMemo(() => {
    const out = [];
    (site.surveys || []).forEach((survey) => {
      (survey.locations || []).forEach((loc) => {
        (loc.images || []).forEach((img) => {
          if (!img.label && (img.emergingRoosts || []).length === 0 && !img.visualSpecies && !img.matchedRecordingId) return;
          const matched = M.matchedRecordingFor(survey, img);
          const species = matchedRecordingSpecies(img, matched) || img.visualSpecies;
          const entranceCodes = (img.emergingRoosts || [])
            .map((e) => (site.roostEntrances || []).find((r) => r.id === e.roostEntranceId))
            .filter(Boolean).map((r) => r.code);
          out.push({ survey, location: loc, image: img, species, entranceCodes, matched });
        });
      });
    });
    out.sort((a, b) => (a.survey.surveyDate || '').localeCompare(b.survey.surveyDate || '') || a.image.fileName.localeCompare(b.image.fileName));
    return out;
  }, [site]);

  return h('div', { className: 'main' },
    h('div', { className: 'main-header' },
      h('div', null,
        h('div', { className: 'main-title' }, '📷 Observations'),
        h('div', { className: 'main-subtitle' }, `${rows.length} recorded observation(s)`)
      )
    ),
    h('div', { className: 'content' },
      rows.length === 0
        ? h('div', { className: 'empty-state' }, h('div', { className: 'empty-title' }, 'No observations recorded yet'))
        : h('div', { style: { overflowX: 'auto' } },
            h('table', { style: { borderCollapse: 'collapse', fontSize: 13, width: '100%' } },
              h('thead', null, h('tr', null,
                h('th', { style: SUMMARY_TH_STYLE }, 'Date'), h('th', { style: SUMMARY_TH_STYLE }, 'Location'),
                h('th', { style: SUMMARY_TH_STYLE }, 'File'), h('th', { style: SUMMARY_TH_STYLE }, 'Entrance(s)'),
                h('th', { style: SUMMARY_TH_STYLE }, 'Species'), h('th', { style: SUMMARY_TH_STYLE }, '')
              )),
              h('tbody', null, rows.map((row, i) => h('tr', { key: i },
                h('td', { style: SUMMARY_TD_STYLE }, row.survey.surveyDate || '—'),
                h('td', { style: SUMMARY_TD_STYLE }, row.location.name || '(unnamed)'),
                h('td', { style: SUMMARY_TD_STYLE },
                  h('span', {
                    style: { color: 'var(--accent)', cursor: 'pointer' }, title: 'Open WIS still',
                    onClick: () => setOpenImageFor(row.image),
                  }, row.image.fileName)),
                h('td', { style: SUMMARY_TD_STYLE }, row.entranceCodes.join(', ') || '—'),
                h('td', { style: SUMMARY_TD_STYLE },
                  !row.species ? '—' : h('span', {
                    style: {
                      background: speciesPillColor(row.species), color: '#0a0c0e', borderRadius: 100, padding: '2px 9px',
                      fontSize: 11, fontWeight: 700, border: 'none', font: 'inherit',
                      cursor: row.matched ? 'pointer' : 'default',
                    },
                    title: row.matched ? 'View sonogram' : 'No matched sound recording',
                    onClick: row.matched ? () => setSonogramFor(row.matched.recording) : undefined,
                  }, row.species)),
                h('td', { style: SUMMARY_TD_STYLE },
                  row.image.videoBaseName && h('button', { className: 'btn btn-secondary btn-tiny', onClick: () => setOpenVideoFor(row.image) }, '🎬 Video'))
              )))
            )
          )
    ),
    openVideoFor && h(VideoPopup, {
      image: openVideoFor,
      videoHandle: mediaIndex ? findVideoHandle(mediaIndex, openVideoFor.videoBaseName) : null,
      onClose: () => setOpenVideoFor(null),
    }),
    openImageFor && h(WisImagePopup, {
      image: openImageFor,
      imageHandle: mediaIndex ? mediaIndex.get((openImageFor.fileName || '').toLowerCase()) : null,
      onClose: () => setOpenImageFor(null),
    }),
    sonogramFor && h(SonogramPopup, {
      recording: sonogramFor,
      audioHandle: mediaIndex ? mediaIndex.get((sonogramFor.fileName || '').toLowerCase()) : null,
      onClose: () => setSonogramFor(null),
    })
  );
}
function findVideoHandle(mediaIndex, videoBaseName) {
  if (!videoBaseName) return null;
  const lower = videoBaseName.toLowerCase();
  for (const [name, handle] of mediaIndex.entries()) {
    if (VIDEO_EXT.test(name) && name.startsWith(lower)) return handle;
  }
  return null;
}

// ---------------- Sound analysis results (report only, same shape as SurveyReview's per-survey
// results panel - no raw audio playback needed, it's a summary of species/passes/bouts already
// recorded in the site data). ----------------
// Renders a spectrogram for one recording on demand, synchronously on the main thread rather than
// via dsp-worker.js's background worker (Dsp.computeSpectrogramAsync) - that worker is spun up
// with `new Worker('dsp-worker.js')`, a path resolved against the PAGE's own origin, which breaks
// once dsp.js itself is loaded cross-origin the way this portal reuses it (see index.html's own
// comment). The synchronous Dsp.computeSpectrogram this worker calls internally is exposed too, and
// a brief (sub-second) main-thread block opening one sonogram at a time - not paging rapidly
// through hundreds of them, the scenario that motivated the worker internally - is an acceptable
// trade rather than duplicating dsp.js/dsp-worker.js locally just to fix the relative path.
function SonogramPopup({ recording, audioHandle, onClose }) {
  const canvasRef = useRef(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error | missing
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!audioHandle) { setStatus('missing'); return; }
    (async () => {
      try {
        const file = await audioHandle.getFile();
        const buf = await file.arrayBuffer();
        const parsed = Wav.parseWav(buf);
        const spec = Dsp.computeSpectrogram(parsed.samples, parsed.sampleRate, 512);
        if (cancelled) return;
        const img = Dsp.renderSpectrogramImageData(spec, {
          frameFrom: 0, frameTo: spec.numFrames - 1, binFrom: 0, binTo: spec.numBins - 1,
          floorDb: Dsp.DEFAULT_FLOOR_DB, rangeDb: 50, saturation: 0.85,
        });
        const off = document.createElement('canvas');
        off.width = img.width; off.height = img.height;
        off.getContext('2d').putImageData(img, 0, 0);
        const canvas = canvasRef.current;
        canvas.width = 900; canvas.height = 300;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(off, 0, 0, 900, 300);
        if (!cancelled) setStatus('ready');
      } catch (e) {
        if (!cancelled) { setError(e && e.message || String(e)); setStatus('error'); }
      }
    })();
    return () => { cancelled = true; };
  }, [audioHandle]);

  return h(Modal, { title: `Sonogram — ${recording.fileName}`, onClose, wide: true },
    status === 'missing' && h('div', { className: 'warning-banner' }, 'No matching sound file found in the linked folder.'),
    status === 'loading' && h('div', { className: 'card-sub' }, 'Decoding and rendering…'),
    status === 'error' && h('div', { className: 'warning-banner' }, error),
    h('canvas', { ref: canvasRef, style: { width: '100%', display: status === 'ready' ? 'block' : 'none', background: '#0a0c0e', borderRadius: 'var(--radius)' } }),
    h('div', { className: 'modal-actions' }, h('button', { className: 'btn btn-secondary', onClick: onClose }, 'Close'))
  );
}

function SoundResultsView({ site, mediaIndex }) {
  const surveys = site.surveys || [];
  const [surveyId, setSurveyId] = useState(surveys[0] ? surveys[0].id : null);
  const survey = surveys.find((s) => s.id === surveyId) || surveys[0];
  const stats = useMemo(() => survey ? computeSoundStats([survey]) : null, [survey]);
  const [sonogramFor, setSonogramFor] = useState(null); // recording | null

  return h('div', { className: 'main' },
    h('div', { className: 'main-header' },
      h('div', null,
        h('div', { className: 'main-title' }, '🔊 Sound analysis results'),
        stats && h('div', { className: 'main-subtitle' },
          `${stats.speciesList.length} species confirmed · ${stats.totalAnalysed}/${stats.totalRecordings} recording(s) analysed`)
      ),
      surveys.length > 1 && h('select', { value: surveyId || '', onChange: (e) => setSurveyId(e.target.value) },
        surveys.map((s) => h('option', { key: s.id, value: s.id }, s.surveyDate || '(no date)')))
    ),
    h('div', { className: 'content' },
      !survey && h('div', { className: 'empty-state' }, h('div', { className: 'empty-title' }, 'No survey nights recorded')),
      survey && stats.speciesList.length === 0 && h('div', { className: 'empty-state' },
        h('div', { className: 'empty-title' }, 'No species confirmed yet')),
      survey && stats.speciesList.map((s) => h('div', { key: s.species, className: 'card', style: { marginBottom: 12, padding: 14 } },
        h('div', { className: 'card-title' }, s.species),
        h('div', { className: 'card-sub', style: { marginTop: 4, marginBottom: 10 } },
          `${s.totalPasses} pass(es), ${s.totalBouts} bout(s), across ${s.references.length} detector(s)`),
        h('div', { style: { overflowX: 'auto' } },
          h('table', { style: { borderCollapse: 'collapse', fontSize: 12, width: '100%' } },
            h('thead', null, h('tr', null,
              h('th', { style: SUMMARY_TH_STYLE }, 'Location/detector'), h('th', { style: SUMMARY_TH_STYLE }, 'Passes'), h('th', { style: SUMMARY_TH_STYLE }, 'Bouts')
            )),
            h('tbody', null, s.references.map((ref, i) => h('tr', { key: i },
              h('td', { style: SUMMARY_TD_STYLE }, ref.detectorName), h('td', { style: SUMMARY_TD_STYLE }, ref.passCount), h('td', { style: SUMMARY_TD_STYLE }, ref.boutCount)
            )))
          )
        )
      )),
      survey && stats.detectorEntries.length > 0 && h('div', null,
        h('div', { className: 'section-title' }, 'By detector'),
        stats.detectorEntries.map(({ detector }) => h('div', { key: detector.id },
          h('div', { className: 'section-title', style: { fontSize: 13, margin: '12px 0 6px' } }, detector.name || '(unnamed detector)'),
          h(SoundSummaryCard, { detector, progress: M.soundProgress(detector) }),
          (detector.recordings || []).length > 0 && h('div', { style: { overflowX: 'auto', marginTop: -8, marginBottom: 16 } },
            h('table', { style: { borderCollapse: 'collapse', fontSize: 12, width: '100%' } },
              h('thead', null, h('tr', null,
                h('th', { style: SUMMARY_TH_STYLE }, 'Time'), h('th', { style: SUMMARY_TH_STYLE }, 'File'),
                h('th', { style: SUMMARY_TH_STYLE }, 'Species'), h('th', { style: SUMMARY_TH_STYLE }, '')
              )),
              h('tbody', null, (detector.recordings || []).map((rec) => h('tr', { key: rec.id },
                h('td', { style: SUMMARY_TD_STYLE }, rec.dateTimeIso ? new Date(rec.dateTimeIso).toLocaleTimeString() : '—'),
                h('td', { style: SUMMARY_TD_STYLE }, rec.fileName),
                h('td', { style: SUMMARY_TD_STYLE }, recordingSpeciesLabel(rec.analysis) || '—'),
                h('td', { style: SUMMARY_TD_STYLE },
                  h('button', { className: 'btn btn-secondary btn-tiny', onClick: () => setSonogramFor(rec) }, '🔬 Sonogram'))
              )))
            )
          )
        ))
      )
    ),
    sonogramFor && h(SonogramPopup, {
      recording: sonogramFor,
      audioHandle: mediaIndex ? mediaIndex.get((sonogramFor.fileName || '').toLowerCase()) : null,
      onClose: () => setSonogramFor(null),
    })
  );
}

// ---------------- Outputs (exported clips/reports - anything in the linked folder that isn't a
// source WIS still or video already shown in Observations) ----------------
function OutputsView({ site, mediaIndex }) {
  const usedNames = useMemo(() => {
    const used = new Set();
    (site.surveys || []).forEach((survey) => {
      (survey.locations || []).forEach((loc) => (loc.images || []).forEach((img) => {
        used.add(img.fileName.toLowerCase());
      }));
      // Sound recordings are already surfaced (with a "View sonogram" button) under Sound
      // analysis - marking them used here too so they don't also show up as an unexplained
      // "extra" file in Outputs.
      (survey.soundDetectors || []).forEach((det) => (det.recordings || []).forEach((rec) => {
        if (rec.fileName) used.add(rec.fileName.toLowerCase());
      }));
    });
    if (mediaIndex) {
      for (const [name] of mediaIndex.entries()) {
        if (VIDEO_EXT.test(name)) {
          // Any video referenced as a WIS still's source video is "used" too, not just the
          // still itself - matched the same startsWith convention as findVideoHandle.
          const isSourceVideo = (site.surveys || []).some((survey) => (survey.locations || []).some((loc) =>
            (loc.images || []).some((img) => img.videoBaseName && name.startsWith(img.videoBaseName.toLowerCase()))));
          if (isSourceVideo) used.add(name);
        }
      }
    }
    return used;
  }, [site, mediaIndex]);

  const outputs = useMemo(() => {
    if (!mediaIndex) return [];
    return Array.from(mediaIndex.entries())
      .filter(([name]) => !usedNames.has(name))
      .map(([name, handle]) => ({ name, handle }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [mediaIndex, usedNames]);

  const [urls, setUrls] = useState({});
  async function open(item) {
    let url = urls[item.name];
    if (!url) { url = await F.getFileBlobUrl(item.handle); setUrls((u) => ({ ...u, [item.name]: url })); }
    window.open(url, '_blank');
  }

  return h('div', { className: 'main' },
    h('div', { className: 'main-header' },
      h('div', null,
        h('div', { className: 'main-title' }, '📤 Outputs'),
        h('div', { className: 'main-subtitle' }, `${outputs.length} file(s) - exported clips, reports and anything else in the handover folder`)
      )
    ),
    h('div', { className: 'content' },
      !mediaIndex && h('div', { className: 'empty-state' },
        h('div', { className: 'empty-title' }, 'No folder linked'),
        h('div', { className: 'empty-text' }, 'Link your handover folder from the sidebar to see exported clips and reports here.')),
      mediaIndex && outputs.length === 0 && h('div', { className: 'empty-state' }, h('div', { className: 'empty-title' }, 'Nothing extra found in the linked folder')),
      mediaIndex && outputs.length > 0 && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        outputs.map((item) => h('div', {
          key: item.name, className: 'card', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px' },
        },
          h('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 13 } }, item.name),
          h('button', { className: 'btn btn-secondary btn-small', onClick: () => open(item) }, 'Open')
        ))
      )
    )
  );
}

// ---------------- Survey info (date, weather, sunset, timing, personnel) ----------------
// survey.personnel only ever holds {surveyorId, role} in the app's own live data - resolving a
// name normally needs a connection to the shared org-wide surveyor register, which this offline
// portal deliberately doesn't have. exportSiteToFile now also bakes a `surveyorName` onto each
// entry at export time (the one place that IS online), so this falls back to "(name unresolved -
// re-export from a newer version of SurveyReview)" only for a JSON exported before that existed.
function SurveyInfoView({ site }) {
  const surveys = site.surveys || [];
  return h('div', { className: 'main' },
    h('div', { className: 'main-header' },
      h('div', null,
        h('div', { className: 'main-title' }, 'ℹ️ Survey info'),
        h('div', { className: 'main-subtitle' }, `${surveys.length} survey visit(s)`)
      )
    ),
    h('div', { className: 'content' },
      h('div', { className: 'card', style: { marginBottom: 16 } },
        h('div', { className: 'card-title' }, site.siteName || '(untitled site)'),
        site.client && h('div', { className: 'card-sub', style: { marginTop: 2 } }, site.client)
      ),
      surveys.length === 0
        ? h('div', { className: 'empty-state' }, h('div', { className: 'empty-title' }, 'No survey visits recorded'))
        : surveys.map((sv) => h('div', { key: sv.id, className: 'card', style: { marginBottom: 12 } },
            h('div', { className: 'card-title' }, sv.surveyDate || '(no date)'),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginTop: 10, fontSize: 13 } },
              h('div', null, h('div', { className: 'card-sub' }, 'Weather'), sv.weather || '—'),
              h('div', null, h('div', { className: 'card-sub' }, 'Sunset'), sv.sunset || '—'),
              h('div', null, h('div', { className: 'card-sub' }, 'Survey start'), sv.surveyStart || '—'),
              h('div', null, h('div', { className: 'card-sub' }, 'Survey end'), sv.surveyEnd || '—'),
              h('div', null, h('div', { className: 'card-sub' }, 'Cameras'), (sv.locations || []).length),
              h('div', null, h('div', { className: 'card-sub' }, 'Sound detectors'), (sv.soundDetectors || []).length)
            ),
            h('div', { style: { marginTop: 10 } },
              h('div', { className: 'card-sub', style: { marginBottom: 4 } }, 'Site personnel'),
              (sv.personnel || []).length === 0
                ? h('div', { style: { fontSize: 13 } }, '—')
                : h('div', { style: { fontSize: 13 } },
                    (sv.personnel || []).map((p) =>
                      `${p.surveyorName || '(name unresolved - re-export from a newer version of SurveyReview)'}${p.role ? ' — ' + p.role : ''}`
                    ).join(', '))
            )
          ))
    )
  );
}

// ---------------- App shell ----------------
function App() {
  const [site, setSite] = useState(null);
  const [mediaIndex, setMediaIndex] = useState(null);
  const [tab, setTab] = useState('roost');

  if (!site) return h(LoadSiteScreen, { onLoaded: setSite });
  if (mediaIndex === null) return h(LinkMediaScreen, { onLinked: setMediaIndex, onSkip: () => setMediaIndex(new Map()) });

  const tabs = [
    ['roost', '🦇 Roost register'],
    ['observations', '📷 Observations'],
    ['sound', '🔊 Sound analysis'],
    ['info', 'ℹ️ Survey info'],
    ['outputs', '📤 Outputs'],
  ];
  return h('div', { className: 'app-shell' },
    h('div', { className: 'sidebar' },
      h('div', { className: 'sidebar-header' },
        h('div', { className: 'sidebar-app-name' }, site.siteName || '(untitled site)'),
        h('div', { className: 'sidebar-app-sub' }, site.client || 'Survey data viewer')
      ),
      h('div', { className: 'sidebar-section' },
        tabs.map(([k, label]) => h('div', {
          key: k, className: 'tree-node' + (tab === k ? ' tree-node-active' : ''), onClick: () => setTab(k),
        }, label))
      )
    ),
    tab === 'roost' && h(RoostRegisterView, { site }),
    tab === 'observations' && h(ObservationsView, { site, mediaIndex }),
    tab === 'sound' && h(SoundResultsView, { site, mediaIndex }),
    tab === 'info' && h(SurveyInfoView, { site }),
    tab === 'outputs' && h(OutputsView, { site, mediaIndex })
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(h(App));

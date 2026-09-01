(function () {
  const canvas = document.getElementById('globeCanvas');
  const state = document.getElementById('globeState');
  const timeRange = document.getElementById('globeTime');
  const timeLabel = document.getElementById('globeTimeLabel');
  const resetButton = document.getElementById('globeReset');
  if (!canvas || !state || !timeRange || !timeLabel || !resetButton) return;

  const ctx = canvas.getContext('2d');
  const DEG = Math.PI / 180;
  const MU = 398600.4418;
  const MAX_PROPAGATION_HOURS = 24;
  let centerLat = 15 * DEG;
  let centerLon = 0;
  let satellites = [];
  let renderedPoints = [];
  let selectedEventId = null;
  let dragging = null;

  function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
  function normalizeAngle(value) { let result = value % (Math.PI * 2); if (result < 0) result += Math.PI * 2; return result; }
  function julianDate(date) { return date.getTime() / 86400000 + 2440587.5; }
  function gmstRadians(date) {
    const jd = julianDate(date);
    const t = (jd - 2451545.0) / 36525;
    return normalizeAngle((280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * t * t - t * t * t / 38710000) * DEG);
  }
  function solveEccentricAnomaly(meanAnomaly, eccentricity) {
    let eccentricAnomaly = meanAnomaly;
    for (let index = 0; index < 12; index += 1) {
      const delta = (eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly) - meanAnomaly) / (1 - eccentricity * Math.cos(eccentricAnomaly));
      eccentricAnomaly -= delta;
      if (Math.abs(delta) < 1e-10) break;
    }
    return eccentricAnomaly;
  }
  function propagate(event, hoursOffset) {
    const p = event.properties || {};
    const meanMotion = Number(p.mean_motion);
    const eccentricity = Number(p.eccentricity);
    const inclination = Number(p.inclination_deg) * DEG;
    const raan = Number(p.ra_of_asc_node_deg) * DEG;
    const argPericenter = Number(p.arg_of_pericenter_deg) * DEG;
    const meanAnomaly0 = Number(p.mean_anomaly_deg) * DEG;
    const epoch = new Date(event.observed_at);
    if (![meanMotion, eccentricity, inclination, raan, argPericenter, meanAnomaly0].every(Number.isFinite) || Number.isNaN(epoch.getTime()) || meanMotion <= 0 || eccentricity < 0 || eccentricity >= 1) return null;
    const boundedHours = clamp(Number(hoursOffset) || 0, -MAX_PROPAGATION_HOURS, MAX_PROPAGATION_HOURS);
    const n = meanMotion * Math.PI * 2 / 86400;
    const semiMajorAxis = Math.cbrt(MU / (n * n));
    const meanAnomaly = normalizeAngle(meanAnomaly0 + n * boundedHours * 3600);
    const eccentricAnomaly = solveEccentricAnomaly(meanAnomaly, eccentricity);
    const xOrbital = semiMajorAxis * (Math.cos(eccentricAnomaly) - eccentricity);
    const yOrbital = semiMajorAxis * Math.sqrt(1 - eccentricity * eccentricity) * Math.sin(eccentricAnomaly);
    const cosO = Math.cos(raan), sinO = Math.sin(raan), cosI = Math.cos(inclination), sinI = Math.sin(inclination), cosW = Math.cos(argPericenter), sinW = Math.sin(argPericenter);
    const xEci = (cosO * cosW - sinO * sinW * cosI) * xOrbital + (-cosO * sinW - sinO * cosW * cosI) * yOrbital;
    const yEci = (sinO * cosW + cosO * sinW * cosI) * xOrbital + (-sinO * sinW + cosO * cosW * cosI) * yOrbital;
    const zEci = (sinW * sinI) * xOrbital + (cosW * sinI) * yOrbital;
    const target = new Date(epoch.getTime() + boundedHours * 3600000);
    const theta = gmstRadians(target);
    const x = Math.cos(theta) * xEci + Math.sin(theta) * yEci;
    const y = -Math.sin(theta) * xEci + Math.cos(theta) * yEci;
    const z = zEci;
    const longitude = Math.atan2(y, x) / DEG;
    const latitude = Math.atan2(z, Math.hypot(x, y)) / DEG;
    const altitudeKm = Math.hypot(x, y, z) - 6378.137;
    return { latitude, longitude, altitudeKm, target, model: 'two-body-kepler' };
  }
  function project(latitudeDeg, longitudeDeg) {
    const latitude = Number(latitudeDeg) * DEG;
    const longitude = Number(longitudeDeg) * DEG;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const width = canvas.width, height = canvas.height;
    const radius = Math.min(width, height) * 0.43;
    const deltaLongitude = longitude - centerLon;
    const cosc = Math.sin(centerLat) * Math.sin(latitude) + Math.cos(centerLat) * Math.cos(latitude) * Math.cos(deltaLongitude);
    if (cosc < 0) return null;
    return {
      x: width / 2 + radius * Math.cos(latitude) * Math.sin(deltaLongitude),
      y: height / 2 - radius * (Math.cos(centerLat) * Math.sin(latitude) - Math.sin(centerLat) * Math.cos(latitude) * Math.cos(deltaLongitude)),
      visible: true,
    };
  }
  function drawGrid(radius) {
    ctx.save();
    ctx.strokeStyle = 'rgba(148,163,184,.28)';
    ctx.lineWidth = 1;
    for (let latitude = -60; latitude <= 60; latitude += 30) {
      ctx.beginPath(); let drawing = false;
      for (let longitude = -180; longitude <= 180; longitude += 3) {
        const point = project(latitude, longitude);
        if (!point) { drawing = false; continue; }
        if (!drawing) { ctx.moveTo(point.x, point.y); drawing = true; } else ctx.lineTo(point.x, point.y);
      }
      ctx.stroke();
    }
    for (let longitude = -150; longitude <= 180; longitude += 30) {
      ctx.beginPath(); let drawing = false;
      for (let latitude = -90; latitude <= 90; latitude += 2) {
        const point = project(latitude, longitude);
        if (!point) { drawing = false; continue; }
        if (!drawing) { ctx.moveTo(point.x, point.y); drawing = true; } else ctx.lineTo(point.x, point.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  function draw() {
    const width = canvas.width, height = canvas.height, radius = Math.min(width, height) * 0.43;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, width, height);
    const gradient = ctx.createRadialGradient(width * .4, height * .35, radius * .1, width / 2, height / 2, radius);
    gradient.addColorStop(0, '#164e63'); gradient.addColorStop(1, '#082f49');
    ctx.beginPath(); ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2); ctx.fillStyle = gradient; ctx.fill();
    ctx.strokeStyle = '#64748b'; ctx.lineWidth = 2; ctx.stroke();
    drawGrid(radius);
    renderedPoints = [];
    const hours = Number(timeRange.value) || 0;
    const publicEvents = Array.isArray(currentEvents) ? currentEvents : [];
    for (const event of publicEvents) {
      if (!Number.isFinite(Number(event.latitude)) || !Number.isFinite(Number(event.longitude))) continue;
      const point = project(event.latitude, event.longitude); if (!point) continue;
      renderedPoints.push({ ...point, event, latitude: Number(event.latitude), longitude: Number(event.longitude), kind: 'event' });
    }
    for (const event of satellites) {
      const position = propagate(event, hours); if (!position) continue;
      const point = project(position.latitude, position.longitude); if (!point) continue;
      renderedPoints.push({ ...point, event, ...position, kind: 'satellite' });
    }
    for (const point of renderedPoints) {
      const selected = point.event.id === selectedEventId;
      ctx.beginPath(); ctx.arc(point.x, point.y, selected ? 7 : point.kind === 'satellite' ? 4.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = selected ? '#f8fafc' : point.kind === 'satellite' ? '#fbbf24' : '#38bdf8'; ctx.fill();
      if (selected) { ctx.fillStyle = '#f8fafc'; ctx.font = '12px system-ui'; ctx.fillText(String(point.event.title || point.event.id).slice(0, 52), point.x + 10, point.y + 4); }
    }
    timeLabel.textContent = `${hours >= 0 ? '+' : ''}${hours.toFixed(1)} h from each source element epoch`;
    state.textContent = `${renderedPoints.length} visible point(s) · ${satellites.length} orbital snapshots · two-body Kepler approximation (not SGP4), bounded to ±24 h`;
  }
  function decodeEvent(row) {
    let properties = row.properties;
    if (!properties && typeof row.properties_json === 'string') { try { properties = JSON.parse(row.properties_json); } catch (_) { properties = {}; } }
    return { ...row, properties: properties || {} };
  }
  async function loadSatellites() {
    try {
      const response = await fetch('/api/v1/events?category=satellite-orbit&limit=1000', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      satellites = (await response.json()).map(decodeEvent).slice(0, 1000);
      draw();
    } catch (error) { state.textContent = `Orbital view unavailable: ${error.message}`; draw(); }
  }
  function selectPoint(point) {
    if (!point) return;
    selectedEventId = point.event.id;
    centerLat = clamp(point.latitude, -85, 85) * DEG;
    centerLon = point.longitude * DEG;
    if (typeof map !== 'undefined' && map?.setView) map.setView([point.latitude, point.longitude], point.kind === 'satellite' ? 4 : Math.max(3, map.getZoom()));
    const evidence = document.getElementById('evidence');
    if (evidence) evidence.textContent = JSON.stringify({ ...point.event, globe_position: point.kind === 'satellite' ? { latitude: point.latitude, longitude: point.longitude, altitude_km: point.altitudeKm, propagated_at: point.target?.toISOString(), model: point.model, warning: 'Visualization-only two-body approximation; not SGP4 and not suitable for navigation or operational tracking.' } : undefined }, null, 2);
    if (typeof selectGraphForEvent === 'function') selectGraphForEvent(point.event);
    draw();
  }
  function pointAt(event) {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * canvas.width / rect.width;
    const y = (event.clientY - rect.top) * canvas.height / rect.height;
    let best = null, distance = Infinity;
    for (const point of renderedPoints) { const current = Math.hypot(point.x - x, point.y - y); if (current < distance) { best = point; distance = current; } }
    return best && distance <= 12 ? best : null;
  }
  function selectEventFromStream(event) {
    const card = event.target.closest('button.event-card'); if (!card) return;
    const cards = [...document.querySelectorAll('#events > button.event-card')];
    const index = cards.indexOf(card); if (index < 0 || !Array.isArray(currentEvents) || !currentEvents[index]) return;
    const selected = currentEvents[index]; selectedEventId = selected.id;
    const satellite = satellites.find(item => item.id === selected.id);
    if (satellite) { const position = propagate(satellite, Number(timeRange.value) || 0); if (position) { centerLat = clamp(position.latitude, -85, 85) * DEG; centerLon = position.longitude * DEG; } }
    else if (Number.isFinite(Number(selected.latitude)) && Number.isFinite(Number(selected.longitude))) { centerLat = clamp(Number(selected.latitude), -85, 85) * DEG; centerLon = Number(selected.longitude) * DEG; }
    draw();
  }

  canvas.addEventListener('click', (event) => selectPoint(pointAt(event)));
  canvas.addEventListener('pointerdown', (event) => { dragging = { x: event.clientX, y: event.clientY, lat: centerLat, lon: centerLon }; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener('pointermove', (event) => { if (!dragging) return; centerLon = dragging.lon - (event.clientX - dragging.x) * .007; centerLat = clamp(dragging.lat + (event.clientY - dragging.y) * .007, -Math.PI / 2, Math.PI / 2); draw(); });
  canvas.addEventListener('pointerup', () => { dragging = null; });
  canvas.addEventListener('pointercancel', () => { dragging = null; });
  timeRange.addEventListener('input', draw);
  resetButton.addEventListener('click', () => { centerLat = 15 * DEG; centerLon = 0; selectedEventId = null; timeRange.value = '0'; draw(); });
  document.getElementById('events')?.addEventListener('click', selectEventFromStream);
  document.getElementById('refreshBtn')?.addEventListener('click', () => setTimeout(loadSatellites, 0));
  document.getElementById('sourceFilter')?.addEventListener('change', () => setTimeout(draw, 0));
  document.getElementById('categoryFilter')?.addEventListener('change', () => setTimeout(draw, 0));
  new MutationObserver(() => draw()).observe(document.getElementById('events'), { childList: true });
  loadSatellites();
})();

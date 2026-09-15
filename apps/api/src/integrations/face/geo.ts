/** Geolocation helpers: haversine distance, geofence evaluation and basic GPS trust indicators. */
export interface Gps { latitude: number; longitude: number; accuracyM: number; capturedAt: string; isMocked?: boolean | null }
export interface Fence { name: string; latitude: number; longitude: number; radiusM: number }
export type GeofenceResult = 'INSIDE' | 'OUTSIDE' | 'NO_GPS' | 'LOW_ACCURACY' | 'SUSPICIOUS' | 'NOT_REQUIRED' | 'NO_FENCE';

const R = 6371000;
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export interface GeoEvalConfig { gpsRequired: boolean; geofenceRequired: boolean; gpsAccuracyLimitM: number; maxFixAgeSeconds: number }
export interface GeoEval { result: GeofenceResult; distanceM: number | null; fence: string | null; suspiciousReasons: string[] }

/** Evaluate a GPS fix against a set of fences. Accuracy is added to the radius so an imperfect fix near the edge is not rejected. */
export function evaluateGeofence(gps: Gps | null, fences: Fence[], cfg: GeoEvalConfig, previous?: { latitude: number; longitude: number; at: string } | null): GeoEval {
  const suspicious: string[] = [];
  if (!cfg.gpsRequired && !cfg.geofenceRequired) return { result: 'NOT_REQUIRED', distanceM: null, fence: null, suspiciousReasons: suspicious };
  if (!gps) return { result: 'NO_GPS', distanceM: null, fence: null, suspiciousReasons: suspicious };
  if (gps.isMocked) suspicious.push('MOCK_LOCATION_FLAG');
  const ageS = (Date.now() - new Date(gps.capturedAt).getTime()) / 1000;
  if (Number.isNaN(ageS) || ageS > cfg.maxFixAgeSeconds || ageS < -60) suspicious.push('STALE_FIX');
  if (gps.accuracyM <= 0 || gps.accuracyM < 1) suspicious.push('IMPLAUSIBLE_ACCURACY');
  if (previous) { const d = haversineM(previous.latitude, previous.longitude, gps.latitude, gps.longitude); const dt = Math.max(1, (new Date(gps.capturedAt).getTime() - new Date(previous.at).getTime()) / 1000); if (d / dt > 70) suspicious.push('IMPOSSIBLE_TRAVEL'); } // > 250 km/h between fixes
  if (gps.accuracyM > cfg.gpsAccuracyLimitM) return { result: 'LOW_ACCURACY', distanceM: null, fence: null, suspiciousReasons: suspicious };
  if (!cfg.geofenceRequired) return { result: suspicious.length ? 'SUSPICIOUS' : 'INSIDE', distanceM: null, fence: null, suspiciousReasons: suspicious };
  if (!fences.length) return { result: 'NO_FENCE', distanceM: null, fence: null, suspiciousReasons: suspicious };
  let best: { d: number; f: Fence } | null = null;
  for (const f of fences) { const d = haversineM(gps.latitude, gps.longitude, f.latitude, f.longitude); if (!best || d < best.d) best = { d, f }; }
  const inside = best!.d <= best!.f.radiusM + Math.min(gps.accuracyM, cfg.gpsAccuracyLimitM);
  if (!inside) return { result: 'OUTSIDE', distanceM: Math.round(best!.d), fence: best!.f.name, suspiciousReasons: suspicious };
  return { result: suspicious.length ? 'SUSPICIOUS' : 'INSIDE', distanceM: Math.round(best!.d), fence: best!.f.name, suspiciousReasons: suspicious };
}

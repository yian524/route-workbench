/* Route calculations only. No DOM, storage, network bootstrap, or API keys. */
(function (root, factory) {
  'use strict';
  const engine = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = engine;
  else root.PlannerEngine = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const VERSION = 5;
  const SCHEMA = 'taiwan-motorcycle-plan';
  const EARTH_METERS = 6371008.8;
  const MAX_POINTS = 25000;
  const MAX_IMPORT_BYTES = 3000000;
  const DEFAULT_MODEL = Object.freeze({signalCount: 0, twoStageTurns: 0, cruiseKph: 25,
    trafficDelayMinutes: 0, redWaitSeconds: 30, twoStageSeconds: 60});
  const MODEL_LIMITS = Object.freeze({signalCount: [0, 1000, true], twoStageTurns: [0, 1000, true],
    cruiseKph: [1, 120, false], trafficDelayMinutes: [0, 240, false],
    redWaitSeconds: [0, 600, false], twoStageSeconds: [0, 1200, false]});
  const MANUAL_WARNING = '手動畫點以相鄰點直線累計距離，未自動貼齊道路；不是已驗證可騎路線。';
  const SIGNAL_WARNING = '紅綠燈數、平均等待及額外待轉時間由你輸入；未取得逐路口實際號誌秒數。';
  const GOOGLE_WARNING = 'Google 機車路線仍在 beta，可能漏掉適合機車的道路；請確認現場標誌、車道、禁行及待轉規定。';
  const TURN_WARNING = 'Google 轉向指令不能確認兩段式待轉；是否可直接左轉須看現場標誌。';

  class PlannerError extends Error {
    constructor(code, message) { super(message); this.name = 'PlannerError'; this.code = code; }
  }
  function fail(code, message) { throw new PlannerError(code, message); }
  function finite(value, min, max, name, integer) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
      fail('INVALID_NUMBER', name + ' 必須是範圍內的有限' + (integer ? '整數' : '數字') + '。');
    return value;
  }
  function plainText(value, maxLength) {
    if (typeof value !== 'string') return '';
    return value.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
      .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength || 400);
  }
  function point(value, withLabel) {
    if (!value || typeof value !== 'object') fail('INVALID_POINT', '座標必須是 {lat,lng} 或 [lat,lng]。');
    let lat, lng;
    if (Array.isArray(value)) { lat = value[0]; lng = value[1]; }
    else {
      lat = typeof value.lat === 'function' ? value.lat() : value.lat;
      lng = typeof value.lng === 'function' ? value.lng() : value.lng;
    }
    const result = {lat: finite(lat, -90, 90, '緯度'), lng: finite(lng, -180, 180, '經度')};
    if (withLabel && !Array.isArray(value)) {
      for (const field of ['name', 'label', 'road']) {
        const text = plainText(value[field], 160); if (text) result[field] = text;
      }
    }
    return result;
  }
  function points(values, withLabel) {
    if (!Array.isArray(values) || values.length > MAX_POINTS) fail('INVALID_PATH', '路徑必須是陣列且最多 ' + MAX_POINTS + ' 點。');
    return values.map(value => point(value, withLabel));
  }
  const radians = n => n * Math.PI / 180;
  function betweenMeters(a, b) {
    const dLat = radians(b.lat - a.lat), dLng = radians(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_METERS * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
  }
  function distanceMeters(values) {
    const path = points(values || []); let meters = 0;
    for (let i = 1; i < path.length; i++) meters += betweenMeters(path[i - 1], path[i]);
    return meters;
  }
  function cleanModel(input) {
    const result = {};
    for (const key of Object.keys(MODEL_LIMITS)) {
      const v = input && input[key] !== undefined ? input[key] : DEFAULT_MODEL[key];
      const range = MODEL_LIMITS[key]; result[key] = finite(v, range[0], range[1], key, range[2]);
    }
    return result;
  }
  function estimateCandidate(input) {
    input = input || {};
    const model = cleanModel(input);
    const meters = distanceMeters(input.path || input.points || input.geometry || []);
    const cruiseSeconds = meters / (model.cruiseKph / 3.6);
    const signalDelaySeconds = model.signalCount * model.redWaitSeconds;
    // This is EXTRA delay after the signal delay already counted above.
    const twoStageDelaySeconds = model.twoStageTurns * model.twoStageSeconds;
    const trafficDelaySeconds = model.trafficDelayMinutes * 60;
    return {distanceMeters: meters, cruiseSeconds, signalDelaySeconds, twoStageDelaySeconds, trafficDelaySeconds,
      totalSeconds: cruiseSeconds + signalDelaySeconds + twoStageDelaySeconds + trafficDelaySeconds,
      durationSeconds: cruiseSeconds + signalDelaySeconds + twoStageDelaySeconds + trafficDelaySeconds,
      source: 'manual_model', status: 'assumption_based', model, geometrySource: 'drawn_segments',
      durationIncludesTraffic: false, label: '手動假設估算，非 Google 車流預測',
      warnings: [MANUAL_WARNING, SIGNAL_WARNING, '待轉秒數是每次「額外」增加的時間，避免與已計入的紅燈等待重複。']};
  }
  function bearing(a, b) {
    const latA = radians(a.lat), latB = radians(b.lat), dLng = radians(b.lng - a.lng);
    return (Math.atan2(Math.sin(dLng) * Math.cos(latB), Math.cos(latA) * Math.sin(latB) -
      Math.sin(latA) * Math.cos(latB) * Math.cos(dLng)) * 180 / Math.PI + 360) % 360;
  }
  function cardinal(heading) { return ['北', '東北', '東', '東南', '南', '西南', '西', '西北'][Math.round(heading / 45) % 8]; }
  function turnKind(incoming, outgoing) {
    const delta = (outgoing - incoming + 540) % 360 - 180;
    if (Math.abs(delta) >= 150) return 'uturn';
    if (Math.abs(delta) < 25) return 'straight';
    return delta > 0 ? 'right' : 'left';
  }
  function nameOf(p, index) { return p.label || p.name || p.road || '點 ' + (index + 1); }
  function deriveManualSteps(values) {
    const path = points(values || [], true); if (path.length < 2) return [];
    const result = [];
    for (let i = 0; i < path.length - 1; i++) {
      const distance = betweenMeters(path[i], path[i + 1]);
      const heading = bearing(path[i], path[i + 1]);
      const kind = i === 0 ? 'depart' : (distance < 0.1 || betweenMeters(path[i - 1], path[i]) < 0.1 ? 'unknown' : turnKind(bearing(path[i - 1], path[i]), heading));
      const turns = {left: '折線向左轉向', right: '折線向右轉向', straight: '折線延續原方向', uturn: '折線折返', unknown: '轉向無法判讀', depart: '開始繪圖路段'};
      result.push({index: i, road: path[i].road || '', instruction: '於' + nameOf(path[i], i) + '，' + turns[kind] +
        '；朝' + cardinal(heading) + '前往' + nameOf(path[i + 1], i + 1) + '（直線約 ' + Math.round(distance) + ' 公尺）。',
        turnKind: kind, action: kind, heading, distanceMeters: distance, start: path[i], end: path[i + 1],
        startLocation: path[i], endLocation: path[i + 1], startIndex: i, endIndex: i + 1,
        source: 'manual_geometry', confirmed: false, verification: '幾何示意；道路、合法轉向與待轉未核對', warning: MANUAL_WARNING});
    }
    return result;
  }
  function cleanTime(value) {
    if (value === undefined || value === null || value === '') return '';
    const d = new Date(value); if (!Number.isFinite(d.getTime())) fail('INVALID_TIME', '日期時間無效。');
    return d.toISOString();
  }
  function cleanCandidate(input, index) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_PLAN', '候選路線格式無效。');
    const path = points(input.path || input.points || input.waypoints || [], true);
    const status = ['manual_draft', 'historical_record', 'imported_unverified'].includes(input.status) ? input.status : 'manual_draft';
    const result = {id: plainText(input.id, 100) || 'candidate-' + (index + 1), name: plainText(input.name, 160) || '候選 ' + (index + 1),
      path, points: path.map(p => Object.assign({}, p)), model: cleanModel(input.model || input), status,
      source: 'user_plan', note: plainText(input.note, 1200)};
    const originalSource = plainText(input.source, 60); if (originalSource) result.originalSource = originalSource;
    return result;
  }
  function sanitizePlan(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_PLAN', '規劃檔必須是物件。');
    if (input.version !== undefined && input.version !== VERSION) fail('UNSUPPORTED_VERSION', '規劃檔版本不支援，目前為 ' + VERSION + '。');
    if (input.schema !== undefined && input.schema !== SCHEMA) fail('INVALID_PLAN', '規劃檔種類不正確。');
    const result = {schema: SCHEMA, version: VERSION, name: plainText(input.name, 160) || '我的通勤規劃',
      status: 'manual_draft', source: 'user_plan', model: cleanModel(input.model || input), note: plainText(input.note, 1200)};
    for (const field of ['path', 'points', 'waypoints']) if (input[field] !== undefined) result[field] = points(input[field], true);
    for (const field of ['origin', 'destination']) if (input[field] !== undefined) {
      result[field] = typeof input[field] === 'string' ? plainText(input[field], 300) : point(input[field], true);
    }
    for (const field of ['createdAt', 'updatedAt', 'departureTime']) if (input[field] !== undefined) result[field] = cleanTime(input[field]);
    if (input.candidates !== undefined) {
      if (!Array.isArray(input.candidates) || input.candidates.length > 10) fail('INVALID_PLAN', '候選路線最多 10 條。');
      result.candidates = input.candidates.map(cleanCandidate);
    }
    if (input.selectedCandidateId !== undefined) result.selectedCandidateId = plainText(input.selectedCandidateId, 100);
    if (['manual_draft', 'historical_record', 'imported_unverified'].includes(input.status)) result.status = input.status;
    return result;
  }
  function exportPlan(input) { return JSON.stringify(sanitizePlan(input), null, 2); }
  function importPlan(text) {
    if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES ||
      (typeof TextEncoder !== 'undefined' && new TextEncoder().encode(text).length > MAX_IMPORT_BYTES))
      fail('INVALID_PLAN', '規劃檔必須是小於 3 MB 的 JSON 文字。');
    let data; try { data = JSON.parse(text); } catch (_) { fail('INVALID_JSON', 'JSON 格式無效，未匯入。'); }
    const plan = sanitizePlan(data); plan.status = 'imported_unverified';
    if (plan.candidates) plan.candidates.forEach(candidate => { candidate.status = 'imported_unverified'; });
    return plan;
  }
  function routeLocation(value) {
    if (typeof value === 'string') {
      const text = plainText(value, 300); if (!text || /^https?:/i.test(text)) fail('INVALID_POINT', '請提供座標或地址，不能用網址當路線端點。');
      return text;
    }
    return point(value);
  }
  function safeRouteError(error) {
    const rawCode = plainText(error && error.code, 100);
    const code = /^[A-Z_]{1,80}$/.test(rawCode) ? rawCode : 'GOOGLE_ROUTE_FAILED';
    return new PlannerError(code, 'Google 機車路線計算失敗。請檢查 API 啟用、金鑰限制、配額、途經點與支援地區；保留手動畫線。');
  }
  function googleTurn(maneuver) {
    const m = plainText(maneuver, 80).toUpperCase().replace(/-/g, '_');
    if (/UTURN/.test(m)) return 'uturn';
    if (/LEFT/.test(m)) return 'left';
    if (/RIGHT/.test(m)) return 'right';
    if (/DESTINATION|ARRIVE/.test(m)) return 'arrive';
    if (/DEPART/.test(m)) return 'depart';
    if (/STRAIGHT|NAME_CHANGE/.test(m)) return 'straight';
    if (/MERGE/.test(m)) return 'merge';
    return 'unknown';
  }
  function normalizeGoogleRoutes(response, context) {
    if (!response || !Array.isArray(response.routes) || !response.routes.length) fail('NO_ROUTES', 'Google 未回傳可用機車路線，請調整途經點；沒有改用汽車模式。');
    context = context || {};
    return response.routes.map((route, routeIndex) => {
      const path = points(route.path || []);
      if (path.length < 2) fail('MISSING_ROUTE_PATH', 'Google 回傳缺少完整路徑，不能當作可用導航。');
      const meters = finite(route.distanceMeters, 0, 50000000, 'Google 距離');
      const durationSeconds = finite(route.durationMillis, 0, 31536000000, 'Google 時間') / 1000;
      const steps = [];
      for (const leg of route.legs || []) for (const step of leg.steps || []) {
        if (step.travelMode && !['TWO_WHEELER', 'WALKING'].includes(String(step.travelMode)))
          fail('UNEXPECTED_TRAVEL_MODE', 'Google 回傳非機車路段，不能當作機車導航。');
        const instruction = plainText(step.instructions, 800) || 'Google 未提供這段轉向說明。';
        const kind = googleTurn(step.maneuver);
        const start = step.startLocation ? point(step.startLocation) : null;
        const end = step.endLocation ? point(step.endLocation) : null;
        steps.push({index: steps.length, legIndex: (route.legs || []).indexOf(leg), road: '', instruction,
          maneuver: plainText(step.maneuver, 80), action: kind, turnKind: kind, travelMode: plainText(String(step.travelMode || ''), 60),
          distanceMeters: finite(step.distanceMeters, 0, 50000000, 'Google 路段距離'),
          start, end, startLocation: start, endLocation: end, path: points(step.path || []),
          source: 'google_routes', confirmed: false, verification: 'Google 指引；現場標誌／待轉未核對',
          warning: kind === 'left' || kind === 'uturn' ? TURN_WARNING : '行車仍依現場號誌及標誌。'});
      }
      const warnings = [GOOGLE_WARNING, TURN_WARNING];
      for (const warning of route.warnings || []) { const text = plainText(warning, 800); if (text) warnings.push(text); }
      if (!steps.length) warnings.push('Google 未回傳逐段說明；目前只有路徑與總時間。');
      if (route.travelAdvisory && route.travelAdvisory.routeRestrictionsPartiallyIgnored)
        warnings.push('Google 提示部分道路／車種限制可能未符合，請勿直接採用這條路線。');
      const fallback = response.fallbackInfo && response.fallbackInfo.routingMode;
      const includesTraffic = response.fallbackInfo ? (fallback === 'TRAFFIC_UNAWARE' ? false : fallback === 'TRAFFIC_AWARE' ? true : null) : true;
      if (response.fallbackInfo) warnings.push('Google 使用備援計算模式：' + plainText(fallback || '模式未提供', 80) + '；不是原要求的完整車流計算。');
      if (context.alternativesDisabled) warnings.push('有途經點時 Google 不提供同次備選路線；請將其他候選另行計算。');
      if (steps.some(step => step.travelMode === 'WALKING')) warnings.push('Google 路線含步行段；不能把整條路線當作可騎到門口。');
      return {id: 'google-' + (routeIndex + 1), name: plainText(route.description, 160) || 'Google 機車候選 ' + (routeIndex + 1),
        path, geometry: path, distanceMeters: meters, durationSeconds, totalSeconds: durationSeconds,
        durationIncludesTraffic: includesTraffic, durationSource: includesTraffic === true ? 'google_traffic_prediction' : includesTraffic === false ? 'google_static_fallback' : 'google_fallback_unknown',
        source: 'google_routes', status: route.travelAdvisory && route.travelAdvisory.routeRestrictionsPartiallyIgnored ? 'provider_restriction_warning' : 'provider_prediction',
        steps, warnings: [...new Set(warnings)], departureTime: context.departureTime || '',
        signalCount: null, twoStageTurns: null, label: 'Google 機車 beta 估算，依現場；不另外加總手動紅燈或待轉秒數'};
    });
  }
  async function computeGoogleRoute(input, options) {
    fail('NO_CHARGE_POLICY', '零費用版不發出 Google 收費機車路線請求。');
  }
  function estimate(route, options) {
    const path = Array.isArray(route) ? route : route && (route.path || route.points || route.geometry);
    return estimateCandidate(Object.assign({}, !Array.isArray(route) && route || {}, options || {}, {path: path || []}));
  }
  return Object.freeze({VERSION, SCHEMA, DEFAULT_MODEL, PlannerError, distanceMeters, distance: distanceMeters,
    estimateCandidate, estimate, deriveManualSteps, sanitizePlan, exportPlan, importPlan,
    computeGoogleRoute, normalizeGoogleRoutes, normalizePoint: point, normalizePoints: points});
});

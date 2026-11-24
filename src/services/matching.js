/**
 * Job matching (rules based).
 *
 *  1. HARD FILTERS (a mechanic that fails any of these is never shown the job):
 *     - verified and online
 *     - offers the service category (enabled in their catalog)
 *     - has the equipment the category requires
 *     - job is inside the mechanic's maximum travel radius
 *     - works that day/time, date not blocked, no overlapping booking
 *  2. RANKING of the survivors with WEIGHTS below.
 *
 * The weights are a starting point and need client approval (see requirements, section 4).
 */
const { MechanicProfile, ServiceCategory } = require('../models');
const { slotKeys, busyKeys } = require('./slots');

const WEIGHTS = { distance: 0.3, vehicle: 0.2, rating: 0.3, reliability: 0.2 };

function distanceKm([lng1, lat1], [lng2, lat2]) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return h * 60 + (m || 0);
};

/** Is the requested time inside the mechanic's weekly hours and not on a blocked date? */
function worksAt(profile, start, durationMins = 120) {
  const local = new Date(new Date(start).getTime() + (profile.utcOffsetMinutes || 0) * 60000);
  const day = local.getUTCDay();
  const dateStr = local.toISOString().slice(0, 10);
  if (!profile.workingDays.includes(day)) return false;
  if (profile.blockedDates.includes(dateStr)) return false;
  const startMin = local.getUTCHours() * 60 + local.getUTCMinutes();
  return startMin >= toMinutes(profile.workStart) && startMin + durationMins <= toMinutes(profile.workEnd);
}

const hasEquipment = (profile, required = []) => {
  const have = profile.equipment.map((e) => e.toLowerCase());
  return required.every((r) => have.includes(r.toLowerCase()));
};

function score(profile, { vehicleMake, dist }) {
  const distance = 1 - Math.min(dist / (profile.serviceRadiusKm || 1), 1);
  const vehicle = !profile.vehicleMakes.length
    ? 0.5
    : profile.vehicleMakes.some((m) => m.toLowerCase() === String(vehicleMake || '').toLowerCase())
    ? 1
    : 0;
  const rating = profile.reviewCount ? profile.rating / 5 : 0.6; // new mechanics start neutral
  const totalJobs = profile.completedJobs + profile.cancelledJobs;
  const reliability = totalJobs ? profile.completedJobs / totalJobs : 0.8;
  const total =
    WEIGHTS.distance * distance + WEIGHTS.vehicle * vehicle + WEIGHTS.rating * rating + WEIGHTS.reliability * reliability;
  return Math.round(total * 1000) / 10; // 0-100
}

/** Why a single mechanic can / cannot take a job. Returns { ok, reason, dist }. */
async function checkEligibility(profile, ctx, category) {
  if (profile.verificationStatus !== 'verified') return { ok: false, reason: 'Mechanic is not verified yet' };
  if (!profile.isOnline) return { ok: false, reason: 'Mechanic is offline' };
  if (!profile.services.some((s) => s.category === ctx.category && s.enabled)) return { ok: false, reason: 'Service not offered' };
  if (category && !hasEquipment(profile, category.requiredEquipment)) return { ok: false, reason: 'Mechanic lacks required equipment' };
  const dist = distanceKm(profile.location.coordinates, ctx.coordinates);
  if (dist > profile.serviceRadiusKm) return { ok: false, reason: 'Outside mechanic service radius', dist };
  if (!worksAt(profile, ctx.scheduledAt, ctx.durationMins)) return { ok: false, reason: 'Mechanic is not available at that time', dist };
  const busy = await busyKeys([profile.user], slotKeys(ctx.scheduledAt, ctx.durationMins));
  if (busy.get(String(profile.user))) return { ok: false, reason: 'That slot is already booked', dist };
  return { ok: true, dist };
}

/**
 * ctx: { category, vehicleMake, coordinates:[lng,lat], scheduledAt, durationMins }
 * Returns eligible mechanics sorted by score: [{ profile, score, distanceKm }]
 */
async function findMatches(ctx, limit = 10) {
  const category = await ServiceCategory.findOne({ slug: ctx.category, active: true });
  if (!category) return [];
  const candidates = await MechanicProfile.find({
    verificationStatus: 'verified',
    isOnline: true,
    'services.category': ctx.category, // exact enabled check is done per mechanic in checkEligibility
  }).populate('user', 'name avatar status');

  const eligible = [];
  for (const p of candidates) {
    if (!p.user || p.user.status !== 'active') continue;
    const r = await checkEligibility(p, ctx, category);
    if (r.ok) eligible.push({ profile: p, distanceKm: Math.round(r.dist * 10) / 10, score: score(p, { ...ctx, dist: r.dist }) });
  }
  return eligible.sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = { WEIGHTS, distanceKm, worksAt, hasEquipment, score, checkEligibility, findMatches };

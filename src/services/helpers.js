const { Notification, AuditLog, Setting } = require('../models');

const getSettings = async () => (await Setting.findOne({ key: 'platform' })) || (await Setting.create({ key: 'platform' }));

const notify = (user, title, body, type = 'info', job) =>
  Notification.create({ user, title, body, type, job }).catch((e) => console.error('notify failed', e.message));

const audit = (req, action, target, meta) =>
  AuditLog.create({ actor: req.user?._id, action, target, meta, ip: req.ip }).catch((e) => console.error('audit failed', e.message));

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Before a booking is confirmed mechanics only see an approximate location (privacy rule). */
function maskLocation(job) {
  const j = job.toObject ? job.toObject() : { ...job };
  if (['requested', 'quoted'].includes(j.status)) {
    j.location = {
      city: j.location?.city,
      address: j.location?.city ? `Near ${j.location.city}` : 'Approximate area',
      coordinates: (j.location?.coordinates || []).map((c) => Math.round(c * 100) / 100),
      approximate: true,
    };
  }
  return j;
}

/**
 * Fee model (client brief):
 *   owner booking fee   5% to 10% of the job value, added on top of what the owner pays
 *   mechanic sourcing   10% of the job value, deducted from the mechanic's payout
 */
const OWNER_FEE_MIN = 0.05;
const OWNER_FEE_MAX = 0.1;
const clampOwnerFee = (r) => Math.min(OWNER_FEE_MAX, Math.max(OWNER_FEE_MIN, Number(r) || OWNER_FEE_MIN));
function computeFees(price, { ownerFeeRate, platformFeeRate }) {
  const oRate = clampOwnerFee(ownerFeeRate);
  const mRate = Number.isFinite(Number(platformFeeRate)) ? Number(platformFeeRate) : 0.1;
  const ownerFee = round2(price * oRate);
  const mechanicFee = round2(price * mRate);
  return { ownerFeeRate: oRate, mechanicFeeRate: mRate, ownerFee, mechanicFee, platformFee: round2(ownerFee + mechanicFee), totalCharged: round2(price + ownerFee), payout: round2(price - mechanicFee) };
}

module.exports = { getSettings, notify, audit, round2, maskLocation, computeFees, clampOwnerFee, OWNER_FEE_MIN, OWNER_FEE_MAX };
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

module.exports = { getSettings, notify, audit, round2, maskLocation };

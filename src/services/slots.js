const { SlotReservation } = require('../models');

const HOUR = 3600000;

/** ISO keys for every clock hour a booking touches. */
function slotKeys(start, durationMins = 120) {
  const s = new Date(start).getTime();
  const first = Math.floor(s / HOUR) * HOUR;
  const end = s + durationMins * 60000;
  const keys = [];
  for (let t = first; t < end; t += HOUR) keys.push(new Date(t).toISOString());
  return keys;
}

/**
 * Atomically reserve every hour of a booking for a mechanic.
 * The unique index (mechanic, slotKey) guarantees two bookings can never share an hour:
 * if any insert hits a duplicate key we roll back what we inserted and report a conflict.
 */
async function reserveSlots(mechanicId, start, durationMins, jobId) {
  const keys = slotKeys(start, durationMins);
  const done = [];
  try {
    for (const slotKey of keys) {
      const doc = await SlotReservation.create({ mechanic: mechanicId, slotKey, job: jobId });
      done.push(doc._id);
    }
    return true;
  } catch (err) {
    if (done.length) await SlotReservation.deleteMany({ _id: { $in: done } });
    if (err.code === 11000) return false;
    throw err;
  }
}

const releaseSlots = (jobId) => SlotReservation.deleteMany({ job: jobId });

async function busyKeys(mechanicIds, keys) {
  const rows = await SlotReservation.find({ mechanic: { $in: mechanicIds }, slotKey: { $in: keys } }).select('mechanic slotKey');
  const map = new Map();
  rows.forEach((r) => map.set(String(r.mechanic), true));
  return map; // mechanicId -> has a conflict
}

module.exports = { slotKeys, reserveSlots, releaseSlots, busyKeys };

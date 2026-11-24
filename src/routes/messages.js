const router = require('express').Router();
const { Message, Job } = require('../models');
const { asyncHandler, ApiError, protect } = require('../middleware');
const { notify } = require('../services/helpers');

router.use(protect);

// Conversations are scoped to a job between its owner and its assigned mechanic.
async function loadJob(req) {
  const job = await Job.findById(req.params.jobId).populate('owner', 'name avatar').populate('mechanic', 'name avatar');
  if (!job || !job.mechanic) throw new ApiError(404, 'Messaging opens once a mechanic is booked');
  const me = String(req.user._id);
  if (String(job.owner._id) !== me && String(job.mechanic._id) !== me) throw new ApiError(403, 'Not your job');
  return job;
}

router.get(
  '/conversations',
  asyncHandler(async (req, res) => {
    const field = req.user.role === 'mechanic' ? 'mechanic' : 'owner';
    const jobs = await Job.find({ [field]: req.user._id, mechanic: { $ne: null }, status: { $ne: 'cancelled' } })
      .populate('owner', 'name avatar').populate('mechanic', 'name avatar').populate('vehicle', 'make model').sort('-updatedAt').limit(50);
    const out = [];
    for (const j of jobs) {
      const last = await Message.findOne({ job: j._id }).sort('-createdAt');
      const unread = await Message.countDocuments({ job: j._id, to: req.user._id, read: false });
      out.push({ jobId: j._id, with: field === 'owner' ? j.mechanic : j.owner, vehicle: j.vehicle, category: j.category, status: j.status, lastMessage: last?.text, lastAt: last?.createdAt || j.updatedAt, unread });
    }
    res.json({ conversations: out });
  })
);

router.get(
  '/job/:jobId',
  asyncHandler(async (req, res) => {
    const job = await loadJob(req);
    await Message.updateMany({ job: job._id, to: req.user._id, read: false }, { read: true });
    const messages = await Message.find({ job: job._id }).sort('createdAt').limit(300);
    const other = String(job.owner._id) === String(req.user._id) ? job.mechanic : job.owner;
    res.json({ messages, with: other });
  })
);

router.post(
  '/job/:jobId',
  asyncHandler(async (req, res) => {
    const job = await loadJob(req);
    const text = (req.body.text || '').trim();
    if (!text) throw new ApiError(400, 'Message is empty');
    const to = String(job.owner._id) === String(req.user._id) ? job.mechanic._id : job.owner._id;
    const message = await Message.create({ job: job._id, from: req.user._id, to, text });
    notify(to, req.user.name, text.slice(0, 80), 'message', job._id);
    res.status(201).json({ message });
  })
);

module.exports = router;

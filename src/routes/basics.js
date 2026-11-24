/** Uploads, vehicles, service categories, notifications, reviews, disputes. */
const express = require('express');
const { Vehicle, ServiceCategory, Notification, Review, Dispute, Job, MechanicProfile } = require('../models');
const { asyncHandler, ApiError, protect, requireRole, upload } = require('../middleware');
const { uploadBuffer, destroy } = require('../config/cloudinary');
const { notify } = require('../services/helpers');

/* ---------------- uploads (Cloudinary) ---------------- */
const uploads = express.Router();
uploads.use(protect);
uploads.post(
  '/',
  upload.array('files', 6),
  asyncHandler(async (req, res) => {
    if (!req.files?.length) throw new ApiError(400, 'No files uploaded');
    const folder = `autoservice/${req.query.folder || 'misc'}`.replace(/[^a-z0-9/_-]/gi, '');
    const files = await Promise.all(req.files.map((f) => uploadBuffer(f.buffer, folder)));
    res.status(201).json({ files });
  })
);

/* ---------------- vehicles ---------------- */
const vehicles = express.Router();
vehicles.use(protect, requireRole('owner'));
vehicles.get('/', asyncHandler(async (req, res) => res.json({ vehicles: await Vehicle.find({ owner: req.user._id }).sort('-isDefault -createdAt') })));
vehicles.post(
  '/',
  asyncHandler(async (req, res) => {
    const { make, model, year, trim, engine, mileage, plate, vin, photo } = req.body;
    if (!make || !model || !year) throw new ApiError(400, 'Year, make and model are required');
    if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) throw new ApiError(400, 'VIN must be 17 characters (no I, O or Q)');
    const first = !(await Vehicle.exists({ owner: req.user._id }));
    const v = await Vehicle.create({ owner: req.user._id, make, model, year, trim, engine, mileage, plate, vin, photo, isDefault: first });
    res.status(201).json({ vehicle: v });
  })
);
vehicles.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const v = await Vehicle.findOne({ _id: req.params.id, owner: req.user._id });
    if (!v) throw new ApiError(404, 'Vehicle not found');
    if (req.body.vin && !/^[A-HJ-NPR-Z0-9]{17}$/i.test(req.body.vin)) throw new ApiError(400, 'VIN must be 17 characters (no I, O or Q)');
    ['make', 'model', 'year', 'trim', 'engine', 'mileage', 'plate', 'vin', 'photo'].forEach((k) => req.body[k] !== undefined && (v[k] = req.body[k]));
    if (req.body.isDefault) {
      await Vehicle.updateMany({ owner: req.user._id }, { isDefault: false });
      v.isDefault = true;
    }
    await v.save();
    res.json({ vehicle: v });
  })
);
vehicles.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const active = await Job.exists({ vehicle: req.params.id, status: { $in: ['requested', 'quoted', 'booked', 'in_progress'] } });
    if (active) throw new ApiError(400, 'This vehicle has an active job');
    const v = await Vehicle.findOneAndDelete({ _id: req.params.id, owner: req.user._id });
    if (!v) throw new ApiError(404, 'Vehicle not found');
    destroy(v.photo?.publicId);
    res.json({ message: 'Removed' });
  })
);

/* ---------------- service categories (public read, admin write is in admin.js) ---------------- */
const categories = express.Router();
categories.get('/', asyncHandler(async (req, res) => res.json({ categories: await ServiceCategory.find({ active: true }).sort('name') })));

/* ---------------- notifications ---------------- */
const notifications = express.Router();
notifications.use(protect);
notifications.get(
  '/',
  asyncHandler(async (req, res) => {
    const items = await Notification.find({ user: req.user._id }).sort('-createdAt').limit(50);
    res.json({ notifications: items, unread: items.filter((n) => !n.read).length });
  })
);
notifications.post('/read-all', asyncHandler(async (req, res) => {
  await Notification.updateMany({ user: req.user._id, read: false }, { read: true });
  res.json({ message: 'ok' });
}));

/* ---------------- reviews ---------------- */
const reviews = express.Router();
reviews.get(
  '/mechanic/:id',
  asyncHandler(async (req, res) => {
    const items = await Review.find({ mechanic: req.params.id }).populate('owner', 'name avatar').sort('-createdAt').limit(50);
    res.json({ reviews: items });
  })
);
reviews.post(
  '/',
  protect,
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const { jobId, rating, comment } = req.body;
    const job = await Job.findOne({ _id: jobId, owner: req.user._id });
    if (!job || job.status !== 'completed') throw new ApiError(400, 'You can only review a completed job');
    if (!(rating >= 1 && rating <= 5)) throw new ApiError(400, 'Rating must be 1 to 5');
    if (await Review.exists({ job: job._id })) throw new ApiError(409, 'You already reviewed this job');
    const review = await Review.create({ job: job._id, owner: req.user._id, mechanic: job.mechanic, rating, comment }); // verified: tied to a completed job
    const p = await MechanicProfile.findOne({ user: job.mechanic });
    p.rating = Math.round(((p.rating * p.reviewCount + rating) / (p.reviewCount + 1)) * 100) / 100;
    p.reviewCount += 1;
    await p.save();
    notify(job.mechanic, 'New review', `${req.user.name} rated you ${rating}/5`, 'review', job._id);
    res.status(201).json({ review });
  })
);

/* ---------------- disputes ---------------- */
const disputes = express.Router();
disputes.use(protect, requireRole('owner', 'mechanic'));
disputes.get('/mine', asyncHandler(async (req, res) => res.json({ disputes: await Dispute.find({ raisedBy: req.user._id }).sort('-createdAt') })));
disputes.post(
  '/',
  asyncHandler(async (req, res) => {
    const { jobId, subject, description } = req.body;
    const job = await Job.findById(jobId);
    const me = String(req.user._id);
    if (!job || (String(job.owner) !== me && String(job.mechanic) !== me)) throw new ApiError(404, 'Job not found');
    if (!subject) throw new ApiError(400, 'Subject is required');
    const against = String(job.owner) === me ? job.mechanic : job.owner;
    const d = await Dispute.create({ job: job._id, raisedBy: req.user._id, against, subject, description });
    res.status(201).json({ dispute: d });
  })
);

module.exports = { uploads, vehicles, categories, notifications, reviews, disputes };

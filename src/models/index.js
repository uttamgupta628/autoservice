const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const fileSchema = new Schema({ url: String, publicId: String }, { _id: false });
const opts = { timestamps: true };

/* ---------- User ---------- */
const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true, index: true },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ['owner', 'mechanic', 'admin'], required: true },
    avatar: fileSchema,
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    suspensionReason: String,
  },
  opts
);
userSchema.pre('save', async function () {
  if (this.isModified('password')) this.password = await bcrypt.hash(this.password, 10);
});
userSchema.methods.matchPassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};
userSchema.methods.toJSON = function () {
  const o = this.toObject();
  delete o.password;
  return o;
};

/* ---------- Vehicle ---------- */
const vehicleSchema = new Schema(
  {
    owner: { type: ObjectId, ref: 'User', required: true, index: true },
    make: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    year: { type: Number, required: true },
    trim: String,
    engine: String,
    mileage: Number,
    plate: { type: String, trim: true, uppercase: true },
    vin: { type: String, trim: true, uppercase: true },
    photo: fileSchema,
    isDefault: { type: Boolean, default: false },
  },
  opts
);

/* ---------- Service category (catalog managed by admin) ---------- */
const categorySchema = new Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    description: String,
    basePrice: { type: Number, default: 0 },
    icon: { type: String, default: 'construct' },
    instantBook: { type: Boolean, default: true },
    requiredEquipment: [String],
    active: { type: Boolean, default: true },
  },
  opts
);

/* ---------- Mechanic profile ---------- */
const mechanicSchema = new Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true, unique: true },
    shopName: String,
    bio: String,
    experienceYears: { type: Number, default: 0 },
    vehicleMakes: [String], // makes the mechanic has experience with (empty = all)
    equipment: [String],
    serviceRadiusKm: { type: Number, default: 10 },
    city: String,
    address: String,
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [77.5946, 12.9716] }, // [lng, lat]
    },
    isOnline: { type: Boolean, default: true },
    workingDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] }, // 0 = Sunday
    workStart: { type: String, default: '09:00' },
    workEnd: { type: String, default: '19:00' },
    utcOffsetMinutes: { type: Number, default: 330 },
    blockedDates: [String], // YYYY-MM-DD
    services: [{ _id: false, category: String, price: Number, enabled: { type: Boolean, default: true } }],
    documents: [{ _id: false, type: { type: String }, url: String, publicId: String, name: String }],
    verificationStatus: {
      type: String,
      enum: ['draft', 'submitted', 'under_review', 'verified', 'rejected', 'suspended'],
      default: 'draft',
      index: true,
    },
    verificationNote: String,
    submittedAt: Date,
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
    completedJobs: { type: Number, default: 0 },
    cancelledJobs: { type: Number, default: 0 },
  },
  opts
);

/* ---------- Job (repair request / booking / work order) ---------- */
const quoteSchema = new Schema(
  {
    mechanic: { type: ObjectId, ref: 'User' },
    labor: Number,
    parts: Number,
    travel: Number,
    tax: Number,
    total: Number,
    note: String,
    version: { type: Number, default: 1 },
    validUntil: Date,
    status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  },
  { timestamps: true }
);
const jobSchema = new Schema(
  {
    owner: { type: ObjectId, ref: 'User', required: true, index: true },
    vehicle: { type: ObjectId, ref: 'Vehicle', required: true },
    mechanic: { type: ObjectId, ref: 'User', index: true },
    type: { type: String, enum: ['instant', 'request'], required: true },
    category: { type: String, required: true },
    services: [{ _id: false, category: String, name: String, price: Number }],
    description: String,
    media: [fileSchema],
    location: {
      address: String,
      city: String,
      coordinates: { type: [Number], default: [77.5946, 12.9716] }, // [lng, lat]
    },
    scheduledAt: { type: Date, required: true },
    durationMins: { type: Number, default: 120 },
    status: {
      type: String,
      enum: ['requested', 'quoted', 'booked', 'in_progress', 'completed', 'cancelled'],
      default: 'requested',
      index: true,
    },
    matchedMechanics: [{ type: ObjectId, ref: 'User' }],
    declinedBy: [{ type: ObjectId, ref: 'User' }],
    quotes: [quoteSchema],
    changeOrders: [
      {
        description: String,
        amount: Number,
        status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    /* symptom report generated by the diagnostic assistant (empty for plain requests) */
    diagnosis: {
      areaId: String,
      areaLabel: String,
      symptomId: String,
      symptomLabel: String,
      symptomCategory: String,
      answers: [{ _id: false, question: String, answer: String }],
      causes: [{ _id: false, label: String, level: String }],
      safety: { level: { type: String, enum: ['none', 'warning', 'urgent'], default: 'none' }, messages: [String], advice: String },
      classification: { type: String, enum: ['diagnostic', 'repair', 'installation'] },
      classificationReason: String,
      serviceName: String,
      summary: String,
      ownerNote: String,
      generatedAt: Date,
    },
    /* a mechanic can say the job was classified wrongly and recommend something else */
    classificationFlags: [
      {
        mechanic: { type: ObjectId, ref: 'User' },
        recommended: { type: String, enum: ['diagnostic', 'repair', 'installation'] },
        note: String,
        status: { type: String, enum: ['open', 'accepted', 'dismissed'], default: 'open' },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    /* who supplies the parts. customer = owner brings them; supplier_pickup / ship_to_customer = milestone 2 */
    parts: {
      source: { type: String, enum: ['mechanic', 'customer', 'supplier_pickup', 'ship_to_customer'], default: 'mechanic' },
      items: [
        {
          _id: false,
          name: String,
          partNumber: String,
          brand: String,
          quantity: { type: Number, default: 1 },
          condition: { type: String, enum: ['new', 'used', 'refurbished'], default: 'new' },
          notes: String,
          photos: [fileSchema],
        },
      ],
      customerConfirmed: { type: Boolean, default: false },
      confirmedAt: Date,
      ready: { type: Boolean, default: false },
      readyAt: Date,
      readyNote: String,
      inspection: {
        status: { type: String, enum: ['pending', 'ok', 'mismatch'], default: 'pending' },
        note: String,
        at: Date,
      },
      fulfillment: {
        status: { type: String, enum: ['none', 'awaiting_pickup', 'picked_up', 'shipped', 'delivered'], default: 'none' },
        tracking: String,
        at: Date,
      },
    },
    price: { type: Number, default: 0 },
    cancelReason: String,
    cancelledBy: { type: ObjectId, ref: 'User' },
    history: [{ _id: false, status: String, at: { type: Date, default: Date.now }, by: { type: ObjectId, ref: 'User' }, note: String }],
  },
  opts
);

/* ---------- Slot reservation (unique index = atomic double-booking guard) ---------- */
const slotSchema = new Schema({
  mechanic: { type: ObjectId, ref: 'User', required: true },
  slotKey: { type: String, required: true }, // ISO hour
  job: { type: ObjectId, ref: 'Job', index: true },
});
slotSchema.index({ mechanic: 1, slotKey: 1 }, { unique: true });

/* ---------- Payment ---------- */
const paymentSchema = new Schema(
  {
    job: { type: ObjectId, ref: 'Job', required: true, unique: true }, // one payment per job = no duplicates
    owner: { type: ObjectId, ref: 'User', index: true },
    mechanic: { type: ObjectId, ref: 'User', index: true },
    amount: { type: Number, default: 0 }, // job value (what the mechanic's work is worth)
    ownerFee: { type: Number, default: 0 }, // booking fee added on top for the owner
    mechanicFee: { type: Number, default: 0 }, // job-sourcing fee deducted from the mechanic
    ownerFeeRate: Number,
    mechanicFeeRate: Number,
    totalCharged: { type: Number, default: 0 }, // amount + ownerFee
    platformFee: { type: Number, default: 0 }, // ownerFee + mechanicFee = platform revenue
    payout: { type: Number, default: 0 },
    status: { type: String, enum: ['authorized', 'captured', 'refunded', 'voided'], default: 'authorized' },
    payoutStatus: { type: String, enum: ['none', 'pending', 'settled'], default: 'none' },
    provider: { type: String, default: 'simulated' },
    capturedAt: Date,
    refundedAt: Date,
    settledAt: Date,
  },
  opts
);

/* ---------- Message / Notification / Review / Dispute / Audit / Setting ---------- */
const messageSchema = new Schema(
  {
    job: { type: ObjectId, ref: 'Job', required: true, index: true },
    from: { type: ObjectId, ref: 'User', required: true },
    to: { type: ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, maxlength: 2000 },
    read: { type: Boolean, default: false },
  },
  opts
);
const notificationSchema = new Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true, index: true },
    title: String,
    body: String,
    type: { type: String, default: 'info' },
    job: { type: ObjectId, ref: 'Job' },
    read: { type: Boolean, default: false },
  },
  opts
);
const reviewSchema = new Schema(
  {
    job: { type: ObjectId, ref: 'Job', required: true, unique: true },
    owner: { type: ObjectId, ref: 'User', required: true },
    mechanic: { type: ObjectId, ref: 'User', required: true, index: true },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: String,
  },
  opts
);
const disputeSchema = new Schema(
  {
    job: { type: ObjectId, ref: 'Job', required: true },
    raisedBy: { type: ObjectId, ref: 'User', required: true },
    against: { type: ObjectId, ref: 'User' },
    subject: { type: String, required: true },
    description: String,
    status: { type: String, enum: ['open', 'in_review', 'resolved'], default: 'open', index: true },
    resolution: String,
    resolvedBy: { type: ObjectId, ref: 'User' },
  },
  opts
);
const auditSchema = new Schema(
  {
    actor: { type: ObjectId, ref: 'User' },
    action: { type: String, required: true },
    target: String,
    meta: Schema.Types.Mixed,
    ip: String,
  },
  opts
);
const settingSchema = new Schema({
  key: { type: String, unique: true, default: 'platform' },
  platformFeeRate: { type: Number, default: 0.1 }, // mechanic job-sourcing fee (deducted from payout)
  ownerFeeRate: { type: Number, default: 0.05 }, // owner booking fee, allowed range 5% to 10%
  supplierIntegrationEnabled: { type: Boolean, default: false }, // milestone 2: supplier pick-up / shipped parts
  taxRate: { type: Number, default: 0.18 },
  leadLimit: { type: Number, default: 10 },
  currency: { type: String, default: 'INR' },
});

module.exports = {
  User: mongoose.model('User', userSchema),
  Vehicle: mongoose.model('Vehicle', vehicleSchema),
  ServiceCategory: mongoose.model('ServiceCategory', categorySchema),
  MechanicProfile: mongoose.model('MechanicProfile', mechanicSchema),
  Job: mongoose.model('Job', jobSchema),
  SlotReservation: mongoose.model('SlotReservation', slotSchema),
  Payment: mongoose.model('Payment', paymentSchema),
  Message: mongoose.model('Message', messageSchema),
  Notification: mongoose.model('Notification', notificationSchema),
  Review: mongoose.model('Review', reviewSchema),
  Dispute: mongoose.model('Dispute', disputeSchema),
  AuditLog: mongoose.model('AuditLog', auditSchema),
  Setting: mongoose.model('Setting', settingSchema),
};
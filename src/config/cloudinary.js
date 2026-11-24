const cloudinary = require('cloudinary').v2;

const configured = () =>
  !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

let initialised = false;
function init() {
  if (initialised || !configured()) return;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  initialised = true;
}

/** Upload an in-memory buffer to Cloudinary. Resolves { url, publicId }. */
function uploadBuffer(buffer, folder = 'autoservice') {
  return new Promise((resolve, reject) => {
    if (!configured()) {
      return reject(
        Object.assign(new Error('Cloudinary is not configured. Set CLOUDINARY_* values in backend/.env'), { status: 503 })
      );
    }
    init();
    const stream = cloudinary.uploader.upload_stream({ folder, resource_type: 'auto' }, (err, result) =>
      err ? reject(err) : resolve({ url: result.secure_url, publicId: result.public_id })
    );
    stream.end(buffer);
  });
}

async function destroy(publicId) {
  if (!publicId || !configured()) return;
  init();
  await cloudinary.uploader.destroy(publicId).catch(() => {});
}

module.exports = { uploadBuffer, destroy, configured };

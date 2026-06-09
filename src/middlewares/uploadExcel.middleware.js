import multer from 'multer';

const storage = multer.memoryStorage();

export const uploadExcel = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/octet-stream'
    ];

    const allowedExtensions = ['.xlsx', '.xls'];

    const originalName = String(file.originalname || '').toLowerCase();
    const validExtension = allowedExtensions.some((ext) => originalName.endsWith(ext));
    const validMime = allowedMimeTypes.includes(file.mimetype);

    if (!validExtension && !validMime) {
      return cb(new Error('Solo se permiten archivos Excel .xlsx o .xls'));
    }

    cb(null, true);
  }
});
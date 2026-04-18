import multer from 'multer'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs'

export const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads')
export const THUMBS_DIR = path.join(UPLOADS_DIR, 'thumbs')

// Ensure dirs exist
fs.mkdirSync(UPLOADS_DIR, { recursive: true })
fs.mkdirSync(THUMBS_DIR, { recursive: true })

const allowedMimes = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/quicktime', 'video/webm',
])

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.bin'
    cb(null, `${crypto.randomUUID()}${ext}`)
  },
})

export const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (allowedMimes.has(file.mimetype)) cb(null, true)
    else cb(new Error(`File type ${file.mimetype} not allowed`))
  },
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max (covers video)
    files: 10,
  },
})

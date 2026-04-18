import sharp from 'sharp'
import path from 'path'
import { THUMBS_DIR } from './upload'

export async function generateThumbnail(filePath: string): Promise<{ thumbFileName: string; width: number; height: number }> {
  const thumbFileName = `thumb_${path.basename(filePath, path.extname(filePath))}.jpg`
  const thumbPath = path.join(THUMBS_DIR, thumbFileName)

  const metadata = await sharp(filePath).metadata()
  await sharp(filePath)
    .resize(400, undefined, { withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toFile(thumbPath)

  return {
    thumbFileName,
    width: metadata.width || 0,
    height: metadata.height || 0,
  }
}

// Copies the canonical Comms Hub SOP from context-files/ into the client
// bundle. Runs automatically before dev and build so the in-app SOP view
// always renders the same content the deliverable file holds. Never edit
// the bundled copy directly — it is overwritten on every run.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../../context-files/DialPad/Comms-Hub-SOPs.md')
const dst = resolve(here, '../src/content/comms-hub-sops.md')

if (!existsSync(src)) {
  console.error(`[sync-sop] canonical SOP missing at ${src}`)
  process.exit(1)
}
mkdirSync(dirname(dst), { recursive: true })
copyFileSync(src, dst)
console.log(`[sync-sop] ${src} → ${dst}`)

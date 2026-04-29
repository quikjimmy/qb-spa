# Integration logos

Drop the brand logos for the customer-card icon strip + Documents thumbnails
in this folder. Vite serves `client/public/*` at the site root, so a file at
`client/public/integrations/drive.svg` is reachable at `/integrations/drive.svg`.

## Wired filenames (case-sensitive)

| File | Used by |
|---|---|
| `qb.png`      | Customer card icon strip (desktop H1 + mobile own-row) |
| `drive.png`   | Customer card icon strip |
| `enerflo.png` | Customer card icon strip |
| `arrivy.png`  | Customer card icon strip |

## Swapping a logo

Just replace the file with the same name. Vite's dev server serves
`client/public/*` at the site root, so `/integrations/drive.png` resolves
without any rebuild. PNG, JPG, or SVG with the same filename will all
work — `<img>` tags don't care about extension as long as the URL matches.

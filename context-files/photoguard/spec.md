# PhotoGuard — Spec for Claude Code

## What It Is

PhotoGuard is a photo validation feature inside the KIN Home Portal app (qb-spa). It validates field photos from Arrivy tasks using AI vision, with human-in-the-loop review.

## Context

- **App:** qb-spa — Vue 3 + Vite frontend, Express + SQLite backend
- **Frontend:** `/root/.openclaw/workspace/qb-spa/client/`
- **Backend:** `/root/.openclaw/workspace/qb-spa/server/`
- **Auth:** JWT-based, SQLite locally, Supabase in production
- **Arrivy API:** Field service platform — has site survey & install checkout forms with photo uploads
- **Vision AI:** Ollama `kimi-k2.6:cloud` (free tier, ~6s/photo, supports image input)

## What Already Exists

There's already code in the repo:
- `server/src/routes/photoguard.ts` — backend route with Arrivy polling, photo download, vision validation, DB schema
- `client/src/views/PhotoGuardView.vue` — dashboard view (task list, photo grid, review modal, SSE)
- `client/src/views/PhotoGuardFormView.vue` — native form view (section-by-section Arrivy form recreation)
- `client/src/data/arrivy-forms.ts` — form schema data (206 photo categories across 2 forms)

The code compiles and runs but needs polish and bug fixes.

## What Needs Doing

### 1. Fix the dashboard view (`PhotoGuardView.vue`)

The dashboard shows:
- Stats strip (total tasks, photos, passed, failed, pass rate)
- Coverage bars by section
- Task cards (clickable → detail view)
- Task detail: photo grid filtered by section/status, photo modal with AI result + human review
- SSE real-time updates (scan started, validation done, review events)
- Toast notifications

**Issues to fix:**
- The `router` variable is used in the template but not properly imported/initialized in the script (line ~4 uses `useRouter()` but `router` may not be exposed to template)
- Filter buttons need working state bindings
- Photo modal needs proper review form (approve/reject/resubmit with note)
- Mobile responsiveness needs verification

### 2. Fix the form view (`PhotoGuardFormView.vue`)

Recreates Arrivy's site survey (79 photo categories, 9 sections) and install checkout (127 categories, 6 sections) forms natively with inline AI validation.

- Section-by-section navigation (like Arrivy's screen breaks)
- Photo capture/upload with inline AI validation (pass/fail appears as you upload)
- All form field types: photo upload, dropdown, checklist, text input, text blocks
- Progress tracking per section
- Form submission to backend
- SSE for real-time validation results

**Issues to fix:**
- Photo upload needs to POST to `/api/photoguard/upload` and get validation result back
- Section navigation needs working prev/next buttons
- Form data needs to submit to backend on completion
- Progress tracking needs to work with the photo states

### 3. Verify backend routes (`photoguard.ts`)

The backend has:
- DB schema for `photoguard_tasks` and `photoguard_photos` tables
- Arrivy API integration (poll tasks, download photos)
- Ollama vision validation (sends photo as base64, gets pass/fail + issues + description)
- EXIF extraction via sharp
- SSE endpoint for real-time updates
- Review endpoint (approve/reject/resubmit)
- Stats endpoint
- Scan endpoint (triggers Arrivy poll)

**Verify these work:**
- `GET /api/photoguard/stats` — returns aggregate stats
- `GET /api/photoguard/tasks?limit=50` — returns task list
- `GET /api/photoguard/tasks/:id` — returns task with photos
- `POST /api/photoguard/scan?days=3` — scans Arrivy for recent tasks
- `POST /api/photoguard/revalidate/:photoId` — re-runs vision validation
- `POST /api/photoguard/photos/:photoId/review` — human review
- `GET /api/photoguard/review-queue` — count of photos needing review
- `GET /api/photoguard/events` — SSE stream (token passed as query param)
- `POST /api/photoguard/upload` — photo upload with validation

### 4. Wire up the router

In `client/src/router/`, make sure these routes exist:
- `/photoguard` → `PhotoGuardView.vue`
- `/photoguard/form/:formType` → `PhotoGuardFormView.vue` (formType = `site_survey` or `install_checkout`)

### 5. Arrivy credentials

Arrivy auth is in environment variables:
- `ARRIVY_AUTH_KEY` — API key
- `ARRIVY_AUTH_TOKEN` — auth token
- `ARRIVY_API_BASE` — base URL (defaults to `https://app.arrivy.com/api`)

Check `/root/.openclaw/workspace/qb-spa/server/.env` for these.

### 6. Ollama vision API

The vision validation calls Ollama's API:
- Model: `kimi-k2.6:cloud` (or `OLLAMA_VISION_MODEL` env var)
- Endpoint: `OLLAMA_BASE/api/chat` (defaults to `https://ollama.com`)
- API key: read from `/root/.openclaw/openclaw.json` → `models.providers.ollama.apiKey`
- Sends photo as base64 in the `images` field of the message
- Expects JSON response with: `passed`, `confidence`, `issues[]`, `description`
- Format: `stream: false`, `format: 'json'`

## Database Schema

```sql
CREATE TABLE photoguard_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arrivy_task_id TEXT NOT NULL UNIQUE,
  task_title TEXT, task_type TEXT, task_status TEXT,
  customer_name TEXT, crew_name TEXT, template_name TEXT,
  project_rid INTEGER, form_id TEXT, form_title TEXT,
  completed_at TEXT, scanned_at TEXT,
  total_photos INTEGER DEFAULT 0,
  passed_photos INTEGER DEFAULT 0,
  failed_photos INTEGER DEFAULT 0,
  pending_photos INTEGER DEFAULT 0,
  overall_status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE photoguard_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_rowid INTEGER NOT NULL REFERENCES photoguard_tasks(id) ON DELETE CASCADE,
  arrivy_task_id TEXT NOT NULL,
  file_id TEXT NOT NULL UNIQUE,
  filename TEXT, category_label TEXT, category_hash TEXT,
  category_section TEXT, form_type TEXT,
  required INTEGER DEFAULT 1,
  file_path TEXT, thumb_path TEXT,
  file_size INTEGER, width INTEGER, height INTEGER,
  has_exif INTEGER, has_gps INTEGER,
  camera_make TEXT, camera_model TEXT, photo_timestamp TEXT,
  metadata_issues TEXT,
  validation_status TEXT DEFAULT 'pending',
  validation_passed INTEGER, validation_confidence REAL,
  validation_issues TEXT, validation_description TEXT,
  validation_model TEXT, validation_time_ms INTEGER,
  validated_at TEXT,
  review_status TEXT, reviewer TEXT, review_note TEXT, reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Form Schema

206 photo categories total across two Arrivy forms:

**Site Survey** (79 categories, 9 sections):
- Pre-Survey (house number)
- Site Photos (front, sides, back, backyard)
- Roof Photos (roof planes, material, slope, eave, obstructions)
- Electrical Photos (meter, MSP, panel, busbar, sub panels)
- Attic Photos (rafters, spacing, slope, can lights)
- Modular Home Details (HUD plate, foundation)
- Ground Mount (location, distance)
- Existing Solar (modules, inverters, disconnects)
- Other Items

**Install Checkout** (127 categories, 6 sections):
- Pre-Survey, Inspection, Electrical section, etc.

Each category has: `hash` (Arrivy field ID), `label`, `required` (bool), `form`, `section`, `hints` (what the vision AI should look for).

The form data is in `client/src/data/arrivy-forms.ts`.

## Vision AI Prompt

```
You are a solar site survey photo validator. A field agent just took this photo for the category: "{categoryLabel}"

Requirements for this photo: {hints}

Respond in JSON format ONLY:
{
  "passed": true/false,
  "confidence": 0.0-1.0,
  "issues": ["specific issue 1", "specific issue 2"],
  "description": "brief description of what you see in the photo"
}

A photo PASSES if it meets the requirements. It FAILS if:
- Wrong subject (photo doesn't match the category)
- Too blurry or dark to be useful
- Missing required elements (measuring tape, labels, etc.)
- Wrong angle or doesn't show what's needed
- Photo appears to be a placeholder, stock image, or not a real site photo
```

## Tech Stack

- Vue 3 (Composition API, `<script setup>`)
- Vite 7
- Tailwind CSS 4 (via `@tailwindcss/vite`)
- Express.js backend with `better-sqlite3`
- `sharp` for image processing/EXIF
- Arrivy REST API (`X-Auth-Key` / `X-Auth-Token` headers)
- Ollama API for vision (`Authorization: Bearer` header, `images` field in message)

## Acceptance Criteria

1. Dashboard loads at `/photoguard` — shows stats, task cards, scan button
2. Clicking a task opens detail view with photo grid
3. Photos show validation status (passed/failed/pending) with confidence
4. Photo modal shows full image, AI description, issues, and review buttons
5. Human review (approve/reject/resubmit) works and updates the photo status
6. "Scan Arrivy" button pulls recent tasks and their photos
7. SSE pushes real-time updates when validations complete
8. Form view at `/photoguard/form/site_survey` shows the site survey form
9. Form view at `/photoguard/form/install_checkout` shows the install checkout form
10. Photo upload in form view triggers AI validation and shows result inline
import type { FeedbackItem } from '../types/feedback'

const STORAGE_KEY = 'qb-feedback'

export function getFeedbackItems(): FeedbackItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as FeedbackItem[]
  } catch {
    return []
  }
}

export function saveFeedbackItem(item: FeedbackItem): void {
  const items = getFeedbackItems()
  items.push(item)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
}

export function clearFeedback(): void {
  localStorage.removeItem(STORAGE_KEY)
}

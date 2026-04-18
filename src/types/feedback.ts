export type FeedbackCategory = 'Bug' | 'Feature Request' | 'General Feedback'

export const CATEGORIES: FeedbackCategory[] = ['Bug', 'Feature Request', 'General Feedback']

export interface FeedbackItem {
  id: string
  category: FeedbackCategory
  message: string
  pageUrl: string
  createdAt: string
}

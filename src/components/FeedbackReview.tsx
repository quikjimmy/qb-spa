import { useState } from 'react'
import { getFeedbackItems, clearFeedback } from '../utils/feedbackStorage'
import type { FeedbackItem } from '../types/feedback'
import './FeedbackReview.css'

export default function FeedbackReview() {
  const [items, setItems] = useState<FeedbackItem[]>(() =>
    getFeedbackItems().reverse()
  )

  function handleClear() {
    if (window.confirm('Clear all feedback? This cannot be undone.')) {
      clearFeedback()
      setItems([])
    }
  }

  return (
    <div className="feedback-review">
      <div className="feedback-review-header">
        <h2>Feedback ({items.length})</h2>
        {items.length > 0 && (
          <button onClick={handleClear} className="clear-btn">Clear all</button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="feedback-empty">No feedback yet.</p>
      ) : (
        <ul className="feedback-list">
          {items.map((item) => (
            <li key={item.id} className="feedback-card">
              <div className="feedback-card-header">
                <span className={`feedback-badge ${badgeClass(item.category)}`}>
                  {item.category}
                </span>
                <time dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString()}
                </time>
              </div>
              <p className="feedback-message">{item.message}</p>
              <span className="feedback-url">{item.pageUrl}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function badgeClass(category: string): string {
  switch (category) {
    case 'Bug': return 'badge-bug'
    case 'Feature Request': return 'badge-feature'
    default: return 'badge-general'
  }
}

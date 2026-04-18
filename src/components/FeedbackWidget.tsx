import { useState } from 'react'
import { CATEGORIES, type FeedbackCategory } from '../types/feedback'
import { saveFeedbackItem } from '../utils/feedbackStorage'
import './FeedbackWidget.css'

export default function FeedbackWidget() {
  const [isOpen, setIsOpen] = useState(false)
  const [category, setCategory] = useState<FeedbackCategory>('General Feedback')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState(false)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = message.trim()
    if (!trimmed) {
      setError('Please enter a message.')
      return
    }

    saveFeedbackItem({
      id: crypto.randomUUID(),
      category,
      message: trimmed,
      pageUrl: window.location.href,
      createdAt: new Date().toISOString(),
    })

    setMessage('')
    setError('')
    setSubmitted(true)
    setTimeout(() => {
      setSubmitted(false)
      setIsOpen(false)
    }, 1500)
  }

  function handleCancel() {
    setMessage('')
    setError('')
    setIsOpen(false)
  }

  return (
    <div className="feedback-widget">
      {isOpen && (
        <div className="feedback-panel">
          {submitted ? (
            <p className="feedback-thanks">Thanks for your feedback!</p>
          ) : (
            <form onSubmit={handleSubmit}>
              <label>
                Category
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>

              <label>
                Message
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={4}
                  placeholder="What's on your mind?"
                />
              </label>

              {error && <p className="feedback-error">{error}</p>}

              <div className="feedback-actions">
                <button type="button" onClick={handleCancel}>Cancel</button>
                <button type="submit">Submit</button>
              </div>
            </form>
          )}
        </div>
      )}

      <button
        className="feedback-trigger"
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Send feedback"
      >
        Feedback
      </button>
    </div>
  )
}

import { useState } from 'react'
import FeedbackWidget from './components/FeedbackWidget'
import FeedbackReview from './components/FeedbackReview'
import './App.css'

type View = 'app' | 'review'

function App() {
  const [view, setView] = useState<View>('app')

  return (
    <>
      <nav className="app-nav">
        <button
          className={view === 'app' ? 'active' : ''}
          onClick={() => setView('app')}
        >
          App
        </button>
        <button
          className={view === 'review' ? 'active' : ''}
          onClick={() => setView('review')}
        >
          Review Feedback
        </button>
      </nav>

      {view === 'app' ? (
        <main>
          <h1>qb-spa</h1>
          <p>Welcome to your app.</p>
        </main>
      ) : (
        <FeedbackReview />
      )}

      <FeedbackWidget />
    </>
  )
}

export default App

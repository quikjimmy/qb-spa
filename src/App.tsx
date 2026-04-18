import { useState } from 'react'
import FeedbackWidget from './components/FeedbackWidget'
import FeedbackReview from './components/FeedbackReview'
import AgentDashboard from './components/AgentDashboard'
import AgentBuilder from './components/AgentBuilder'
import AgentDetail from './components/AgentDetail'
import './App.css'

type Page = 'app' | 'agents' | 'review'

type AgentView =
  | { screen: 'dashboard' }
  | { screen: 'builder'; agentId?: string }
  | { screen: 'detail'; agentId: string }

function App() {
  const [page, setPage] = useState<Page>('app')
  const [agentView, setAgentView] = useState<AgentView>({ screen: 'dashboard' })

  function navigateAgents() {
    setPage('agents')
    setAgentView({ screen: 'dashboard' })
  }

  return (
    <>
      <nav className="app-nav">
        <button
          className={page === 'app' ? 'active' : ''}
          onClick={() => setPage('app')}
        >
          App
        </button>
        <button
          className={page === 'agents' ? 'active' : ''}
          onClick={navigateAgents}
        >
          Agents
        </button>
        <button
          className={page === 'review' ? 'active' : ''}
          onClick={() => setPage('review')}
        >
          Review Feedback
        </button>
      </nav>

      {page === 'app' && (
        <main>
          <h1>qb-spa</h1>
          <p>Welcome to your app.</p>
        </main>
      )}

      {page === 'agents' && agentView.screen === 'dashboard' && (
        <AgentDashboard
          onCreateNew={() => setAgentView({ screen: 'builder' })}
          onSelectAgent={(id) => setAgentView({ screen: 'detail', agentId: id })}
        />
      )}

      {page === 'agents' && agentView.screen === 'builder' && (
        <AgentBuilder
          agentId={agentView.agentId}
          onSave={(id) => setAgentView({ screen: 'detail', agentId: id })}
          onCancel={() => setAgentView({ screen: 'dashboard' })}
        />
      )}

      {page === 'agents' && agentView.screen === 'detail' && (
        <AgentDetail
          agentId={agentView.agentId}
          onBack={() => setAgentView({ screen: 'dashboard' })}
          onEdit={(id) => setAgentView({ screen: 'builder', agentId: id })}
        />
      )}

      {page === 'review' && <FeedbackReview />}

      <FeedbackWidget />
    </>
  )
}

export default App

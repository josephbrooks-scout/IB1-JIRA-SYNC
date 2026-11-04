import { LocalJiraConnection } from './LocalJiraConnection'

type TicketWorkflowProps = {
  stage: 'load' | 'preview' | 'review'
  onLoad?: () => void
  onPreview?: () => void
}

export function TicketWorkflow({ stage, onLoad, onPreview }: TicketWorkflowProps) {
  return (
    <nav className="ticket-workflow" aria-label="Ticket workflow">
      <ol>
        <li aria-current={stage === 'load' ? 'step' : undefined}>
          {onLoad ? (
            <button type="button" onClick={onLoad}><span>1</span>Load document</button>
          ) : (
            <a href="#/"><span>1</span>Load document</a>
          )}
        </li>
        <li aria-current={stage === 'preview' ? 'step' : undefined}>
          {onPreview ? (
            <button type="button" onClick={onPreview} disabled={stage === 'load'}><span>2</span>Preview tickets</button>
          ) : (
            <a href="#/"><span>2</span>Preview tickets</a>
          )}
        </li>
        <li aria-current={stage === 'review' ? 'step' : undefined}>
          <a href="#/review"><span>3</span>Review changes</a>
        </li>
      </ol>
      <p>Preview only. Jira changes require your approval.</p>
      <LocalJiraConnection />
      <details className="jira-account-guide">
        <summary>Use Jira with your own account</summary>
        <p>
          This website previews documents and reviews reports locally in your browser.
          It does not collect Jira passwords or API tokens and cannot sync directly to Jira.
        </p>
        <ol>
          <li>Clone the repository on your computer, install Node.js 22.18 or newer, and run <code>npm ci</code>.</li>
          <li>
            Copy <code>.env.example</code> to <code>.env</code>. Enter your own Jira site URL,
            email, and API token as <code>JIRA_BASE_URL</code>, <code>JIRA_EMAIL</code>, and <code>JIRA_API_TOKEN</code>.
            Never share or commit this file.
          </li>
          <li>Generate a dry-run report locally, load it in Review changes, and check off every proposed change.</li>
          <li>Apply the downloaded approvals using the local CLI and your own Jira permissions.</li>
        </ol>
        <p>
          <a href="https://github.com/josephbrooks-scout/IB1-JIRA-SYNC#sharing-with-teammates" target="_blank" rel="noreferrer">
            Setup instructions and commands
          </a>
          {' · '}
          <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">
            Create your own Jira API token
          </a>
        </p>
      </details>
    </nav>
  )
}

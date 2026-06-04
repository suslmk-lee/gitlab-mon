import React from 'react'
import {createRoot} from 'react-dom/client'
import './style.css'
import App from './App'

class ErrorBoundary extends React.Component<{children: React.ReactNode}, {error: Error | null}> {
    state = {error: null as Error | null}

    static getDerivedStateFromError(error: Error) {
        return {error}
    }

    render() {
        if (this.state.error) {
            return (
                <div style={{padding: 24, color: '#f85149', fontFamily: 'monospace', fontSize: 13}}>
                    <h3>화면 렌더링 오류</h3>
                    <pre style={{whiteSpace: 'pre-wrap'}}>{String(this.state.error?.stack || this.state.error)}</pre>
                </div>
            )
        }
        return this.props.children
    }
}

const container = document.getElementById('root')

const root = createRoot(container!)

root.render(
    <React.StrictMode>
        <ErrorBoundary>
            <App/>
        </ErrorBoundary>
    </React.StrictMode>
)

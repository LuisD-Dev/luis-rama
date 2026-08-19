import { Component } from 'react';
import { UIIcon } from './Icons.jsx';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onReset) this.props.onReset();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="error-boundary">
          <div className="error-boundary-content">
            <span className="error-boundary-icon"><UIIcon name="warning" size={30} /></span>
            <h2>Algo salió mal</h2>
            <p>Ocurrió un error inesperado. Intenta recargar la página.</p>
            <div className="error-boundary-actions">
              <button className="button button-secondary" onClick={this.handleReset}>
                Reintentar
              </button>
              <button className="button button-primary" onClick={() => window.location.reload()}>
                Recargar página
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;

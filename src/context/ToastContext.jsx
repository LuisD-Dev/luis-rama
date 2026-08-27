import { createContext, useCallback, useContext, useState } from 'react';
import { UIIcon } from '../components/common/Icons.jsx';

const ToastContext = createContext();

export const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = 'success', duration = 4000) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, type, duration }]);
    if (type === 'success') {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
    }
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const success = useCallback((msg) => addToast(msg, 'success', 4000), [addToast]);
  const error = useCallback((msg) => addToast(msg, 'error', 0), [addToast]);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast, success, error }}>
      {children}
      <div className="toast-container" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <span className="toast-icon" aria-hidden="true">
              {t.type === 'success' ? (
                <UIIcon name="check" size={16} />
              ) : t.type === 'error' ? (
                <UIIcon name="warning" size={16} />
              ) : (
                <UIIcon name="eye" size={16} />
              )}
            </span>
            <span className="toast-message">{t.message}</span>
            {t.type === 'error' && (
              <button className="toast-dismiss" onClick={() => removeToast(t.id)} aria-label="Cerrar">
                <UIIcon name="close" size={14} />
              </button>
            )}
            {t.type === 'success' && t.duration > 0 && (
              <span className="toast-progress" style={{ animationDuration: `${t.duration}ms` }} />
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
};

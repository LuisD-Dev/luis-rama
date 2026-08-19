import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { authService } from '../../services/api.js';
import { validatePassword, PASSWORD_HINT } from '../../utils/password.js';
import { UIIcon } from '../../components/common/Icons.jsx';

export const ResetPasswordPage = () => {
  const location = useLocation();
  const [email, setEmail] = useState(location.state?.email || '');
  const [pin, setPin] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(location.state?.successMessage || null);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    setError(null);

    try {
      const passwordError = validatePassword(newPassword);
      if (passwordError) {
        setError(passwordError);
        return;
      }
      await authService.resetPassword(email, pin, newPassword);
      setMessage('Contraseña restablecida correctamente. Redirigiendo al login...');
      setTimeout(() => navigate('/auth/login'), 1300);
    } catch (err) {
      setError(err.response?.data?.error || 'No se pudo restablecer la contraseña.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-container">
        <div className="auth-card">
          <h1>Restablecer contraseña</h1>
          <p className="auth-subtitle">Introduce tu correo, el PIN recibido y una nueva contraseña.</p>

          {error && <div key={error} className="error-message animate-shake">{error}</div>}
          {message && <div className="success-message">{message}</div>}
          {location.state?.email && (
            <div className="info-message">
              Se envió el PIN a <strong>{location.state.email}</strong>. Usa ese código aquí o haz clic en "Volver a enviar" si no lo recibiste.
            </div>
          )}

          <form onSubmit={handleSubmit} className="auth-form">
            <div className="form-group">
              <label htmlFor="reset-email">Email</label>
              <input
                id="reset-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="tu@email.com"
              />
            </div>
            <div className="form-group">
              <label htmlFor="reset-pin">PIN de recuperación</label>
              <input
                id="reset-pin"
                type="text"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                required
                placeholder="123456"
              />
            </div>
            <div className="form-group password-group">
              <label htmlFor="reset-password">Nueva contraseña</label>
              <div className="password-field">
                <input
                  id="reset-password"
                  type={showPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  className="password-toggle"
                  aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  onClick={() => setShowPassword((prev) => !prev)}
                >
                  <UIIcon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
                </button>
              </div>
            </div>
            <button type="submit" disabled={loading} className="button button-primary button-block">
              {loading ? <span className="btn-loading"><span className="spinner" /> Restableciendo…</span> : 'Restablecer contraseña'}
            </button>
          </form>

          <p className="auth-footer">
            ¿No recibiste el PIN? <Link to="/auth/forgot-password">Volver a enviar</Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default ResetPasswordPage;

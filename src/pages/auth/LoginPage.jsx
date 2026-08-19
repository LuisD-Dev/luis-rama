import { useState } from 'react';
import { useNavigate, Link, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth.js';
import { getSafeRedirect } from '../../utils/safeRedirect.js';
import { AuthLayout } from '../../components/auth/AuthLayout.jsx';
import { UIIcon } from '../../components/common/Icons.jsx';

export const LoginPage = () => {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const redirectParam = searchParams.get('redirect') || searchParams.get('returnTo');
  const reason = searchParams.get('reason');
  const safeRedirect = getSafeRedirect(redirectParam);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(location.state?.message || null);

  const { login } = useAuth();
  const navigate = useNavigate();

  const handleForgotPassword = () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setError('Primero ingresa tu correo electrónico para acceder a la recuperación de contraseña.');
      return;
    }
    sessionStorage.setItem('recoveryEmail', normalizedEmail);
    navigate('/auth/forgot-password', { state: { email: normalizedEmail } });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await login(email, password);
      sessionStorage.removeItem('recoveryEmail');
      navigate(safeRedirect || '/dashboard');
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Bienvenido de vuelta a Teclia."
      subtitle="Continúa donde lo dejaste y sigue avanzando en tu aprendizaje."
    >
      <div className="auth-card">
          <h1>Inicia sesión</h1>
          <p className="auth-subtitle">Accede a tu cuenta de estudiante</p>

          {reason === 'expired' && (
            <div className="error-message">
              Fuiste desconectado porque tu sesión expiró.
            </div>
          )}

          {error && <div key={error} className="error-message animate-shake">{error}</div>}

          <form onSubmit={handleSubmit} className="auth-form">
            <div className="form-group">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="tu@email.com"
              />
            </div>

            <div className="form-group password-group">
              <label htmlFor="password">Contraseña</label>
              <div className="password-field">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
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

            <div className="auth-link-row">
              <button type="button" className="link-button" onClick={handleForgotPassword}>
                ¿Olvidaste tu contraseña?
              </button>
            </div>

            <button type="submit" disabled={loading} className="button button-primary button-block">
              {loading ? <span className="btn-loading"><span className="spinner" /> Cargando…</span> : 'Iniciar sesión'}
            </button>
          </form>

          <p className="auth-footer">
            ¿No tienes cuenta? <Link to="/auth/signup">Regístrate como estudiante</Link>
          </p>
      </div>
    </AuthLayout>
  );
};

export default LoginPage;

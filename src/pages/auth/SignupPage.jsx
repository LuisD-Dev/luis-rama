import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth.js';
import { validatePassword, PASSWORD_HINT } from '../../utils/password.js';
import { PasswordStrengthMeter } from '../../components/common/PasswordStrengthMeter.jsx';
import { AuthLayout } from '../../components/auth/AuthLayout.jsx';
import { UIIcon } from '../../components/common/Icons.jsx';

export const SignupPage = () => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const { signup } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('Las contraseñas no coinciden');
      return;
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }

    setLoading(true);

    try {
      await signup(email, password, name);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'Signup failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Empieza a tocar piano hoy."
      subtitle="Crea tu cuenta gratis y desbloquea recursos, lecciones y tu teclado interactivo."
    >
      <div className="auth-card">
          <h1>Crear cuenta</h1>
          <p className="auth-subtitle">Únete a Teclia y comienza a aprender</p>

          {error && <div key={error} className="error-message animate-shake">{error}</div>}

          <form onSubmit={handleSubmit} className="auth-form">
            <div className="form-group">
              <label htmlFor="name">Nombre</label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="Tu nombre completo"
              />
            </div>

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
              <PasswordStrengthMeter password={password} />
              <p className="field-hint">{PASSWORD_HINT}</p>
            </div>

            <div className="form-group password-group">
              <label htmlFor="confirmPassword">Confirmar contraseña</label>
              <div className="password-field">
                <input
                  id="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  className="password-toggle"
                  aria-label={showConfirmPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  onClick={() => setShowConfirmPassword((prev) => !prev)}
                >
                  <UIIcon name={showConfirmPassword ? 'eyeOff' : 'eye'} size={18} />
                </button>
              </div>
            </div>

            <button type="submit" disabled={loading} className="button button-primary button-block">
              {loading ? <span className="btn-loading"><span className="spinner" /> Creando cuenta…</span> : 'Registrarse'}
            </button>
          </form>

          <p className="auth-footer">
            ¿Ya tienes cuenta? <Link to="/auth/login">Inicia sesión aquí</Link>
          </p>
      </div>
    </AuthLayout>
  );
};

export default SignupPage;

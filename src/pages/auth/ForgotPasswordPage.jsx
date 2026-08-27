import { useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { authService } from '../../services/api.js';
import { validatePassword, PASSWORD_HINT } from '../../utils/password.js';

const normalizeEmail = (email) => email.trim().toLowerCase();

export const ForgotPasswordPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const recoveryEmail = normalizeEmail(
    location.state?.email || sessionStorage.getItem('recoveryEmail') || ''
  );

  const [email] = useState(recoveryEmail);
  const [pin, setPin] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(true);
  const [accountVerified, setAccountVerified] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!recoveryEmail) {
      navigate('/auth/login', {
        replace: true,
        state: { message: 'Primero ingresa tu correo en el login para recuperar la contraseña.' },
      });
      return;
    }

    sessionStorage.setItem('recoveryEmail', recoveryEmail);

    const verifyAccount = async () => {
      setVerifying(true);
      setError(null);
      try {
        await authService.verifyRecoveryEmail(recoveryEmail);
        setAccountVerified(true);
      } catch (err) {
        setAccountVerified(false);
        setError(err.response?.data?.error || 'No existe una cuenta registrada con este correo.');
      } finally {
        setVerifying(false);
      }
    };

    verifyAccount();
  }, [recoveryEmail, navigate]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!accountVerified) return;

    setLoading(true);
    setMessage(null);
    setError(null);

    try {
      if (!sent) {
        const res = await authService.forgotPassword(recoveryEmail);
        const successMessage = res.data.message || 'Se ha enviado un PIN de recuperación al correo. Revisa tu bandeja de entrada.';
        setMessage(successMessage);
        setSent(true);
      } else {
        const passwordError = validatePassword(newPassword);
        if (passwordError) {
          setError(passwordError);
          return;
        }
        await authService.resetPassword(recoveryEmail, pin, newPassword);
        sessionStorage.removeItem('recoveryEmail');
        setMessage('Contraseña restablecida correctamente. Redirigiendo al login...');
        setTimeout(() => navigate('/auth/login'), 1300);
      }
    } catch (err) {
      setError(err.response?.data?.error || (sent ? 'No se pudo restablecer la contraseña.' : 'No se pudo enviar el correo de recuperación.'));
    } finally {
      setLoading(false);
    }
  };

  if (!recoveryEmail) {
    return null;
  }

  return (
    <div className="auth-page">
      <div className="auth-container">
        <div className="auth-card">
          <h1>{sent ? 'Restablecer contraseña' : 'Recuperar contraseña'}</h1>
          <p className="auth-subtitle">
            {sent
              ? 'Introduce el PIN que recibiste y escribe una nueva contraseña.'
              : 'Usaremos el correo que ingresaste en el login para enviarte un PIN de recuperación.'}
          </p>

          {error && <div key={error} className="error-message animate-shake">{error}</div>}
          {message && <div className="success-message">{message}</div>}

          {verifying ? (
            <p className="auth-subtitle">Verificando cuenta...</p>
          ) : (
            <form onSubmit={handleSubmit} className="auth-form">
              <div className="form-group">
                <label htmlFor="recover-email">Email</label>
                <input
                  id="recover-email"
                  type="email"
                  value={email}
                  readOnly
                  disabled
                  className="input-readonly"
                />
              </div>

              {!accountVerified ? (
                <Link to="/auth/login" className="button button-secondary button-block">
                  Volver al login
                </Link>
              ) : !sent ? (
                <button type="submit" disabled={loading} className="button button-primary button-block">
                  {loading ? 'Enviando PIN...' : 'Enviar PIN de recuperación'}
                </button>
              ) : (
                <>
                  <div className="form-group">
                    <label htmlFor="recover-pin">PIN de recuperación</label>
                    <input
                      id="recover-pin"
                      type="text"
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                      required
                      placeholder="123456"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="recover-password">Nueva contraseña</label>
                    <input
                      id="recover-password"
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                    placeholder="Nueva contraseña"
                  />
                  <p className="field-hint">{PASSWORD_HINT}</p>
                </div>
                  <button type="submit" disabled={loading} className="button button-primary button-block">
                    {loading ? 'Restableciendo...' : 'Restablecer contraseña'}
                  </button>
                </>
              )}
            </form>
          )}

          <p className="auth-footer">
            {sent ? (
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setSent(false);
                  setMessage(null);
                  setError(null);
                  setPin('');
                  setNewPassword('');
                }}
              >
                Volver a enviar PIN
              </button>
            ) : (
              <Link to="/auth/login">¿Recordaste tu contraseña? Iniciar sesión</Link>
            )}
          </p>
        </div>
      </div>
    </div>
  );
};

export default ForgotPasswordPage;

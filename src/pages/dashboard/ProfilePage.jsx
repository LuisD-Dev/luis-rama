import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth.js';
import { authService } from '../../services/api.js';
import { resolveAvatar, storeAvatar } from '../../utils/avatar.js';
import { validatePassword, PASSWORD_HINT } from '../../utils/password.js';
import { planLabel } from '../../utils/plans.js';
import StripeCardForm from '../../components/payments/StripeCardForm.jsx';
import { CheckoutFlow } from '../../components/payments/CheckoutFlow.jsx';
import { UIIcon } from '../../components/common/Icons.jsx';

const vipPlans = [
  {
    label: 'Básico',
    price: '$9.99',
    features: ['Acceso a recursos', 'Lecciones guiadas', 'Comunidad privada'],
    details: 'Ideal para comenzar, con acceso completo a recursos y una comunidad dedicada al aprendizaje.',
  },
  {
    label: 'Pro',
    price: '$24.99',
    features: ['Feedback de IA', 'Clases 1:1', 'Partituras exclusivas'],
    details: 'El plan más equilibrado para acelerar tu progreso con tutoría guiada y contenido exclusivo.',
  },
  {
    label: 'Master',
    price: '$49.99',
    features: ['Plan personalizado', 'Sesiones premium', 'Análisis avanzado'],
    details: 'Para quienes quieren una experiencia VIP completa con seguimiento premium y soporte prioritario.',
  },
];

const mapProfileError = (err) => {
  if (!err.response) {
    return { general: 'Error de conexión. Intenta de nuevo.', field: null };
  }

  const status = err.response.status;
  const message = err.response.data?.error || 'No se pudo actualizar el perfil.';

  if (status === 400) {
    return { general: null, field: message };
  }

  return { general: message, field: null };
};

const mapPasswordError = (err) => {
  if (!err.response) {
    return 'Error de conexión. Intenta de nuevo.';
  }
  return err.response.data?.error || 'Error cambiando contraseña';
};

export const ProfilePage = () => {
  const { user, updateProfile } = useAuth();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState('general');
  const [name, setName] = useState(user?.name || '');

  const [avatarPreview, setAvatarPreview] = useState(() => resolveAvatar(user?.avatar_url || ''));
  const [avatarFile, setAvatarFile] = useState(null);
  const [profileMessage, setProfileMessage] = useState(null);
  const [profileError, setProfileError] = useState(null);
  const [nameFieldError, setNameFieldError] = useState(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [changePassword, setChangePassword] = useState({ current: '', new: '', confirm: '' });
  const [passwordError, setPasswordError] = useState(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [showPassword, setShowPassword] = useState({ current: false, new: false, confirm: false });
  const [activePlan, setActivePlan] = useState(null);

  useEffect(() => {
    setName(user?.name || '');
    setAvatarPreview(resolveAvatar(user?.avatar_url || ''));
    setAvatarFile(null);
  }, [user]);

  const handleAvatarUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  };

  const handleProfileSave = async (e) => {
    e.preventDefault();
    setProfileMessage(null);
    setProfileError(null);
    setNameFieldError(null);
    setProfileSaving(true);

    try {
      let payload = undefined;
      if (avatarFile) {
        payload = new FormData();
        payload.append('name', name);
        payload.append('avatar', avatarFile);
      }
      const res = await updateProfile(name, payload);
      setProfileMessage('Perfil actualizado correctamente.');
      const savedUrl = res.user.avatar_url || '';
      if (savedUrl) {
        storeAvatar(res.user.id, savedUrl);
      }
      setAvatarPreview(resolveAvatar(savedUrl) || avatarPreview);
      setAvatarFile(null);
      setTimeout(() => setProfileMessage(null), 3000);
    } catch (err) {
      const { general, field } = mapProfileError(err);
      if (field) {
        setNameFieldError(field);
      } else {
        setProfileError(general);
      }
    } finally {
      setProfileSaving(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);

    if (changePassword.new !== changePassword.confirm) {
      setPasswordError('Las contraseñas no coinciden');
      return;
    }

    const passwordError = validatePassword(changePassword.new);
    if (passwordError) {
      setPasswordError(passwordError);
      return;
    }

    try {
      setPasswordSaving(true);
      await authService.changePassword(changePassword.current, changePassword.new);
      setPasswordSuccess(true);
      setChangePassword({ current: '', new: '', confirm: '' });
      setTimeout(() => setPasswordSuccess(false), 3000);
    } catch (err) {
      setPasswordError(mapPasswordError(err));
    } finally {
      setPasswordSaving(false);
    }
  };

  const roleLabel = user?.role === 'admin'
    ? 'Instructor'
    : user?.plan_tier
      ? planLabel(user.plan_tier)
      : user?.role === 'premium'
        ? 'Premium'
        : 'Estudiante';

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab === 'security' || tab === 'subscription' || tab === 'general') {
      setActiveTab(tab);
    }
  }, [searchParams]);

  return (
    <div className="profile-page">
      <div className="page-shell">
        <div className="profile-header">
          <h1>Perfil</h1>
          <p>Administra tu cuenta, seguridad y preferencias.</p>
        </div>

        <div className="profile-tabs">
          <button className={`profile-tab ${activeTab === 'general' ? 'active' : ''}`} onClick={() => setActiveTab('general')}>
            General
          </button>
          <button className={`profile-tab ${activeTab === 'security' ? 'active' : ''}`} onClick={() => setActiveTab('security')}>
            Seguridad
          </button>
          <button className={`profile-tab ${activeTab === 'subscription' ? 'active' : ''}`} onClick={() => setActiveTab('subscription')}>
            Suscripción
          </button>
        </div>

        {activeTab === 'general' && (
          <div className="profile-content">
            <div className="profile-section">
              <h2>Información general</h2>
              <div className="profile-card">
                <form onSubmit={handleProfileSave} className="profile-form">
                  <div className="profile-row">
                    <div className="avatar-preview-card">
                      <div className="avatar-preview-shell">
                        {avatarPreview ? (
                          <img
                            src={avatarPreview}
                            alt="Avatar de perfil"
                            className="profile-avatar-image"
                            loading="lazy"
                            decoding="async"
                            width={128}
                            height={128}
                            onError={() => setAvatarPreview('')}
                          />
                        ) : (
                          <div className="avatar-placeholder">{user?.name?.slice(0, 1) || 'T'}</div>
                        )}
                      </div>
                      <label className="avatar-upload-label">
                        <span className="button button-secondary">Seleccionar imagen</span>
                        <input type="file" accept="image/*" onChange={handleAvatarUpload} />
                      </label>
                      {avatarFile && <div className="avatar-selected-tag">Imagen elegida lista para subir</div>}
                    </div>
                    <div className="profile-fields">
                      <div className="profile-field">
                        <label>Nombre</label>
                        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tu nombre" />
                        {nameFieldError && <p className="field-error">{nameFieldError}</p>}
                      </div>
                      <div className="profile-field">
                        <label>Email</label>
                        <p className="profile-value">{user?.email}</p>
                      </div>
                      <div className="profile-field">
                        <label>Rol</label>
                        <p className="profile-value role-badge">{roleLabel}</p>
                      </div>
                    </div>
                  </div>

                  {profileError && <div className="error-message">{profileError}</div>}
                  {profileMessage && <div className="success-message">{profileMessage}</div>}
                  <button type="submit" className="button button-primary" disabled={profileSaving}>
                    {profileSaving ? 'Guardando...' : 'Guardar cambios'}
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'security' && (
          <div className="profile-content">
            <div className="profile-section">
              <h2>Cambiar contraseña</h2>
              <div className="profile-card">
                {passwordError && <div className="error-message">{passwordError}</div>}
                {passwordSuccess && <div className="success-message">Contraseña actualizada correctamente.</div>}
                <form onSubmit={handleChangePassword} className="password-form">
                  <div className="form-group password-group">
                    <label htmlFor="current">Contraseña actual</label>
                    <div className="password-field">
                      <input
                        id="current"
                        type={showPassword.current ? 'text' : 'password'}
                        value={changePassword.current}
                        onChange={(e) => setChangePassword({ ...changePassword, current: e.target.value })}
                        required
                        placeholder="Ingresa tu contraseña actual"
                      />
                      <button type="button" className="password-toggle" aria-label={showPassword.current ? 'Ocultar contraseña' : 'Mostrar contraseña'} onClick={() => setShowPassword((prev) => ({ ...prev, current: !prev.current }))}>
                        <UIIcon name={showPassword.current ? 'eyeOff' : 'eye'} size={18} />
                      </button>
                    </div>
                  </div>
                  <div className="form-group password-group">
                    <label htmlFor="new">Nueva contraseña</label>
                    <div className="password-field">
                      <input
                        id="new"
                        type={showPassword.new ? 'text' : 'password'}
                        value={changePassword.new}
                        onChange={(e) => setChangePassword({ ...changePassword, new: e.target.value })}
                        required
                        placeholder="Ingresa tu nueva contraseña"
                      />
                      <button type="button" className="password-toggle" aria-label={showPassword.new ? 'Ocultar contraseña' : 'Mostrar contraseña'} onClick={() => setShowPassword((prev) => ({ ...prev, new: !prev.new }))}>
                        <UIIcon name={showPassword.new ? 'eyeOff' : 'eye'} size={18} />
                      </button>
                    </div>
                    <p className="field-hint">{PASSWORD_HINT}</p>
                  </div>
                  <div className="form-group password-group">
                    <label htmlFor="confirm">Confirmar nueva contraseña</label>
                    <div className="password-field">
                      <input
                        id="confirm"
                        type={showPassword.confirm ? 'text' : 'password'}
                        value={changePassword.confirm}
                        onChange={(e) => setChangePassword({ ...changePassword, confirm: e.target.value })}
                        required
                        placeholder="Confirma tu nueva contraseña"
                      />
                      <button type="button" className="password-toggle" aria-label={showPassword.confirm ? 'Ocultar contraseña' : 'Mostrar contraseña'} onClick={() => setShowPassword((prev) => ({ ...prev, confirm: !prev.confirm }))}>
                        <UIIcon name={showPassword.confirm ? 'eyeOff' : 'eye'} size={18} />
                      </button>
                    </div>
                  </div>
                  <button type="submit" className="button button-primary" disabled={passwordSaving}>
                    {passwordSaving ? 'Actualizando...' : 'Actualizar contraseña'}
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'subscription' && (
          <div className="profile-content">
            <div className="profile-section">
              <h2>Planes VIP</h2>
              <div className="plan-grid">
                {vipPlans.map((plan) => (
                  <div key={plan.label} className={`plan-card ${activePlan === plan.label ? 'active' : ''}`}>
                    <div className="plan-card-header">
                      <div>
                        <h3>{plan.label}</h3>
                        <p className="plan-price">{plan.price}</p>
                      </div>
                      <button
                        type="button"
                        className="button button-outline"
                        onClick={() => setActivePlan(activePlan === plan.label ? null : plan.label)}
                      >
                        {activePlan === plan.label ? 'Ocultar' : 'Ver más'}
                      </button>
                    </div>
                    {activePlan === plan.label && (
                      <div className="plan-details plan-card-details">
                        <p>{plan.details}</p>
                        <ul>
                          {plan.features.map((feature) => (
                            <li key={feature}>{feature}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="profile-section">
              <h2>Actualizar plan</h2>
              <div className="profile-card">
                <CheckoutFlow
                  initialPlan={user?.plan_tier}
                  renderPaymentForm={({ plan, onSuccess }) => (
                    <StripeCardForm
                      submitLabel="Guardar método de pago"
                      successMessage={`Método de pago del plan ${plan.label} enviado correctamente.`}
                      onSuccess={onSuccess}
                    />
                  )}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ProfilePage;

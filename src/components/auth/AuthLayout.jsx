import { Logo } from '../common/Logo.jsx';
import { UIIcon } from '../common/Icons.jsx';

const defaultBullets = [
  'Lecciones en video paso a paso',
  'Partituras y pistas incluidas',
  'Teclado interactivo y teoría clara',
];

export const AuthLayout = ({ children, title, subtitle, bullets = defaultBullets }) => (
  <div className="auth-page">
    <div className="auth-split">
      <aside className="auth-brand bg-grid">
        <Logo size={48} showTagline />
        <h2>{title || 'Aprende piano con acompañamiento real.'}</h2>
        <p>{subtitle || 'Una academia online diseñada para que practiques con claridad y avances con confianza.'}</p>
        <ul className="auth-brand-list">
          {bullets.map((b) => (
            <li key={b}><UIIcon name="check" size={16} className="lp-check" />{b}</li>
          ))}
        </ul>
      </aside>
      <div className="auth-container">
        {children}
      </div>
    </div>
  </div>
);

export default AuthLayout;

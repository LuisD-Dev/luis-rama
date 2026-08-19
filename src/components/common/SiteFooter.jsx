import { Link } from 'react-router-dom';
import { Logo } from './Logo.jsx';

const socials = [
  { label: 'IG', href: 'https://www.instagram.com/tecliaacademy?utm_source=qr', name: 'Instagram' },
  { label: 'YT', href: '#', name: 'YouTube' },
  { label: 'TT', href: '#', name: 'TikTok' },
  { label: 'IN', href: '#', name: 'LinkedIn' },
];

export const SiteFooter = () => (
  <footer className="site-footer">
    <div className="site-footer-grid">
      <div className="site-footer-brand">
        <Logo size={40} showTagline={false} />
        <p>
          Academia de piano online. Lecciones en video, partituras y planes flexibles
          para aprender a tu ritmo, con acompañamiento profesional.
        </p>
      </div>

      <div>
        <h5>Explorar</h5>
        <div className="site-footer-links">
          <a href="/#inicio">Inicio</a>
          <a href="/#como-funciona">Cómo funciona</a>
          <a href="/#planes">Planes</a>
          <a href="/#explora">Recursos</a>
        </div>
      </div>

      <div>
        <h5>Cuenta</h5>
        <div className="site-footer-links">
          <Link to="/auth/login">Iniciar sesión</Link>
          <Link to="/auth/signup">Crear cuenta</Link>
          <Link to="/recursos">Mis recursos</Link>
          <Link to="/profile">Mi perfil</Link>
        </div>
      </div>

      <div>
        <h5>Contacto</h5>
        <div className="site-footer-links">
          <a href="mailto:austinrmz2007@gmail.com">austinrmz2007@gmail.com</a>
          <a href="tel:+50662608415">+506 6260 8415</a>
        </div>
      </div>
    </div>

    <div className="site-footer-bottom">
      <span>© {new Date().getFullYear()} Teclia. Todos los derechos reservados.</span>
      <div className="site-footer-social">
        {socials.map((s) => (
          <a key={s.name} href={s.href} aria-label={s.name} title={s.name} target="_blank" rel="noopener noreferrer">
            {s.label}
          </a>
        ))}
      </div>
    </div>
  </footer>
);

export default SiteFooter;

import { Link, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Icon, UIIcon } from '../../components/common/Icons.jsx';
import { PersonaBanner } from '../../components/common/PersonaBanner.jsx';
import { useContent } from '../../context/ContentContext.jsx';
import { useAuth } from '../../hooks/useAuth.js';
import { adminService, authService, statsService } from '../../services/api.js';
import { useKeyboardShortcuts, KeyboardShortcutsHelp } from '../../components/common/KeyboardShortcuts.jsx';

const StatCard = ({ label, value, icon, trend, highlight }) => (
  <div className={`stat-card ${highlight ? 'highlight' : ''}`}>
    <div className="stat-card-header">
      {icon && <span className="stat-icon">{icon}</span>}
      <span className="stat-label">{label}</span>
    </div>
    <div className="stat-value">{value ?? '—'}</div>
    {trend !== undefined && (
      <div className={`stat-trend ${trend >= 0 ? 'trend-up' : 'trend-down'}`}>
        {trend >= 0 ? '↑' : '↓'} {Math.abs(trend)}%
      </div>
    )}
  </div>
);

const SkeletonStat = () => (
  <div className="stat-card skeleton">
    <div className="skeleton-line skeleton-line-sm" />
    <div className="skeleton-line skeleton-line-lg" />
    <div className="skeleton-line skeleton-line-xs" />
  </div>
);

export const AdminDashboardPage = () => {
  const navigate = useNavigate();
  const { content } = useContent();
  const { user } = useAuth();
  const [dashboardStats, setDashboardStats] = useState(null);
  const [statsError, setStatsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showShortcuts, setShowShortcuts] = useState(false);

  useKeyboardShortcuts({
    showHelp: () => setShowShortcuts((p) => !p),
    addStudent: () => navigate('/admin/students'),
    createContent: () => navigate('/admin/upload'),
    goDashboard: () => navigate('/admin'),
    goStudents: () => navigate('/admin/students'),
    goContent: () => navigate('/admin/content'),
  });

  const recentContent = content.slice(0, 5);
  const formatCurrency = (amount, currency = 'USD') => {
    return new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount ?? 0);
  };

  const loadDashboardStats = () => {
    setLoading(true);
    setStatsError('');

    adminService
      .getDashboardStats()
      .then((res) => {
        setDashboardStats(res.data);
      })
      .catch(async () => {
        try {
          const [visitsRes, studentsRes] = await Promise.all([
            statsService.getVisitStats(),
            authService.getStudents(),
          ]);

          const studentList = Array.isArray(studentsRes?.data?.students)
            ? studentsRes.data.students
            : [];

          setDashboardStats({
            pageVisits: visitsRes?.data?.pageVisits ?? 0,
            studentCount: studentList.length,
            revenueThisMonth: 0,
            revenueLastMonth: 0,
            revenueChange: 0,
            activeSubscriptions: { basico: 0, pro: 0, master: 0, total: 0 },
            currency: 'USD',
          });

          setStatsError('Ingresos no disponibles en este servidor. Se muestran estudiantes y visitas en tiempo real.');
        } catch (_fallbackError) {
          setStatsError('No se pudieron cargar las métricas. Intenta nuevamente.');
        }
      })
      .finally(() => setLoading(false));
  };

  const stats = {
    total: content.length,
  };

  const activeSubscriptions = dashboardStats?.activeSubscriptions || { basico: 0, pro: 0, master: 0, total: 0 };

  useEffect(() => {
    loadDashboardStats();
  }, []);

  return (
    <div className="dashboard-layout">
      <div className="dashboard-main">
        <PersonaBanner
          name="Panel del instructor"
          subtitle={`Bienvenido, ${user?.name || ''}. Gestiona tus lecciones y recursos para los estudiantes.`}
          initial={user?.name?.charAt(0)?.toUpperCase() || 'A'}
          chips={[
            { label: 'Administrador', variant: 'gold' },
            { label: user?.email || '', },
            { label: 'Cuenta activa', variant: 'success' },
          ]}
          actions={(
            <>
              <Link to="/admin/upload" className="button button-primary">+ Crear contenido</Link>
              <Link to="/admin/students" className="button button-secondary">Estudiantes</Link>
            </>
          )}
        />

        <div className="admin-stats">
          <h2>Resumen del panel</h2>
          {statsError && (
            <div className="stats-error" role="alert">
              <p>{statsError}</p>
              <button type="button" className="button button-ghost small" onClick={loadDashboardStats}>
                Reintentar
              </button>
            </div>
          )}
          <div className="stats-grid">
            {loading ? (
              <>
                <SkeletonStat />
                <SkeletonStat />
                <SkeletonStat />
                <SkeletonStat />
                <SkeletonStat />
                <SkeletonStat />
                <SkeletonStat />
                <SkeletonStat />
                <SkeletonStat />
              </>
            ) : (
              <>
                <StatCard label="Visitas a la página" value={dashboardStats?.pageVisits ?? 0} icon="👁️" />
                <StatCard label="Estudiantes" value={dashboardStats?.studentCount ?? 0} icon="👥" />
                <StatCard
                  label="Ingresos este mes"
                  value={formatCurrency(dashboardStats?.revenueThisMonth, dashboardStats?.currency || 'USD')}
                  icon="💰"
                  trend={dashboardStats?.revenueChange ?? 0}
                  highlight
                />
                <StatCard
                  label="Ingresos mes pasado"
                  value={formatCurrency(dashboardStats?.revenueLastMonth, dashboardStats?.currency || 'USD')}
                  icon="📆"
                />
                <StatCard label="Suscripciones activas" value={activeSubscriptions.total} icon="🔔" />
                <StatCard label="Plan básico" value={activeSubscriptions.basico} icon="🥉" />
                <StatCard label="Plan pro" value={activeSubscriptions.pro} icon="🥈" />
                <StatCard label="Plan master" value={activeSubscriptions.master} icon="🥇" />
                <StatCard label="Total contenidos" value={stats.total} icon="📚" />
              </>
            )}
          </div>
        </div>

        <div className="admin-quick-actions">
          <h2>Acciones rápidas</h2>
          <div className="quick-actions-grid">
            <Link to="/admin/students" className="action-card">
              <div className="action-icon"><UIIcon name="plus" size={20} /></div>
              <h3>Añadir estudiante</h3>
              <p>Registrar nuevo alumno en la plataforma</p>
            </Link>
            <Link to="/admin/upload" className="action-card">
              <div className="action-icon"><UIIcon name="upload" size={20} /></div>
              <h3>Crear contenido</h3>
              <p>Subir video, PDF, audio o imagen</p>
            </Link>
            <Link to="/admin/content" className="action-card">
              <div className="action-icon"><UIIcon name="clipboard" size={20} /></div>
              <h3>Gestionar contenido</h3>
              <p>Revisar y administrar recursos</p>
            </Link>
            <Link to="/admin/students" className="action-card">
              <div className="action-icon"><UIIcon name="users" size={20} /></div>
              <h3>Ver estudiantes</h3>
              <p>Consultar alumnos y sus planes</p>
            </Link>
            <a href="/admin" className="action-card" onClick={(e) => { e.preventDefault(); alert('Reportes próximamente'); }}>
              <div className="action-icon"><UIIcon name="chart" size={20} /></div>
              <h3>Ver reportes</h3>
              <p>Estadísticas y análisis de plataforma</p>
            </a>
            <a href="/admin" className="action-card" onClick={(e) => { e.preventDefault(); alert('Exportación próximamente'); }}>
              <div className="action-icon"><UIIcon name="download" size={20} /></div>
              <h3>Exportar datos</h3>
              <p>Descargar datos de estudiantes</p>
            </a>
          </div>
        </div>

        <div className="admin-recent">
          <div className="content-header">
            <h2>Contenido reciente</h2>
            <button className="button button-ghost small" onClick={() => setShowShortcuts(true)} title="Atajos de teclado" aria-label="Atajos de teclado">
              <UIIcon name="keyboard" size={16} /> Atajos
            </button>
          </div>
          {recentContent.length === 0 ? (
            <div className="empty-state">
              <span className="empty-state-icon" aria-hidden="true"><UIIcon name="video" size={26} /></span>
              <p>No hay contenido aún. <Link to="/admin/upload">Añade tu primer contenido</Link></p>
            </div>
          ) : (
            <div className="recent-list">
              {recentContent.map(item => (
                <div key={item.id} className="recent-item">
                  <div className="recent-icon"><Icon type={item.type} className="recent-icon-svg" /></div>
                  <div className="recent-info">
                    <h4>{item.title}</h4>
                    <p>{item.type.toUpperCase()}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showShortcuts && (
        <KeyboardShortcutsHelp onClose={() => setShowShortcuts(false)} />
      )}
    </div>
  );
};

export default AdminDashboardPage;

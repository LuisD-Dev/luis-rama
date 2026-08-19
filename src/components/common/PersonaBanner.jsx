export const PersonaBanner = ({ name, subtitle, initial, chips = [], actions = null }) => (
  <div className="persona-banner">
    <div className="persona-avatar" aria-hidden="true">{initial}</div>
    <div className="persona-body">
      <h1>{name}</h1>
      {subtitle && <p>{subtitle}</p>}
      {chips.length > 0 && (
        <div className="persona-chips">
          {chips.map((chip, i) => (
            <span key={i} className={`chip ${chip.variant ? `chip-${chip.variant}` : ''}`}>
              {chip.label}
            </span>
          ))}
        </div>
      )}
    </div>
    {actions && <div className="persona-actions">{actions}</div>}
  </div>
);

export default PersonaBanner;

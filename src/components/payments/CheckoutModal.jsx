import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

export const CheckoutModal = ({ children, onClose }) => {
  const overlayRef = useRef(null);

  const handleKey = useCallback((e) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKey);
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.documentElement.style.overflow = '';
    };
  }, [handleKey]);

  const handleOverlayClick = (e) => {
    if (e.target === overlayRef.current) onClose();
  };

  return createPortal(
    <div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick} role="dialog" aria-modal="true" aria-label="Proceso de compra">
      <div className="modal-content checkout-modal">
        <button type="button" className="checkout-modal-close" onClick={onClose} aria-label="Cerrar">&times;</button>
        {children}
      </div>
    </div>,
    document.body
  );
};

export default CheckoutModal;

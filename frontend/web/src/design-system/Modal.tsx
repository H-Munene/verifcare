import type { ReactNode } from 'react';
import './components.css';

export interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ title, onClose, children }: ModalProps) {
  return (
    <div className="ds-modal-overlay" onClick={onClose}>
      <div className="ds-modal" onClick={(event) => event.stopPropagation()}>
        <div className="ds-modal__title">{title}</div>
        {children}
      </div>
    </div>
  );
}

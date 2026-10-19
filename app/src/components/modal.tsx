import { useEffect, type ReactNode } from 'react';

export function Modal({
  children,
  isVisible,
  onClose,
  labelledBy,
}: {
  children: ReactNode;
  isVisible: boolean;
  onClose: () => void;
  labelledBy?: string;
}) {
  useEffect(() => {
    if (!isVisible) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isVisible, onClose]);

  if (!isVisible) return null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-[rgba(5,8,14,0.7)] p-2.5 backdrop-blur-sm sm:p-5"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-[90%] max-w-[420px] overflow-y-auto rounded-2xl border border-edge bg-panel p-6 shadow-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

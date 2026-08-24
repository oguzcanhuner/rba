import { useEffect, useRef } from 'react';

export type ContextMenuItem = {
  label: string;
  onSelect: () => void;
  variant?: 'default' | 'destructive';
  disabled?: boolean;
};

export type ContextMenuEntry = ContextMenuItem | 'divider';

type ContextMenuProps = {
  position: { x: number; y: number };
  items: ContextMenuEntry[];
  onClose: () => void;
};

/** A lightweight positioned popover menu, dismissed on outside click or
 * Escape. There is no existing menu primitive in this project to reuse. */
export function ContextMenu({ position, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="context-menu"
      ref={ref}
      role="menu"
      style={{ top: position.y, left: position.x }}
    >
      {items.map((item, index) => {
        const nextItem = items
          .slice(index + 1)
          .find((entry) => entry !== 'divider');
        const key =
          item === 'divider'
            ? `divider-before-${typeof nextItem === 'object' ? nextItem.label : 'end'}`
            : item.label;

        return item === 'divider' ? (
          <div className="context-menu__divider" key={key} />
        ) : (
          <button
            className={`context-menu__item${
              item.variant === 'destructive'
                ? ' context-menu__item--destructive'
                : ''
            }`}
            disabled={item.disabled}
            key={key}
            role="menuitem"
            type="button"
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

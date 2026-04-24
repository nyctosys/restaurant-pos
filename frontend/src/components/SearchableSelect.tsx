import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export type SearchableSelectOption = {
  value: string;
  label: string;
  searchText?: string;
  disabled?: boolean;
};

type SearchableSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  className?: string;
  dropdownClassName?: string;
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

export default function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Select an option',
  searchPlaceholder = 'Search…',
  emptyMessage = 'No results found.',
  disabled = false,
  className,
  dropdownClassName,
}: SearchableSelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Tracks the portal dropdown div so outside-click detection includes it
  const portalRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menuStyle, setMenuStyle] = useState<{ top: number; left: number; width: number } | null>(null);

  const sortedOptions = useMemo(
    () =>
      [...options].sort((left, right) =>
        left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' })
      ),
    [options]
  );

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sortedOptions;
    return sortedOptions.filter(
      (opt) =>
        opt.label.toLowerCase().includes(q) ||
        (opt.searchText ?? '').toLowerCase().includes(q)
    );
  }, [sortedOptions, query]);

  const selectedOption = sortedOptions.find((option) => option.value === value);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      // Close only if click is outside BOTH the trigger wrapper AND the portal dropdown
      const insideRoot = rootRef.current?.contains(target) ?? false;
      const insidePortal = portalRef.current?.contains(target) ?? false;
      if (!insideRoot && !insidePortal) {
        setOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    const updateMenuPosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      setMenuStyle({
        top: rect.bottom + 8,
        left: rect.left,
        width: rect.width,
      });
    };

    updateMenuPosition();

    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);

    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [open]);

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen((current) => !current);
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
        className={cx(
          'flex w-full items-center justify-between gap-3 rounded-lg border border-soot-200 bg-white/80 px-4 py-2.5 text-left text-sm text-soot-800 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={cx('truncate', !selectedOption && 'text-soot-400')}>
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown
          className={cx('h-4 w-4 shrink-0 text-soot-400 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>

      {open && menuStyle
        ? createPortal(
            <div
              ref={portalRef}
              className={cx(
                'fixed z-[120] min-w-[12rem] overflow-hidden rounded-xl border border-soot-200 bg-white/95 shadow-xl backdrop-blur-md',
                dropdownClassName
              )}
              style={{ top: menuStyle.top, left: menuStyle.left, width: menuStyle.width }}
            >
              {sortedOptions.length > 6 && (
                <div className="p-2 border-b border-soot-100">
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={searchPlaceholder}
                    className="w-full px-3 py-1.5 text-sm bg-white border border-soot-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-400"
                    // Prevent form submit on Enter inside search box
                    onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                    autoFocus
                  />
                </div>
              )}
              <div className="max-h-64 overflow-y-auto p-1.5" role="listbox">
                {filteredOptions.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-soot-400">{emptyMessage}</div>
                ) : (
                  filteredOptions.map((option) => {
                    const selected = option.value === value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        disabled={option.disabled}
                        onMouseDown={(e) => {
                          // Use onMouseDown to fire before the outside-click handler,
                          // and prevent the blur from the trigger button.
                          e.preventDefault();
                        }}
                        onClick={() => {
                          if (option.disabled) return;
                          onChange(option.value);
                          setOpen(false);
                        }}
                        className={cx(
                          'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                          option.disabled
                            ? 'cursor-not-allowed text-soot-300'
                            : 'text-soot-700 hover:bg-brand-50 hover:text-soot-900',
                          selected && 'bg-brand-50 font-semibold text-brand-800'
                        )}
                        role="option"
                        aria-selected={selected}
                      >
                        <span className="truncate">{option.label}</span>
                        {selected ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
                      </button>
                    );
                  })
                )}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

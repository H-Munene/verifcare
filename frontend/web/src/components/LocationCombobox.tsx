// A searchable, hover-aware dropdown for the county/constituency/ward cascade
// (RegisterDependantPage.tsx's Location step) - a plain native <select> can't fire a callback as
// the pointer moves over an option, which the map's hover-to-highlight behavior needs, so this is
// a small custom combobox instead. Generic over the option type so the same component serves all
// three levels (CountyOption/ConstituencyOption/WardOption from geo/adminBoundaries.ts).

import { useEffect, useRef, useState } from 'react';
import './LocationCombobox.css';

export interface LocationComboboxProps<T> {
  label: string;
  countHint?: string;
  options: T[];
  getCode: (option: T) => string | number;
  getName: (option: T) => string;
  value: T | null;
  onSelect: (option: T | null) => void;
  onHoverOption: (option: T | null) => void;
  disabled?: boolean;
  disabledHint?: string;
  placeholder?: string;
}

export function LocationCombobox<T>({
  label,
  countHint,
  options,
  getCode,
  getName,
  value,
  onSelect,
  onHoverOption,
  disabled = false,
  disabledHint = 'Select previous level first',
  placeholder = 'Search...',
}: LocationComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const filtered = options.filter((option) =>
    getName(option).toLowerCase().includes(query.toLowerCase()),
  );

  function handleSelect(option: T) {
    onSelect(option);
    onHoverOption(null);
    setOpen(false);
    setQuery('');
  }

  function handleClear() {
    onSelect(null);
    onHoverOption(null);
  }

  return (
    <div className="location-combobox" ref={containerRef}>
      <div className="location-combobox__label-row">
        <span className="location-combobox__label">{label}</span>
        {countHint ? <span className="location-combobox__hint">{countHint}</span> : null}
      </div>

      {disabled ? (
        <div className="location-combobox__disabled">{disabledHint}</div>
      ) : value ? (
        <div className="location-combobox__filled">
          <span>{getName(value)}</span>
          <button
            type="button"
            className="location-combobox__clear"
            onClick={handleClear}
            aria-label={`Clear ${label}`}
          >
            &times;
          </button>
        </div>
      ) : (
        <div className="location-combobox__input-wrap">
          <input
            className="location-combobox__input"
            type="text"
            value={query}
            placeholder={placeholder}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
          />
          {open ? (
            <ul className="location-combobox__list" onMouseLeave={() => onHoverOption(null)}>
              {filtered.length === 0 ? (
                <li className="location-combobox__empty">No matches</li>
              ) : (
                filtered.map((option) => (
                  <li
                    key={getCode(option)}
                    className="location-combobox__option"
                    onMouseEnter={() => onHoverOption(option)}
                    onClick={() => handleSelect(option)}
                  >
                    <span>{getName(option)}</span>
                    <span className="location-combobox__option-code">Code {getCode(option)}</span>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}

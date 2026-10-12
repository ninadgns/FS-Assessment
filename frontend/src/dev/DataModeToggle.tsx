import { useState } from 'react'
import { currentMode, DATA_MODES, type DataMode, MODE_LABEL, setMode } from './dataModes'

/** Dev-only switch between demo and stress-test data. Plain chrome, not part of the design. */
export function DataModeToggle({ onChange }: { onChange: (mode: DataMode) => void }) {
  const [mode, setLocal] = useState(currentMode)
  return (
    <div
      role="radiogroup"
      aria-label="Test data"
      style={{
        position: 'fixed',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 50,
        maxWidth: 'calc(100vw - 16px)',
        overflowX: 'auto',
        display: 'flex',
        gap: 2,
        padding: 3,
        borderRadius: 999,
        background: '#d4d4d8',
        font: '12px system-ui, sans-serif',
        boxShadow: '0 1px 4px rgb(0 0 0 / 0.2)',
      }}
    >
      {DATA_MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          onClick={() => {
            setMode(m)
            setLocal(m)
            onChange(m)
          }}
          style={{
            border: 0,
            borderRadius: 999,
            padding: '4px 10px',
            background: mode === m ? '#fff' : 'transparent',
            color: '#18181b',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {MODE_LABEL[m]}
        </button>
      ))}
    </div>
  )
}

import { useId } from 'react';

interface FieldProps {
  label: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
  error?: string;
  hint?: string;
  htmlFor?: string;
  // Convenience: render an <input> automatically when these are provided
  input?: React.InputHTMLAttributes<HTMLInputElement> & { type?: string };
}

export function Field({ label, right, children, error, hint, htmlFor, input }: FieldProps) {
  const autoId = useId();
  const inputId = htmlFor ?? (input ? autoId : undefined);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label
          htmlFor={inputId}
          style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-2)' }}
        >
          {label}
        </label>
        {right && <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{right}</span>}
      </div>

      {input ? (
        <input
          id={inputId}
          className="input"
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? `${inputId}-err` : hint ? `${inputId}-hint` : undefined}
          style={error ? { borderColor: 'var(--error)', boxShadow: '0 0 0 3px var(--error-soft)' } : undefined}
          {...input}
        />
      ) : (
        children
      )}

      {hint && !error && (
        <p id={`${inputId}-hint`} style={{ fontSize: 12, color: 'var(--ink-3)', margin: 0 }}>{hint}</p>
      )}
      {error && (
        <p id={`${inputId}-err`} role="alert" style={{ fontSize: 12, color: 'var(--error)', margin: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
          <span aria-hidden="true">⚠</span> {error}
        </p>
      )}
    </div>
  );
}

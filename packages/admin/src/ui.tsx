import { signal } from '@preact/signals';
import type { ComponentChildren, JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

// ------------------------------------------------------------------ toasts

interface Toast {
    id: number;
    text: string;
    tone: 'ok' | 'error';
}
const toasts = signal<Toast[]>([]);
let seq = 0;

export function toast(text: string, tone: Toast['tone'] = 'ok') {
    const id = ++seq;
    toasts.value = [...toasts.value, { id, text, tone }];
    setTimeout(() => (toasts.value = toasts.value.filter(t => t.id !== id)), tone === 'error' ? 6000 : 3000);
}

export function errorToast(err: unknown) {
    toast(err instanceof Error ? err.message : String(err), 'error');
}

export function Toasts() {
    return (
        <div class="toasts" role="status" aria-live="polite">
            {toasts.value.map(t => (
                <div key={t.id} class={`toast ${t.tone}`}>
                    {t.text}
                </div>
            ))}
        </div>
    );
}

// ------------------------------------------------------------------ primitives

type ButtonProps = JSX.HTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'ghost' | 'danger' | 'plain'; busy?: boolean; disabled?: boolean; type?: 'button' | 'submit' };

export function Button({ tone = 'ghost', busy, children, class: cls, disabled, type = 'button', ...rest }: ButtonProps) {
    return (
        <button {...rest} type={type} class={`btn ${tone} ${cls ?? ''}`} disabled={disabled || busy}>
            {busy ? <span class="spinner" aria-hidden="true" /> : null}
            {children}
        </button>
    );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
    return (
        <label class="field">
            <span class="field-label">{label}</span>
            {children}
            {hint ? <span class="field-hint">{hint}</span> : null}
        </label>
    );
}

export function Pill({ tone = 'neutral', children }: { tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue'; children: ComponentChildren }) {
    return <span class={`pill ${tone}`}>{children}</span>;
}

export function Empty({ title, children }: { title: string; children?: ComponentChildren }) {
    return (
        <div class="empty">
            <p class="empty-title">{title}</p>
            {children ? <div class="empty-body">{children}</div> : null}
        </div>
    );
}

export function PageHead({ title, children }: { title: string; children?: ComponentChildren }) {
    return (
        <header class="page-head">
            <h1>{title}</h1>
            <div class="page-actions">{children}</div>
        </header>
    );
}

export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
        window.addEventListener('keydown', onKey);
        // The field marked autofocus, else the first field in the body; never the close button.
        const root = ref.current;
        (root?.querySelector<HTMLElement>('[autofocus]') ?? root?.querySelector<HTMLElement>('.dialog-body :is(input, textarea, select, button)'))?.focus();
        return () => window.removeEventListener('keydown', onKey);
    }, []);
    return (
        <div class="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
            <div ref={ref} class={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
                <div class="dialog-head">
                    <h2>{title}</h2>
                    <button class="icon-btn" onClick={onClose} aria-label="Close">
                        ×
                    </button>
                </div>
                <div class="dialog-body">{children}</div>
            </div>
        </div>
    );
}

/** Loads data and exposes reload, the loading flag and the error. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const reload = useCallback(() => {
        setLoading(true);
        return fn()
            .then(d => (setData(d), setError(null)))
            .catch(e => setError(e?.message ?? String(e)))
            .finally(() => setLoading(false));
    }, deps);
    useEffect(() => {
        reload();
    }, [reload]);
    return { data, error, loading, reload, setData };
}

export function Loading() {
    return (
        <div class="loading">
            <span class="spinner" aria-hidden="true" /> Loading
        </div>
    );
}

export function ErrorNote({ text }: { text: string }) {
    return <div class="note error">{text}</div>;
}

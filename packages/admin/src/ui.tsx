import { signal } from '@preact/signals';
import type { ComponentChildren, JSX } from 'preact';
import { useCallback, useEffect, useId, useRef, useState } from 'preact/hooks';
import { Icon, type IconName } from './icons';

// ------------------------------------------------------------------ toasts

interface Toast {
    id: number;
    text: string;
    tone: 'ok' | 'error';
    leaving?: boolean;
}
const toasts = signal<Toast[]>([]);
let seq = 0;

function dismiss(id: number) {
    if (!toasts.value.some(t => t.id === id && !t.leaving)) return;
    toasts.value = toasts.value.map(t => (t.id === id ? { ...t, leaving: true } : t));
    // Long enough for the exit animation.
    setTimeout(() => (toasts.value = toasts.value.filter(t => t.id !== id)), 180);
}

export function toast(text: string, tone: Toast['tone'] = 'ok') {
    const id = ++seq;
    // Four at most: a burst of saves should not stack up the screen.
    toasts.value = [...toasts.value.slice(-3), { id, text, tone }];
    setTimeout(() => dismiss(id), tone === 'error' ? 6000 : 3200);
}

export function errorToast(err: unknown) {
    toast(err instanceof Error ? err.message : String(err), 'error');
}

export function Toasts() {
    return (
        <div class="toasts" role="status" aria-live="polite">
            {toasts.value.map(t => (
                <div key={t.id} class={`toast ${t.tone}${t.leaving ? ' leaving' : ''}`}>
                    <Icon name={t.tone === 'error' ? 'alert' : 'checkCircle'} class="toast-icon" />
                    <span class="toast-text">{t.text}</span>
                    <button type="button" class="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                        <Icon name="x" size={14} />
                    </button>
                </div>
            ))}
        </div>
    );
}

// ------------------------------------------------------------------ primitives

type ButtonProps = Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'icon' | 'size'> & {
    tone?: 'primary' | 'ghost' | 'danger' | 'plain';
    size?: 'sm' | 'md' | 'lg';
    /** A leading icon; the spinner takes its place while busy. */
    icon?: IconName;
    busy?: boolean;
    disabled?: boolean;
    type?: 'button' | 'submit';
};

export function Button({ tone = 'ghost', size = 'md', icon, busy, children, class: cls, disabled, type = 'button', ...rest }: ButtonProps) {
    return (
        <button {...rest} type={type} class={`btn ${tone}${size === 'md' ? '' : ` ${size}`} ${cls ?? ''}`} disabled={disabled || busy} aria-busy={busy || undefined}>
            {busy ? <span class="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 15} /> : null}
            {children}
        </button>
    );
}

/** A square button with only an icon: the label is read out and shown as a tooltip. */
export function IconButton({
    icon,
    label,
    size = 16,
    tooltip = 'bottom',
    class: cls,
    ...rest
}: Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'icon' | 'size' | 'label'> & { icon: IconName; label: string; size?: number; tooltip?: 'bottom' | 'right' | false; disabled?: boolean }) {
    return (
        <button
            type="button"
            {...rest}
            class={`icon-btn ${cls ?? ''}`}
            aria-label={label}
            data-tooltip={tooltip ? label : undefined}
            data-tooltip-side={tooltip === 'right' ? 'right' : undefined}
        >
            <Icon name={icon} size={size} />
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

export function Pill({ tone = 'neutral', dot, children }: { tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue'; dot?: boolean; children: ComponentChildren }) {
    return <span class={`pill ${tone}${dot ? ' dot' : ''}`}>{children}</span>;
}

/** Initials in a circle, or the person's picture when there is one. */
export function Avatar({ name, src, size = 24 }: { name: string; src?: string | null; size?: number }) {
    const [failed, setFailed] = useState(false);
    const initials =
        name
            .split(/[\s@._-]+/)
            .filter(Boolean)
            .slice(0, 2)
            .map(w => w[0]!.toUpperCase())
            .join('') || '?';
    if (src && !failed) return <img class="avatar" src={src} alt="" width={size} height={size} style={{ width: size, height: size }} onError={() => setFailed(true)} />;
    return (
        <span class="avatar" style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)) }} aria-hidden="true">
            {initials}
        </span>
    );
}

export function Empty({ title, icon, action, children }: { title: string; icon?: IconName; action?: ComponentChildren; children?: ComponentChildren }) {
    return (
        <div class="empty">
            {icon ? (
                <span class="empty-icon" aria-hidden="true">
                    <Icon name={icon} size={20} />
                </span>
            ) : null}
            <p class="empty-title">{title}</p>
            {children ? <div class="empty-body">{children}</div> : null}
            {action ? <div class="empty-actions">{action}</div> : null}
        </div>
    );
}

/** Every screen opens the same way: title, one line on what it is for, and its actions on the right. */
export function PageHead({ title, description, children }: { title: string; description?: ComponentChildren; children?: ComponentChildren }) {
    return (
        <header class="page-head">
            <div class="page-title">
                <h1>{title}</h1>
                {description ? <p class="page-desc">{description}</p> : null}
            </div>
            {children ? <div class="page-actions">{children}</div> : null}
        </header>
    );
}

/** Tabs that look like one control, e.g. Posts | Pages. Arrow keys move between them. */
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: ComponentChildren; count?: number | null }[]; onChange: (v: T) => void }) {
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const i = options.findIndex(o => o.value === value);
        const next = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length];
        const group = e.currentTarget as HTMLElement;
        onChange(next.value);
        requestAnimationFrame(() => group.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
    };
    return (
        <div class="segmented" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
            {options.map(o => {
                const on = o.value === value;
                return (
                    <button key={o.value} type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1} class={on ? 'on' : ''} onClick={() => onChange(o.value)}>
                        {o.label}
                        {o.count != null ? <span class="count">{o.count.toLocaleString()}</span> : null}
                    </button>
                );
            })}
        </div>
    );
}

// ------------------------------------------------------------------ dialogs

// Open dialogs, innermost last: Escape and Tab belong to the top one only.
const openDialogs: number[] = [];
let dialogSeq = 0;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

function keepFocusInside(root: HTMLElement, e: KeyboardEvent) {
    const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || !root.contains(at))) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && (at === last || !root.contains(at))) {
        e.preventDefault();
        first.focus();
    }
}

export function Dialog({
    title,
    description,
    onClose,
    children,
    wide,
    size
}: {
    title: string;
    description?: ComponentChildren;
    onClose: () => void;
    children: ComponentChildren;
    wide?: boolean;
    size?: 'sm' | 'md' | 'lg';
}) {
    const ref = useRef<HTMLDivElement>(null);
    const titleId = useId();
    const close = useRef(onClose);
    close.current = onClose;
    useEffect(() => {
        const id = ++dialogSeq;
        openDialogs.push(id);
        const opener = document.activeElement as HTMLElement | null;
        const root = ref.current;
        const onKey = (e: KeyboardEvent) => {
            if (openDialogs[openDialogs.length - 1] !== id) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                close.current();
            } else if (e.key === 'Tab' && root) keepFocusInside(root, e);
        };
        window.addEventListener('keydown', onKey);
        document.documentElement.classList.add('has-dialog');
        // The field marked autofocus, else the first field in the body; never the close button.
        (root?.querySelector<HTMLElement>('[autofocus]') ?? root?.querySelector<HTMLElement>('.dialog-body :is(input, textarea, select, button)') ?? root)?.focus();
        return () => {
            window.removeEventListener('keydown', onKey);
            openDialogs.splice(openDialogs.indexOf(id), 1);
            if (!openDialogs.length) document.documentElement.classList.remove('has-dialog');
            if (opener?.isConnected) opener.focus({ preventScroll: true });
        };
    }, []);
    const width = size && size !== 'md' ? size : wide ? 'wide' : '';
    return (
        <div class="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
            <div ref={ref} class={`dialog ${width}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
                <div class="dialog-head">
                    <div class="dialog-titles">
                        <h2 id={titleId}>{title}</h2>
                        {description ? <p class="dialog-desc">{description}</p> : null}
                    </div>
                    <button type="button" class="icon-btn dialog-close" onClick={onClose} aria-label="Close">
                        <Icon name="x" size={16} />
                    </button>
                </div>
                <div class="dialog-body">{children}</div>
            </div>
        </div>
    );
}

// ------------------------------------------------------------------ loading

/** Loads data and exposes reload, the loading flag and the error. A slow answer never overwrites a newer one. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const latest = useRef(0);
    const reload = useCallback(() => {
        const n = ++latest.current;
        setLoading(true);
        return fn()
            .then(d => {
                if (n === latest.current) (setData(d), setError(null));
            })
            .catch(e => {
                if (n === latest.current) setError(e?.message ?? String(e));
            })
            .finally(() => {
                if (n === latest.current) setLoading(false);
            });
    }, deps);
    useEffect(() => {
        reload();
    }, [reload]);
    return { data, error, loading, reload, setData };
}

export function Loading() {
    return (
        <div class="loading" role="status">
            <span class="spinner" aria-hidden="true" /> Loading
        </div>
    );
}

/** A placeholder bar that shimmers while its content loads. */
export function Skeleton({ width = '100%', height = 10 }: { width?: string | number; height?: number }) {
    return <span class="skeleton" style={{ width, height }} aria-hidden="true" />;
}

/** The shape of a table, before its rows arrive. */
export function TableSkeleton({ rows = 8, columns = 4 }: { rows?: number; columns?: number }) {
    const cols = Array.from({ length: columns }, (_, i) => i);
    return (
        <div class="table-wrap" role="status" aria-label="Loading">
            <table class="table skeleton-table">
                <thead>
                    <tr>
                        {cols.map(c => (
                            <th key={c}>
                                <Skeleton width={c === 0 ? 72 : 48} height={8} />
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {Array.from({ length: rows }, (_, r) => (
                        <tr key={r}>
                            {cols.map(c => (
                                <td key={c}>
                                    <Skeleton width={c === 0 ? `${46 + ((r * 29) % 40)}%` : `${44 + ((r * 13 + c * 17) % 38)}%`} />
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export function ErrorNote({ text }: { text: string }) {
    return <div class="note error">{text}</div>;
}

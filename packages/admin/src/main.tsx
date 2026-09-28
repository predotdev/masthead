import { signal } from '@preact/signals';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, base, session, type Me } from './api';
import { Analytics } from './pages/analytics';
import { Ideas } from './pages/ideas';
import { Login, Verify } from './pages/login';
import { Members } from './pages/members';
import { Newsletters, SendDetail } from './pages/newsletters';
import { Posts } from './pages/posts';
import { Settings } from './pages/settings';
import { StaffPage } from './pages/staff';
import { Tags } from './pages/tags';
import { Loading, Toasts, errorToast } from './ui';

const route = signal(location.hash.slice(1) || '/posts');
window.addEventListener('hashchange', () => (route.value = location.hash.slice(1) || '/posts'));

const NAV: { path: string; label: string; roles?: string[] }[] = [
    { path: '/posts', label: 'Posts' },
    { path: '/pages', label: 'Pages' },
    { path: '/ideas', label: 'Ideas' },
    { path: '/analytics', label: 'Analytics' },
    { path: '/members', label: 'Members', roles: ['owner', 'admin'] },
    { path: '/newsletters', label: 'Newsletters', roles: ['owner', 'admin', 'editor'] },
    { path: '/tags', label: 'Tags' },
    { path: '/staff', label: 'Staff' },
    { path: '/settings', label: 'Settings', roles: ['owner', 'admin'] }
];

// The writing editor (TipTap) is most of the bundle, so it loads on its own and is fetched while idle.
type EditorModule = typeof import('./pages/editor');
let editorModule: EditorModule | null = null;
const loadEditor = () => import('./pages/editor').then(m => (editorModule = m));

function LazyEditor({ id }: { id: string }) {
    const [mod, setMod] = useState(editorModule);
    useEffect(() => {
        if (!mod) loadEditor().then(setMod, errorToast);
    }, []);
    return mod ? <mod.EditorPage id={id} /> : <Loading />;
}

function Page() {
    const [, head, arg] = route.value.split('/');
    switch (head) {
        case 'pages':
            return <Posts type="page" />;
        case 'edit':
            return <LazyEditor id={arg} />;
        case 'ideas':
            return <Ideas />;
        case 'analytics':
            return <Analytics />;
        case 'members':
            return <Members />;
        case 'newsletters':
            return arg ? <SendDetail id={arg} /> : <Newsletters />;
        case 'tags':
            return <Tags />;
        case 'staff':
            return <StaffPage />;
        case 'settings':
            return <Settings />;
        default:
            return <Posts type="post" />;
    }
}

function App() {
    useEffect(() => {
        api<Me>('/me')
            .then(me => (session.value = me))
            .catch(() => (session.value = null));
        const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 800));
        idle(() => loadEditor().catch(() => {}));
    }, []);

    const [, first, second] = route.value.split('/');
    // Sign-in links land on #/verify/<token>, signed in or not.
    if (first === 'verify' && second)
        return (
            <>
                <Verify token={decodeURIComponent(second.split('?')[0])} />
                <Toasts />
            </>
        );
    if (session.value === undefined) return <Loading />;
    if (session.value === null)
        return (
            <>
                <Login />
                <Toasts />
            </>
        );

    const me = session.value;
    const head = route.value.split('/')[1];
    const editing = head === 'edit';
    return (
        <div class={`shell ${editing ? 'editing' : ''}`}>
            <nav class="sidebar" aria-label="Admin">
                <a class="brand" href={base} target="_blank" rel="noreferrer" title="View the site">
                    {me.site.icon ? <img src={me.site.icon} alt="" width={20} height={20} /> : null}
                    <span>{me.site.title}</span>
                </a>
                <div class="nav">
                    {NAV.filter(n => !n.roles || n.roles.includes(me.user.role)).map(n => (
                        <a key={n.path} href={`#${n.path}`} class={`/${head}` === n.path || (head === 'edit' && n.path === '/posts') ? 'on' : ''}>
                            {n.label}
                        </a>
                    ))}
                </div>
                <div class="me">
                    {me.testMode ? (
                        <span class="pill amber" title="Test mode: email reaches only the team. Newsletters go only to team members; subscribers get nothing.">
                            test mode: team-only email
                        </span>
                    ) : null}
                    <span class="muted small">
                        {me.user.name} · {me.user.role}
                    </span>
                    <button
                        class="link-btn"
                        onClick={async () => {
                            await api('/auth/logout', { method: 'POST' }).catch(errorToast);
                            session.value = null;
                        }}
                    >
                        Sign out
                    </button>
                </div>
            </nav>
            <main class="main">
                <Page />
            </main>
            <Toasts />
        </div>
    );
}

render(<App />, document.getElementById('app')!);

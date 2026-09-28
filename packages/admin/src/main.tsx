import { signal } from '@preact/signals';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, base, session, type Me } from './api';
import { Icon, type IconName } from './icons';
import { Analytics } from './pages/analytics';
import { Calendar } from './pages/calendar';
import { Ideas } from './pages/ideas';
import { Login, Verify } from './pages/login';
import { Members } from './pages/members';
import { Newsletters, SendDetail } from './pages/newsletters';
import { WelcomeSeries } from './pages/welcome-series';
import { NotificationsButton, useNotificationsPoll } from './pages/notifications';
import { Posts, createPost } from './pages/posts';
import { Settings } from './pages/settings';
import { StaffPage } from './pages/staff';
import { Tags } from './pages/tags';
import { Avatar, Loading, Toasts, errorToast } from './ui';

const route = signal(location.hash.slice(1) || '/posts');
window.addEventListener('hashchange', () => (route.value = location.hash.slice(1) || '/posts'));

// ------------------------------------------------------------------ theme

type ThemeChoice = 'system' | 'light' | 'dark';
const THEME_KEY = 'masthead-admin-theme';
const readTheme = (): ThemeChoice => {
    try {
        const v = localStorage.getItem(THEME_KEY);
        return v === 'light' || v === 'dark' ? v : 'system';
    } catch {
        return 'system';
    }
};
const theme = signal<ThemeChoice>(readTheme());
// The stylesheet follows the system; data-theme only records an explicit choice.
function applyTheme(t: ThemeChoice) {
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
}
applyTheme(theme.value);

function setTheme(t: ThemeChoice) {
    theme.value = t;
    applyTheme(t);
    try {
        t === 'system' ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, t);
    } catch {
        // Private windows can refuse storage; the choice still holds until reload.
    }
}

// ------------------------------------------------------------------ navigation

type Role = Me['user']['role'];
interface NavItem {
    path: string;
    label: string;
    icon: IconName;
    roles?: Role[];
}
const NAV: { label: string; items: NavItem[] }[] = [
    {
        label: 'Content',
        items: [
            { path: '/posts', label: 'Posts', icon: 'posts' },
            { path: '/calendar', label: 'Calendar', icon: 'calendar' },
            { path: '/ideas', label: 'Ideas', icon: 'ideas' },
            { path: '/tags', label: 'Tags', icon: 'tags' }
        ]
    },
    {
        label: 'Audience',
        items: [
            { path: '/analytics', label: 'Analytics', icon: 'analytics' },
            { path: '/members', label: 'Members', icon: 'members', roles: ['owner', 'admin'] },
            { path: '/newsletters', label: 'Newsletters', icon: 'newsletters', roles: ['owner', 'admin', 'editor'] }
        ]
    },
    {
        label: 'Site',
        items: [
            { path: '/staff', label: 'Staff', icon: 'staff' },
            { path: '/settings', label: 'Settings', icon: 'settings', roles: ['owner', 'admin'] }
        ]
    }
];
const TITLES: Record<string, string> = { pages: 'Pages', edit: 'Editor', calendar: 'Calendar', ideas: 'Ideas', analytics: 'Analytics', members: 'Members', newsletters: 'Newsletters', tags: 'Tags', staff: 'Staff', settings: 'Settings' };
const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', editor: 'Editor', author: 'Author', contributor: 'Contributor' };

/** The nav item a route belongs to: pages and the editor live under Posts. */
const section = (head: string) => (head === 'pages' || head === 'edit' || !head ? '/posts' : `/${head}`);

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
        case 'calendar':
            return <Calendar />;
        case 'ideas':
            return <Ideas />;
        case 'analytics':
            return <Analytics />;
        case 'members':
            return <Members />;
        case 'newsletters':
            return arg === 'welcome' ? <WelcomeSeries /> : arg ? <SendDetail id={arg} /> : <Newsletters />;
        case 'tags':
            return <Tags />;
        case 'staff':
            return <StaffPage />;
        case 'settings':
            return <Settings section={arg} />;
        default:
            return <Posts type="post" />;
    }
}

/** The site's icon, or its first letter when there is none or it fails to load. */
function SiteMark({ me }: { me: Me }) {
    const [failed, setFailed] = useState(false);
    return (
        <span class="brand-mark">
            {me.site.icon && !failed ? <img src={me.site.icon} alt="" width={24} height={24} onError={() => setFailed(true)} /> : me.site.title.slice(0, 1).toUpperCase()}
        </span>
    );
}

function ComposeButton({ rail }: { rail: boolean }) {
    const [busy, setBusy] = useState(false);
    return (
        <button
            type="button"
            class="icon-btn compose"
            aria-label="New post"
            data-tooltip="New post"
            data-tooltip-side={rail ? 'right' : undefined}
            disabled={busy}
            onClick={async () => {
                setBusy(true);
                await createPost('post');
                setBusy(false);
            }}
        >
            {busy ? <span class="spinner" aria-hidden="true" /> : <Icon name="compose" size={15} />}
        </button>
    );
}

function TestModePill() {
    return (
        <span class="pill amber dot test-pill" title="Test mode: email reaches only the team. Newsletters go only to team members; subscribers get nothing.">
            <span class="test-pill-text">Test mode: team-only email</span>
        </span>
    );
}

function ThemeSwitch() {
    const options: [ThemeChoice, IconName, string][] = [
        ['system', 'monitor', 'System'],
        ['light', 'sun', 'Light'],
        ['dark', 'moon', 'Dark']
    ];
    return (
        <div class="theme-switch" role="group" aria-label="Theme">
            {options.map(([value, icon, label]) => (
                <button key={value} type="button" aria-pressed={theme.value === value} aria-label={label} title={label} class={theme.value === value ? 'on' : ''} onClick={() => setTheme(value)}>
                    <Icon name={icon} size={14} />
                </button>
            ))}
        </div>
    );
}

/** Who is signed in, with the theme, the public site and sign out one click away. */
function UserMenu({ me, rail }: { me: Me; rail: boolean }) {
    const [open, setOpen] = useState(false);
    const box = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            setOpen(false);
            trigger.current?.focus();
        };
        document.addEventListener('mousedown', onDown);
        window.addEventListener('keydown', onKey);
        return () => (document.removeEventListener('mousedown', onDown), window.removeEventListener('keydown', onKey));
    }, [open]);
    useEffect(() => setOpen(false), [route.value]);

    const signOut = async () => {
        await api('/auth/logout', { method: 'POST' }).catch(errorToast);
        session.value = null;
    };

    return (
        <div class="user" ref={box}>
            <button
                ref={trigger}
                type="button"
                class="user-btn"
                aria-expanded={open}
                aria-controls="user-menu"
                aria-label={rail ? `${me.user.name}, ${ROLE_LABEL[me.user.role]}` : undefined}
                data-tooltip={rail && !open ? me.user.name : undefined}
                data-tooltip-side="right"
                onClick={() => setOpen(!open)}
            >
                <Avatar name={me.user.name} size={28} />
                <span class="user-text">
                    <span class="user-name">{me.user.name}</span>
                    <span class="user-role">{ROLE_LABEL[me.user.role]}</span>
                </span>
                <Icon name="chevronsUpDown" size={14} class="user-chevron" />
            </button>
            {open ? (
                <div class="popover user-menu" id="user-menu">
                    <div class="pop-head">
                        <span class="pop-name">{me.user.name}</span>
                        <span class="pop-email">{me.user.email}</span>
                    </div>
                    <a class="pop-item" href={base} target="_blank" rel="noreferrer">
                        <Icon name="globe" size={15} />
                        View site
                        <Icon name="arrowUpRight" size={13} class="pop-end" />
                    </a>
                    <div class="pop-row">
                        <span>Theme</span>
                        <ThemeSwitch />
                    </div>
                    <div class="pop-sep" role="separator" />
                    <button type="button" class="pop-item" onClick={signOut}>
                        <Icon name="logOut" size={15} />
                        Sign out
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function Sidebar({ me, head, rail }: { me: Me; head: string; rail: boolean }) {
    const active = section(head);
    const tip = (label: string) => (rail ? { 'data-tooltip': label, 'data-tooltip-side': 'right' } : {});
    return (
        <nav class="sidebar" id="sidebar" aria-label="Admin">
            <div class="sidebar-top">
                <a class="brand" href={base} target="_blank" rel="noreferrer" aria-label={`${me.site.title}, view the site`} {...tip('View the site')}>
                    <SiteMark me={me} />
                    <span class="brand-name">{me.site.title}</span>
                    <Icon name="arrowUpRight" size={13} class="brand-out" />
                </a>
                <NotificationsButton rail={rail} />
                <ComposeButton rail={rail} />
            </div>
            <div class="nav">
                {NAV.map(group => {
                    const items = group.items.filter(n => !n.roles || n.roles.includes(me.user.role));
                    return items.length ? (
                        <div class="nav-group" key={group.label}>
                            <p class="nav-label">{group.label}</p>
                            {items.map(n => (
                                <a key={n.path} href={`#${n.path}`} class={`nav-item${active === n.path ? ' on' : ''}`} aria-current={active === n.path ? 'page' : undefined} {...tip(n.label)}>
                                    <Icon name={n.icon} />
                                    <span class="nav-text">{n.label}</span>
                                </a>
                            ))}
                        </div>
                    ) : null;
                })}
            </div>
            <div class="sidebar-foot">
                {me.testMode ? <TestModePill /> : null}
                <UserMenu me={me} rail={rail} />
            </div>
        </nav>
    );
}

function App() {
    const [menuOpen, setMenuOpen] = useState(false);
    const main = useRef<HTMLElement>(null);
    const menuButton = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        api<Me>('/me')
            .then(me => (session.value = me))
            .catch(() => (session.value = null));
        const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 800));
        idle(() => loadEditor().catch(() => {}));
    }, []);

    const [, first, second] = route.value.split('/');
    const me = session.value;
    useNotificationsPoll(!!me);

    // A new screen starts at the top, with the phone menu closed.
    useEffect(() => {
        setMenuOpen(false);
        main.current?.scrollTo(0, 0);
        window.scrollTo(0, 0);
    }, [route.value]);

    useEffect(() => {
        if (!me) return;
        document.title = `${first === 'posts' || !first ? 'Posts' : (TITLES[first] ?? 'Admin')} · ${me.site.title}`;
    }, [first, me?.site.title]);

    // The site's icon in the browser tab, so the admin tab is easy to find.
    useEffect(() => {
        if (!me?.site.icon) return;
        let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
        if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            document.head.append(link);
        }
        link.href = me.site.icon;
    }, [me?.site.icon]);

    // The phone menu: Escape closes it and the page behind stays put.
    useEffect(() => {
        document.documentElement.classList.toggle('menu-open', menuOpen);
        if (!menuOpen) return;
        document.querySelector<HTMLElement>('#sidebar .nav-item')?.focus({ preventScroll: true });
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            setMenuOpen(false);
            menuButton.current?.focus();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [menuOpen]);

    // Sign-in links land on #/verify/<token>, signed in or not.
    if (first === 'verify' && second)
        return (
            <>
                <Verify token={decodeURIComponent(second.split('?')[0])} />
                <Toasts />
            </>
        );
    if (me === undefined)
        return (
            <div class="boot">
                <span class="spinner" aria-label="Loading" />
            </div>
        );
    if (me === null)
        return (
            <>
                <Login />
                <Toasts />
            </>
        );

    // While writing, the sidebar folds to icons to give the page the room.
    const editing = first === 'edit';
    return (
        <div class={`shell${editing ? ' editing' : ''}${menuOpen ? ' menu-open' : ''}`}>
            <header class="topbar">
                <a class="brand" href={base} target="_blank" rel="noreferrer" aria-label={`${me.site.title}, view the site`}>
                    <SiteMark me={me} />
                    <span class="brand-name">{me.site.title}</span>
                </a>
                <span class="topbar-space" />
                {me.testMode ? (
                    <span class="pill amber dot" title="Test mode: email reaches only the team. Newsletters go only to team members; subscribers get nothing.">
                        Test mode
                    </span>
                ) : null}
                <NotificationsButton phone />
                <button ref={menuButton} type="button" class="icon-btn menu-btn" aria-label={menuOpen ? 'Close menu' : 'Menu'} aria-expanded={menuOpen} aria-controls="sidebar" onClick={() => setMenuOpen(!menuOpen)}>
                    <Icon name={menuOpen ? 'x' : 'menu'} size={18} />
                </button>
            </header>
            <Sidebar me={me} head={first ?? ''} rail={editing} />
            <div class="scrim" onClick={() => setMenuOpen(false)} />
            <main class="main" ref={main}>
                <div class="page-wrap">
                    <Page />
                </div>
            </main>
            <Toasts />
        </div>
    );
}

render(<App />, document.getElementById('app')!);

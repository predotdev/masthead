import { useEffect, useState } from 'preact/hooks';
import { api, session, type Me } from '../api';
import { Button, Field, errorToast } from '../ui';

interface Brand {
    title: string;
    logo: string | null;
    invertLogoInLight: boolean;
}

function useBrand() {
    const [brand, setBrand] = useState<Brand | null>(null);
    useEffect(() => {
        api<Brand>('/auth/brand')
            .then(setBrand)
            .catch(() => setBrand(null));
    }, []);
    return brand;
}

function BrandMark({ brand }: { brand: Brand | null }) {
    if (!brand) return <div class="login-brand" />;
    return (
        <div class="login-brand">
            {brand.logo ? <img class={brand.invertLogoInLight ? 'invert-light' : ''} src={brand.logo} alt="" height={26} /> : null}
            <span>{brand.title}</span>
        </div>
    );
}

/** Reads ?email= and ?expired from the hash, e.g. #/login?expired=1&email=a%40b.com */
function hashParams(): URLSearchParams {
    const q = location.hash.indexOf('?');
    return new URLSearchParams(q >= 0 ? location.hash.slice(q + 1) : '');
}

export function Login() {
    const brand = useBrand();
    const params = hashParams();
    const [email, setEmail] = useState(params.get('email') ?? '');
    const [sent, setSent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [useToken, setUseToken] = useState(false);
    const [token, setToken] = useState('');
    const notice = params.has('expired') ? 'That sign-in link was already used or has expired. Here is a fresh one, one click away.' : null;

    const sendLink = async (e: Event) => {
        e.preventDefault();
        setBusy(true);
        try {
            await api('/auth/login', { body: { email } });
            setSent(true);
        } catch (err) {
            errorToast(err);
        } finally {
            setBusy(false);
        }
    };

    const signInWithToken = async (e: Event) => {
        e.preventDefault();
        setBusy(true);
        try {
            await api('/auth/bootstrap', { body: { token } });
            session.value = await api<Me>('/me');
            location.hash = '#/posts';
        } catch (err) {
            errorToast(err);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div class="login">
            <div class="login-card">
                <BrandMark brand={brand} />
                <h1>Sign in</h1>
                {sent ? (
                    <div class="stack">
                        <p class="muted">
                            If <strong>{email}</strong> is on the team, a sign-in link is on its way. It works once, for an hour.
                        </p>
                        <p class="muted small">Nothing after a minute? Check spam, or make sure this is the address you were invited with.</p>
                        <Button onClick={() => setSent(false)}>Use a different address</Button>
                    </div>
                ) : useToken ? (
                    <form onSubmit={signInWithToken} class="stack">
                        <Field label="Owner token" hint="The BOOTSTRAP_TOKEN secret set when the server was deployed.">
                            <input type="password" required value={token} onInput={e => setToken(e.currentTarget.value)} autoComplete="off" />
                        </Field>
                        <Button tone="primary" type="submit" busy={busy}>
                            Sign in
                        </Button>
                    </form>
                ) : (
                    <form onSubmit={sendLink} class="stack">
                        {notice ? <p class="note warn">{notice}</p> : null}
                        <Field label="Email">
                            <input type="email" required value={email} onInput={e => setEmail(e.currentTarget.value)} autoComplete="email" placeholder="you@company.com" autoFocus />
                        </Field>
                        <Button tone="primary" type="submit" busy={busy}>
                            Email me a sign-in link
                        </Button>
                    </form>
                )}
                <button class="link-btn" onClick={() => (setUseToken(!useToken), setSent(false))}>
                    {useToken ? 'Use an email link instead' : 'Use the owner token'}
                </button>
            </div>
        </div>
    );
}

/** Where sign-in links land. The link is only used up when the person clicks Continue. */
export function Verify({ token }: { token: string }) {
    const brand = useBrand();
    const [link, setLink] = useState<{ state: string; email?: string; name?: string } | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        api<{ state: string; email?: string; name?: string }>(`/auth/link?token=${encodeURIComponent(token)}`)
            .then(setLink)
            .catch(() => setLink({ state: 'unknown' }));
    }, [token]);

    const go = async () => {
        setBusy(true);
        try {
            await api('/auth/verify', { body: { token } });
            session.value = await api<Me>('/me');
            location.hash = '#/posts';
        } catch (err) {
            errorToast(err);
            setBusy(false);
            setLink({ ...link, state: 'used' });
        }
    };

    if (link && link.state !== 'valid') {
        location.replace(`#/login?expired=1${link.email ? `&email=${encodeURIComponent(link.email)}` : ''}`);
        return null;
    }
    return (
        <div class="login">
            <div class="login-card">
                <BrandMark brand={brand} />
                <h1>{link?.name ? `Continue as ${link.name}` : 'Sign in'}</h1>
                {link?.email ? <p class="muted">{link.email}</p> : null}
                <Button tone="primary" busy={busy || !link} onClick={go}>
                    Continue to the admin
                </Button>
            </div>
        </div>
    );
}

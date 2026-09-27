import { useState } from 'preact/hooks';
import { api, session, type Me } from '../api';
import { Button, Field, errorToast } from '../ui';

export function Login() {
    const [email, setEmail] = useState('');
    const [sent, setSent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [useToken, setUseToken] = useState(false);
    const [token, setToken] = useState('');

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
                <h1>Sign in</h1>
                {sent ? (
                    <p class="muted">If {email} belongs to someone on the team, a sign-in link is on its way. It works once and expires in 20 minutes.</p>
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
                        <Field label="Email">
                            <input type="email" required value={email} onInput={e => setEmail(e.currentTarget.value)} autoComplete="email" placeholder="you@company.com" />
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

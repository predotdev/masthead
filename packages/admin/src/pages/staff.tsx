import { useState } from 'preact/hooks';
import { api, fmtDate, session, type Staff } from '../api';
import { Button, Dialog, ErrorNote, Field, PageHead, Pill, TableSkeleton, errorToast, toast, useLoad } from '../ui';
import { SeoFields, type SeoValue } from './seo-fields';

const ROLES = ['admin', 'editor', 'author', 'contributor'] as const;
const ROLE_HINT: Record<string, string> = {
    owner: 'Everything, including billing and removing admins',
    admin: 'Everything: content, members, newsletters, settings',
    editor: 'All posts, tags and newsletters',
    author: 'Writes and publishes their own posts',
    contributor: 'Writes drafts for review'
};

export function StaffPage() {
    const { data, error, loading, reload } = useLoad(() => api<Staff[]>('/staff'), []);
    const [inviting, setInviting] = useState(false);
    const [profile, setProfile] = useState<Staff | null>(null);
    const canManage = session.value?.user.role === 'owner' || session.value?.user.role === 'admin';

    const setRole = async (s: Staff, role: string) => {
        try {
            await api(`/staff/${s.id}`, { method: 'PUT', body: { role } });
            toast(`${s.name} is now ${role === 'admin' ? 'an' : 'a'} ${role}`);
            reload();
        } catch (err) {
            errorToast(err);
        }
    };

    return (
        <div>
            <PageHead title="Staff" description="Who can sign in, and what each role can do.">
                {canManage ? (
                    <Button tone="primary" icon="userPlus" onClick={() => setInviting(true)}>
                        Invite
                    </Button>
                ) : null}
            </PageHead>
            {error ? <ErrorNote text={error} /> : null}
            {loading && !data ? (
                <TableSkeleton rows={4} columns={5} />
            ) : (
                <div class="table-wrap">
                    <table class="table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Role</th>
                                <th>Status</th>
                                <th>Last signed in</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {data?.map(s => (
                                <tr key={s.id}>
                                    <td>
                                        <span class="title-cell">{s.name}</span>
                                        <span class="muted small"> · {s.email}</span>
                                    </td>
                                    <td>
                                        {canManage && s.role !== 'owner' ? (
                                            <select value={s.role} onChange={e => setRole(s, e.currentTarget.value)} title={ROLE_HINT[s.role]}>
                                                {ROLES.map(r => (
                                                    <option key={r} value={r}>
                                                        {r}
                                                    </option>
                                                ))}
                                            </select>
                                        ) : (
                                            <span title={ROLE_HINT[s.role]}>{s.role}</span>
                                        )}
                                    </td>
                                    <td>
                                        <Pill tone={s.status === 'active' ? 'green' : s.status === 'invited' ? 'amber' : 'neutral'}>{s.status}</Pill>
                                    </td>
                                    <td class="muted">{s.lastSeenAt ? fmtDate(s.lastSeenAt) : 'Never'}</td>
                                    <td class="num">
                                        {canManage || s.id === session.value?.user.staffId ? (
                                            <Button tone="plain" onClick={() => setProfile(s)}>
                                                Author page
                                            </Button>
                                        ) : null}
                                        {canManage && s.role !== 'owner' ? (
                                            <Button
                                                tone="plain"
                                                onClick={async () => {
                                                    if (!window.confirm(`Remove ${s.name}? Their posts stay.`)) return;
                                                    await api(`/staff/${s.id}`, { method: 'DELETE' }).catch(errorToast);
                                                    reload();
                                                }}
                                            >
                                                Remove
                                            </Button>
                                        ) : null}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {inviting ? <Invite onClose={() => (setInviting(false), reload())} /> : null}
            {profile ? <AuthorPage staff={profile} onClose={() => (setProfile(null), reload())} /> : null}
        </div>
    );
}

function Invite({ onClose }: { onClose: () => void }) {
    const [email, setEmail] = useState('');
    const [name, setName] = useState('');
    const [role, setRole] = useState('author');
    const [busy, setBusy] = useState(false);
    return (
        <Dialog title="Invite someone" onClose={onClose}>
            <form
                class="stack"
                onSubmit={async e => {
                    e.preventDefault();
                    setBusy(true);
                    try {
                        const r = await api<{ invited: boolean }>('/staff', { body: { email, name, role } });
                        toast(r.invited ? `Invite sent to ${email}` : 'Added. The invite email could not be sent; they can request a sign-in link.');
                        onClose();
                    } catch (err) {
                        errorToast(err);
                        setBusy(false);
                    }
                }}
            >
                <Field label="Email">
                    <input type="email" required value={email} onInput={e => setEmail(e.currentTarget.value)} />
                </Field>
                <Field label="Name">
                    <input value={name} onInput={e => setName(e.currentTarget.value)} />
                </Field>
                <Field label="Role" hint={ROLE_HINT[role]}>
                    <select value={role} onChange={e => setRole(e.currentTarget.value)}>
                        {ROLES.map(r => (
                            <option key={r} value={r}>
                                {r}
                            </option>
                        ))}
                    </select>
                </Field>
                <div class="dialog-actions">
                    <Button onClick={onClose}>Cancel</Button>
                    <Button tone="primary" type="submit" busy={busy}>
                        Send invite
                    </Button>
                </div>
            </form>
        </Dialog>
    );
}

/** The public page for one author: their bio and how it shows in search and when shared. */
function AuthorPage({ staff, onClose }: { staff: Staff; onClose: () => void }) {
    const [bio, setBio] = useState(staff.bio ?? '');
    const [seo, setSeo] = useState<SeoValue>({ metaTitle: staff.metaTitle, metaDescription: staff.metaDescription, ogImage: staff.ogImage, noindex: staff.noindex });
    const [busy, setBusy] = useState(false);
    return (
        <Dialog title={`${staff.name}'s author page`} description="Shown at the author's address on the site." onClose={onClose} wide>
            <form
                class="stack"
                onSubmit={async e => {
                    e.preventDefault();
                    setBusy(true);
                    try {
                        await api(`/staff/${staff.id}`, {
                            method: 'PUT',
                            body: { bio: bio.trim() || null, metaTitle: seo.metaTitle ?? null, metaDescription: seo.metaDescription ?? null, ogImage: seo.ogImage ?? null, noindex: Boolean(seo.noindex) }
                        });
                        toast('Saved. The author page is updating.');
                        onClose();
                    } catch (err) {
                        errorToast(err);
                        setBusy(false);
                    }
                }}
            >
                <Field label="Bio" hint="Shown on the page and used as its description in search.">
                    <textarea rows={3} value={bio} onInput={e => setBio(e.currentTarget.value)} />
                </Field>
                <SeoFields
                    kind="author"
                    id={staff.id}
                    name={staff.name}
                    address={`${session.value?.site.url ?? ''}author/${staff.slug}/`}
                    description={bio}
                    value={seo}
                    onChange={patch => setSeo(cur => ({ ...cur, ...patch }))}
                />
                <div class="dialog-actions">
                    <div class="grow" />
                    <Button onClick={onClose}>Cancel</Button>
                    <Button tone="primary" type="submit" busy={busy}>
                        Save
                    </Button>
                </div>
            </form>
        </Dialog>
    );
}

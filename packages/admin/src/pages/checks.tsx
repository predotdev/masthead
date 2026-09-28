import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { session } from '../api';
import { applyFixes, bodyIssues, checkedEditor, ignoredKeys, missingLink, openIssue, revealIssue, type BodyIssue } from '../editor/style-check';
import { applyEdits, checkText, type Finding, type Fix, type PreviewPart, type RuleId } from '../editor/style-rules';
import { styleRules } from '../house-style';
import { Icon } from '../icons';
import { Button, Segmented, Skeleton, toast } from '../ui';
import { LinksPanel } from './links';

type Range = { from: number; to: number };
/** Asks the AI to rewrite a range of the post (the editor's AI card does the rest). */
export type Rewrite = (range: Range, instruction: string) => void;

/** Which tab of the panel is showing; a fix can send you to Links. */
export const checksTab = signal<'style' | 'links'>('style');

// ------------------------------------------------------------------ ignoring

const ignoreScope = signal<string | null>(null);
const ignoreStore = (postId: string) => `masthead-style-ignored:${postId}`;

/** Loads what was ignored in this post, in this browser. */
function useIgnored(postId: string) {
    useEffect(() => {
        ignoreScope.value = postId;
        try {
            ignoredKeys.value = new Set(JSON.parse(localStorage.getItem(ignoreStore(postId)) ?? '[]') as string[]);
        } catch {
            ignoredKeys.value = new Set();
        }
        return () => {
            ignoreScope.value = null;
            ignoredKeys.value = new Set();
        };
    }, [postId]);
}

function saveIgnored(next: Set<string>) {
    ignoredKeys.value = next;
    const scope = ignoreScope.peek();
    try {
        if (scope) next.size ? localStorage.setItem(ignoreStore(scope), JSON.stringify([...next].slice(-300))) : localStorage.removeItem(ignoreStore(scope));
    } catch {
        // Private windows can refuse storage; it holds until the page reloads.
    }
}

const ignore = (f: Finding) => saveIgnored(new Set([...ignoredKeys.value, f.key]));

// ------------------------------------------------------------------ counting

function useTitleFindings(title: string): Finding[] {
    const rules = styleRules.value;
    const ignored = ignoredKeys.value;
    return useMemo(() => (rules ? checkText(title, rules).filter(f => !ignored.has(f.key)) : []), [title, rules, ignored]);
}

const NOUNS: Record<RuleId, [string, string]> = {
    dash: ['em dash', 'em dashes'],
    spelling: ['spelling', 'spellings'],
    phrase: ['phrase to avoid', 'phrases to avoid'],
    name: ['name never to mention', 'names never to mention']
};

/** "2 em dashes, 1 spelling and no link to another post". */
function summary(findings: Finding[], link: boolean): string {
    const parts = (Object.keys(NOUNS) as RuleId[]).flatMap(rule => {
        const n = findings.filter(f => f.rule === rule).length;
        return n ? [`${n} ${NOUNS[rule][n === 1 ? 0 : 1]}`] : [];
    });
    if (link) parts.push('no link to another post');
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '');
}

function useIssues(title: string) {
    const inTitle = useTitleFindings(title);
    const inBody = bodyIssues.value;
    const link = missingLink.value;
    return { inTitle, inBody, link, total: inTitle.length + inBody.length + (link ? 1 : 0) };
}

// ------------------------------------------------------------------ the editor bar

/** The count of house-style issues in the post, as a small status control in the editor bar; opens the panel. */
export function StyleButton({ postId, title, open, onClick }: { postId: string; title: string; open: boolean; onClick: () => void }) {
    useIgnored(postId);
    const { total } = useIssues(title);
    const ready = !!styleRules.value;
    const label = ready ? (total ? `Style checks: ${total} to fix` : 'Style checks: nothing to fix') : 'Style checks';
    return (
        <Button
            class={`style-btn${ready ? (total ? ' has-issues' : ' clean') : ''}`}
            icon="spellCheck"
            aria-pressed={open}
            aria-label={label}
            data-tooltip={open ? undefined : label}
            // The count opens on the list it counts, whichever tab was last open.
            onClick={() => (open || (checksTab.value = 'style'), onClick())}
        >
            {ready && total ? <span class="style-count">{total}</span> : null}
        </Button>
    );
}

// ------------------------------------------------------------------ the panel

export function ChecksPanel({ postId, title, onTitle, onRewrite }: { postId: string; title: string; onTitle: (title: string) => void; onRewrite: Rewrite }) {
    const { total } = useIssues(title);
    const tab = checksTab.value;
    return (
        <aside class="settings-panel checks-panel" aria-label="Style and links">
            <div class="checks-top">
                <Segmented
                    label="Checks"
                    value={tab}
                    options={[
                        { value: 'style', label: 'Style', count: styleRules.value && total ? total : null },
                        { value: 'links', label: 'Links' }
                    ]}
                    onChange={v => (checksTab.value = v)}
                />
            </div>
            {tab === 'style' ? <StyleList title={title} onTitle={onTitle} onRewrite={onRewrite} /> : <LinksPanel postId={postId} />}
        </aside>
    );
}

type Item = { where: 'title'; finding: Finding } | { where: 'body'; finding: BodyIssue };

function StyleList({ title, onTitle, onRewrite }: { title: string; onTitle: (title: string) => void; onRewrite: Rewrite }) {
    const ed = checkedEditor.value;
    const { inTitle, inBody, link, total } = useIssues(title);
    const admin = session.value?.user.role === 'owner' || session.value?.user.role === 'admin';
    if (!styleRules.value)
        return (
            <div class="checks-body" aria-busy="true">
                <Skeleton width="60%" height={12} />
                <Skeleton width="90%" />
                <Skeleton width="80%" />
            </div>
        );
    const items: Item[] = [...inTitle.map(finding => ({ where: 'title' as const, finding })), ...inBody.map(finding => ({ where: 'body' as const, finding }))];
    const safe = items.filter(i => i.finding.fixes.some(f => f.safe));

    const fix = (item: Item, fix: Fix) => {
        if (fix.rewrite) {
            if (item.where === 'body') onRewrite({ from: item.finding.base + fix.rewrite.from, to: item.finding.base + fix.rewrite.to }, fix.rewrite.instruction);
            return;
        }
        if (item.where === 'title') onTitle(applyEdits(title, fix.edits));
        else if (ed) applyFixes(ed, [{ issue: item.finding, fix }]);
    };

    const fixAll = () => {
        const titleEdits = inTitle.flatMap(f => f.fixes.find(x => x.safe)?.edits ?? []);
        if (titleEdits.length) onTitle(applyEdits(title, titleEdits));
        if (ed) applyFixes(ed, inBody.flatMap(issue => issue.fixes.filter(x => x.safe).slice(0, 1).map(fix => ({ issue, fix }))));
        toast(`Fixed ${safe.length} ${safe.length === 1 ? 'issue' : 'issues'}`);
    };

    const reveal = (item: Item) => {
        if (item.where === 'body') return ed && revealIssue(ed, item.finding);
        const input = document.querySelector<HTMLTextAreaElement>('.title-input');
        input?.focus();
        input?.setSelectionRange(item.finding.from, item.finding.to);
    };

    return (
        <div class="checks-body">
            <div class="checks-summary">
                <div class="checks-summary-head">
                    <p class="checks-total">{total ? `${total} to fix` : 'Nothing to fix'}</p>
                    {safe.length ? (
                        <Button size="sm" tone="primary" icon="check" onClick={fixAll} title="Em dashes, spellings and phrases with a set replacement. Phrases that need rewording stay for you.">
                            Fix all {safe.length}
                        </Button>
                    ) : null}
                </div>
                <p class="muted small">{total ? `${summary([...inTitle, ...inBody], link)}.` : 'The post follows the house style.'}</p>
            </div>
            {!ed ? <p class="note">Go back to the editor from the HTML source to check the post itself.</p> : null}
            {total ? (
                <ul class="issue-list">
                    {items.map(item => (
                        <IssueRow key={item.where === 'body' ? item.finding.id : `title:${item.finding.from}`} item={item} onReveal={() => reveal(item)} onFix={f => fix(item, f)} onIgnore={() => ignore(item.finding)} />
                    ))}
                    {link ? (
                        <li class="issue issue-links">
                            <div class="issue-top">
                                <div class="issue-main">
                                    <span class="issue-head">
                                        <span class="issue-dot" aria-hidden="true" />
                                        <span class="issue-title">No link to another post</span>
                                    </span>
                                    <span class="issue-context">Readers and search engines follow links between posts. The Links tab finds posts on the same subject.</span>
                                </div>
                            </div>
                            <div class="issue-fixes">
                                <button type="button" class="fix-chip best" onClick={() => (checksTab.value = 'links')}>
                                    <Icon name="link" size={12} />
                                    Suggest links
                                </button>
                            </div>
                        </li>
                    ) : null}
                </ul>
            ) : (
                <div class="checks-clear">
                    <span class="checks-clear-icon" aria-hidden="true">
                        <Icon name="check" size={18} />
                    </span>
                    <p>No em dashes, stray spellings or phrases to avoid.</p>
                </div>
            )}
            <p class="checks-foot">
                {ignoredKeys.value.size ? (
                    <button type="button" class="link-btn" onClick={() => saveIgnored(new Set())}>
                        Check the {ignoredKeys.value.size} ignored again
                    </button>
                ) : null}
                {admin ? (
                    <a class="link-btn" href="#/settings/style">
                        Edit the checks
                    </a>
                ) : (
                    <span>Admins set the checks in Settings.</span>
                )}
            </p>
        </div>
    );
}

function IssueRow({ item, onReveal, onFix, onIgnore }: { item: Item; onReveal: () => void; onFix: (fix: Fix) => void; onIgnore: () => void }) {
    const f = item.finding;
    // The AI card rewrites text in the body; the title has its own suggestions in Settings, Search.
    const fixes = item.where === 'title' ? f.fixes.filter(x => !x.rewrite) : f.fixes;
    return (
        <li class={`issue issue-${f.rule}`}>
            <div class="issue-top">
                <button type="button" class="issue-main" onClick={onReveal} title={item.where === 'title' ? 'Go to the title' : 'Show it in the post'}>
                    <span class="issue-head">
                        <span class="issue-dot" aria-hidden="true" />
                        <span class="issue-title">{f.title}</span>
                        {item.where === 'title' ? <span class="issue-where">Title</span> : null}
                    </span>
                    <span class="issue-context">
                        {f.context.before}
                        <mark>{f.text}</mark>
                        {f.context.after}
                    </span>
                </button>
                <button type="button" class="issue-ignore" onClick={onIgnore} title="Leave it as written in this post">
                    Ignore
                </button>
            </div>
            <div class="issue-fixes">
                {fixes.map((x, i) => (
                    <button type="button" key={x.label} class={`fix-chip${i === 0 ? ' best' : ''}`} title={x.preview ? x.preview.map(p => (p.del ? '' : p.text)).join('') : undefined} onClick={() => onFix(x)}>
                        {x.rewrite ? <Icon name="sparkles" size={12} /> : null}
                        {x.label}
                    </button>
                ))}
            </div>
        </li>
    );
}

/** A fix as it would read: what goes struck through, what comes highlighted. */
function Preview({ parts }: { parts: PreviewPart[] }) {
    return (
        <>
            {parts.map((p, i) =>
                p.del ? (
                    <del key={i}>{p.text}</del>
                ) : p.ins ? (
                    <ins key={i}>{p.text}</ins>
                ) : (
                    <span key={i}>{p.text}</span>
                )
            )}
        </>
    );
}

// ------------------------------------------------------------------ the fix menu

/** Opens under an underlined issue when it is clicked: what is wrong, and the fixes as they would read. */
export function StyleFixMenu({ onRewrite }: { onRewrite: Rewrite }) {
    const ed = checkedEditor.value;
    const id = openIssue.value;
    const issue = id ? bodyIssues.value.find(i => i.id === id) : undefined;
    const box = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!ed || !issue) return;
        const close = () => (openIssue.value = null);
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
        const onDown = (e: MouseEvent) => {
            const t = e.target as HTMLElement;
            if (!box.current?.contains(t) && !t.closest?.('.style-issue')) close();
        };
        // Typing, or moving the cursor off the issue, puts the menu away.
        const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
            const at = ed.state.selection.from;
            if (transaction.docChanged || at < issue.base + issue.from || at > issue.base + issue.to) close();
        };
        window.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onDown);
        ed.on('transaction', onTransaction);
        return () => {
            window.removeEventListener('keydown', onKey);
            document.removeEventListener('mousedown', onDown);
            ed.off('transaction', onTransaction);
        };
    }, [ed, issue?.id]);

    if (!ed || !issue) return null;
    const host = ed.view.dom.parentElement!.getBoundingClientRect();
    const at = ed.view.coordsAtPos(issue.base + issue.from);
    const width = Math.min(320, host.width);
    const left = Math.max(0, Math.min(at.left - host.left - 12, host.width - width));

    const run = (fix: Fix) => {
        openIssue.value = null;
        if (fix.rewrite) return onRewrite({ from: issue.base + fix.rewrite.from, to: issue.base + fix.rewrite.to }, fix.rewrite.instruction);
        applyFixes(ed, [{ issue, fix }]);
        ed.commands.focus();
    };

    return (
        <div ref={box} class={`style-menu issue-${issue.rule}`} style={{ top: at.bottom - host.top + 8, left, width }} role="dialog" aria-label={issue.title} onMouseDown={e => e.preventDefault()}>
            <div class="style-menu-head">
                <span class="issue-dot" aria-hidden="true" />
                <strong>{issue.title}</strong>
                <button type="button" class="icon-btn" aria-label="Close" onClick={() => (openIssue.value = null)}>
                    <Icon name="x" size={14} />
                </button>
            </div>
            <p class="style-menu-message">{issue.message}</p>
            <div class="style-menu-fixes">
                {issue.fixes.map((fix, i) => (
                    <button type="button" key={fix.label} class={`style-fix${i === 0 ? ' best' : ''}`} onClick={() => run(fix)}>
                        <span class="style-fix-label">
                            {fix.rewrite ? <Icon name="sparkles" size={13} /> : null}
                            {fix.label}
                        </span>
                        <span class="style-fix-preview">{fix.preview ? <Preview parts={fix.preview} /> : 'Opens a rewrite of the sentence to accept or discard'}</span>
                    </button>
                ))}
            </div>
            <div class="style-menu-foot">
                <button type="button" class="link-btn" onClick={() => (ignore(issue), (openIssue.value = null))}>
                    Ignore here
                </button>
                <span class="style-menu-keys">
                    <kbd>Esc</kbd> to close
                </span>
            </div>
        </div>
    );
}

// ------------------------------------------------------------------ the title

/** The title with its issues underlined: a copy of its text sits under the (transparent) field and draws the lines. */
export function TitleChecks({ title, children }: { title: string; children: ComponentChildren }) {
    const findings = useTitleFindings(title);
    const parts: ComponentChildren[] = [];
    let at = 0;
    findings.forEach((f, i) => {
        parts.push(title.slice(at, f.from), (
            <mark key={i} class={`style-issue style-${f.rule}`}>
                {title.slice(f.from, f.to)}
            </mark>
        ));
        at = f.to;
    });
    parts.push(title.slice(at));
    return (
        <div class="title-wrap">
            {findings.length ? (
                <div class="title-mirror" aria-hidden="true">
                    {parts}
                </div>
            ) : null}
            {children}
        </div>
    );
}

// ------------------------------------------------------------------ publishing

/** Open issues, named in the publish dialog. They never stop a post going out. */
export function PublishStyleNote({ title, onReview }: { title: string; onReview: () => void }) {
    const { inTitle, inBody, link, total } = useIssues(title);
    if (!styleRules.value || !total) return null;
    return (
        <div class="note warn style-publish-note">
            {total === 1 ? 'One house-style issue' : `${total} house-style issues`}: {summary([...inTitle, ...inBody], link)}. You can publish anyway.{' '}
            <button type="button" class="link-btn" onClick={() => ((checksTab.value = 'style'), onReview())}>
                Review
            </button>
        </div>
    );
}

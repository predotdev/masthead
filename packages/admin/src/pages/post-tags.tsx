import { useEffect, useRef } from 'preact/hooks';
import { api, type Post, type Tag } from '../api';

/** A post as the server returns it, with the tags it picked by itself. */
export type TaggedPost = Post & { autoTags?: string[] | null; autoTagging?: boolean };

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Keeps the editor's tags in step with tags the server picks after a save.
 * Saves carry tags only when the writer changed them, so a save never clears
 * tags that arrived in the meantime, and picked tags join the draft unless
 * the writer has chosen tags of their own.
 */
export function useServerTags<D extends { tags: string[] }>(initial: Post, setDraft: (fn: (d: D) => D) => void, setPost: (fn: (p: Post) => Post) => void) {
    const server = useRef(initial.tags);
    const alive = useRef(true);
    useEffect(
        () => () => {
            alive.current = false;
        },
        []
    );

    const learn = (p: TaggedPost) => {
        const before = server.current;
        server.current = p.tags;
        if (!same(before, p.tags)) setDraft(d => (same(d.tags, before) ? { ...d, tags: p.tags } : d));
    };

    // Tags are picked after the response: look again a few times until they land.
    const watch = (p: TaggedPost, tries = 0) => {
        if (!p.autoTagging || tries >= 4) return;
        setTimeout(async () => {
            if (!alive.current) return;
            const fresh = await api<TaggedPost>(`/posts/${p.id}`).catch(() => null);
            if (!alive.current || !fresh) return;
            if (same(fresh.tags, p.tags)) return watch(p, tries + 1);
            setPost(prev => ({ ...prev, tags: fresh.tags, autoTags: fresh.autoTags }) as TaggedPost);
            learn(fresh);
        }, [2500, 4000, 6000, 10000][tries]);
    };

    return {
        /** The draft as a save sends it: without tags when the writer hasn't changed them. */
        outgoing: (draft: D) => {
            if (!same(draft.tags, server.current)) return draft;
            const { tags: _tags, ...rest } = draft;
            return rest;
        },
        /** Call with every post the server returns. */
        saved: (p: TaggedPost) => (learn(p), watch(p))
    };
}

/** Says which of the post's tags were picked for it, until the writer changes them. */
export function AutoTagNote({ post, ids, tags }: { post: TaggedPost; ids: string[]; tags: Tag[] }) {
    const names = (post.autoTags ?? []).filter(id => ids.includes(id)).map(id => tags.find(t => t.id === id)?.name).filter(Boolean);
    return names.length ? <span class="field-hint">Picked automatically: {names.join(', ')}. Remove any that don't fit.</span> : null;
}

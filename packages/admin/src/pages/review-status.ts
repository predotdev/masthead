/** Review states as the admin names and colors them, shared by the editor, the posts list and the calendar. */
import type { Me } from '../api';

export type ReviewStatus = 'in_review' | 'approved' | 'changes_requested';

export const REVIEW_LABEL: Record<ReviewStatus, string> = { in_review: 'In review', approved: 'Approved', changes_requested: 'Changes requested' };
export const REVIEW_TONE: Record<ReviewStatus, 'blue' | 'green' | 'red'> = { in_review: 'blue', approved: 'green', changes_requested: 'red' };

/** Someone on the team who can open a post: a possible reviewer, or someone to mention. */
export interface Person {
    id: string;
    name: string;
    role: Me['user']['role'];
    profileImage: string | null;
}

export const ROLE_NAME: Record<Person['role'], string> = { owner: 'Owner', admin: 'Admin', editor: 'Editor', author: 'Author', contributor: 'Contributor' };

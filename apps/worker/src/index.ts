/**
 * Deployable Masthead Worker: the default theme, pre.dev AI for the studio,
 * and Resend for email. Swap any of them by editing this file.
 */
import { predevAI } from '@masthead/ai-predev';
import { resend } from '@masthead/email-resend';
import { createApp } from '@masthead/server';
import { defaultTheme } from '@masthead/theme-default';

export default createApp({
    theme: defaultTheme,
    ai: env => (env.PREDEV_API_KEY ? predevAI({ apiKey: env.PREDEV_API_KEY }) : null),
    email: env => (env.RESEND_API_KEY ? resend({ apiKey: env.RESEND_API_KEY, webhookSecret: env.RESEND_WEBHOOK_SECRET }) : null)
});

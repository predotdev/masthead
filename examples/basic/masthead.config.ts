import { predevAI } from '@masthead/ai-predev';
import { defineConfig } from '@masthead/core';
import { snapshotFile } from '@masthead/core/node';
import { defaultTheme } from '@masthead/theme-default';
import { webFs } from '@masthead/web-fs';

// Secrets come from the environment (see .env.example), never from this file.
export default defineConfig({
    site: { url: 'https://example.com/blog/' },
    content: snapshotFile('snapshot.json'),
    output: webFs('dist'),
    theme: defaultTheme,
    ai: predevAI({
        textModel: process.env.MASTHEAD_TEXT_MODEL,
        imageModel: process.env.MASTHEAD_IMAGE_MODEL
    })
});

	// @ts-check

import mdx from '@astrojs/mdx';
import { unified } from '@astrojs/markdown-remark';
import sitemap from '@astrojs/sitemap';
import remarkDirective from 'remark-directive';
import svgbob from 'remark-svgbob';
import { defineConfig, fontProviders } from 'astro/config';
import { remarkAdmonitions } from './src/utils/remark-admonitions.js';

// https://astro.build/config
export default defineConfig({
	site: 'https://blog.atimin.dev',
	integrations: [mdx(), sitemap()],
	markdown: {
		processor: unified({
			remarkPlugins: [remarkDirective, remarkAdmonitions, svgbob],
		}),
	},
	fonts: [
		{
			provider: fontProviders.local(),
			name: 'Atkinson',
			cssVariable: '--font-atkinson',
			fallbacks: ['sans-serif'],
			options: {
				variants: [
					{
						src: ['./src/assets/fonts/atkinson-regular.woff'],
						weight: 400,
						style: 'normal',
						display: 'swap',
					},
					{
						src: ['./src/assets/fonts/atkinson-bold.woff'],
						weight: 700,
						style: 'normal',
						display: 'swap',
					},
				],
			},
		},
	],
});

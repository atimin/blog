import { getCollection } from 'astro:content';
import rss from '@astrojs/rss';
import { marked } from 'marked';
import { SITE_DESCRIPTION, SITE_TITLE } from '../consts';
import { replaceSvgbobBlocksWithLinkedImages } from '../utils/rss-diagrams.js';

export async function GET(context) {
	const posts = await getCollection('blog');
	const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
	return rss({
		title: SITE_TITLE,
		description: SITE_DESCRIPTION,
		site: new URL(base, context.site),
		items: posts.map((post) => {
			const postUrl = new URL(`${base}${post.id}/`, context.site).toString();
			const diagramBaseUrl = new URL(`${base}rss-diagrams/${post.id}/`, context.site).toString();

			return {
				...post.data,
				link: `${base}${post.id}/`,
				content: marked(
					replaceSvgbobBlocksWithLinkedImages(post.body, {
						imageBaseUrl: diagramBaseUrl,
						postUrl,
						title: post.data.title,
					}),
				),
			};
		}),
	});
}

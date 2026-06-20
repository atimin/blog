import { getCollection } from 'astro:content';
import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import svgbob from 'remark-svgbob';
import { unified } from 'unified';
import { getSvgbobDiagrams } from '../../utils/rss-diagrams.js';

export async function getStaticPaths() {
	const posts = (await getCollection('blog')).filter((post) => !post.data.draft);

	return posts.flatMap((post) =>
		getSvgbobDiagrams(post.body).map((diagram, index) => ({
			params: { diagram: `${post.id}/${index + 1}` },
			props: { diagram },
		})),
	);
}

export async function GET({ props }) {
	const svg = await renderSvgbob(props.diagram);

	return new Response(svg, {
		headers: {
			'Cache-Control': 'public, max-age=31536000, immutable',
			'Content-Type': 'image/svg+xml; charset=utf-8',
		},
	});
}

async function renderSvgbob(diagram) {
	const file = await unified()
		.use(remarkParse)
		.use(svgbob)
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeStringify, { allowDangerousHtml: true })
		.process(`~~~svgbob\n${diagram}\n~~~`);

	return String(file);
}

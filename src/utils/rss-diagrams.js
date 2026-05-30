const SVGBOB_BLOCK_RE = /(```|~~~)[ \t]*svgbob[^\n]*\n([\s\S]*?)\n\1[ \t]*(?=\n|$)/g;

export function getSvgbobDiagrams(markdown) {
	return Array.from(markdown.matchAll(SVGBOB_BLOCK_RE), (match) => match[2]);
}

export function replaceSvgbobBlocksWithLinkedImages(markdown, { imageBaseUrl, postUrl, title }) {
	let diagramIndex = 0;

	return markdown.replace(SVGBOB_BLOCK_RE, () => {
		diagramIndex += 1;

		const imageUrl = `${imageBaseUrl}${diagramIndex}.svg`;
		const alt = `${title} diagram ${diagramIndex}`;

		return `<p><a href="${escapeHtmlAttribute(postUrl)}"><img src="${escapeHtmlAttribute(imageUrl)}" alt="${escapeHtmlAttribute(alt)}"></a></p>`;
	});
}

function escapeHtmlAttribute(value) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

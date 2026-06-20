const ADMONITION_TITLES = {
	notice: 'Notice',
};

const ADMONITION_TYPES = new Set(Object.keys(ADMONITION_TITLES));

export function remarkAdmonitions() {
	return (tree) => {
		visit(tree, (node) => {
			if (node.type !== 'containerDirective') {
				return;
			}

			const type = node.name?.toLowerCase();
			if (!ADMONITION_TYPES.has(type)) {
				return;
			}

			const attributes = node.attributes ?? {};
			const title = attributes.title ?? ADMONITION_TITLES[type];

			node.data = node.data ?? {};
			node.data.hName = 'aside';
			node.data.hProperties = {
				...attributes,
				className: ['admonition', `admonition-${type}`],
				'data-admonition': type,
			};

			delete node.data.hProperties.title;

			node.children.unshift({
				type: 'paragraph',
				data: {
					hName: 'p',
					hProperties: { className: ['admonition-title'] },
				},
				children: [
					{
						type: 'strong',
						children: [{ type: 'text', value: title }],
					},
				],
			});
		});
	};
}

export function replaceAdmonitionsWithHtml(markdown) {
	return markdown.replace(/^:::(notice)(?:\{title="([^"]+)"\})?\n([\s\S]*?)\n:::$/gm, (_match, type, title, body) => {
		const label = title ?? ADMONITION_TITLES[type];

		return `<aside class="admonition admonition-${type}" data-admonition="${type}">\n<p class="admonition-title"><strong>${escapeHtml(label)}</strong></p>\n\n${body}\n</aside>`;
	});
}

function visit(node, callback) {
	callback(node);

	if (!Array.isArray(node.children)) {
		return;
	}

	for (const child of node.children) {
		visit(child, callback);
	}
}

function escapeHtml(value) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

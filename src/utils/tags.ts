export function getTagSlug(tag: string) {
	return tag
		.trim()
		.toLowerCase()
		.replace(/&/g, 'and')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function getTagHref(tag: string) {
	return `/tags/${getTagSlug(tag)}/`;
}
